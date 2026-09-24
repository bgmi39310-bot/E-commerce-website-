import os
import logging
import threading
from flask import Flask, jsonify
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

from routes.payments import payments_bp
from routes.admin import admin_bp
from routes.cron import cron_bp
from routes.uploads import uploads_bp
from routes.account import account_bp
from routes.products import products_bp
from utils.cache import init_redis
from utils.limiter import limiter
from utils.product_sync import start_product_sync

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_app():
    app = Flask(__name__)

    # Render (like most hosts) puts this app behind a reverse proxy, so
    # request.remote_addr would otherwise be the PROXY's IP for every
    # single visitor — useless for both logging and the IP-based rate
    # limiting below. ProxyFix reads the real client IP back out of the
    # X-Forwarded-For header the proxy sets. x_for=1 trusts exactly one
    # proxy hop, matching Render's setup.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)

    allowed_origins = [
        origin.strip()
        for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if not allowed_origins:
        # Falling back to "*" isn't wrong for local development, but it's
        # easy to forget to set ALLOWED_ORIGINS when deploying for real —
        # and a silent "*" in production means ANY website can call this
        # API using a signed-in visitor's browser session. Make that loud
        # instead of silent. See backend/.env.example.
        logger.warning(
            "ALLOWED_ORIGINS is not set — CORS is falling back to '*' (any "
            "origin allowed). This is fine for local development, but set "
            "ALLOWED_ORIGINS to your real frontend URL(s) before deploying."
        )
    CORS(app, origins=allowed_origins or "*", supports_credentials=False)

    limiter.init_app(app)

    app.register_blueprint(payments_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(cron_bp)
    app.register_blueprint(uploads_bp)
    app.register_blueprint(account_bp)
    app.register_blueprint(products_bp)

    def _startup_background_tasks():
        # Both of these do blocking network I/O (connecting to Redis, then
        # attaching the Firestore watch) — run them here, in ONE background
        # thread, one after the other, so:
        #   1. Neither can ever block gunicorn from answering a request —
        #      including its own health check — while the app is starting.
        #      A previous version connected to Redis lazily, INSIDE the
        #      first request that needed it; when that connection hung,
        #      the whole request hung with it, and gunicorn's worker
        #      timeout eventually SIGKILLed the worker outright (seen as
        #      "Internal Server Error" on every /api/products request).
        #      See utils/cache.py's module docstring for the full story.
        #   2. start_product_sync() runs AFTER init_redis() finishes (not
        #      in a separate, racing thread) so it always sees Redis's
        #      final connected/not-connected state, rather than possibly
        #      checking get_redis() before the connection attempt (which
        #      can take a couple of seconds) has completed.
        init_redis()
        start_product_sync()

    threading.Thread(target=_startup_background_tasks, daemon=True).start()

    @app.route("/")
    @app.route("/api/health")
    def health():
        return jsonify({"status": "ok", "service": "vande-market-backend"})

    @app.errorhandler(404)
    def not_found(_e):
        return jsonify({"error": "Not found"}), 404

    @app.errorhandler(429)
    def rate_limited(e):
        return jsonify({"error": "Too many requests — please slow down and try again shortly."}), 429

    @app.errorhandler(500)
    def server_error(e):
        app.logger.exception(e)
        return jsonify({"error": "Internal server error"}), 500

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
