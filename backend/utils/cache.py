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

CRITICAL — connecting happens ONLY via init_redis(), called ONCE from a
background thread at app startup (see app.py). get_redis() NEVER attempts
a connection itself; it only ever returns whatever is already there.

This is not just an optimization — it's what keeps the app from crashing.
An earlier version connected lazily, inside get_redis() itself, the first
time any request needed Redis. Connecting is a network call (DNS + TLS
handshake to Upstash) that can hang far longer than its own configured
timeout if something's wrong (a bad REDIS_URL, a network path that silently
drops packets instead of refusing the connection, etc). Because that
lazy-connect ran INSIDE the request handler, a hung connection attempt hung
the whole request — and when it ran past gunicorn's worker timeout,
gunicorn killed the worker outright (SIGKILL), turning "Redis is slow to
connect" into "the whole site 500s". Doing the one connection attempt in a
background thread at startup means a slow/hanging Redis can never affect
an HTTP request at all — worst case, caching just silently stays off.
"""

import os
import logging
import threading

import redis

logger = logging.getLogger(__name__)

_client = None
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


def init_redis():
    """
    Makes the ONE connection attempt to Redis. Call this exactly once, from
    a background thread, at app startup (see app.py) — NEVER from inside a
    request handler. See the module docstring for why: this does blocking
    network I/O that must never sit on the critical path of answering an
    HTTP request.
    """
    global _client
    client = _connect()
    with _lock:
        _client = client


def get_redis():
    """
    Returns the shared Redis client, or None if Redis isn't configured,
    isn't reachable, or init_redis() (see above) hasn't finished yet.
    Deliberately does NOT attempt a connection itself — safe to call from
    anywhere, including inside a request handler, with zero risk of
    blocking on network I/O. ALWAYS check for None before using the
    result, and wrap actual .get()/.set() calls in their own try/except
    too, since a working connection can still drop later.
    """
    with _lock:
        return _client
