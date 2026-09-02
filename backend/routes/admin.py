"""
Admin-only endpoints. Every route here requires @require_admin, which
checks the caller's Firebase ID token AND that users/{uid}.isAdmin == true
in Firestore — the exact same trust rule the Firestore security rules
already use, so behaviour stays consistent whether an action happens from
the client (admin-panel.html, still works via Firestore rules) or here.

The reason these exist here too, not just client-side: this is the place to
add things a client should never be trusted to do correctly on its own —
audit logging, multi-step operations that must all succeed together,
or (in future) side effects like sending an email/SMS on a decision.
"""

from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, g

from utils.auth import require_admin
from utils.firebase_admin_init import db, auth as firebase_auth

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


def _log_admin_action(action, target, extra=None):
    db.collection("adminActionLog").add({
        "action": action,
        "target": target,
        "performedBy": g.uid,
        "extra": extra or {},
        "at": datetime.now(timezone.utc),
    })


@admin_bp.route("/block-user", methods=["POST"])
@require_admin
def block_user():
    data = request.get_json(silent=True) or {}
    uid = data.get("uid")
    should_block = bool(data.get("shouldBlock"))
    if not uid:
        return jsonify({"error": "'uid' is required."}), 400

    db.collection("users").document(uid).set({"blocked": should_block}, merge=True)
    if should_block:
        try:
            firebase_auth.update_user(uid, disabled=True)
        except Exception:
            pass  # user doc flag is still authoritative for the frontend either way
    else:
        try:
            firebase_auth.update_user(uid, disabled=False)
        except Exception:
            pass

    _log_admin_action("block_user" if should_block else "unblock_user", uid)
    return jsonify({"success": True})


@admin_bp.route("/verify-kyc", methods=["POST"])
@require_admin
def verify_kyc():
    data = request.get_json(silent=True) or {}
    seller_uid = data.get("sellerUid")
    status = data.get("status")  # "Verified" | "Rejected"
    if not seller_uid or status not in ("Verified", "Rejected"):
        return jsonify({"error": "'sellerUid' and a valid 'status' are required."}), 400

    db.collection("sellers_profiles").document(seller_uid).set({
        "kycStatus": status,
        "kycReviewedAt": datetime.now(timezone.utc),
        "kycReviewedBy": g.uid,
    }, merge=True)

    db.collection("users").document(seller_uid).collection("notifications").add({
        "title": f"KYC {status}",
        "body": "Your seller verification has been reviewed." if status == "Verified"
                else "Your KYC documents were rejected — please re-check and resubmit.",
        "type": "default",
        "link": "seller-dashboard.html",
        "read": False,
        "createdAt": datetime.now(timezone.utc),
    })

    _log_admin_action("verify_kyc", seller_uid, {"status": status})
    return jsonify({"success": True})


@admin_bp.route("/set-premium", methods=["POST"])
@require_admin
def set_premium():
    data = request.get_json(silent=True) or {}
    seller_uid = data.get("sellerUid")
    is_premium = bool(data.get("isPremium"))
    if not seller_uid:
        return jsonify({"error": "'sellerUid' is required."}), 400

    db.collection("sellers_profiles").document(seller_uid).set({"isPremium": is_premium}, merge=True)
    _log_admin_action("set_premium", seller_uid, {"isPremium": is_premium})
    return jsonify({"success": True})


@admin_bp.route("/delete-product", methods=["POST"])
@require_admin
def delete_product():
    data = request.get_json(silent=True) or {}
    product_id = data.get("productId")
    if not product_id:
        return jsonify({"error": "'productId' is required."}), 400

    db.collection("vendors").document(product_id).delete()
    _log_admin_action("delete_product", product_id)
    return jsonify({"success": True})


@admin_bp.route("/resolve-report", methods=["POST"])
@require_admin
def resolve_report():
    data = request.get_json(silent=True) or {}
    report_id = data.get("reportId")
    also_delete_product_id = data.get("alsoDeleteProductId")
    if not report_id:
        return jsonify({"error": "'reportId' is required."}), 400

    db.collection("reports").document(report_id).set({"status": "Resolved"}, merge=True)
    if also_delete_product_id:
        db.collection("vendors").document(also_delete_product_id).delete()

    _log_admin_action("resolve_report", report_id, {"deletedProduct": also_delete_product_id})
    return jsonify({"success": True})
