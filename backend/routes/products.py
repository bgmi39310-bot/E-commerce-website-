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
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify, g

from firebase_admin import firestore

from utils.auth import require_auth
from utils.fast_cache import serve_cached
from utils import cache_keeper
from utils.cache import get_redis
from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

products_bp = Blueprint("products", __name__, url_prefix="/api/products")

_PRODUCT_LIMIT = 500  # matches the limit index.html used when it queried Firestore directly
_LISTING_TTL_SECONDS = 600  # 10 min safety-net TTL (see module docstring)
_PRODUCT_TTL_SECONDS = 600

_HOMEPAGE_CACHE_KEY = "homepage:products"

# Mirrors premium-logic.js's FREE_TIER_LIMITS — kept here too because the
# the whole point of this endpoint is enforcing these server-side. The old
# client-only check (premium-logic.js's countSellerProducts/isPremiumSeller,
# called from product-logic.js before deciding whether to show an error
# toast) was never actually a security boundary: a free seller could add
# unlimited products or photos by calling the Firestore SDK directly and
# skipping the UI's own check entirely, since the create permission in
# firestore.rules never looked at how many products that seller already had.
_FREE_TIER_LIMITS = {
    "maxProducts": 30,
    "maxPhotosPerProduct": 1,
    "maxBulkRows": 450,  # Firestore batches cap at 500 writes; stay comfortably under that
}

_DEFAULT_PRODUCT_IMAGE = "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&auto=format&fit=crop&q=80"


def _is_premium_seller(uid):
    snap = db.collection("sellers_profiles").document(uid).get()
    return snap.exists and (snap.to_dict() or {}).get("isPremium") is True


def _invalidate_product_caches(uid):
    """Products created here go straight into Firestore via firebase-admin,
    which the live Firestore->Redis sync listener (utils/product_sync.py)
    will pick up and reflect within about a second anyway — but invalidating
    these two keys immediately means the NEXT page load (which could happen
    before that listener fires) doesn't serve a stale list missing the
    product the seller just added."""
    r = get_redis()
    if r is None:
        return
    try:
        r.delete(_HOMEPAGE_CACHE_KEY)
        r.delete(f"shop:{uid}:products")
    except Exception:
        logger.exception("Could not invalidate product caches for sellerUid=%s", uid)


def _safe_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _shop_key(seller_uid):
    return f"shop:{seller_uid}:products"


def _product_key(product_id):
    return f"product:{product_id}"


def _doc_to_dict(doc):
    d = doc.to_dict() or {}
    d["id"] = doc.id
    return d


def _cache_get(r, key):
    """Reads+decodes a cache entry, or returns None on ANY problem (key
    missing, Redis connection drop, corrupt JSON, etc) so callers can
    always just fall back to Firestore rather than needing their own
    try/except at every call site."""
    if r is None:
        return None
    try:
        cached = r.get(key)
        return json.loads(cached) if cached is not None else None
    except Exception:
        logger.exception("Redis read failed for key=%s (falling back to Firestore)", key)
        return None


_MEMORY_TTL_SECONDS = 15  # how long each worker reuses its in-memory copy (see utils/fast_cache.py)


@products_bp.route("", methods=["GET"])
def list_products():
    """The full product listing for the homepage. Replaces index.html's old
    direct `getDocs(query(collection(db, "vendors"), limit(500)))` call —
    same 500-item cap, just served from Redis on every visit after the
    first, and from this worker's memory (pre-compressed) between refreshes."""
    cache_keeper.touch(_HOMEPAGE_CACHE_KEY)  # site is in use: keep the Redis copy warm
    return serve_cached("products:list", _MEMORY_TTL_SECONDS, _build_products_payload)


def _fetch_products_from_firestore():
    # Ordered newest-first: if there are ever more than _PRODUCT_LIMIT
    # products, this guarantees the cap drops the OLDEST listings, not an
    # arbitrary slice — without an explicit order, a seller's brand-new
    # product could simply never appear once the catalog passed the cap.
    # No composite index needed (a plain orderBy with no where-filter uses
    # Firestore's automatic single-field index).
    return [
        _doc_to_dict(d)
        for d in db.collection("vendors").order_by("createdAt", direction=firestore.Query.DESCENDING).limit(_PRODUCT_LIMIT).stream()
    ]


def _write_products_to_redis(r, products):
    if r is None:
        return
    try:
        r.set(_HOMEPAGE_CACHE_KEY, json.dumps(products, default=str), ex=_LISTING_TTL_SECONDS)
    except Exception:
        logger.exception("Could not write homepage product list to Redis (continuing without caching it)")


def _build_products_payload():
    r = get_redis()
    cached = _cache_get(r, _HOMEPAGE_CACHE_KEY)
    if cached is not None:
        return {"products": cached, "cached": True}

    products = _fetch_products_from_firestore()
    _write_products_to_redis(r, products)
    return {"products": products, "cached": False}


def _rebuild_products_cache():
    """Used by utils/cache_keeper.py: refills the Redis copy BEFORE it expires."""
    _write_products_to_redis(get_redis(), _fetch_products_from_firestore())


cache_keeper.register(_HOMEPAGE_CACHE_KEY, _rebuild_products_cache)


@products_bp.route("/shop/<seller_uid>", methods=["GET"])
def list_shop_products(seller_uid):
    """One seller's products — replaces shop.html's old direct
    `query(collection(db, "vendors"), where("sellerUid", "==", sellerUid))`."""
    r = get_redis()
    cache_key = _shop_key(seller_uid)
    cached = _cache_get(r, cache_key)
    if cached is not None:
        return jsonify({"products": cached, "cached": True})

    products = [_doc_to_dict(d) for d in db.collection("vendors").where("sellerUid", "==", seller_uid).stream()]

    if r is not None:
        try:
            r.set(cache_key, json.dumps(products, default=str), ex=_LISTING_TTL_SECONDS)
        except Exception:
            logger.exception("Could not write shop product list to Redis for sellerUid=%s (continuing without caching it)", seller_uid)

    return jsonify({"products": products, "cached": False})


@products_bp.route("", methods=["POST"])
@limiter.limit("20 per minute")
@require_auth
def create_product():
    """
    Creates a product. Mirrors product-logic.js's addProductToFirebase, but
    server-side — see _FREE_TIER_LIMITS above for why that move was needed.
    sellerUid is taken from the verified ID token (g.uid), never trusted
    from the request body, so nobody can list a product under someone
    else's name.
    """
    if not g.user.get("email_verified"):
        return jsonify({"error": "Please verify your email before listing products."}), 403

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    shop_name = (data.get("shopName") or "").strip()
    price = _safe_float(data.get("price"))

    if not name or not shop_name:
        return jsonify({"error": "Please enter Product Name and Price, and save your Shop Profile first."}), 400
    if price is None or price <= 0:
        return jsonify({"error": "Please enter a valid price."}), 400

    is_premium = _is_premium_seller(g.uid)

    if not is_premium:
        count_result = db.collection("vendors").where("sellerUid", "==", g.uid).count().get()
        existing_count = count_result[0][0].value
        if existing_count >= _FREE_TIER_LIMITS["maxProducts"]:
            return jsonify({
                "error": f"Free sellers can list up to {_FREE_TIER_LIMITS['maxProducts']} products. "
                         "Upgrade to Premium for unlimited listings!"
            }), 403

    images = data.get("images")
    images = [str(u).strip() for u in images if str(u or "").strip()] if isinstance(images, list) else []
    if not is_premium and len(images) > _FREE_TIER_LIMITS["maxPhotosPerProduct"]:
        images = images[:_FREE_TIER_LIMITS["maxPhotosPerProduct"]]
    if not images:
        images = [_DEFAULT_PRODUCT_IMAGE]

    sizes = data.get("sizes")
    sizes = [str(s).strip() for s in sizes if str(s or "").strip()] if isinstance(sizes, list) else []
    colors = data.get("colors")
    colors = [str(c).strip() for c in colors if str(c or "").strip()] if isinstance(colors, list) else []

    variant_stock = data.get("variantStock")
    if not isinstance(variant_stock, dict) or not variant_stock:
        variant_stock = None  # None = not tracked per-variant, same meaning as the old client code

    now = datetime.now(timezone.utc)
    doc_ref = db.collection("vendors").document()
    doc_ref.set({
        "name": name,
        "price": price,
        "unit": (data.get("unit") or "Per Piece"),
        "material": (data.get("material") or "").strip() or "100% Original",
        "warranty": (data.get("warranty") or "").strip() or "Verified Quality",
        "image": images[0],
        "images": images,
        "description": (data.get("description") or "").strip() or f"{name} available in best quality.",
        "shopName": shop_name,
        "sellerUid": g.uid,
        "stock": _safe_int(data.get("stock"), 10),
        "sizes": sizes,
        "category": (data.get("category") or "other"),
        "colors": colors,
        "variantStock": variant_stock,
        "returnWindowDays": _safe_int(data.get("returnWindowDays"), 7),
        "createdAt": now,
        "updatedAt": now,
    })

    _invalidate_product_caches(g.uid)
    return jsonify({"success": True, "productId": doc_ref.id})


@products_bp.route("/bulk", methods=["POST"])
@limiter.limit("5 per minute")
@require_auth
def bulk_create_products():
    """
    Creates many products at once from already-CSV-parsed rows (the CSV
    file itself is still parsed client-side — see bulk-upload-logic.js —
    this just moves the actual Firestore writes + the Premium-only gate
    server-side, same reasoning as create_product() above). Bulk upload was
    ALREADY meant to be Premium-only, but that gate was client-side JS only
    — anyone could call this collection's create permission directly and
    bulk-add as a free seller.
    """
    if not g.user.get("email_verified"):
        return jsonify({"error": "Please verify your email before listing products."}), 403

    data = request.get_json(silent=True) or {}
    shop_name = (data.get("shopName") or "").strip()
    rows = data.get("products")

    if not shop_name:
        return jsonify({"error": "Please save your Shop Profile first!"}), 400
    if not isinstance(rows, list) or not rows:
        return jsonify({"error": "No products to upload."}), 400
    if len(rows) > _FREE_TIER_LIMITS["maxBulkRows"]:
        return jsonify({"error": f"Too many rows in one upload (max {_FREE_TIER_LIMITS['maxBulkRows']})."}), 400

    if not _is_premium_seller(g.uid):
        return jsonify({"error": "Bulk CSV upload is a Premium feature. Upgrade to Premium to add many products at once!"}), 403

    now = datetime.now(timezone.utc)
    batch = db.batch()
    success_count = 0
    fail_count = 0

    for row in rows:
        if not isinstance(row, dict):
            fail_count += 1
            continue
        name = (row.get("name") or "").strip()
        price = _safe_float(row.get("price"))
        if not name or price is None or price <= 0:
            fail_count += 1
            continue

        image = (row.get("image") or "").strip() or _DEFAULT_PRODUCT_IMAGE
        doc_ref = db.collection("vendors").document()
        batch.set(doc_ref, {
            "name": name,
            "price": price,
            "unit": (row.get("unit") or "").strip() or "Per Piece",
            "stock": _safe_int(row.get("stock"), 10),
            "material": (row.get("material") or "").strip() or "100% Original",
            "warranty": (row.get("warranty") or "").strip() or "Verified Quality",
            "image": image,
            "images": [image],
            "description": (row.get("description") or "").strip() or f"{name} available in best quality.",
            "category": (row.get("category") or "other").strip().lower(),
            "shopName": shop_name,
            "sellerUid": g.uid,
            "createdAt": now,
            "updatedAt": now,
        })
        success_count += 1

    if success_count > 0:
        batch.commit()
        _invalidate_product_caches(g.uid)

    return jsonify({"success": True, "created": success_count, "failed": fail_count})


@products_bp.route("/<product_id>", methods=["GET"])
def get_product(product_id):
    """
    A single product, cached. Provided for completeness/future use (e.g. a
    future related-products widget, search, etc) — product.html's own page
    intentionally does NOT call this; see module docstring.
    """
    r = get_redis()
    cache_key = _product_key(product_id)
    cached = _cache_get(r, cache_key)
    if cached is not None:
        return jsonify({"product": cached, "cached": True})

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
