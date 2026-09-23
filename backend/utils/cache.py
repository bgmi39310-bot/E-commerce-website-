"""
Single shared Redis connection, used for two things in this backend:
  1. Live product cache (see product_sync.py + routes/products.py)
  2. Rate limiting (see utils/limiter.py)

IMPORTANT: everything that uses Redis in this app treats it as OPTIONAL.
If REDIS_URL isn't set, or Redis is unreachable, the app must still work
correctly — just slower (every product read hits Firestore directly) and
without rate limiting. Redis going down should never be able to take the
site down. That's why get_redis() returns None instead of raising, and
every caller is expected to check for that AND wrap their actual get/set
calls in try/except (a connection can drop between "get_redis() returned a
client" and the next line actually using it).

The connection itself is made LAZILY, on the first call to get_redis(),
not when this module is imported. Connecting is a network call (DNS +
TLS handshake to Upstash) that can take a couple of seconds — doing that
at import time meant it happened on Render before the app had even started
answering requests, on the critical path of Render's own 5-second startup
health check. Deferring it means the app can start answering requests
immediately; the very first request that needs Redis pays a small one-time
connection cost instead of every worker's boot doing so up front.
"""

import os
import logging
import threading

import redis

logger = logging.getLogger(__name__)

_client = None
_connect_attempted = False
_lock = threading.Lock()


def _connect():
    url = os.environ.get("REDIS_URL")
    if not url:
        logger.warning(
            "REDIS_URL is not set — product caching and rate limiting are "
            "disabled. The site will still work, reading directly from "
            "Firestore for everything. Set REDIS_URL (e.g. from Upstash) to "
            "enable both."
        )
        return None
    try:
        client = redis.from_url(
            url,
            decode_responses=True,   # get back str, not bytes, from every call
            socket_timeout=3,
            socket_connect_timeout=3,
        )
        client.ping()
        logger.info("Connected to Redis.")
        return client
    except Exception:
        logger.exception("Could not connect to Redis at REDIS_URL — continuing without cache/rate limiting.")
        return None


def get_redis():
    """Returns the shared Redis client, or None if Redis isn't configured
    or isn't reachable. ALWAYS check for None before using the result —
    every part of this app must keep working with Redis absent, and every
    actual .get()/.set() call on the returned client should still be
    wrapped in its own try/except, since a working connection can still
    drop later."""
    global _client, _connect_attempted
    if not _connect_attempted:
        with _lock:
            if not _connect_attempted:  # re-check inside the lock
                _client = _connect()
                _connect_attempted = True
    return _client
