"""
Writes batched product-view counts from Redis to Firestore.

Why: every page view used to do a Firestore write on the product document (views += 1). Besides the
write itself, that write woke up EVERY change-listener on the document (this backend's product sync
and each open product tab) — so one view cost several billed reads. Now a view is one Redis INCR
(routes/products.py: POST /api/products/<id>/view) and this thread turns the totals into ONE write
per product every FLUSH_EVERY_SECONDS. Seller dashboards see view counts up to ~10 minutes late,
which is fine for a statistic.

Safe by design: if Redis is off nothing runs (the endpoint writes directly instead); if a Firestore
write fails the count is put back into Redis, so nothing is lost.
"""

import logging
import threading
import time

from firebase_admin import firestore

from routes.products import VIEWS_KEY_PREFIX
from utils.cache import get_redis
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

FLUSH_EVERY_SECONDS = 600
FIRST_FLUSH_DELAY_SECONDS = 180
MAX_PRODUCTS_PER_PASS = 500

_started = False
_lock = threading.Lock()


def flush_views_once():
    """One pass. Returns how many products were updated."""
    r = get_redis()
    if r is None:
        return 0
    updated = 0
    try:
        keys = list(r.scan_iter(match=VIEWS_KEY_PREFIX + "*", count=200))[:MAX_PRODUCTS_PER_PASS]
    except Exception:
        logger.exception("Views flusher: could not list view counters")
        return 0
    for key in keys:
        key = key.decode() if isinstance(key, bytes) else key
        product_id = key[len(VIEWS_KEY_PREFIX):]
        try:
            pipe = r.pipeline()                      # GET + DELETE in one atomic step: no view is lost
            pipe.get(key)
            pipe.delete(key)
            raw = pipe.execute()[0]
            n = int(raw or 0)
        except Exception:
            logger.exception("Views flusher: could not take counter %s", key)
            continue
        if n <= 0:
            continue
        try:
            db.collection("vendors").document(product_id).update({"views": firestore.Increment(n)})
            updated += 1
        except Exception as e:
            if "NotFound" in type(e).__name__ or "404" in str(e):
                continue                              # product was deleted meanwhile: drop its views
            logger.exception("Views flusher: Firestore write failed for %s — putting %s views back", product_id, n)
            try:
                r.incrby(key, n)
            except Exception:
                pass
    return updated


def _loop():
    time.sleep(FIRST_FLUSH_DELAY_SECONDS)
    while True:
        try:
            flush_views_once()
        except Exception:
            logger.exception("Views flusher loop error (will keep running)")
        time.sleep(FLUSH_EVERY_SECONDS)


def start_views_flusher():
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="views-flusher", daemon=True).start()
    logger.info("Views flusher started (every %ss).", FLUSH_EVERY_SECONDS)
