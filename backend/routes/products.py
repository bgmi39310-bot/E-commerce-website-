"""
Read-only, cached product endpoints — used by index.html (homepage) and
shop.html (a seller's shop page) instead of querying Firestore directly
from the browser. On a cache hit these are served entirely from Redis, no
Firestore read at all; on a miss they fall back to Firestore and refill
the cache for next time.

product.html's OWN product page deliberately does NOT use these — it keeps
its direct Firestore getDoc()+onSnapshot() (see product.html), because that
page needs price/stock to be live and accurate at the exact moment someone
is deciding to buy, not "fresh as of the last cache refresh". These
endpoints exist for LISTING pages, where a few seconds/minutes of staleness
on a page full of products is a fine trade-off for far fewer Firestore
reads — the actual order is re-verified server-side regardless (see
routes/payments.py), so a stale price shown while browsing can never
result in someone actually being charged the wrong amount.

Cache freshness: kept live by utils/product_sync.py, which listens for
Firestore changes and updates/invalidates these same keys the moment a
seller edits anything — usually within about a second. The short TTLs set
here are just a safety net in case that listener is ever down, not the
main way these caches stay fresh.
"""

import json
import logging

from flask import Blueprint, jsonify

from utils.cache import get_redis
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

products_bp = Blueprint("products", __name__, url_prefix="/api/products")

_PRODUCT_LIMIT = 500  # matches the limit index.html used when it queried Firestore directly
_LISTING_TTL_SECONDS = 600  # 10 min safety-net TTL (see module docstring)
_PRODUCT_TTL_SECONDS = 600

_HOMEPAGE_CACHE_KEY = "homepage:products"


def _shop_key(seller_uid):
    return f"shop:{seller_uid}:products"


def _product_key(product_id):
    return f"product:{product_id}"


def _doc_to_dict(doc):
    d = doc.to_dict() or {}
    d["id"] = doc.id
    return d


@products_bp.route("", methods=["GET"])
def list_products():
    """The full product listing for the homepage. Replaces index.html's old
    direct `getDocs(query(collection(db, "vendors"), limit(500)))` call —
    same 500-item cap, just served from Redis on every visit after the
    first."""
    r = get_redis()
    if r is not None:
        cached = r.get(_HOMEPAGE_CACHE_KEY)
        if cached is not None:
            return jsonify({"products": json.loads(cached), "cached": True})

    products = [_doc_to_dict(d) for d in db.collection("vendors").limit(_PRODUCT_LIMIT).stream()]

    if r is not None:
        try:
            r.set(_HOMEPAGE_CACHE_KEY, json.dumps(products, default=str), ex=_LISTING_TTL_SECONDS)
        except Exception:
            logger.exception("Could not write homepage product list to Redis (continuing without caching it)")

    return jsonify({"products": products, "cached": False})


@products_bp.route("/shop/<seller_uid>", methods=["GET"])
def list_shop_products(seller_uid):
    """One seller's products — replaces shop.html's old direct
    `query(collection(db, "vendors"), where("sellerUid", "==", sellerUid))`."""
    r = get_redis()
    cache_key = _shop_key(seller_uid)
    if r is not None:
        cached = r.get(cache_key)
        if cached is not None:
            return jsonify({"products": json.loads(cached), "cached": True})

    products = [_doc_to_dict(d) for d in db.collection("vendors").where("sellerUid", "==", seller_uid).stream()]

    if r is not None:
        try:
            r.set(cache_key, json.dumps(products, default=str), ex=_LISTING_TTL_SECONDS)
        except Exception:
            logger.exception("Could not write shop product list to Redis for sellerUid=%s (continuing without caching it)", seller_uid)

    return jsonify({"products": products, "cached": False})


@products_bp.route("/<product_id>", methods=["GET"])
def get_product(product_id):
    """
    A single product, cached. Provided for completeness/future use (e.g. a
    future related-products widget, search, etc) — product.html's own page
    intentionally does NOT call this; see module docstring.
    """
    r = get_redis()
    cache_key = _product_key(product_id)
    if r is not None:
        cached = r.get(cache_key)
        if cached is not None:
            return jsonify({"product": json.loads(cached), "cached": True})

    doc = db.collection("vendors").document(product_id).get()
    if not doc.exists:
        return jsonify({"error": "Product not found."}), 404
    data = _doc_to_dict(doc)

    if r is not None:
        try:
            r.set(cache_key, json.dumps(data, default=str), ex=_PRODUCT_TTL_SECONDS)
        except Exception:
            logger.exception("Could not write product %s to Redis (continuing without caching it)", product_id)

    return jsonify({"product": data, "cached": False})

