"""
In-memory, pre-compressed response cache for the two public listing
endpoints (/api/products and /api/sellers).

WHY: these endpoints are hit by EVERY homepage visitor. Before this, every
request did: Redis GET -> json.loads (decode ~500 products) -> jsonify
(encode them again) -> send uncompressed. On Render's small free CPU that
capped the server at roughly 13 requests per second.

Now each worker process keeps the finished JSON (and a gzip copy) in memory
for a few seconds and simply hands the same bytes to every visitor — no
Redis call, no re-encoding, and a much smaller download. The data is still
refreshed from Redis/Firestore every `ttl` seconds, so a seller's edit
shows up within a few seconds (Redis itself is still invalidated live by
utils/product_sync.py / utils/seller_sync.py, as before).
"""

import gzip
import json
import logging
import threading
import time

from flask import Response, request

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_store = {}  # key -> {"exp": float, "body": bytes, "gz": bytes}


_refreshing = set()  # keys with a background refresh running right now


def _make_entry(build, ttl):
    body = json.dumps(build(), default=str).encode("utf-8")
    return {"exp": time.time() + ttl, "body": body, "gz": gzip.compress(body, 5)}


def _refresh_in_background(key, ttl, build):
    """Rebuilds the copy on a separate thread so no visitor has to wait for
    it. Only one refresh per key runs at a time."""
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)

    def work():
        try:
            _store[key] = _make_entry(build, ttl)
        except Exception:
            logger.exception("Background refresh of %s failed; keeping the previous copy", key)
            old = _store.get(key)
            if old is not None:
                old["exp"] = time.time() + 5  # try again in a few seconds
        finally:
            with _lock:
                _refreshing.discard(key)

    threading.Thread(target=work, daemon=True).start()


def serve_cached(key, ttl, build):
    """Returns a Flask Response for `build()`'s result (a JSON-able dict).

    - First ever request (nothing in memory yet): builds it, that one visitor
      waits.
    - After that, once the copy is older than `ttl` seconds, visitors still
      get the existing copy INSTANTLY while a fresh one is built in the
      background — nobody waits for a refresh.
    - If a refresh fails, the older copy keeps being served."""
    entry = _store.get(key)

    if entry is None:
        with _lock:
            entry = _store.get(key)
            if entry is None:
                entry = _make_entry(build, ttl)  # nothing to fall back on: errors propagate
                _store[key] = entry
    elif entry["exp"] <= time.time():
        _refresh_in_background(key, ttl, build)

    wants_gzip = "gzip" in (request.headers.get("Accept-Encoding") or "").lower()
    resp = Response(entry["gz"] if wants_gzip else entry["body"], mimetype="application/json")
    if wants_gzip:
        resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    resp.headers["Cache-Control"] = f"public, max-age={ttl}"
    return resp
