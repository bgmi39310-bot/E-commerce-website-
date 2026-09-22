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

Only real image files are forwarded — a file's declared mimetype AND its
first few bytes are both checked against known image signatures. The
mimetype alone isn't trustworthy (the browser just echoes whatever the
uploading client claims), so it's a filter, not the security boundary;
matching a real image signature actually restricts what gets sent onward.
"""

import os
import logging
import requests
from flask import Blueprint, request, jsonify

from utils.auth import require_auth
from utils.limiter import limiter

logger = logging.getLogger(__name__)

uploads_bp = Blueprint("uploads", __name__, url_prefix="/api/uploads")

_MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8MB — matches the frontend's own pre-check

# Magic-byte signatures for the image formats we actually expect (product
# photos, shop logos, etc). Checked against the first bytes of the upload
# regardless of what the browser claims the file is.
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg"),                 # JPEG
    (b"\x89PNG\r\n\x1a\n", "image/png"),              # PNG
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),                          # WEBP (RIFF....WEBP)
    (b"BM", "image/bmp"),
)


def _sniff_image_type(head_bytes):
    for signature, mimetype in _IMAGE_SIGNATURES:
        if head_bytes.startswith(signature):
            # WEBP files are RIFF containers also used by WAV/AVI — confirm
            # the "WEBP" tag actually follows before accepting it as one.
            if signature == b"RIFF" and head_bytes[8:12] != b"WEBP":
                continue
            return mimetype
    return None


@uploads_bp.route("/image", methods=["POST"])
@limiter.limit("20 per minute")
@require_auth
def upload_image():
    if "image" not in request.files:
        return jsonify({"error": "No image file provided."}), 400

    file = request.files["image"]
    if not file or not file.filename:
        return jsonify({"error": "No image file provided."}), 400

    if not (file.mimetype or "").startswith("image/"):
        return jsonify({"error": "Only image files can be uploaded."}), 400

    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size > _MAX_UPLOAD_BYTES:
        return jsonify({"error": "Image is too large (max 8MB)."}), 400
    if size == 0:
        return jsonify({"error": "The uploaded file is empty."}), 400

    head = file.read(16)
    file.seek(0)
    if not _sniff_image_type(head):
        return jsonify({"error": "That file doesn't look like a valid image."}), 400

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
