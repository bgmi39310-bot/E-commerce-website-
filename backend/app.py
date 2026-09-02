import os
from flask import Flask, jsonify
from flask_cors import CORS

from routes.payments import payments_bp
from routes.admin import admin_bp
from routes.cron import cron_bp


def create_app():
    app = Flask(__name__)

    allowed_origins = [
        origin.strip()
        for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    CORS(app, origins=allowed_origins or "*", supports_credentials=False)

    app.register_blueprint(payments_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(cron_bp)

    @app.route("/")
    @app.route("/api/health")
    def health():
        return jsonify({"status": "ok", "service": "vande-market-backend"})

    @app.errorhandler(404)
    def not_found(_e):
        return jsonify({"error": "Not found"}), 404

    @app.errorhandler(500)
    def server_error(e):
        app.logger.exception(e)
        return jsonify({"error": "Internal server error"}), 500

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
