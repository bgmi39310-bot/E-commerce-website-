"""
Same idea as product_sync.py, for the `sellers_profiles` collection this
time — the homepage's "sellers near you" list used to read this ENTIRE
collection straight from Firestore on every single first-visit-of-the-
session (see index.html's loadSellersNearYou, which already had its own
5-minute sessionStorage cache on top of that — this just adds a SHARED
cache underneath it, so the read only genuinely hits Firestore once across
ALL visitors, not once per visitor's first session).

Unlike products, seller profiles don't have a per-visit "cosmetic" counter
like `views` — a seller edits their shop details rarely, and even
followerCount only changes on an explicit follow/unfollow action, nowhere
near as often as a product page view. So this skips product_sync.py's
significant-vs-cosmetic distinction entirely and just invalidates the
cached list on ANY change — simpler, and still rarely triggered in
practice.
"""

import json
import logging
import threading

from utils.cache import get_redis
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

SELLERS_CACHE_KEY = "sellers:all"
_LISTING_TTL_SECONDS = 600  # 10 min safety net, same reasoning as product_sync.py


def _on_sellers_change(col_snapshot, changes, read_time):
    r = get_redis()
    if r is None or not changes:
        return
    try:
        r.delete(SELLERS_CACHE_KEY)
        logger.info("Synced %d Firestore seller-profile change(s) to Redis (list invalidated).", len(changes))
    except Exception:
        logger.exception("Failed to invalidate the Redis sellers cache")


_listener_started = False
_listener_lock = threading.Lock()


def start_seller_sync():
    """Starts the live Firestore -> Redis listener for sellers_profiles,
    once per process. See product_sync.start_product_sync for the full
    reasoning — this is the same pattern, applied to a second collection."""
    global _listener_started
    with _listener_lock:
        if _listener_started:
            return
        if get_redis() is None:
            logger.info("Redis not configured — skipping the sellers cache sync listener.")
            return
        try:
            db.collection("sellers_profiles").on_snapshot(_on_sellers_change)
            _listener_started = True
            logger.info("Started live Firestore -> Redis sellers-profile sync listener.")
        except Exception:
            logger.exception("Could not start the Firestore sellers sync listener — sellers caching will stay cold.")

