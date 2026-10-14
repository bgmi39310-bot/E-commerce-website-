"""
Coupon creation. Mirrors coupon-logic.js's addCoupon(), moved server-side
for the same reason product creation was (see routes/products.py's module
docstring): the free-tier "1 active coupon at a time" limit used to be a
client-side check only, bypassable by calling the Firestore SDK directly.
Everything else about coupons (activate/deactivate/delete, listing them,
redeeming one at checkout) stays exactly as it was — owner-only via
firestore.rules — only CREATE needed to move, since that's the one place
a count needs to be re-verified.
"""

import logging
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify, g

from utils.auth import require_auth
from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

coupons_bp = Blueprint("coupons", __name__, url_prefix="/api/coupons")

# Mirrors premium-logic.js's FREE_TIER_LIMITS.maxActiveCoupons.
_MAX_ACTIVE_COUPONS_FREE = 1


def _is_premium_seller(uid):
    snap = db.collection("sellers_profiles").document(uid).get()
    return snap.exists and (snap.to_dict() or {}).get("isPremium") is True


@coupons_bp.route("", methods=["POST"])
@limiter.limit("20 per minute")
@require_auth
def create_coupon():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip().upper()
    discount_type = data.get("discountType")
    expiry_date = (data.get("expiryDate") or "").strip() or None
    usage_limit_raw = data.get("usageLimit")

    if not code:
        return jsonify({"error": "Please enter a coupon code."}), 400
    if discount_type not in ("percent", "flat"):
        return jsonify({"error": "Invalid discount type."}), 400

    try:
        value = float(data.get("value"))
        if value <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "Please enter a valid discount value."}), 400
    if discount_type == "percent" and value > 90:
        return jsonify({"error": "Percentage discount can't exceed 90%."}), 400

    if expiry_date:
        try:
            expiry_day = datetime.strptime(expiry_date, "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"error": "Invalid expiry date."}), 400
        if expiry_day < datetime.now(timezone.utc).date():
            return jsonify({"error": "Expiry date can't be in the past."}), 400

    usage_limit = None
    if usage_limit_raw not in (None, ""):
        try:
            usage_limit = int(usage_limit_raw)
            if usage_limit <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Usage limit must be at least 1."}), 400

    if not _is_premium_seller(g.uid):
        count_result = (
            db.collection("coupons")
              .where("sellerUid", "==", g.uid)
              .where("active", "==", True)
              .count()
              .get()
        )
        active_count = count_result[0][0].value
        if active_count >= _MAX_ACTIVE_COUPONS_FREE:
            return jsonify({
                "error": f"Free sellers can have {_MAX_ACTIVE_COUPONS_FREE} active coupon at a time. "
                         "Upgrade to Premium for unlimited coupons!"
            }), 403

    # A coupon code must be unique across the WHOLE site while active, not
    # just per-seller — checkout looks a code up by code alone (see
    # validateCoupon in coupon-logic.js / payments.py's _apply_coupon), so
    # two different sellers both having an active "SAVE20" would make
    # checkout pick one of them arbitrarily.
    dup = list(
        db.collection("coupons")
          .where("code", "==", code)
          .where("active", "==", True)
          .limit(1)
          .stream()
    )
    if dup:
        return jsonify({"error": f'Coupon code "{code}" is already in use. Please choose a different code.'}), 409

    now = datetime.now(timezone.utc)
    doc_ref = db.collection("coupons").document()
    doc_ref.set({
        "code": code,
        "sellerUid": g.uid,
        "discountType": discount_type,
        "value": value,
        "expiryDate": expiry_date,          # 'YYYY-MM-DD' string or null = never expires
        "usageLimit": usage_limit,          # null = unlimited
        "usedCount": 0,
        "active": True,
        "createdAt": now,
    })

    return jsonify({"success": True, "couponId": doc_ref.id, "code": code})
