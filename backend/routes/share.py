"""
Public "share card" link for a shop: GET /share/shop/<seller_uid>

WhatsApp (and most other apps) build a link preview — a small card with a
picture, a title and a line of text — by reading special <meta> tags from the
page the link points to. The shop pages themselves are static files on GitHub
Pages and can't change those tags per shop, so a shared link points HERE
instead. This page:
  1. carries the shop's preview tags (logo, shop name, area), and
  2. instantly sends the person on to the real shop page.

So in WhatsApp the receiver sees a nice card, and tapping it opens the shop.

ONLY details that are already public on the shop page are used: shop name,
logo, city/area, the villages it delivers to and the follower count. Never
phone, address, email, UPI, map location or KYC data.
"""

import html
import json
import logging
import os
from urllib.parse import quote, urlparse

from flask import Blueprint, Response, request

from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

share_bp = Blueprint("share", __name__, url_prefix="/share")


def _allowed_origins():
    return [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]


def _frontend_base(requested):
    """The website's own folder URL (e.g. https://name.github.io/repo/) — taken
    from the link the seller shared, but ONLY if its site is on our allowed
    list. This stops the page being used to bounce people to a stranger's site."""
    allowed = _allowed_origins()
    try:
        u = urlparse(requested or "")
        origin = f"{u.scheme}://{u.netloc}"
        if u.scheme in ("http", "https") and u.netloc and origin in allowed:
            path = u.path if u.path.endswith("/") else u.path.rsplit("/", 1)[0] + "/"
            return origin + path
    except Exception:
        pass
    return (allowed[0] + "/") if allowed else "/"


def _page(title, description, image, canonical, target):
    e = html.escape
    image_tags = (
        f'<meta property="og:image" content="{e(image, quote=True)}">'
        f'<meta name="twitter:image" content="{e(image, quote=True)}">'
        if image else ""
    )
    js_target = json.dumps(target).replace("</", "<\\/")
    return f"""<!DOCTYPE html>
<html lang="hi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(description, quote=True)}">
<meta property="og:site_name" content="DesiMarket">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(title, quote=True)}">
<meta property="og:description" content="{e(description, quote=True)}">
<meta property="og:url" content="{e(canonical, quote=True)}">
{image_tags}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{e(title, quote=True)}">
<meta name="twitter:description" content="{e(description, quote=True)}">
<meta http-equiv="refresh" content="0; url={e(target, quote=True)}">
<script>location.replace({js_target});</script>
<style>body{{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#232f3e}}a{{color:#007185;font-weight:bold}}</style>
</head>
<body>
<h2>{e(title)}</h2>
<p>Dukaan khul rahi hai... <a href="{e(target, quote=True)}">Yahan tap karein</a></p>
</body>
</html>"""


@share_bp.route("/shop/<seller_uid>", methods=["GET"])
@limiter.limit("60 per minute")
def share_shop(seller_uid):
    base = _frontend_base(request.args.get("b"))
    target = f"{base}shop.html?id={quote(seller_uid, safe='')}"
    canonical = f"{request.base_url}?b={quote(base, safe='')}"  # rebuilt from the checked value, never the raw query

    try:
        snap = db.collection("sellers_profiles").document(seller_uid).get()
        d = (snap.to_dict() or {}) if snap.exists else {}
    except Exception:
        logger.exception("share_shop: could not read seller %s", seller_uid)
        d = {}

    shop = str(d.get("shopName") or "DesiMarket Shop")[:80]
    city = str(d.get("city") or "")[:60]
    logo = str(d.get("logo") or "")
    if not logo.startswith("https://"):
        logo = ""
    villages = [str(v)[:40] for v in (d.get("deliveryVillages") or []) if v][:4]
    try:
        followers = max(0, int(d.get("followerCount") or 0))
    except (TypeError, ValueError):
        followers = 0

    parts = []
    if city:
        parts.append(f"📍 {city}")
    if villages:
        parts.append("🚚 " + ", ".join(villages))
    if followers:
        parts.append(f"👥 {followers} followers")
    parts.append("Dukaan dekhne ke liye tap karein 👉")

    resp = Response(_page(f"{shop} — DesiMarket", " · ".join(parts), logo, canonical, target), mimetype="text/html")
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp
