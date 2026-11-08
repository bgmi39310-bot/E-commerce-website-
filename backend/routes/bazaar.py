"""
Gaon Bazaar — a local classifieds + work board, separate from the normal
cart/checkout shop.  Four kinds of posts live in ONE collection (bazaar_posts):

  sell    Pashu, fasal, beej/khad, chara/bhusa, purana saman, mahila utpad
          (SHG / hastshilp / achaar-papad), vahan, khet bataai/theka
  rent    Tractor, JCB, tempo, thresher, pump/machine, bhaada-sharing
  job     Kaam ki requirement ("kal 5 majdoor chahiye") — can be emergency
  worker  Majdoor / karigar / toli profile ("main kaam dhoondh raha hoon")

Trust & safety built in (all enforced HERE, not just in the page):
  * Phone numbers are private. A poster chooses "direct" (signed-in people can
    tap Call/WhatsApp) or "masked" (people send a request; the number is shown
    only after the poster ACCEPTS). A poster may give a family member's number
    and a label (Pati / Bhai / Pita ...).
  * Signed-in, non-anonymous users only for anything that writes.
  * Job / worker posts need an "18 saal se bade hain" confirmation, and "fees
    jama karo"-style scam wording is rejected.
  * Animals need a "kheti/doodh/paalan ke liye, katai ke liye nahi"
    declaration and at least one photo; slaughter wording is rejected.
  * "Bik gaya / Kaam mil gaya" toggle, 30-day auto expiry (15 for jobs),
    Report button (3 different people -> hidden until an admin looks),
    2-way star ratings after an accepted request, admin-granted "Local
    Verified" badge (Sarpanch / CSC centre / known shop).

  Public
    GET  /api/bazaar/posts?kind=&category=&state=&district=&q=&womenOnly=1
    GET  /api/bazaar/posts/<id>
  Signed-in
    POST   /api/bazaar/posts
    PATCH  /api/bazaar/posts/<id>              (status / renew / edit)
    DELETE /api/bazaar/posts/<id>
    GET    /api/bazaar/posts/<id>/contact      (only for "direct" posts)
    POST   /api/bazaar/posts/<id>/lead         (send a request)
    POST   /api/bazaar/posts/<id>/report
    GET    /api/bazaar/my/posts
    GET    /api/bazaar/my/leads
    GET    /api/bazaar/posts/<id>/leads        (owner)
    POST   /api/bazaar/posts/<id>/leads/<uid>/decide
    POST   /api/bazaar/ratings
  Admin
    GET  /api/bazaar/admin/queue
    POST /api/bazaar/admin/posts/<id>/status
    POST /api/bazaar/admin/users/<uid>/verify

Place is chosen by PIN code (see routes/geo.py): the server fills state /
district / block from the PIN itself, so spelling is never typed by hand, and
each post keeps an approximate lat/lng (rounded to ~1 km — exact home
coordinates are never stored or shown) so lists can be filtered "within
5/10/25 km" and show "Purab mein 3 km door".

Collections (backend-only, Firestore rules deny the browser):
  bazaar_posts/{id}, bazaar_leads/{postId_requesterUid},
  bazaar_ratings/{leadId_raterUid}, bazaar_profiles/{uid}
"""

import logging
import math
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse

from firebase_admin import firestore
from flask import Blueprint, jsonify, request, g

from utils.auth import require_auth, require_admin
from utils.firebase_admin_init import db
from utils.limiter import limiter
from routes.geo import lookup_pincode, valid_pin

logger = logging.getLogger(__name__)

bazaar_bp = Blueprint("bazaar", __name__, url_prefix="/api/bazaar")

KINDS = ("sell", "rent", "job", "worker")
CATEGORIES = {
    "sell": {
        "pashu": "Pashu (janwar)", "fasal": "Fasal / anaaj", "beej-khad": "Beej / khad / dawai",
        "chara": "Chara / bhusa / gobar khad", "saman": "Purana gharelu saman",
        "mahila-utpad": "Mahila utpad (achaar, papad, ghee...)", "hastshilp": "Hath-karga / hastshilp",
        "vahan": "Vahan (tractor, bike, gaadi)", "khet-theka": "Khet bataai / theka",
    },
    "rent": {
        "tractor": "Tractor + auzaar", "jcb": "JCB / machine", "tempo": "Loading tempo / pickup",
        "thresher": "Thresher / harvester", "pump-machine": "Pump / chhoti machine",
        "bhaada-sharing": "Bhaada sharing (space bacha hai)", "anya": "Anya",
    },
    "job": {
        "khet-kaam": "Khet ka kaam", "nirman": "Nirman / chhat / mistri", "driver": "Driver",
        "ghar-kaam": "Ghar / pashu seva", "silai-ghar": "Ghar baithe kaam (silai etc.)", "anya": "Anya",
    },
    "worker": {
        "khet-majdoor": "Khet majdoor", "mistri": "Mistri / rajmistri", "plumber": "Plumber",
        "electrician": "Electrician", "driver": "Driver / tractor driver", "karigar": "Karigar",
        "silai-kadhai": "Silai-kadhai", "toli": "Majdoor toli", "anya": "Anya",
    },
}
ANIMALS = ("gaay", "bhains", "bakri", "bail", "bhed", "murgi", "ghoda", "anya")
PRICE_UNITS = ("total", "per_din", "per_ghanta", "per_kilo", "per_quintal", "per_acre", "per_nag")

# key -> (type, *limits)
FIELD_SPEC = {
    "animalType": ("choice", ANIMALS), "breed": ("str", 40), "ageYears": ("num", 0, 60),
    "milkPerDay": ("num", 0, 80), "lactation": ("int", 0, 20), "healthNote": ("str", 140),
    "agriDeclared": ("bool",),
    "quantity": ("num", 0, 10_000_000), "quantityUnit": ("str", 12),
    "condition": ("choice", ("naya", "purana", "theek")),
    "vehicleType": ("str", 30), "modelName": ("str", 40), "year": ("int", 1950, 2100),
    "kmDriven": ("int", 0, 2_000_000), "docsOk": ("bool",),
    "groupName": ("str", 60),
    "withOperator": ("bool",), "machine": ("str", 40),
    "startDate": ("date",), "workersNeeded": ("int", 1, 500), "durationDays": ("int", 1, 365),
    "womenOnly": ("bool",), "emergency": ("bool",),
    "toli": ("bool",), "groupSize": ("int", 1, 200), "experienceYears": ("int", 0, 60),
    "skills": ("str", 100), "availability": ("str", 60),
}

MAX_PHOTOS = 4
MAX_ACTIVE_POSTS = 15
EXPIRY_DAYS = {"sell": 30, "rent": 30, "worker": 30, "job": 15}
REPORTS_TO_HIDE = 3
LIST_FETCH_CAP = 400
LIST_RETURN_CAP = 60
MAX_AMOUNT_PAISE = 1_000_000_000 * 100       # Rs 100 crore — vehicles/land are big

SLAUGHTER_WORDS = ("kasai", "qasai", "slaughter", "butcher", "beef", "katne ke liye", "kasaikhana",
                   "bucharkhana", "कसाई", "बूचड़", "कत्ल")
SCAM_WORDS = ("registration fee", "joining fee", "processing fee", "security deposit",
              "fees jama", "fee jama", "paise bhejiye pehle", "pehle paise bhejo")


# ----------------------------------------------------------------- helpers

def _now():
    return datetime.now(timezone.utc)


def _clean(value, limit):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _norm(value):
    return _clean(value, 60).lower()


def _iso(ts):
    try:
        return ts.isoformat()
    except AttributeError:
        return None


def _paise(value, field="Keemat"):
    try:
        d = Decimal(str(value if value not in (None, "") else 0).strip())
    except (InvalidOperation, AttributeError):
        raise ValueError(f"{field} sahi nahi hai.")
    if not d.is_finite() or d < 0:
        raise ValueError(f"{field} sahi nahi hai.")
    p = int((d * 100).quantize(Decimal("1")))
    if p > MAX_AMOUNT_PAISE:
        raise ValueError(f"{field} bahut zyada hai.")
    return p


def _phone(value, label="Phone number"):
    p = re.sub(r"\D", "", str(value or ""))
    if p.startswith("91") and len(p) == 12:
        p = p[2:]
    if not re.fullmatch(r"[6-9]\d{9}", p):
        raise ValueError(f"{label} 10 ank ka sahi number likhiye.")
    return p


def _is_anonymous():
    return (g.user.get("firebase") or {}).get("sign_in_provider") == "anonymous"


def require_member(fn):
    """Signed-in, non-anonymous user."""
    from functools import wraps

    @wraps(fn)
    @require_auth
    def wrapper(*args, **kwargs):
        if _is_anonymous():
            return jsonify({"error": "Pehle apne mobile/email se login kijiye."}), 403
        return fn(*args, **kwargs)
    return wrapper


def _try_uid():
    """Uid of the caller if a valid token was sent, else None (for public endpoints)."""
    try:
        from firebase_admin import auth as firebase_auth
        from utils.auth import _extract_id_token
        token = _extract_id_token()
        return firebase_auth.verify_id_token(token)["uid"] if token else None
    except Exception:
        return None


DIRECTIONS = ("Uttar", "Uttar-Purab", "Purab", "Dakshin-Purab", "Dakshin", "Dakshin-Paschim", "Paschim", "Uttar-Paschim")


def _coord(lat, lng):
    """(lat, lng) rounded to ~1 km if they are valid and inside India's bounding box, else (None, None)."""
    try:
        la, lo = float(lat), float(lng)
    except (TypeError, ValueError):
        return None, None
    if not (6.0 <= la <= 38.0 and 68.0 <= lo <= 98.0):
        return None, None
    return round(la, 2), round(lo, 2)


def _distance_and_direction(a_lat, a_lng, b_lat, b_lng):
    """Km from A (viewer) to B (post) and the compass direction of B as seen from A."""
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    km = 2 * 6371.0 * math.asin(math.sqrt(h))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    return round(km, 1), DIRECTIONS[int((bearing + 22.5) // 45) % 8]


def _profile(uid, cache):
    if uid in cache:
        return cache[uid]
    snap = db.collection("bazaar_profiles").document(uid).get()
    p = snap.to_dict() if snap.exists else {}
    count = p.get("ratingCount", 0)
    cache[uid] = {
        "rating": round(p.get("ratingSum", 0) / count, 1) if count else None,
        "ratingCount": count,
        "verified": bool(p.get("localVerified")),
    }
    return cache[uid]


def _notify(uid, title, body, link):
    if not uid:
        return
    try:
        db.collection("users").document(uid).collection("notifications").document().set({
            "title": title, "body": body, "type": "bazaar", "link": link,
            "read": False, "createdAt": _now(),
        })
    except Exception:
        logger.exception("Bazaar: could not notify %s", uid)


def _validate_fields(raw):
    out = {}
    for key, spec in FIELD_SPEC.items():
        if key not in (raw or {}) or raw[key] in (None, ""):
            continue
        v, kind = raw[key], spec[0]
        try:
            if kind == "str":
                out[key] = _clean(v, spec[1])
            elif kind == "choice":
                v = str(v).lower()
                if v not in spec[1]:
                    raise ValueError
                out[key] = v
            elif kind == "bool":
                out[key] = bool(v) if isinstance(v, bool) else str(v).lower() in ("true", "1", "yes")
            elif kind == "int":
                n = int(Decimal(str(v)))
                if not spec[1] <= n <= spec[2]:
                    raise ValueError
                out[key] = n
            elif kind == "num":
                n = float(Decimal(str(v)))
                if not spec[1] <= n <= spec[2]:
                    raise ValueError
                out[key] = n
            elif kind == "date":
                out[key] = datetime.strptime(str(v), "%Y-%m-%d").date().isoformat()
        except (ValueError, InvalidOperation):
            raise ValueError(f"'{key}' sahi nahi hai.")
    return out


def _validate_photos(raw):
    photos = []
    for u in (raw or [])[:MAX_PHOTOS]:
        u = str(u or "").strip()
        host = (urlparse(u).hostname or "")
        if u and urlparse(u).scheme == "https" and (host == "ibb.co" or host.endswith(".ibb.co")) and len(u) < 400:
            photos.append(u)
    return photos


def _post_public(pid, p, cache, viewer_uid=None):
    prof = _profile(p.get("ownerUid"), cache)
    return {
        "id": pid, "kind": p.get("kind"), "category": p.get("category"),
        "title": p.get("title"), "description": p.get("description"),
        "price": p.get("price", 0), "priceUnit": p.get("priceUnit", "total"),
        "state": p.get("state"), "district": p.get("district"), "block": p.get("block"),
        "village": p.get("village"), "postOffice": p.get("postOffice"),
        "pincode": p.get("pincode"), "landmark": p.get("landmark"),
        "photos": p.get("photos") or [], "fields": p.get("fields") or {},
        "status": p.get("status"), "ownerName": p.get("ownerName"),
        "contactMode": p.get("contactMode"), "contactLabel": p.get("contactLabel"),
        "ownerRating": prof["rating"], "ownerRatingCount": prof["ratingCount"],
        "ownerVerified": prof["verified"],
        "isOwner": bool(viewer_uid and viewer_uid == p.get("ownerUid")),
        "leadCount": p.get("leadCount", 0),
        "createdAt": _iso(p.get("createdAt")), "expiresAt": _iso(p.get("expiresAt")),
    }


def _live(p, now):
    return p.get("status") == "active" and (not p.get("expiresAt") or p["expiresAt"] > now)


def _own_post(post_id):
    ref = db.collection("bazaar_posts").document(post_id)
    snap = ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("ownerUid") != g.uid:
        return None, None
    return ref, snap.to_dict()


# -------------------------------------------------------------- public read

@bazaar_bp.route("/meta", methods=["GET"])
def meta():
    return jsonify({"categories": CATEGORIES, "animals": ANIMALS, "priceUnits": PRICE_UNITS})


@bazaar_bp.route("/posts", methods=["GET"])
@limiter.limit("120 per minute")
def list_posts():
    kind = request.args.get("kind", "")
    if kind not in KINDS:
        return jsonify({"error": "kind sahi nahi hai."}), 400
    category = request.args.get("category", "")
    state = _norm(request.args.get("state"))
    district = _norm(request.args.get("district"))
    q = _norm(request.args.get("q"))
    women_only = request.args.get("womenOnly") in ("1", "true")
    v_lat, v_lng = _coord(request.args.get("lat"), request.args.get("lng"))
    v_pin = re.sub(r"\D", "", request.args.get("pincode") or "")
    try:
        radius = min(float(request.args.get("radiusKm") or 0), 300)
    except ValueError:
        radius = 0
    near_mode = v_lat is not None and radius > 0          # "within N km of me"

    query = db.collection("bazaar_posts").where("kind", "==", kind)
    if district and not near_mode:
        query = query.where("districtKey", "==", district)
    now = _now()
    rows = []
    for d in query.limit(LIST_FETCH_CAP).stream():
        p = d.to_dict() or {}
        if not _live(p, now):
            continue
        if category and p.get("category") != category:
            continue
        if state and not near_mode and p.get("stateKey") != state:
            continue
        dist = direction = None
        if v_lat is not None and p.get("lat") is not None:
            dist, direction = _distance_and_direction(v_lat, v_lng, p["lat"], p["lng"])
        if near_mode:
            same_pin = bool(v_pin) and p.get("pincode") == v_pin
            if not ((dist is not None and dist <= radius) or (dist is None and same_pin)):
                continue
            if same_pin and dist is None:
                dist, direction = 0.0, None
        if women_only and not (p.get("fields") or {}).get("womenOnly"):
            continue
        if q and q not in " ".join([p.get("title", ""), p.get("description", ""),
                                    p.get("village", ""), p.get("district", "")]).lower():
            continue
        rows.append((d.id, p, dist, direction))
    rows.sort(key=lambda r: ((r[1].get("fields") or {}).get("emergency") is not True,
                             r[2] if (v_lat is not None and r[2] is not None) else 10 ** 6,
                             -(r[1].get("createdAt") or now).timestamp()))
    cache = {}
    posts = []
    for i, p, dist, direction in rows[:LIST_RETURN_CAP]:
        out = _post_public(i, p, cache)
        out["distanceKm"], out["direction"] = dist, direction
        posts.append(out)
    avg = None
    if kind in ("job", "worker"):
        wages = [p["price"] for p in posts if p["priceUnit"] == "per_din" and p["price"] > 0]
        avg = round(sum(wages) / len(wages)) if wages else None
    return jsonify({"posts": posts, "total": len(rows), "avgDailyWage": avg})


@bazaar_bp.route("/posts/<post_id>", methods=["GET"])
@limiter.limit("120 per minute")
def get_post(post_id):
    snap = db.collection("bazaar_posts").document(post_id).get()
    if not snap.exists:
        return jsonify({"error": "Ye post nahi mila."}), 404
    p = snap.to_dict() or {}
    uid = _try_uid()
    if p.get("status") == "hidden" and uid != p.get("ownerUid"):
        return jsonify({"error": "Ye post nahi mila."}), 404
    out = _post_public(snap.id, p, {}, uid)
    v_lat, v_lng = _coord(request.args.get("lat"), request.args.get("lng"))
    out["distanceKm"] = out["direction"] = None
    if v_lat is not None and p.get("lat") is not None:
        out["distanceKm"], out["direction"] = _distance_and_direction(v_lat, v_lng, p["lat"], p["lng"])
    if p.get("expiresAt") and p["expiresAt"] <= _now() and p.get("status") == "active":
        out["status"] = "expired"
    return jsonify({"post": out})


# ------------------------------------------------------------ create / edit

@bazaar_bp.route("/posts", methods=["POST"])
@limiter.limit("10 per hour")
@require_member
def create_post():
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    category = data.get("category")
    if kind not in KINDS or category not in CATEGORIES.get(kind, {}):
        return jsonify({"error": "Post ka prakaar ya category sahi nahi hai."}), 400
    try:
        title = _clean(data.get("title"), 80)
        if len(title) < 3:
            return jsonify({"error": "Title likhiye (kam se kam 3 akshar)."}), 400
        description = _clean(data.get("description"), 600)
        pin = re.sub(r"\D", "", str(data.get("pincode") or ""))
        geo = lookup_pincode(pin) if valid_pin(pin) else None
        if data.get("pincode") and not valid_pin(pin):
            return jsonify({"error": "6 ank ka sahi PIN code likhiye."}), 400
        if geo:        # trust the PIN lookup over whatever the phone sent
            state, district, block = geo["state"], geo["district"], geo.get("block") or ""
        else:          # PIN lookup unavailable / old clients: fall back to typed names
            state, district, block = _clean(data.get("state"), 40), _clean(data.get("district"), 60), _clean(data.get("block"), 60)
        if not district:
            return jsonify({"error": "Apna PIN code likhiye taaki zila apne aap bhar jaye."}), 400
        lat, lng = _coord(data.get("lat"), data.get("lng"))          # phone GPS (rounded to ~1 km)
        if lat is None and geo and geo.get("lat") is not None:
            lat, lng = _coord(geo["lat"], geo["lng"])
        unit = data.get("priceUnit") or "total"
        if unit not in PRICE_UNITS:
            return jsonify({"error": "Keemat ka naap sahi nahi hai."}), 400
        price = _paise(data.get("price"))
        fields = _validate_fields(data.get("fields"))
        photos = _validate_photos(data.get("photos"))
        contact_phone = _phone(data.get("contactPhone"), "Sampark ka number")
        owner_name = _clean(data.get("ownerName"), 40)
        if not owner_name:
            return jsonify({"error": "Apna naam likhiye."}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    text = f"{title} {description}".lower()
    if kind in ("job", "worker", "rent") and any(w in text for w in SCAM_WORDS):
        return jsonify({"error": "Kaam ke naam par 'fees jama' jaisi baat allowed nahi hai."}), 400
    if kind in ("job", "worker"):
        if data.get("adult") is not True:
            return jsonify({"error": "Kaam wale posts ke liye '18 saal se bade hain' par tick kijiye."}), 400
        if kind == "job" and (price <= 0 or unit not in ("per_din", "total")):
            return jsonify({"error": "Kaam ki mazdoori (rupaye prati din ya kul) likhiye."}), 400
        if kind == "job" and not fields.get("workersNeeded"):
            return jsonify({"error": "Kitne log chahiye, ye likhiye."}), 400
        if kind == "job" and fields.get("emergency") and not fields.get("startDate"):
            fields["startDate"] = (_now() + timedelta(hours=5, minutes=30)).date().isoformat()
    if kind == "rent" and (price <= 0 or unit not in ("per_ghanta", "per_din", "per_acre", "total")):
        return jsonify({"error": "Kiraye ki dar likhiye (prati ghanta / din / acre)."}), 400
    if kind == "sell" and category == "pashu":
        if fields.get("animalType") not in ANIMALS:
            return jsonify({"error": "Janwar ka prakaar chuniye."}), 400
        if not fields.get("agriDeclared"):
            return jsonify({"error": "Ye janwar sirf kheti / doodh / paalan ke liye hai — is par tick kijiye."}), 400
        if not photos:
            return jsonify({"error": "Janwar ki kam se kam ek photo zaroori hai."}), 400
        if any(w in text for w in SLAUGHTER_WORDS):
            return jsonify({"error": "Katai/kasai ke liye janwar ki bikri yahan allowed nahi hai."}), 400
    if kind == "sell" and category == "vahan" and not photos:
        return jsonify({"error": "Vahan ki kam se kam ek photo zaroori hai."}), 400

    active = [1 for d in db.collection("bazaar_posts").where("ownerUid", "==", g.uid).stream()
              if _live(d.to_dict() or {}, _now())]
    if len(active) >= MAX_ACTIVE_POSTS:
        return jsonify({"error": f"Ek saath max {MAX_ACTIVE_POSTS} chalu post ho sakte hain. Purane band kijiye."}), 409

    mode = data.get("contactMode") if data.get("contactMode") in ("direct", "masked") else "masked"
    ref = db.collection("bazaar_posts").document()
    now = _now()
    ref.set({
        "kind": kind, "category": category, "title": title, "description": description,
        "price": price, "priceUnit": unit, "fields": fields, "photos": photos,
        "state": state, "stateKey": _norm(state), "block": block,
        "district": district, "districtKey": _norm(district), "village": _clean(data.get("village"), 60),
        "pincode": pin if valid_pin(pin) else None, "landmark": _clean(data.get("landmark"), 80) or None,
        "postOffice": _clean(data.get("postOffice"), 60) or None,
        "lat": lat, "lng": lng,
        "ownerUid": g.uid, "ownerName": owner_name.split(" ")[0],
        "contactPhone": contact_phone, "contactLabel": _clean(data.get("contactLabel"), 20) or "Khud",
        "contactMode": mode, "status": "active", "reports": 0, "reporterUids": [], "leadCount": 0,
        "createdAt": now, "expiresAt": now + timedelta(days=EXPIRY_DAYS[kind]),
    })

    if kind == "job" and fields.get("emergency"):
        _alert_workers(ref.id, title, district, g.uid)
    return jsonify({"success": True, "id": ref.id})


def _alert_workers(post_id, title, district, skip_uid):
    seen = set()
    try:
        now = _now()
        for d in (db.collection("bazaar_posts").where("kind", "==", "worker")
                  .where("districtKey", "==", _norm(district)).limit(200).stream()):
            p = d.to_dict() or {}
            uid = p.get("ownerUid")
            if uid and uid != skip_uid and uid not in seen and _live(p, now):
                seen.add(uid)
                _notify(uid, "🚨 Emergency kaam", f"{district}: {title}", f"bazaar.html?post={post_id}")
                if len(seen) >= 40:
                    break
    except Exception:
        logger.exception("Bazaar: emergency alert failed")


@bazaar_bp.route("/posts/<post_id>", methods=["PATCH"])
@limiter.limit("60 per hour")
@require_member
def edit_post(post_id):
    ref, p = _own_post(post_id)
    if not ref:
        return jsonify({"error": "Post nahi mila."}), 404
    if p.get("status") == "hidden":
        return jsonify({"error": "Ye post report ki wajah se band hai. Admin ke dekhne tak badla nahi ja sakta."}), 409
    data = request.get_json(silent=True) or {}
    up = {}
    try:
        if "status" in data:
            if data["status"] not in ("active", "done"):
                return jsonify({"error": "Sthiti sahi nahi hai."}), 400
            up["status"] = data["status"]
            if data["status"] == "active":
                up["expiresAt"] = _now() + timedelta(days=EXPIRY_DAYS[p["kind"]])
        if data.get("renew") is True:
            up["status"] = "active"
            up["expiresAt"] = _now() + timedelta(days=EXPIRY_DAYS[p["kind"]])
        if "title" in data:
            t = _clean(data["title"], 80)
            if len(t) < 3:
                return jsonify({"error": "Title likhiye."}), 400
            up["title"] = t
        if "description" in data:
            up["description"] = _clean(data["description"], 600)
        if "price" in data:
            up["price"] = _paise(data["price"])
        if "contactPhone" in data:
            up["contactPhone"] = _phone(data["contactPhone"], "Sampark ka number")
        if "contactLabel" in data:
            up["contactLabel"] = _clean(data["contactLabel"], 20) or "Khud"
        if data.get("contactMode") in ("direct", "masked"):
            up["contactMode"] = data["contactMode"]
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if up:
        ref.update(up)
    return jsonify({"success": True})


@bazaar_bp.route("/posts/<post_id>", methods=["DELETE"])
@limiter.limit("60 per hour")
@require_member
def delete_post(post_id):
    ref, _ = _own_post(post_id)
    if not ref:
        return jsonify({"error": "Post nahi mila."}), 404
    ref.update({"status": "done", "expiresAt": _now() - timedelta(seconds=1), "deleted": True})
    return jsonify({"success": True})


# --------------------------------------------------------- contact & leads

@bazaar_bp.route("/posts/<post_id>/contact", methods=["GET"])
@limiter.limit("30 per hour")
@require_member
def get_contact(post_id):
    snap = db.collection("bazaar_posts").document(post_id).get()
    p = snap.to_dict() if snap.exists else None
    if not p or not _live(p, _now()):
        return jsonify({"error": "Ye post ab chalu nahi hai."}), 404
    if p.get("contactMode") != "direct":
        return jsonify({"error": "Poster ne number chhupa rakha hai — 'Sampark bhejiye' dabaiye."}), 403
    return jsonify({"phone": p["contactPhone"], "label": p.get("contactLabel")})


@bazaar_bp.route("/posts/<post_id>/lead", methods=["POST"])
@limiter.limit("20 per hour")
@require_member
def send_lead(post_id):
    snap = db.collection("bazaar_posts").document(post_id).get()
    p = snap.to_dict() if snap.exists else None
    if not p or not _live(p, _now()):
        return jsonify({"error": "Ye post ab chalu nahi hai."}), 404
    if p.get("ownerUid") == g.uid:
        return jsonify({"error": "Apne hi post par sampark nahi bhej sakte."}), 400
    data = request.get_json(silent=True) or {}
    try:
        name = _clean(data.get("name"), 40)
        if not name:
            return jsonify({"error": "Apna naam likhiye."}), 400
        phone = _phone(data.get("phone"), "Aapka number")
        lead = {"postId": post_id, "postTitle": p.get("title"), "postKind": p.get("kind"),
                "ownerUid": p["ownerUid"], "requesterUid": g.uid,
                "name": name, "phone": phone, "message": _clean(data.get("message"), 200),
                "status": "pending", "createdAt": _now()}
        d = data.get("dates") or {}
        if d.get("from"):
            lead["dates"] = {"from": datetime.strptime(str(d["from"]), "%Y-%m-%d").date().isoformat(),
                             "to": datetime.strptime(str(d.get("to") or d["from"]), "%Y-%m-%d").date().isoformat()}
    except ValueError as e:
        return jsonify({"error": str(e) if "number" in str(e) else "Tareekh sahi nahi hai."}), 400

    lead_ref = db.collection("bazaar_leads").document(f"{post_id}_{g.uid}")
    post_ref = snap.reference

    @firestore.transactional
    def _txn(txn):
        if lead_ref.get(transaction=txn).exists:
            return False
        cur = post_ref.get(transaction=txn).to_dict() or {}
        txn.set(lead_ref, lead)
        txn.update(post_ref, {"leadCount": cur.get("leadCount", 0) + 1})
        return True

    if not _txn(db.transaction()):
        return jsonify({"error": "Aap is post par pehle hi sampark bhej chuke hain."}), 409
    _notify(p["ownerUid"], "📩 Naya sampark", f"{name}: {p.get('title')}", "bazaar.html#mera")
    return jsonify({"success": True})


@bazaar_bp.route("/posts/<post_id>/leads", methods=["GET"])
@limiter.limit("60 per minute")
@require_member
def post_leads(post_id):
    ref, _ = _own_post(post_id)
    if not ref:
        return jsonify({"error": "Post nahi mila."}), 404
    cache, out = {}, []
    for d in db.collection("bazaar_leads").where("postId", "==", post_id).stream():
        l = d.to_dict() or {}
        prof = _profile(l["requesterUid"], cache)
        out.append({"requesterUid": l["requesterUid"], "leadId": d.id, "name": l.get("name"),
                    "phone": l.get("phone"), "message": l.get("message"), "dates": l.get("dates"),
                    "status": l.get("status"), "createdAt": _iso(l.get("createdAt")),
                    "rating": prof["rating"], "verified": prof["verified"],
                    "iRated": db.collection("bazaar_ratings").document(f"{d.id}_{g.uid}").get().exists})
    out.sort(key=lambda r: r["createdAt"] or "", reverse=True)
    return jsonify({"leads": out})


@bazaar_bp.route("/posts/<post_id>/leads/<requester_uid>/decide", methods=["POST"])
@limiter.limit("60 per hour")
@require_member
def decide_lead(post_id, requester_uid):
    ref, p = _own_post(post_id)
    if not ref:
        return jsonify({"error": "Post nahi mila."}), 404
    action = (request.get_json(silent=True) or {}).get("action")
    if action not in ("accept", "decline"):
        return jsonify({"error": "Manzoor ya mana kijiye."}), 400
    lead_ref = db.collection("bazaar_leads").document(f"{post_id}_{requester_uid}")
    snap = lead_ref.get()
    if not snap.exists:
        return jsonify({"error": "Request nahi mili."}), 404
    lead_ref.update({"status": "accepted" if action == "accept" else "declined", "decidedAt": _now()})
    if action == "accept":
        _notify(requester_uid, "✅ Aapki request manzoor hui",
                f"{p.get('title')}: ab aap poster ka number dekh sakte hain.", "bazaar.html#mera")
    return jsonify({"success": True})


@bazaar_bp.route("/my/posts", methods=["GET"])
@limiter.limit("60 per minute")
@require_member
def my_posts():
    cache, now = {}, _now()
    rows = []
    for d in db.collection("bazaar_posts").where("ownerUid", "==", g.uid).stream():
        p = d.to_dict() or {}
        if p.get("deleted"):
            continue
        out = _post_public(d.id, p, cache, g.uid)
        if p.get("status") == "active" and p.get("expiresAt") and p["expiresAt"] <= now:
            out["status"] = "expired"
        out["contactPhone"] = p.get("contactPhone")
        out["reports"] = p.get("reports", 0)
        rows.append(out)
    rows.sort(key=lambda r: r["createdAt"] or "", reverse=True)
    return jsonify({"posts": rows})


@bazaar_bp.route("/my/leads", methods=["GET"])
@limiter.limit("60 per minute")
@require_member
def my_leads():
    out = []
    for d in db.collection("bazaar_leads").where("requesterUid", "==", g.uid).stream():
        l = d.to_dict() or {}
        item = {"leadId": d.id, "postId": l.get("postId"), "title": l.get("postTitle"),
                "kind": l.get("postKind"), "status": l.get("status"), "message": l.get("message"),
                "createdAt": _iso(l.get("createdAt")),
                "iRated": db.collection("bazaar_ratings").document(f"{d.id}_{g.uid}").get().exists}
        if l.get("status") == "accepted":
            post = db.collection("bazaar_posts").document(l["postId"]).get().to_dict() or {}
            item["ownerPhone"] = post.get("contactPhone")
            item["ownerLabel"] = post.get("contactLabel")
            item["ownerName"] = post.get("ownerName")
        out.append(item)
    out.sort(key=lambda r: r["createdAt"] or "", reverse=True)
    return jsonify({"leads": out})


# --------------------------------------------------------- report & rating

@bazaar_bp.route("/posts/<post_id>/report", methods=["POST"])
@limiter.limit("20 per hour")
@require_member
def report_post(post_id):
    reason = _clean((request.get_json(silent=True) or {}).get("reason"), 140)
    if not reason:
        return jsonify({"error": "Report ka karan likhiye."}), 400
    ref = db.collection("bazaar_posts").document(post_id)

    @firestore.transactional
    def _txn(txn):
        p = ref.get(transaction=txn).to_dict()
        if not p:
            return "missing", None
        if p.get("ownerUid") == g.uid:
            return "own", None
        reporters = list(p.get("reporterUids") or [])
        if g.uid in reporters:
            return "dup", None
        reporters.append(g.uid)
        up = {"reporterUids": reporters, "reports": len(reporters),
              "reportReasons": (list(p.get("reportReasons") or []) + [reason])[-5:]}
        if len(reporters) >= REPORTS_TO_HIDE and p.get("status") == "active":
            up["status"] = "hidden"
        txn.update(ref, up)
        return "ok", p.get("ownerUid")

    result, owner = _txn(db.transaction())
    if result == "missing":
        return jsonify({"error": "Post nahi mila."}), 404
    if result == "own":
        return jsonify({"error": "Apna hi post report nahi kar sakte."}), 400
    if result == "dup":
        return jsonify({"error": "Aap ise pehle hi report kar chuke hain."}), 409
    return jsonify({"success": True})


@bazaar_bp.route("/ratings", methods=["POST"])
@limiter.limit("30 per hour")
@require_member
def rate():
    data = request.get_json(silent=True) or {}
    lead_id = str(data.get("leadId") or "")
    try:
        stars = int(data.get("stars"))
    except (TypeError, ValueError):
        stars = 0
    if not 1 <= stars <= 5:
        return jsonify({"error": "1 se 5 star chuniye."}), 400
    lead = db.collection("bazaar_leads").document(lead_id).get().to_dict()
    if not lead or lead.get("status") != "accepted":
        return jsonify({"error": "Rating sirf manzoor hui request par di ja sakti hai."}), 400
    if g.uid == lead["requesterUid"]:
        ratee = lead["ownerUid"]
    elif g.uid == lead["ownerUid"]:
        ratee = lead["requesterUid"]
    else:
        return jsonify({"error": "Ye request aapki nahi hai."}), 403
    rating_ref = db.collection("bazaar_ratings").document(f"{lead_id}_{g.uid}")
    prof_ref = db.collection("bazaar_profiles").document(ratee)
    comment = _clean(data.get("comment"), 140)

    @firestore.transactional
    def _txn(txn):
        if rating_ref.get(transaction=txn).exists:
            return False
        prof = prof_ref.get(transaction=txn)
        cur = prof.to_dict() if prof.exists else {}
        txn.set(rating_ref, {"leadId": lead_id, "raterUid": g.uid, "rateeUid": ratee,
                             "stars": stars, "comment": comment or None, "createdAt": _now()})
        new = {"ratingSum": cur.get("ratingSum", 0) + stars, "ratingCount": cur.get("ratingCount", 0) + 1}
        if prof.exists:
            txn.update(prof_ref, new)
        else:
            txn.set(prof_ref, new)
        return True

    if not _txn(db.transaction()):
        return jsonify({"error": "Aap pehle hi rating de chuke hain."}), 409
    return jsonify({"success": True})


# ------------------------------------------------------------------- admin

@bazaar_bp.route("/admin/queue", methods=["GET"])
@limiter.limit("60 per minute")
@require_admin
def admin_queue():
    rows = []
    for d in db.collection("bazaar_posts").where("reports", ">", 0).stream():
        p = d.to_dict() or {}
        rows.append({"id": d.id, "title": p.get("title"), "kind": p.get("kind"), "status": p.get("status"),
                     "reports": p.get("reports", 0), "reasons": p.get("reportReasons") or [],
                     "ownerUid": p.get("ownerUid"), "ownerName": p.get("ownerName"),
                     "district": p.get("district")})
    rows.sort(key=lambda r: -r["reports"])
    return jsonify({"posts": rows})


@bazaar_bp.route("/admin/posts/<post_id>/status", methods=["POST"])
@limiter.limit("60 per minute")
@require_admin
def admin_status(post_id):
    data = request.get_json(silent=True) or {}
    if data.get("status") not in ("active", "hidden", "done"):
        return jsonify({"error": "Sthiti sahi nahi hai."}), 400
    ref = db.collection("bazaar_posts").document(post_id)
    if not ref.get().exists:
        return jsonify({"error": "Post nahi mila."}), 404
    up = {"status": data["status"]}
    if data.get("resetReports"):
        up.update({"reports": 0, "reporterUids": [], "reportReasons": []})
    ref.update(up)
    return jsonify({"success": True})


@bazaar_bp.route("/admin/users/<uid>/verify", methods=["POST"])
@limiter.limit("60 per minute")
@require_admin
def admin_verify(uid):
    flag = bool((request.get_json(silent=True) or {}).get("verified"))
    ref = db.collection("bazaar_profiles").document(uid)
    if ref.get().exists:
        ref.update({"localVerified": flag})
    else:
        ref.set({"localVerified": flag, "ratingSum": 0, "ratingCount": 0})
    return jsonify({"success": True})
