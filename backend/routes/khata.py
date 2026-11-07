"""
Khata (roz ka hisab-kitab): a shopkeeper keeps a running ledger for each
regular customer — e.g. a milkman who delivers doodh every day and collects
the money once a month — and the customer can open the SAME ledger on their
own phone (or through a read-only link), so nothing is hidden.

How it works
------------
* Seller adds a customer (name + 10-digit phone + up to 5 "roz ka saaman",
  e.g. Doodh 1 L @ Rs 60, Dahi 0.5 kg @ Rs 80). A 6-character link code is made.
* Customer types the code in khata.html and sees the ledger (read-only).
  Customers without the app can use a private read-only link instead.
* Entries: "charge" (maal diya), "payment" (paise mile), "skip" (nahi diya /
  chhutti). Nothing is ever deleted — a wrong entry is CANCELLED or EDITED
  (the old one stays visible, struck through, with the reason).
* Customer can raise a doubt on an entry, and can tell the shop "maine UPI
  se paise bheje" (a claim). Only the seller can confirm it into a payment.
* Extras: chhutti schedule, monthly auto-reminders (utils/khata_runner.py),
  auto-entry from subscription orders, monthly report, "sabko yaad dilao".

Money is stored as integer paise (never floats). Every balance change runs
in a Firestore transaction, so two phones can't corrupt the total.

  Seller                                         (needs a seller profile)
    GET    /api/khata/seller/accounts
    POST   /api/khata/seller/accounts
    PATCH  /api/khata/seller/accounts/<id>
    POST   /api/khata/seller/accounts/<id>/new-code
    POST   /api/khata/seller/accounts/<id>/share         (public link on/off)
    GET    /api/khata/seller/accounts/<id>?month=YYYY-MM
    POST   /api/khata/seller/accounts/<id>/entries
    POST   /api/khata/seller/accounts/<id>/entries/<eid>/void
    POST   /api/khata/seller/accounts/<id>/entries/<eid>/edit
    POST   /api/khata/seller/accounts/<id>/entries/<eid>/reply
    POST   /api/khata/seller/accounts/<id>/entries/<eid>/claim
    POST   /api/khata/seller/daily                        (aaj ka sabko ek saath)
    POST   /api/khata/seller/remind-all
    GET    /api/khata/seller/report?month=YYYY-MM
  Buyer
    POST /api/khata/link
    GET  /api/khata/my
    GET  /api/khata/my/<id>?month=YYYY-MM
    POST /api/khata/my/<id>/entries/<eid>/dispute
    POST /api/khata/my/<id>/pay-claim
  Anyone with the private link (no login)
    GET  /api/khata/public/<token>?month=YYYY-MM

Firestore collections used: khata_accounts/{id} and its subcollection
entries/{entryId}. They are touched ONLY by this backend (Firestore rules
deny all direct browser access — see firestore.rules).
"""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps

from firebase_admin import firestore
from flask import Blueprint, jsonify, request, g

from utils.auth import require_auth
from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

khata_bp = Blueprint("khata", __name__, url_prefix="/api/khata")

MAX_ACCOUNTS_PER_SELLER = 300
MAX_AMOUNT_PAISE = 100_000 * 100       # Rs 1,00,000 per single entry
MAX_BACKDATE_DAYS = 90
MAX_ITEMS = 5
MAX_PENDING_CLAIMS = 3
MAX_PAUSE_DAYS = 120
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O/1/I confusion
CODE_LENGTH = 6
ENTRY_TYPES = ("charge", "payment", "skip")


# ----------------------------------------------------------------- helpers

def ist_now():
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)


def ist_today():
    return ist_now().date()


def _clean(value, limit):
    return str(value or "").strip()[:limit]


def _new_code():
    for _ in range(10):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        clash = db.collection("khata_accounts").where("linkCode", "==", code).limit(1).get()
        if not clash:
            return code
    raise RuntimeError("Could not generate a unique link code.")


def _to_paise(value, field="Amount"):
    """Rupees (e.g. '60', '12.50') -> integer paise. Raises ValueError with a user-facing message."""
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        raise ValueError(f"{field} sahi nahi hai.")
    if not d.is_finite() or d < 0:
        raise ValueError(f"{field} sahi nahi hai.")
    paise = int((d * 100).quantize(Decimal("1")))
    if paise > MAX_AMOUNT_PAISE:
        raise ValueError(f"{field} bahut zyada hai (max Rs 1,00,000).")
    return paise


def _to_qty(value):
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        raise ValueError("Matra (quantity) sahi nahi hai.")
    if not d.is_finite() or d <= 0 or d > 10000:
        raise ValueError("Matra (quantity) sahi nahi hai.")
    return float(d.quantize(Decimal("0.001")))


def _parse_date(value, allow_future=False):
    try:
        d = datetime.strptime(str(value or ist_today().isoformat()), "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("Tareekh sahi nahi hai (YYYY-MM-DD).")
    today = ist_today()
    if d > today and not allow_future:
        raise ValueError("Aane wali tareekh ki entry nahi ho sakti.")
    if d < today - timedelta(days=MAX_BACKDATE_DAYS):
        raise ValueError(f"{MAX_BACKDATE_DAYS} din se purani entry nahi ho sakti.")
    return d


def _month_range(month):
    """'2026-11' -> ('2026-11-01', '2026-12-01'); None -> current IST month."""
    try:
        if month:
            first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        else:
            first = ist_today().replace(day=1)
    except ValueError:
        raise ValueError("Mahina sahi nahi hai (YYYY-MM).")
    nxt = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    return first.isoformat(), nxt.isoformat()


def _iso(ts):
    if ts is None:
        return None
    try:
        return ts.isoformat()
    except AttributeError:
        return str(ts)


def _account_public(doc_id, a, for_seller):
    out = {
        "id": doc_id,
        "shopName": a.get("shopName"),
        "customerName": a.get("customerName"),
        "customerPhone": a.get("customerPhone"),
        "defaultItems": _items_of(a),
        "pause": a.get("pause"),
        "reminderDay": a.get("reminderDay"),
        "autoFromSubscription": bool(a.get("autoFromSubscription")),
        "pendingClaims": a.get("pendingClaims", 0),
        "lastEntryDate": a.get("lastEntryDate"),
        "totalCharged": a.get("totalCharged", 0),
        "totalPaid": a.get("totalPaid", 0),
        "balance": a.get("totalCharged", 0) - a.get("totalPaid", 0),
        "status": a.get("status", "active"),
        "linked": bool(a.get("buyerUid")),
        "lastEntryAt": _iso(a.get("lastEntryAt")),
        "openDisputes": a.get("openDisputes", 0),
    }
    if for_seller:
        out["linkCode"] = None if a.get("buyerUid") else a.get("linkCode")
        out["shareToken"] = a.get("shareToken")
    return out


def _entry_public(doc_id, e):
    return {
        "id": doc_id,
        "type": e.get("type"),
        "date": e.get("date"),
        "itemName": e.get("itemName"),
        "quantity": e.get("quantity"),
        "rate": e.get("rate"),
        "amount": e.get("amount", 0),
        "note": e.get("note"),
        "voided": bool(e.get("voided")),
        "voidReason": e.get("voidReason"),
        "dispute": e.get("dispute"),
        "claimStatus": e.get("claimStatus"),
        "claimReason": e.get("claimReason"),
        "edited": bool(e.get("replaces")),
        "createdAt": _iso(e.get("createdAt")),
    }


def _notify(uid, title, body, link):
    if not uid:
        return
    try:
        db.collection("users").document(uid).collection("notifications").document().set({
            "title": title, "body": body, "type": "khata", "link": link,
            "read": False, "createdAt": datetime.now(timezone.utc),
        })
    except Exception:
        logger.exception("Khata: could not notify %s", uid)


def require_seller(fn):
    """Any signed-in user who has a shop profile (same rule the Seller Hub uses)."""
    @wraps(fn)
    @require_auth
    def wrapper(*args, **kwargs):
        snap = db.collection("sellers_profiles").document(g.uid).get()
        if not snap.exists:
            return jsonify({"error": "Pehle Seller Hub me apni dukaan ki profile banaiye."}), 403
        g.shop = snap.to_dict() or {}
        return fn(*args, **kwargs)
    return wrapper


def _own_account(account_id):
    ref = db.collection("khata_accounts").document(account_id)
    snap = ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("sellerUid") != g.uid:
        return None, None
    return ref, snap.to_dict()


def _buyer_account(account_id):
    ref = db.collection("khata_accounts").document(account_id)
    snap = ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("buyerUid") != g.uid:
        return None, None
    return ref, snap.to_dict()


def _items_of(a):
    items = a.get("defaultItems")
    if items:
        return items
    one = a.get("defaultItem")          # older single-item accounts
    return [one] if one else []


def _validate_items(raw):
    """List of up to MAX_ITEMS {name, unit, quantity, rate(paise)}. Empty rows are ignored."""
    out = []
    for r in (raw or [])[:MAX_ITEMS]:
        name = _clean((r or {}).get("name"), 60)
        if not name:
            continue
        out.append({
            "name": name,
            "unit": _clean(r.get("unit"), 12) or "piece",
            "quantity": _to_qty(r.get("quantity") or 1),
            "rate": _to_paise(r.get("rate"), "Rate"),
        })
    return out


def _in_pause(a, day_iso):
    p = a.get("pause")
    return bool(p and p.get("from") and p.get("to") and p["from"] <= day_iso <= p["to"])


def _line_amount(item):
    return int((Decimal(str(item["quantity"])) * item["rate"]).quantize(Decimal("1")))


def _apply_entry(ref, entry_doc):
    """Writes one entry and updates the account totals atomically."""
    entry_ref = ref.collection("entries").document()

    @firestore.transactional
    def _txn(txn):
        snap = ref.get(transaction=txn)
        acct = snap.to_dict() or {}
        updates = {"lastEntryAt": firestore.SERVER_TIMESTAMP}
        if entry_doc["type"] in ("charge", "skip") and entry_doc["date"] > (acct.get("lastEntryDate") or ""):
            updates["lastEntryDate"] = entry_doc["date"]
        if entry_doc["type"] == "charge":
            updates["totalCharged"] = acct.get("totalCharged", 0) + entry_doc["amount"]
        elif entry_doc["type"] == "payment":
            updates["totalPaid"] = acct.get("totalPaid", 0) + entry_doc["amount"]
        txn.set(entry_ref, entry_doc)
        txn.update(ref, updates)

    _txn(db.transaction())
    return entry_ref.id


def _strip(entry, public):
    if public:
        entry["dispute"] = None     # doubts are between customer and shop, not for a shared link
    return entry


def _month_view(ref, acct, month, public=False):
    start, end = _month_range(month)
    rows = []
    net_from_start = 0   # effect of every live entry dated on/after the month start
    for d in ref.collection("entries").where("date", ">=", start).order_by("date").stream():
        e = d.to_dict() or {}
        if not e.get("voided"):
            if e.get("type") == "charge":
                net_from_start += e.get("amount", 0)
            elif e.get("type") == "payment":
                net_from_start -= e.get("amount", 0)
        if e.get("date") < end:
            rows.append((e.get("date"), _iso(e.get("createdAt")) or "", d.id, e))
    rows.sort(key=lambda r: (r[0], r[1]))

    month_charged = sum(e["amount"] for _, _, _, e in rows
                        if e.get("type") == "charge" and not e.get("voided"))
    month_paid = sum(e["amount"] for _, _, _, e in rows
                     if e.get("type") == "payment" and not e.get("voided"))
    current_balance = acct.get("totalCharged", 0) - acct.get("totalPaid", 0)
    return {
        "month": start[:7],
        "openingBalance": current_balance - net_from_start,
        "monthCharged": month_charged,
        "monthPaid": month_paid,
        "entries": [_strip(_entry_public(i, e), public) for _, _, i, e in rows],
    }


# ------------------------------------------------------------ seller routes

@khata_bp.route("/seller/accounts", methods=["GET"])
@limiter.limit("60 per minute")
@require_seller
def seller_list_accounts():
    rows = []
    for d in db.collection("khata_accounts").where("sellerUid", "==", g.uid).stream():
        a = d.to_dict() or {}
        if a.get("status") == "closed":
            continue
        rows.append(_account_public(d.id, a, True))
    rows.sort(key=lambda r: (-r["balance"], (r["customerName"] or "").lower()))
    return jsonify({
        "accounts": rows,
        "totalPending": sum(r["balance"] for r in rows if r["balance"] > 0),
    })


@khata_bp.route("/seller/accounts", methods=["POST"])
@limiter.limit("30 per minute")
@require_seller
def seller_create_account():
    data = request.get_json(silent=True) or {}
    name = _clean(data.get("customerName"), 60)
    phone = _clean(data.get("customerPhone"), 10)
    if not name:
        return jsonify({"error": "Grahak ka naam likhiye."}), 400
    if not (phone.isdigit() and len(phone) == 10):
        return jsonify({"error": "10 ank ka phone number likhiye."}), 400
    try:
        items = _validate_items(data.get("defaultItems"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    existing = [d.to_dict() or {} for d in
                db.collection("khata_accounts").where("sellerUid", "==", g.uid).stream()]
    live = [a for a in existing if a.get("status") != "closed"]
    if len(live) >= MAX_ACCOUNTS_PER_SELLER:
        return jsonify({"error": f"Ek dukaan me max {MAX_ACCOUNTS_PER_SELLER} khate ho sakte hain."}), 409
    if any(a.get("customerPhone") == phone for a in live):
        return jsonify({"error": "Is number ka khata pehle se bana hua hai."}), 409

    ref = db.collection("khata_accounts").document()
    ref.set({
        "sellerUid": g.uid,
        "shopName": g.shop.get("shopName") or "Dukaan",
        "customerName": name,
        "customerPhone": phone,
        "defaultItems": items,
        "linkCode": _new_code(),
        "buyerUid": None,
        "totalCharged": 0,
        "totalPaid": 0,
        "openDisputes": 0,
        "pendingClaims": 0,
        "status": "active",
        "createdAt": datetime.now(timezone.utc),
    })
    return jsonify({"success": True, "id": ref.id})


@khata_bp.route("/seller/accounts/<account_id>", methods=["PATCH"])
@limiter.limit("30 per minute")
@require_seller
def seller_update_account(account_id):
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    data = request.get_json(silent=True) or {}
    updates = {}
    try:
        if "customerName" in data:
            name = _clean(data.get("customerName"), 60)
            if not name:
                return jsonify({"error": "Grahak ka naam likhiye."}), 400
            updates["customerName"] = name
        if "defaultItems" in data:
            updates["defaultItems"] = _validate_items(data.get("defaultItems"))
            updates["defaultItem"] = firestore.DELETE_FIELD     # drop the old single-item field
        if "pause" in data:
            p = data.get("pause")
            if not p:
                updates["pause"] = None
            else:
                try:
                    f = datetime.strptime(str(p.get("from")), "%Y-%m-%d").date()
                    t = datetime.strptime(str(p.get("to")), "%Y-%m-%d").date()
                except ValueError:
                    return jsonify({"error": "Chhutti ki tareekh sahi nahi hai."}), 400
                if t < f:
                    return jsonify({"error": "Chhutti ki aakhri tareekh shuruat se pehle nahi ho sakti."}), 400
                if (t - f).days > MAX_PAUSE_DAYS:
                    return jsonify({"error": f"Chhutti {MAX_PAUSE_DAYS} din se lambi nahi ho sakti."}), 400
                updates["pause"] = {"from": f.isoformat(), "to": t.isoformat()}
        if "reminderDay" in data:
            rd = data.get("reminderDay")
            if rd in (None, "", 0, "0"):
                updates["reminderDay"] = None
            else:
                try:
                    rd = int(rd)
                except (TypeError, ValueError):
                    return jsonify({"error": "Reminder ki tareekh 1 se 28 ke beech chuniye."}), 400
                if not 1 <= rd <= 28:
                    return jsonify({"error": "Reminder ki tareekh 1 se 28 ke beech chuniye."}), 400
                updates["reminderDay"] = rd
        if "autoFromSubscription" in data:
            updates["autoFromSubscription"] = bool(data.get("autoFromSubscription"))
        if data.get("close") is True:
            if acct.get("totalCharged", 0) - acct.get("totalPaid", 0) != 0:
                return jsonify({"error": "Khata band karne se pehle hisab barabar (Rs 0) kijiye."}), 409
            updates["status"] = "closed"
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if updates:
        ref.update(updates)
    return jsonify({"success": True})


@khata_bp.route("/seller/accounts/<account_id>/new-code", methods=["POST"])
@limiter.limit("10 per minute")
@require_seller
def seller_new_code(account_id):
    """Unlinks the current phone (if any) and makes a fresh code — e.g. customer changed phone."""
    ref, _ = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    code = _new_code()
    ref.update({"linkCode": code, "buyerUid": None})
    return jsonify({"success": True, "linkCode": code})


@khata_bp.route("/seller/accounts/<account_id>", methods=["GET"])
@limiter.limit("60 per minute")
@require_seller
def seller_account_detail(account_id):
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    try:
        view = _month_view(ref, acct, request.args.get("month"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"account": _account_public(account_id, acct, True), **view})


@khata_bp.route("/seller/accounts/<account_id>/entries", methods=["POST"])
@limiter.limit("60 per minute")
@require_seller
def seller_add_entry(account_id):
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    if acct.get("status") == "closed":
        return jsonify({"error": "Ye khata band hai."}), 409

    data = request.get_json(silent=True) or {}
    etype = str(data.get("type") or "").lower()
    if etype not in ENTRY_TYPES:
        return jsonify({"error": "Entry ka type sahi nahi hai."}), 400
    try:
        day = _parse_date(data.get("date"))
        note = _clean(data.get("note"), 140)
        entry = {
            "type": etype, "date": day.isoformat(), "note": note or None,
            "voided": False, "createdAt": datetime.now(timezone.utc), "createdBy": g.uid,
        }
        if etype == "charge":
            qty = _to_qty(data.get("quantity") or 1)
            rate = _to_paise(data.get("rate"), "Rate")
            if rate <= 0:
                return jsonify({"error": "Rate 0 se zyada hona chahiye."}), 400
            amount = int((Decimal(str(qty)) * rate).quantize(Decimal("1")))
            if amount > MAX_AMOUNT_PAISE:
                return jsonify({"error": "Amount bahut zyada hai (max Rs 1,00,000)."}), 400
            item = _clean(data.get("itemName"), 60)
            if not item:
                return jsonify({"error": "Saaman ka naam likhiye."}), 400
            entry.update({"itemName": item, "quantity": qty, "rate": rate, "amount": amount})
        elif etype == "payment":
            amount = _to_paise(data.get("amount"), "Amount")
            if amount <= 0:
                return jsonify({"error": "Amount 0 se zyada hona chahiye."}), 400
            entry.update({"itemName": None, "quantity": None, "rate": None, "amount": amount})
        else:  # skip: "aaj nahi diya" — amount stays 0
            entry.update({"itemName": _clean(data.get("itemName"), 60) or None,
                          "quantity": None, "rate": None, "amount": 0})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    entry_id = _apply_entry(ref, entry)

    if etype == "payment":
        rupees = entry["amount"] / 100
        _notify(acct.get("buyerUid"), "💰 Payment likhi gayi",
                f"{acct.get('shopName')}: Rs {rupees:g} ki payment aapke khate me likhi gayi.",
                "khata.html")
    return jsonify({"success": True, "id": entry_id})


@khata_bp.route("/seller/accounts/<account_id>/entries/<entry_id>/void", methods=["POST"])
@limiter.limit("30 per minute")
@require_seller
def seller_void_entry(account_id, entry_id):
    """Cancel a wrong entry. It is NOT deleted — it stays visible, marked cancelled."""
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    reason = _clean((request.get_json(silent=True) or {}).get("reason"), 140)
    if not reason:
        return jsonify({"error": "Cancel karne ka karan likhiye — grahak ko ye dikhega."}), 400

    entry_ref = ref.collection("entries").document(entry_id)

    @firestore.transactional
    def _txn(txn):
        acct_snap = ref.get(transaction=txn)
        e_snap = entry_ref.get(transaction=txn)
        if not e_snap.exists:
            return "missing"
        e = e_snap.to_dict() or {}
        if e.get("voided"):
            return "already"
        a = acct_snap.to_dict() or {}
        updates = {}
        entry_updates = {"voided": True, "voidReason": reason,
                         "voidedAt": datetime.now(timezone.utc)}
        if e.get("type") == "charge":
            updates["totalCharged"] = a.get("totalCharged", 0) - e.get("amount", 0)
        elif e.get("type") == "payment":
            updates["totalPaid"] = a.get("totalPaid", 0) - e.get("amount", 0)
        if (e.get("dispute") or {}).get("status") == "open":
            updates["openDisputes"] = max(0, a.get("openDisputes", 0) - 1)
            entry_updates.update({"dispute.status": "resolved",
                                  "dispute.reply": "Entry cancel kar di gayi.",
                                  "dispute.resolvedAt": datetime.now(timezone.utc)})
        if updates:
            txn.update(ref, updates)
        txn.update(entry_ref, entry_updates)
        return "ok"

    result = _txn(db.transaction())
    if result == "missing":
        return jsonify({"error": "Entry nahi mili."}), 404
    if result == "already":
        return jsonify({"error": "Ye entry pehle hi cancel ho chuki hai."}), 409
    _notify(acct.get("buyerUid"), "✏️ Khate ki ek entry cancel hui",
            f"{acct.get('shopName')}: {reason}", "khata.html")
    return jsonify({"success": True})


@khata_bp.route("/seller/accounts/<account_id>/entries/<entry_id>/reply", methods=["POST"])
@limiter.limit("30 per minute")
@require_seller
def seller_reply_dispute(account_id, entry_id):
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    reply = _clean((request.get_json(silent=True) or {}).get("reply"), 200)
    if not reply:
        return jsonify({"error": "Jawab likhiye."}), 400

    entry_ref = ref.collection("entries").document(entry_id)

    @firestore.transactional
    def _txn(txn):
        e_snap = entry_ref.get(transaction=txn)
        if not e_snap.exists:
            return "missing"
        d = (e_snap.to_dict() or {}).get("dispute")
        if not d or d.get("status") != "open":
            return "none"
        a = ref.get(transaction=txn).to_dict() or {}
        txn.update(entry_ref, {"dispute.status": "resolved", "dispute.reply": reply,
                               "dispute.resolvedAt": datetime.now(timezone.utc)})
        txn.update(ref, {"openDisputes": max(0, a.get("openDisputes", 0) - 1)})
        return "ok"

    result = _txn(db.transaction())
    if result == "missing":
        return jsonify({"error": "Entry nahi mili."}), 404
    if result == "none":
        return jsonify({"error": "Is entry par koi khula sawal nahi hai."}), 409
    _notify(acct.get("buyerUid"), "💬 Aapke sawal ka jawab aaya",
            f"{acct.get('shopName')}: {reply}", "khata.html")
    return jsonify({"success": True})


@khata_bp.route("/seller/daily", methods=["POST"])
@limiter.limit("10 per minute")
@require_seller
def seller_daily_all():
    """
    "Aaj ka sabko lagao": adds each customer's usual items for the day in one tap
    (one entry per item). Customers who already have a live charge/skip for that
    day are left alone, so pressing the button twice never double-charges anyone.
    When no accountIds are sent, accounts on chhutti (pause) get a "Chhutti" skip
    entry instead of a charge; when the app sends explicit ids, it decides.
    """
    data = request.get_json(silent=True) or {}
    try:
        day = _parse_date(data.get("date")).isoformat()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    only = set(data.get("accountIds") or [])
    skip_ids = set(data.get("skipAccountIds") or [])   # "aaj nahi diya" customers

    added, skipped_existing, no_default = 0, 0, 0
    for d in db.collection("khata_accounts").where("sellerUid", "==", g.uid).stream():
        a = d.to_dict() or {}
        if a.get("status") == "closed" or (only and d.id not in only):
            continue
        items = _items_of(a)
        paused = (not only) and _in_pause(a, day)
        marking_skip = d.id in skip_ids or paused
        if not items and not marking_skip:
            no_default += 1
            continue
        todays = [e.to_dict() or {} for e in
                  d.reference.collection("entries").where("date", "==", day).stream()]
        if any(e.get("type") in ("charge", "skip") and not e.get("voided") for e in todays):
            skipped_existing += 1
            continue
        now = datetime.now(timezone.utc)
        if marking_skip:
            note = "Chhutti" if (paused and d.id not in skip_ids) else "Aaj nahi diya"
            _apply_entry(d.reference, {
                "type": "skip", "date": day, "itemName": (items[0]["name"] if items else None),
                "quantity": None, "rate": None, "amount": 0, "note": note,
                "voided": False, "createdAt": now, "createdBy": g.uid})
        else:
            for item in items:
                _apply_entry(d.reference, {
                    "type": "charge", "date": day, "itemName": item["name"],
                    "quantity": item["quantity"], "rate": item["rate"], "amount": _line_amount(item),
                    "note": None, "voided": False, "createdAt": now, "createdBy": g.uid})
        added += 1
    return jsonify({"success": True, "added": added,
                    "alreadyDone": skipped_existing, "noUsualItem": no_default, "date": day})


@khata_bp.route("/seller/accounts/<account_id>/entries/<entry_id>/edit", methods=["POST"])
@limiter.limit("30 per minute")
@require_seller
def seller_edit_entry(account_id, entry_id):
    """
    Corrects a charge/payment. The OLD entry is kept (cancelled, "Sudhaar kiya gaya")
    and a NEW one replaces it — so the customer can always see what changed.
    """
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    entry_ref = ref.collection("entries").document(entry_id)
    old_snap = entry_ref.get()
    if not old_snap.exists:
        return jsonify({"error": "Entry nahi mili."}), 404
    old = old_snap.to_dict() or {}
    if old.get("type") not in ("charge", "payment") or old.get("voided"):
        return jsonify({"error": "Ye entry badli nahi ja sakti."}), 409

    data = request.get_json(silent=True) or {}
    try:
        new = {"type": old["type"], "date": old["date"], "note": _clean(data.get("note"), 140) or None,
               "voided": False, "createdAt": datetime.now(timezone.utc), "createdBy": g.uid,
               "replaces": entry_id}
        if data.get("date"):
            new["date"] = _parse_date(data.get("date")).isoformat()
        if old["type"] == "charge":
            qty = _to_qty(data.get("quantity") or old.get("quantity") or 1)
            rate = _to_paise(data.get("rate") if data.get("rate") not in (None, "") else old.get("rate", 0) / 100, "Rate")
            if rate <= 0:
                return jsonify({"error": "Rate 0 se zyada hona chahiye."}), 400
            amount = _line_amount({"quantity": qty, "rate": rate})
            item = _clean(data.get("itemName"), 60) or old.get("itemName")
            new.update({"itemName": item, "quantity": qty, "rate": rate, "amount": amount})
        else:
            amount = _to_paise(data.get("amount"), "Amount")
            if amount <= 0:
                return jsonify({"error": "Amount 0 se zyada hona chahiye."}), 400
            new.update({"itemName": None, "quantity": None, "rate": None, "amount": amount})
        if amount > MAX_AMOUNT_PAISE:
            return jsonify({"error": "Amount bahut zyada hai (max Rs 1,00,000)."}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    new_ref = ref.collection("entries").document()

    @firestore.transactional
    def _txn(txn):
        a = ref.get(transaction=txn).to_dict() or {}
        o = entry_ref.get(transaction=txn).to_dict() or {}
        if o.get("voided"):
            return "already"
        key = "totalCharged" if o["type"] == "charge" else "totalPaid"
        upd = {key: a.get(key, 0) - o.get("amount", 0) + new["amount"],
               "lastEntryAt": firestore.SERVER_TIMESTAMP}
        old_upd = {"voided": True, "voidReason": "Sudhaar kiya gaya (naya entry bana)",
                   "voidedAt": datetime.now(timezone.utc), "replacedBy": new_ref.id}
        if (o.get("dispute") or {}).get("status") == "open":
            upd["openDisputes"] = max(0, a.get("openDisputes", 0) - 1)
            old_upd.update({"dispute.status": "resolved", "dispute.reply": "Entry sudhaar di gayi.",
                            "dispute.resolvedAt": datetime.now(timezone.utc)})
        txn.set(new_ref, new)
        txn.update(entry_ref, old_upd)
        txn.update(ref, upd)
        return "ok"

    if _txn(db.transaction()) == "already":
        return jsonify({"error": "Ye entry pehle hi badal/cancel ho chuki hai."}), 409
    _notify(acct.get("buyerUid"), "✏️ Khate ki ek entry sudhari gayi",
            f"{acct.get('shopName')}: ek entry theek ki gayi. Khata dekhiye.", "khata.html")
    return jsonify({"success": True, "id": new_ref.id})


@khata_bp.route("/seller/accounts/<account_id>/entries/<entry_id>/claim", methods=["POST"])
@limiter.limit("30 per minute")
@require_seller
def seller_resolve_claim(account_id, entry_id):
    """Customer said "maine UPI se paise bheje" — seller confirms (-> real payment) or rejects."""
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "").lower()
    if action not in ("confirm", "reject"):
        return jsonify({"error": "Confirm ya reject chuniye."}), 400
    reason = _clean(data.get("reason"), 140)
    if action == "reject" and not reason:
        return jsonify({"error": "Reject karne ka karan likhiye."}), 400

    entry_ref = ref.collection("entries").document(entry_id)
    pay_ref = ref.collection("entries").document()
    try:
        override = _to_paise(data.get("amount"), "Amount") if data.get("amount") not in (None, "") else None
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    @firestore.transactional
    def _txn(txn):
        a = ref.get(transaction=txn).to_dict() or {}
        c = entry_ref.get(transaction=txn).to_dict()
        if not c or c.get("type") != "claim":
            return "missing", 0
        if c.get("claimStatus") != "pending":
            return "done", 0
        pending = max(0, a.get("pendingClaims", 0) - 1)
        if action == "reject":
            txn.update(entry_ref, {"claimStatus": "rejected", "claimReason": reason})
            txn.update(ref, {"pendingClaims": pending})
            return "ok", c.get("amount", 0)
        amount = override or c.get("amount", 0)
        if amount <= 0:
            return "badamount", 0
        today = ist_today().isoformat()
        note = "UPI (grahak ne bheja)" + (f" · {c['note']}" if c.get("note") else "")
        txn.set(pay_ref, {"type": "payment", "date": today, "itemName": None, "quantity": None,
                          "rate": None, "amount": amount, "note": note[:140], "voided": False,
                          "createdAt": datetime.now(timezone.utc), "createdBy": g.uid,
                          "source": "claim", "claimId": entry_id})
        txn.update(entry_ref, {"claimStatus": "confirmed", "paymentId": pay_ref.id})
        txn.update(ref, {"totalPaid": a.get("totalPaid", 0) + amount, "pendingClaims": pending,
                         "lastEntryAt": firestore.SERVER_TIMESTAMP})
        return "ok", amount

    result, amt = _txn(db.transaction())
    if result == "missing":
        return jsonify({"error": "Entry nahi mili."}), 404
    if result == "done":
        return jsonify({"error": "Is par pehle hi faisla ho chuka hai."}), 409
    if result == "badamount":
        return jsonify({"error": "Amount sahi nahi hai."}), 400
    if action == "confirm":
        _notify(acct.get("buyerUid"), "✅ Aapki payment confirm hui",
                f"{acct.get('shopName')}: {_fmt_rupees(amt)} aapke khate me likh diye gaye.", "khata.html")
    else:
        _notify(acct.get("buyerUid"), "❌ Payment ka dawa reject hua",
                f"{acct.get('shopName')}: {reason}", "khata.html")
    return jsonify({"success": True})


@khata_bp.route("/seller/accounts/<account_id>/share", methods=["POST"])
@limiter.limit("20 per minute")
@require_seller
def seller_share(account_id):
    """Private read-only link for customers who don't use the app. Turn off any time."""
    ref, acct = _own_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    if (request.get_json(silent=True) or {}).get("enable") is False:
        ref.update({"shareToken": None})
        return jsonify({"success": True, "shareToken": None})
    token = acct.get("shareToken") or secrets.token_urlsafe(18)
    ref.update({"shareToken": token})
    return jsonify({"success": True, "shareToken": token})


@khata_bp.route("/seller/remind-all", methods=["POST"])
@limiter.limit("5 per hour")
@require_seller
def seller_remind_all():
    """In-app notification to every linked customer with baaki > 0 (once per ~20 hours each)."""
    notified, not_linked, cooled = 0, [], 0
    now = datetime.now(timezone.utc)
    for d in db.collection("khata_accounts").where("sellerUid", "==", g.uid).stream():
        a = d.to_dict() or {}
        bal = a.get("totalCharged", 0) - a.get("totalPaid", 0)
        if a.get("status") == "closed" or bal <= 0:
            continue
        if not a.get("buyerUid"):
            not_linked.append({"id": d.id, "name": a.get("customerName"),
                               "phone": a.get("customerPhone"), "balance": bal})
            continue
        last = a.get("lastRemindedAt")
        if last and (now - last).total_seconds() < 20 * 3600:
            cooled += 1
            continue
        _notify(a["buyerUid"], "📒 Hisab ki yaad",
                f"{a.get('shopName')}: aapka {_fmt_rupees(bal)} baaki hai. Poora hisab Mera Khata me dekhiye.",
                "khata.html")
        d.reference.update({"lastRemindedAt": now})
        notified += 1
    return jsonify({"success": True, "notified": notified, "recentlyReminded": cooled,
                    "notLinked": not_linked})


def _month_totals(ref, start, end, today):
    charged = paid = today_charged = 0
    for d in ref.collection("entries").where("date", ">=", start).stream():
        e = d.to_dict() or {}
        if e.get("voided"):
            continue
        amt = e.get("amount", 0)
        if e.get("date", "") < end:
            if e.get("type") == "charge":
                charged += amt
            elif e.get("type") == "payment":
                paid += amt
        if e.get("type") == "charge" and e.get("date") == today:
            today_charged += amt
    return charged, paid, today_charged


@khata_bp.route("/seller/report", methods=["GET"])
@limiter.limit("20 per minute")
@require_seller
def seller_report():
    try:
        start, end = _month_range(request.args.get("month"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    today = ist_today().isoformat()
    rows, tot_c, tot_p, tot_today, pending, advance = [], 0, 0, 0, 0, 0
    for d in db.collection("khata_accounts").where("sellerUid", "==", g.uid).stream():
        a = d.to_dict() or {}
        if a.get("status") == "closed":
            continue
        c, p, t = _month_totals(d.reference, start, end, today)
        bal = a.get("totalCharged", 0) - a.get("totalPaid", 0)
        tot_c += c
        tot_p += p
        tot_today += t
        pending += max(bal, 0)
        advance += max(-bal, 0)
        rows.append({"id": d.id, "name": a.get("customerName"), "phone": a.get("customerPhone"),
                     "balance": bal, "monthCharged": c, "monthPaid": p})
    rows.sort(key=lambda r: (-r["balance"], (r["name"] or "").lower()))
    return jsonify({
        "month": start[:7], "shopName": g.shop.get("shopName"),
        "customers": rows, "customerCount": len(rows),
        "monthCharged": tot_c, "monthPaid": tot_p, "todayCharged": tot_today,
        "totalPending": pending, "totalAdvance": advance,
        "collectionPercent": round(tot_p * 100 / tot_c) if tot_c else None,
    })


def _fmt_rupees(paise):
    v = paise / 100
    return f"Rs {v:g}"


def auto_charge_from_order(seller_uid, buyer_uid, order_id, item_name, quantity, unit_price):
    """
    Called by utils/subscription_runner.py after it places a roz-ka-order. If this buyer has a
    khata with this seller that has "Subscription order khate me likho" turned on, the charge is
    written to the khata. Safe to call twice for the same order (checked by orderId).
    """
    count = 0
    q = (db.collection("khata_accounts").where("sellerUid", "==", seller_uid)
         .where("buyerUid", "==", buyer_uid))
    for d in q.stream():
        a = d.to_dict() or {}
        if a.get("status") == "closed" or not a.get("autoFromSubscription"):
            continue
        if d.reference.collection("entries").where("orderId", "==", order_id).limit(1).get():
            continue
        qty = _to_qty(quantity)
        rate = _to_paise(unit_price, "Rate")
        _apply_entry(d.reference, {
            "type": "charge", "date": ist_today().isoformat(), "itemName": str(item_name)[:60],
            "quantity": qty, "rate": rate, "amount": _line_amount({"quantity": qty, "rate": rate}),
            "note": "Roz ka order (subscription)", "voided": False,
            "createdAt": datetime.now(timezone.utc), "createdBy": seller_uid,
            "source": "subscription", "orderId": order_id})
        count += 1
    return count


# ------------------------------------------------------------- buyer routes

@khata_bp.route("/link", methods=["POST"])
@limiter.limit("10 per hour")
@require_auth
def buyer_link():
    code = _clean((request.get_json(silent=True) or {}).get("code"), 12).upper()
    if len(code) != CODE_LENGTH:
        return jsonify({"error": f"{CODE_LENGTH} akshar ka code likhiye."}), 400
    hits = db.collection("khata_accounts").where("linkCode", "==", code).limit(1).get()
    if not hits or (hits[0].to_dict() or {}).get("buyerUid") or \
            (hits[0].to_dict() or {}).get("status") == "closed":
        return jsonify({"error": "Ye code galat hai ya pehle hi use ho chuka hai."}), 404
    snap = hits[0]
    a = snap.to_dict() or {}
    if a.get("sellerUid") == g.uid:
        return jsonify({"error": "Apni hi dukaan ke khate ko aap grahak ki tarah nahi jod sakte."}), 400
    snap.reference.update({"buyerUid": g.uid})
    _notify(a.get("sellerUid"), "🔗 Grahak jud gaya",
            f"{a.get('customerName')} ne apna khata phone se jod liya.", "khata-seller.html")
    return jsonify({"success": True, "id": snap.id, "shopName": a.get("shopName")})


@khata_bp.route("/my", methods=["GET"])
@limiter.limit("60 per minute")
@require_auth
def buyer_list():
    rows = [_account_public(d.id, d.to_dict() or {}, False)
            for d in db.collection("khata_accounts").where("buyerUid", "==", g.uid).stream()
            if (d.to_dict() or {}).get("status") != "closed"]
    rows.sort(key=lambda r: (r["shopName"] or "").lower())
    return jsonify({"accounts": rows})


@khata_bp.route("/my/<account_id>", methods=["GET"])
@limiter.limit("60 per minute")
@require_auth
def buyer_detail(account_id):
    ref, acct = _buyer_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    try:
        view = _month_view(ref, acct, request.args.get("month"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    out = _account_public(account_id, acct, False)
    out["shopUpiId"] = _shop_upi(acct.get("sellerUid"))
    return jsonify({"account": out, **view})


def _shop_upi(seller_uid):
    try:
        snap = db.collection("sellers_profiles").document(seller_uid).get()
        return ((snap.to_dict() or {}).get("upiId") or "").strip() or None
    except Exception:
        return None


@khata_bp.route("/my/<account_id>/pay-claim", methods=["POST"])
@limiter.limit("10 per hour")
@require_auth
def buyer_pay_claim(account_id):
    """"Maine UPI se paise bheje" — shows as PENDING until the seller confirms. No balance change."""
    ref, acct = _buyer_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    data = request.get_json(silent=True) or {}
    try:
        amount = _to_paise(data.get("amount"), "Amount")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if amount <= 0:
        return jsonify({"error": "Amount 0 se zyada hona chahiye."}), 400
    note = _clean(data.get("note"), 60) or None      # e.g. UPI reference number
    entry_ref = ref.collection("entries").document()

    @firestore.transactional
    def _txn(txn):
        a = ref.get(transaction=txn).to_dict() or {}
        if a.get("pendingClaims", 0) >= MAX_PENDING_CLAIMS:
            return False
        txn.set(entry_ref, {"type": "claim", "date": ist_today().isoformat(), "itemName": None,
                            "quantity": None, "rate": None, "amount": amount, "note": note,
                            "claimStatus": "pending", "voided": False,
                            "createdAt": datetime.now(timezone.utc), "createdBy": g.uid})
        txn.update(ref, {"pendingClaims": a.get("pendingClaims", 0) + 1})
        return True

    if not _txn(db.transaction()):
        return jsonify({"error": "Pehle ke dawon par dukandaar ka jawab aane dijiye."}), 409
    _notify(acct.get("sellerUid"), "💸 Grahak ne UPI se paise bheje",
            f"{acct.get('customerName')}: {_fmt_rupees(amount)}. Check karke confirm kijiye.",
            "khata-seller.html")
    return jsonify({"success": True})


@khata_bp.route("/public/<token>", methods=["GET"])
@limiter.limit("60 per minute")
def public_view(token):
    """Read-only ledger for a customer who got the private link. No login; token is the secret."""
    if not (10 <= len(token) <= 64):
        return jsonify({"error": "Link galat hai."}), 404
    hits = db.collection("khata_accounts").where("shareToken", "==", token).limit(1).get()
    if not hits or (hits[0].to_dict() or {}).get("status") == "closed":
        return jsonify({"error": "Ye link band ho chuka hai ya galat hai."}), 404
    snap = hits[0]
    acct = snap.to_dict() or {}
    try:
        view = _month_view(snap.reference, acct, request.args.get("month"), public=True)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({
        "account": {
            "shopName": acct.get("shopName"), "customerName": acct.get("customerName"),
            "totalCharged": acct.get("totalCharged", 0), "totalPaid": acct.get("totalPaid", 0),
            "balance": acct.get("totalCharged", 0) - acct.get("totalPaid", 0),
            "shopUpiId": _shop_upi(acct.get("sellerUid")),
        }, **view})


@khata_bp.route("/my/<account_id>/entries/<entry_id>/dispute", methods=["POST"])
@limiter.limit("20 per hour")
@require_auth
def buyer_dispute(account_id, entry_id):
    ref, acct = _buyer_account(account_id)
    if not ref:
        return jsonify({"error": "Khata nahi mila."}), 404
    message = _clean((request.get_json(silent=True) or {}).get("message"), 200)
    if not message:
        return jsonify({"error": "Apna sawal likhiye."}), 400

    entry_ref = ref.collection("entries").document(entry_id)

    @firestore.transactional
    def _txn(txn):
        e_snap = entry_ref.get(transaction=txn)
        if not e_snap.exists:
            return "missing"
        e = e_snap.to_dict() or {}
        if e.get("voided"):
            return "voided"
        if (e.get("dispute") or {}).get("status") == "open":
            return "open"
        a = ref.get(transaction=txn).to_dict() or {}
        txn.update(entry_ref, {"dispute": {"status": "open", "message": message,
                                           "at": datetime.now(timezone.utc),
                                           "reply": None, "resolvedAt": None}})
        txn.update(ref, {"openDisputes": a.get("openDisputes", 0) + 1})
        return "ok"

    result = _txn(db.transaction())
    if result == "missing":
        return jsonify({"error": "Entry nahi mili."}), 404
    if result == "voided":
        return jsonify({"error": "Ye entry pehle hi cancel ho chuki hai."}), 409
    if result == "open":
        return jsonify({"error": "Is entry par aapka sawal pehle se khula hai."}), 409
    _notify(acct.get("sellerUid"), "❓ Khate me grahak ka sawal",
            f"{acct.get('customerName')}: {message}", "khata-seller.html")
    return jsonify({"success": True})
