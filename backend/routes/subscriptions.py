"""
Roz ka order (subscriptions): a buyer says "send me 1 litre doodh every
morning" ONCE, and the server places a normal Cash-on-Delivery / UPI-on-
delivery order for them on schedule (see utils/subscription_runner.py).

  POST /api/subscriptions                  create (starts tomorrow morning)
  GET  /api/subscriptions                  my subscriptions
  POST /api/subscriptions/<id>/pause       pause
  POST /api/subscriptions/<id>/resume      resume
  POST /api/subscriptions/<id>/cancel      stop for good

Only cash-on-delivery or pay-on-delivery are allowed — nothing is ever
charged automatically. Every order it creates goes through exactly the same
checks (real price, stock, seller) as a normal checkout order.
"""

import logging
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, g

from routes.payments import DELIVERY_SLOTS, OrderError, _build_verified_items
from utils.auth import require_auth
from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

subscriptions_bp = Blueprint("subscriptions", __name__, url_prefix="/api/subscriptions")

FREQUENCY_DAYS = {"daily": 1, "alternate": 2, "weekly": 7}
MAX_ACTIVE_PER_BUYER = 10
MAX_QUANTITY = 10
RUN_HOUR_IST = 6  # orders are placed around 6 AM, so they reach the seller early


def ist_now():
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)


def _public(doc_id, s):
    return {
        "id": doc_id,
        "productId": s.get("productId"),
        "productName": s.get("productName"),
        "shopName": s.get("shopName"),
        "quantity": s.get("quantity"),
        "frequency": s.get("frequency"),
        "status": s.get("status"),
        "nextRunDate": s.get("nextRunDate"),
        "ordersPlaced": s.get("ordersPlaced", 0),
        "paymentMethod": s.get("paymentMethod"),
        "slot": (s.get("delivery") or {}).get("slotLabel"),
        "lastResult": s.get("lastResult"),
    }


def _load_own(sub_id):
    ref = db.collection("subscriptions").document(sub_id)
    snap = ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("buyerUid") != g.uid:
        return None, None
    return ref, snap.to_dict()


@subscriptions_bp.route("", methods=["POST"])
@limiter.limit("10 per minute")
@require_auth
def create_subscription():
    if not g.user.get("email_verified"):
        return jsonify({"error": "Please verify your email first."}), 403

    data = request.get_json(silent=True) or {}
    product_id = str(data.get("productId") or "").strip()
    frequency = str(data.get("frequency") or "daily").strip().lower()
    payment_method = str(data.get("paymentMethod") or "COD").strip().upper()
    delivery_in = data.get("delivery") or {}
    try:
        quantity = int(data.get("quantity") or 1)
    except (TypeError, ValueError):
        quantity = 0

    if frequency not in FREQUENCY_DAYS:
        return jsonify({"error": "Choose daily, alternate days or weekly."}), 400
    if payment_method not in ("COD", "UPI"):
        return jsonify({"error": "Pay on delivery (cash or UPI) is the only option for subscriptions."}), 400
    if not (1 <= quantity <= MAX_QUANTITY):
        return jsonify({"error": f"Quantity must be between 1 and {MAX_QUANTITY}."}), 400

    name = str(delivery_in.get("name") or "").strip()
    phone = str(delivery_in.get("phone") or "").strip()
    address = str(delivery_in.get("address") or "").strip()
    city = str(delivery_in.get("city") or "").strip()
    slot_key = str(delivery_in.get("slot") or "anytime").strip().lower()
    if not name or not address:
        return jsonify({"error": "Delivery name and address are required."}), 400
    if not (phone.isdigit() and len(phone) == 10):
        return jsonify({"error": "Please provide a valid 10-digit phone number."}), 400
    if slot_key not in DELIVERY_SLOTS:
        slot_key = "anytime"

    # Validate the product exactly like a real order would (exists, in stock, valid size/colour).
    try:
        verified = _build_verified_items([{
            "productId": product_id,
            "quantity": quantity,
            "selectedSize": data.get("selectedSize"),
            "selectedColor": data.get("selectedColor"),
        }])
    except OrderError as e:
        return jsonify({"error": e.message}), e.status_code
    item = verified[0]

    active = db.collection("subscriptions").where("buyerUid", "==", g.uid).stream()
    if sum(1 for d in active if (d.to_dict() or {}).get("status") in ("active", "paused")) >= MAX_ACTIVE_PER_BUYER:
        return jsonify({"error": f"You can have at most {MAX_ACTIVE_PER_BUYER} subscriptions."}), 409

    first_run = (ist_now() + timedelta(days=1)).date().isoformat()  # starts tomorrow morning
    doc = {
        "buyerUid": g.uid,
        "productId": product_id,
        "productName": item.get("productName"),
        "shopName": item.get("shopName"),
        "sellerUid": item.get("sellerUid"),
        "quantity": quantity,
        "selectedSize": item.get("selectedSize"),
        "selectedColor": item.get("selectedColor"),
        "frequency": frequency,
        "paymentMethod": payment_method,
        "delivery": {"name": name, "phone": phone, "address": address, "city": city,
                     "slot": slot_key, "slotLabel": DELIVERY_SLOTS[slot_key]},
        "status": "active",
        "nextRunDate": first_run,
        "runHour": RUN_HOUR_IST,
        "ordersPlaced": 0,
        "createdAt": datetime.now(timezone.utc),
    }
    ref = db.collection("subscriptions").document()
    ref.set(doc)
    return jsonify({"success": True, "id": ref.id, "firstOrderDate": first_run})


@subscriptions_bp.route("", methods=["GET"])
@limiter.limit("60 per minute")
@require_auth
def list_my_subscriptions():
    rows = []
    for d in db.collection("subscriptions").where("buyerUid", "==", g.uid).stream():
        s = d.to_dict() or {}
        if s.get("status") == "cancelled":
            continue
        rows.append(_public(d.id, s))
    rows.sort(key=lambda r: (r["status"] != "active", r.get("nextRunDate") or ""))
    return jsonify({"subscriptions": rows})


@subscriptions_bp.route("/<sub_id>/<action>", methods=["POST"])
@limiter.limit("30 per minute")
@require_auth
def change_subscription(sub_id, action):
    if action not in ("pause", "resume", "cancel"):
        return jsonify({"error": "Unknown action."}), 404
    ref, s = _load_own(sub_id)
    if ref is None:
        return jsonify({"error": "Subscription not found."}), 404
    if s.get("status") == "cancelled":
        return jsonify({"error": "This subscription is already cancelled."}), 409

    if action == "pause":
        ref.update({"status": "paused"})
    elif action == "cancel":
        ref.update({"status": "cancelled", "cancelledAt": datetime.now(timezone.utc)})
    else:  # resume — never place a backlog of missed days; continue from tomorrow at the earliest
        tomorrow = (ist_now() + timedelta(days=1)).date().isoformat()
        next_run = max(s.get("nextRunDate") or tomorrow, tomorrow)
        ref.update({"status": "active", "nextRunDate": next_run})
    return jsonify({"success": True})
