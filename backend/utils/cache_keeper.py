"""
Keeps the two homepage listing caches in Redis WARM, so a visitor never has
to wait for them to be rebuilt.

THE PROBLEM: the Redis copies of the product list and the seller list expire
every 10 minutes (the safety-net TTL). The moment one expired, the next
visitor's request had to go all the way to Firestore and rebuild it — a slow
request, and a burst of Firestore reads.

THE FIX: a small background thread checks the two Redis keys every ~20
seconds. When one has 60 seconds or less left (or has disappeared, e.g.
because a seller edited something and the live sync deleted it), the thread
rebuilds it from Firestore RIGHT AWAY — before anyone asks for it.

IDLE SITES COST NOTHING: it only does this while the site is actually being
used (a listing was requested in the last 15 minutes). When nobody visits,
the caches are simply allowed to expire and no Firestore reads are spent.

If Redis isn't configured this does nothing at all.
"""

import logging
import threading
import time

from utils.cache import get_redis

logger = logging.getLogger(__name__)

CHECK_EVERY_SECONDS = 20     # how often the thread looks at the keys
REFRESH_AHEAD_SECONDS = 60   # rebuild when this much time (or less) is left
ACTIVE_WINDOW_SECONDS = 15 * 60  # only keep warm if used within this long

_lock = threading.Lock()
_sources = {}  # redis_key -> {"rebuild": callable, "last_used": float}
_started = False


def register(redis_key, rebuild):
    """`rebuild()` must read the data from Firestore and store it in Redis
    under `redis_key` with its normal TTL."""
    with _lock:
        _sources.setdefault(redis_key, {"rebuild": rebuild, "last_used": 0.0})
        _sources[redis_key]["rebuild"] = rebuild


def touch(redis_key):
    """Call on every request for that listing: marks the site as 'in use'."""
    src = _sources.get(redis_key)
    if src is not None:
        src["last_used"] = time.time()


def _tick(now=None):
    """One pass over all registered keys. Returns the keys it rebuilt."""
    now = time.time() if now is None else now
    r = get_redis()
    if r is None:
        return []
    rebuilt = []
    with _lock:
        items = list(_sources.items())
    for key, src in items:
        if now - src["last_used"] > ACTIVE_WINDOW_SECONDS:
            continue  # nobody is using the site — let it expire, spend nothing
        try:
            ttl = r.ttl(key)  # seconds left; -2 = key is gone; -1 = never expires
            if ttl == -2 or (0 <= ttl <= REFRESH_AHEAD_SECONDS):
                src["rebuild"]()
                rebuilt.append(key)
                logger.info("Cache keeper: refreshed %s before it went cold (had %ss left).", key, ttl)
        except Exception:
            logger.exception("Cache keeper: could not refresh %s", key)
    return rebuilt


def _loop():
    while True:
        time.sleep(CHECK_EVERY_SECONDS)
        try:
            _tick()
        except Exception:
            logger.exception("Cache keeper loop error (will keep running)")


def start_cache_keeper():
    """Starts the background thread once per process. Call after init_redis()."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="cache-keeper", daemon=True).start()
    logger.info("Cache keeper started (checks every %ss, refreshes %ss before expiry).",
                CHECK_EVERY_SECONDS, REFRESH_AHEAD_SECONDS)
