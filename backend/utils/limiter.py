"""
Shared Flask-Limiter instance.

Defined in its own module (rather than inside app.py) so route files like
routes/payments.py and routes/uploads.py can `from utils.limiter import
limiter` and use @limiter.limit(...) without a circular import — app.py is
the only place that calls limiter.init_app(app).

Rate limits here are keyed by IP address, not by logged-in user. That's a
deliberate, known trade-off: reading the real user out of the request
happens inside our own @require_auth decorator, which runs AFTER
Flask-Limiter's check, so a per-user key isn't available at the point
Flask-Limiter needs one without re-verifying the ID token twice per
request. Per-IP is simpler and still stops the main threat this is for —
a script hammering an endpoint in a loop — even though, in principle,
many users behind the same NAT/proxy share a limit. If that ever becomes
a real problem, the fix is to verify the token inside a custom key_func.
"""

import os
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

_redis_url = os.environ.get("REDIS_URL")

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_redis_url or "memory://",
    # Bounds how long Flask-Limiter's OWN Redis connection (separate from
    # the one in utils/cache.py) can take to connect/respond. Without this,
    # a slow/unreachable REDIS_URL could hang the first rate-limited
    # request for however long the OS takes to give up — the same failure
    # mode that got a gunicorn worker SIGKILLed when this happened inside
    # utils/cache.py's old lazy-connect (see that file's docstring). A
    # bounded few-second wait can't trigger that.
    storage_options={"socket_connect_timeout": 3, "socket_timeout": 3} if _redis_url else {},
    # No default_limits — each route opts in explicitly with its own
    # @limiter.limit(...) so this can't silently throttle an endpoint
    # nobody intended to rate-limit.
    default_limits=[],
)
