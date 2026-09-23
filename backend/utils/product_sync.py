"""
Keeps the Redis product cache in sync with Firestore, live, with NO changes
needed to how sellers edit products (product-logic.js still writes straight
to Firestore, exactly as before).

HOW: Firestore's own "watch" API — the same underlying mechanism the
frontend's onSnapshot() listeners use — lets a backend process subscribe to
a collection and get called back the instant anything in it changes, with
no polling. We attach ONE such listener to the `vendors` collection when
this process starts, and every add/edit/delete it reports gets mirrored
into Redis within about a second, automatically. Nothing that writes a
product ever needs to know Redis exists.

CACHE KEYS this maintains:
  product:{productId}          -> JSON of that one product (kept live)
  homepage:products             -> JSON array, the index.html listing
                                    (invalidated, not live-patched — see below)
  shop:{sellerUid}:products     -> JSON array, one seller's products
                                    (invalidated, not live-patched)

Why "product:*" is kept live (written on every change) but the two listing
caches are only invalidated (deleted, then rebuilt by whoever asks next):
patching a single product key in place is a one-line operation, but
patching a *list* in place (was this product already in it? does it now
belong in a differently-filtered list?) is fiddly and easy to get subtly
wrong. Deleting the list and letting the next request rebuild it costs one
Firestore query — but only for the first visitor after a change, not
every visitor, which is the whole point of caching it.

IMPORTANT — "views" and "unitsSold" are deliberately ignored when deciding
whether to invalidate the two listing caches (see _COSMETIC_FIELDS below).
Both tick up on essentially every visit/order — product.html bumps `views`
on every single page view, and stock reservation bumps `unitsSold` on
every order — and neither is ever shown on a listing card (only on the
seller's own product-management list). Invalidating homepage/shop caches
on every one of those would mean the listing cache almost never stays
warm under real traffic, defeating most of the point of caching it. A
real content change (price, stock, name, image, etc.) still invalidates
immediately, same as before.
"""

import json
import logging
import threading

from utils.cache import get_redis
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

# Safety-net TTL for individual product entries. The listener is expected to
# keep these fresh in real time; this just guards against a missed event or
# a gap while the listener is (re)connecting, so a stale entry can't live
# forever if something goes wrong.
_PRODUCT_TTL_SECONDS = 6 * 60 * 60  # 6 hours

_HOMEPAGE_CACHE_KEY = "homepage:products"

# Fields that change constantly but never appear on a listing card — see
# the module docstring. Ignored when deciding whether a change is
# "significant" enough to invalidate the homepage/shop listing caches.
_COSMETIC_FIELDS = {"views", "unitsSold"}

# In-memory, per-worker-process record of the last non-cosmetic field set
# seen for each product, used only to detect "did anything that actually
# shows up on a listing card change?". Deliberately NOT stored in Redis —
# it's fine (just slightly less optimal, never incorrect) if this resets on
# a worker restart: the first change seen for a product after a restart is
# always treated as significant, so caches never go stale from this, they
# can only be invalidated a bit more often right after a deploy/restart.
_last_known = {}


def _product_key(product_id):
    return f"product:{product_id}"


def _shop_key(seller_uid):
    return f"shop:{seller_uid}:products"


def _is_significant_change(product_id, new_data):
    """True if this change could affect what a LISTING page shows (so the
    homepage/shop caches should be invalidated), False if only cosmetic
    fields like `views`/`unitsSold` moved."""
    comparable = {k: v for k, v in new_data.items() if k not in _COSMETIC_FIELDS}
    previous = _last_known.get(product_id)
    _last_known[product_id] = comparable
    return previous is None or previous != comparable


def _on_vendors_change(col_snapshot, changes, read_time):
    r = get_redis()
    if r is None:
        return

    touched_sellers = set()
    listings_dirty = False

    try:
        pipe = r.pipeline()
        for change in changes:
            doc = change.document
            product_id = doc.id
            key = _product_key(product_id)

            if change.type.name == "REMOVED":
                pipe.delete(key)
                _last_known.pop(product_id, None)
                listings_dirty = True  # a removed product always changes a listing
            else:
                data = doc.to_dict() or {}
                data["id"] = product_id
                pipe.set(key, json.dumps(data, default=str), ex=_PRODUCT_TTL_SECONDS)

                is_new = change.type.name == "ADDED"
                if is_new or _is_significant_change(product_id, data):
                    listings_dirty = True
                    seller_uid = data.get("sellerUid")
                    if seller_uid:
                        touched_sellers.add(seller_uid)

        if listings_dirty:
            pipe.delete(_HOMEPAGE_CACHE_KEY)
            for seller_uid in touched_sellers:
                pipe.delete(_shop_key(seller_uid))

        pipe.execute()
        logger.info(
            "Synced %d Firestore vendor change(s) to Redis (listings invalidated: %s).",
            len(changes), listings_dirty,
        )
    except Exception:
        logger.exception("Failed to sync a Firestore vendors change into Redis")


_listener_started = False
_listener_lock = threading.Lock()


def start_product_sync():
    """
    Starts the live Firestore -> Redis listener, once per process. Safe to
    call more than once (it's a no-op after the first call) — if gunicorn
    runs multiple worker processes, each one calls this and ends up with
    its own listener, which is fine: Redis writes here are idempotent, so
    a product change simply gets written to Redis more than once instead
    of causing any inconsistency.
    """
    global _listener_started
    with _listener_lock:
        if _listener_started:
            return
        if get_redis() is None:
            logger.info("Redis not configured — skipping the product cache sync listener.")
            return
        try:
            # This call itself does NOT block — google-cloud-firestore runs
            # the watch on its own background thread and delivers an
            # initial "ADDED" event for every existing document right away
            # (which is what seeds the cache the first time this starts),
            # then keeps delivering live changes after that.
            db.collection("vendors").on_snapshot(_on_vendors_change)
            _listener_started = True
            logger.info("Started live Firestore -> Redis product sync listener.")
        except Exception:
            logger.exception("Could not start the Firestore product sync listener — product caching will stay cold (every read will fall back to Firestore).")
