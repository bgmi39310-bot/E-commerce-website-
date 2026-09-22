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

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=os.environ.get("REDIS_URL") or "memory://",
    # No default_limits — each route opts in explicitly with its own
    # @limiter.limit(...) so this can't silently throttle an endpoint
    # nobody intended to rate-limit.
    default_limits=[],
)

