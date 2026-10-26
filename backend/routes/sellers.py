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
from utils.fast_cache import serve_cached
from utils import cache_keeper
from utils.seller_sync import SELLERS_CACHE_KEY
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

sellers_bp = Blueprint("sellers", __name__, url_prefix="/api/sellers")

_LISTING_TTL_SECONDS = 3600  # 1 hour (the live sync deletes the key the moment a seller profile changes)


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


_MEMORY_TTL_SECONDS = 15  # how long each worker reuses its in-memory copy (see utils/fast_cache.py)


@sellers_bp.route("", methods=["GET"])
def list_sellers():
    cache_keeper.touch(SELLERS_CACHE_KEY)  # site is in use: keep the Redis copy warm
    return serve_cached("sellers:list", _MEMORY_TTL_SECONDS, _build_sellers_payload)


def _fetch_sellers_from_firestore():
    sellers = []
    for doc in db.collection("sellers_profiles").stream():
        d = doc.to_dict() or {}
        d["id"] = doc.id
        sellers.append(d)
    return sellers


def _write_sellers_to_redis(r, sellers):
    if r is None:
        return
    try:
        r.set(SELLERS_CACHE_KEY, json.dumps(sellers, default=str), ex=_LISTING_TTL_SECONDS)
    except Exception:
        logger.exception("Could not write sellers list to Redis (continuing without caching it)")


def _build_sellers_payload():
    r = get_redis()
    cached = _cache_get(r, SELLERS_CACHE_KEY)
    if cached is not None:
        return {"sellers": cached, "cached": True}

    sellers = _fetch_sellers_from_firestore()
    _write_sellers_to_redis(r, sellers)
    return {"sellers": sellers, "cached": False}


def _rebuild_sellers_cache():
    """Used by utils/cache_keeper.py: refills the Redis copy BEFORE it expires."""
    _write_sellers_to_redis(get_redis(), _fetch_sellers_from_firestore())


cache_keeper.register(SELLERS_CACHE_KEY, _rebuild_sellers_cache)

