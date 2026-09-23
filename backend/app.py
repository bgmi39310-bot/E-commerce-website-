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

    # Starts the live Firestore -> Redis product cache sync (a no-op if
    # REDIS_URL isn't set — see utils/product_sync.py). Run in a background
    # thread, NOT inline here: connecting to Firestore's watch API + doing
    # the initial sync of every product is a network call that can take a
    # few seconds, and doing it inline delayed create_app() from returning
    # — which delayed this whole worker from being ready to answer
    # anything, including Render's own health check (which only waits 5
    # seconds). Starting it in the background lets Flask begin answering
    # requests immediately; the product cache just finishes warming up a
    # few seconds later instead of blocking startup on it. Safe to call
    # once per worker process; app.py is only ever imported/run once per
    # worker.
    threading.Thread(target=start_product_sync, daemon=True).start()

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
