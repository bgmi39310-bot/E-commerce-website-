"""
Proxies image uploads to ImgBB using a server-side API key.

Previously the frontend called ImgBB directly with the API key sitting in
plain JS (imgbb-config.js) — anyone could open dev tools, copy that key,
and use it to burn through the account's free upload quota (or host
unrelated content on it). Now the frontend sends the image file to US, and
WE call ImgBB using a key that only lives in this server's environment
variables. The key is never shipped to the browser at all.

Requires a signed-in user (any authenticated account) so random strangers
can't use this site's backend as a free anonymous image host.
"""

import os
import logging
import requests
from flask import Blueprint, request, jsonify

from utils.auth import require_auth

logger = logging.getLogger(__name__)

uploads_bp = Blueprint("uploads", __name__, url_prefix="/api/uploads")

_MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8MB — matches the frontend's own pre-check


@uploads_bp.route("/image", methods=["POST"])
@require_auth
def upload_image():
    if "image" not in request.files:
        return jsonify({"error": "No image file provided."}), 400

    file = request.files["image"]
    if not file or not file.filename:
        return jsonify({"error": "No image file provided."}), 400

    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size > _MAX_UPLOAD_BYTES:
        return jsonify({"error": "Image is too large (max 8MB)."}), 400

    api_key = os.environ.get("IMGBB_API_KEY", "")
    if not api_key:
        return jsonify({"error": "Image upload isn't configured on the server yet."}), 500

    try:
        resp = requests.post(
            "https://api.imgbb.com/1/upload",
            params={"key": api_key},
            files={"image": (file.filename, file.stream, file.mimetype)},
            timeout=30,
        )
        data = resp.json()
    except Exception as e:
        logger.exception("ImgBB upload failed")
        return jsonify({"error": "Could not reach the image host. Please try again."}), 502

    if not data.get("success"):
        detail = (data.get("error") or {}).get("message") or "Upload failed."
        return jsonify({"error": detail}), 502

    return jsonify({"url": data["data"]["url"]})
