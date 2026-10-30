"""
POST /api/push/register — a signed-in user's device says "send my
notifications to this token". The token is saved under
users/<uid>/pushTokens/. The actual sending is done by utils/push_sender.py.
"""

import hashlib
import logging
from datetime import datetime, timezone

from firebase_admin import firestore
from flask import Blueprint, jsonify, request, g

from utils.auth import require_auth
from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

push_bp = Blueprint("push", __name__, url_prefix="/api/push")

MAX_TOKENS_PER_USER = 10  # one user may have several phones/browsers; keep the newest few


@push_bp.route("/register", methods=["POST"])
@limiter.limit("20 per minute")
@require_auth
def register_token():
    data = request.get_json(silent=True) or {}
    token = str(data.get("token") or "").strip()
    if not (20 <= len(token) <= 4096):
        return jsonify({"error": "A valid notification token is required."}), 400

    tokens_ref = db.collection("users").document(g.uid).collection("pushTokens")
    doc_id = hashlib.sha256(token.encode("utf-8")).hexdigest()[:40]
    tokens_ref.document(doc_id).set({
        "token": token,
        "createdAt": datetime.now(timezone.utc),
        "userAgent": (request.headers.get("User-Agent") or "")[:120],
    })

    # Keep only the newest MAX_TOKENS_PER_USER devices.
    try:
        docs = list(tokens_ref.order_by("createdAt", direction=firestore.Query.DESCENDING).stream())
        for old in docs[MAX_TOKENS_PER_USER:]:
            old.reference.delete()
    except Exception:
        logger.exception("Could not trim old push tokens for %s", g.uid)

    return jsonify({"success": True})
