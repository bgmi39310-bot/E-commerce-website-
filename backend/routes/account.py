"""
Self-service account deletion. A person can only ever delete THEIR OWN
account and data — the uid always comes from their own verified auth
token (g.uid), never from anything in the request body, so there's no way
to pass someone else's uid here.
"""

import logging
from flask import Blueprint, jsonify, g
from firebase_admin import auth as firebase_auth

from utils.auth import require_auth
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

account_bp = Blueprint("account", __name__, url_prefix="/api/account")


def _delete_subcollection(collection_ref):
    batch = db.batch()
    count = 0
    for doc_snap in collection_ref.stream():
        batch.delete(doc_snap.reference)
        count += 1
        if count >= 400:  # stay under Firestore's 500-write batch limit
            batch.commit()
            batch = db.batch()
            count = 0
    if count > 0:
        batch.commit()


@account_bp.route("/delete-me", methods=["POST"])
@require_auth
def delete_me():
    uid = g.uid

    # Deliberately NOT deleted: orders, reviews, products they SOLD to
    # others, chat/dispute messages. Those involve other people (a buyer
    # who bought from them, a seller who received their order) who have a
    # legitimate reason to keep their own transaction history intact --
    # deleting those would break other people's order history and
    # accounting, not just this person's.
    try:
        _delete_subcollection(db.collection("users").document(uid).collection("addresses"))
        _delete_subcollection(db.collection("users").document(uid).collection("following"))
        _delete_subcollection(db.collection("users").document(uid).collection("notifications"))
        _delete_subcollection(db.collection("sellers_profiles").document(uid).collection("followers"))

        batch = db.batch()
        batch.delete(db.collection("users").document(uid))
        batch.delete(db.collection("sellers_profiles").document(uid))
        batch.delete(db.collection("seller_private_kyc").document(uid))
        batch.delete(db.collection("delivery_profiles").document(uid))
        batch.commit()
    except Exception:
        logger.exception("Failed to delete Firestore profile data for uid=%s", uid)
        return jsonify({"error": "Could not delete your account data. Please try again or contact support."}), 500

    # If they were a seller, delist their products too — a listed product
    # left behind from a deleted account is broken/confusing for buyers.
    try:
        products = db.collection("vendors").where("sellerUid", "==", uid).stream()
        product_batch = db.batch()
        count = 0
        for p in products:
            product_batch.delete(p.reference)
            count += 1
            if count >= 400:
                product_batch.commit()
                product_batch = db.batch()
                count = 0
        if count > 0:
            product_batch.commit()
    except Exception:
        # Not fatal — the account itself still gets deleted even if this
        # particular cleanup step has a problem; logged for manual follow-up.
        logger.exception("Failed to delete products for uid=%s", uid)

    # Finally, the Firebase Auth account itself — this is what actually
    # stops them being able to log back in.
    try:
        firebase_auth.delete_user(uid)
    except Exception:
        logger.exception("Failed to delete Auth user uid=%s", uid)
        return jsonify({
            "error": "Your account data was deleted, but there was a problem removing your login. Please contact support so we can finish this."
        }), 500

    return jsonify({"success": True})

