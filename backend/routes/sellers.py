"""
Read-only, cached sellers listing — used by index.html's "sellers near
you" section instead of reading the whole `sellers_profiles` collection
directly from Firestore. Same reasoning as routes/products.py; see that
file's docstring and utils/seller_sync.py for the full picture.
"""

import json
import logging

from flask import Blueprint, jsonify

from utils.cache import get_redis
from utils.seller_sync import SELLERS_CACHE_KEY
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

sellers_bp = Blueprint("sellers", __name__, url_prefix="/api/sellers")

_LISTING_TTL_SECONDS = 600


def _cache_get(r, key):
    """See routes/products.py's _cache_get — same defensive read: any
    problem at all (missing key, dropped connection, corrupt JSON) just
    falls back to Firestore instead of failing the request."""
    if r is None:
        return None
    try:
        cached = r.get(key)
        return json.loads(cached) if cached is not None else None
    except Exception:
        logger.exception("Redis read failed for key=%s (falling back to Firestore)", key)
        return None


@sellers_bp.route("", methods=["GET"])
def list_sellers():
    r = get_redis()
    cached = _cache_get(r, SELLERS_CACHE_KEY)
    if cached is not None:
        return jsonify({"sellers": cached, "cached": True})

    sellers = []
    for doc in db.collection("sellers_profiles").stream():
        d = doc.to_dict() or {}
        d["id"] = doc.id
        sellers.append(d)

    if r is not None:
        try:
            r.set(SELLERS_CACHE_KEY, json.dumps(sellers, default=str), ex=_LISTING_TTL_SECONDS)
        except Exception:
            logger.exception("Could not write sellers list to Redis (continuing without caching it)")

    return jsonify({"sellers": sellers, "cached": False})

