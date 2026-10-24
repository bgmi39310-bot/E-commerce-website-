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


def serve_cached(key, ttl, build):
    """Returns a Flask Response for `build()`'s result (a JSON-able dict).

    `build` is only called when the in-memory copy is missing or older than
    `ttl` seconds. If a refresh fails but an older copy exists, the older
    copy is served instead of an error."""
    now = time.time()
    entry = _store.get(key)

    if entry is None or entry["exp"] <= now:
        with _lock:
            # Re-check: another thread may have refreshed while we waited.
            entry = _store.get(key)
            if entry is None or entry["exp"] <= time.time():
                try:
                    body = json.dumps(build(), default=str).encode("utf-8")
                    entry = {
                        "exp": time.time() + ttl,
                        "body": body,
                        "gz": gzip.compress(body, 5),
                    }
                    _store[key] = entry
                except Exception:
                    if entry is None:
                        raise  # nothing to fall back on — let the normal error handling run
                    logger.exception("Refreshing %s failed; serving the previous copy", key)
                    entry["exp"] = time.time() + 5  # retry in a few seconds

    wants_gzip = "gzip" in (request.headers.get("Accept-Encoding") or "").lower()
    resp = Response(entry["gz"] if wants_gzip else entry["body"], mimetype="application/json")
    if wants_gzip:
        resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    resp.headers["Cache-Control"] = f"public, max-age={ttl}"
    return resp
