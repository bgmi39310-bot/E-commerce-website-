"""
PIN code -> Rajya / Zila / Tehsil(Block) / Post Offices (+ approximate centre point).

Why: people should pick their place by typing a 6-digit PIN and tapping their
village from a list, never by typing long names. That removes spelling
mistakes, and gives every post a clean (state, district, block, village) plus
a lat/lng, so "5-10 km ke andar" and "Purab mein 3 km door" become possible.

Data sources (both free, no key):
  * India Post public API  https://api.postalpincode.in/pincode/<pin>
        -> state, district, block, list of post offices for that PIN
  * Zippopotam            https://api.zippopotam.us/in/<pin>      (best effort)
        -> approximate lat/lng of the PIN. Coverage is not guaranteed; when it
           has no answer we simply return lat/lng = null and the app falls back
           to district-level filtering (or the person can tap "📍 meri location").
Every successful lookup is cached in Firestore (geo_pincodes/<pin>) for 90 days,
so these outside services are called at most once per PIN per quarter and the
table slowly becomes our own.

  GET /api/geo/pincode/<pin>
"""

import logging
import re
from datetime import datetime, timedelta, timezone

import requests
from flask import Blueprint, jsonify

from utils.firebase_admin_init import db
from utils.limiter import limiter

logger = logging.getLogger(__name__)

geo_bp = Blueprint("geo", __name__, url_prefix="/api/geo")

INDIA_POST_URL = "https://api.postalpincode.in/pincode/{pin}"
ZIPPO_URL = "https://api.zippopotam.us/in/{pin}"
CACHE_DAYS = 90
HTTP_TIMEOUT = 6
PIN_RE = re.compile(r"^[1-9]\d{5}$")


def valid_pin(pin):
    return bool(PIN_RE.match(str(pin or "")))


def _fetch_india_post(pin):
    r = requests.get(INDIA_POST_URL.format(pin=pin), timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    body = r.json()
    entry = body[0] if isinstance(body, list) and body else {}
    offices = entry.get("PostOffice") or []
    if entry.get("Status") != "Success" or not offices:
        return None
    first = offices[0]
    seen, names = set(), []
    for o in offices:
        n = (o.get("Name") or "").strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            names.append({"name": n, "type": o.get("BranchType") or "",
                          "delivery": o.get("DeliveryStatus") or "", "block": (o.get("Block") or "").strip()})
    return {
        "state": (first.get("State") or "").strip(),
        "district": (first.get("District") or "").strip(),
        "block": (first.get("Block") or "").strip(),
        "offices": names[:60],
    }


def _fetch_centre(pin):
    """Approximate lat/lng of the PIN, or (None, None). Never raises."""
    try:
        r = requests.get(ZIPPO_URL.format(pin=pin), timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return None, None
        places = (r.json() or {}).get("places") or []
        pts = [(float(p["latitude"]), float(p["longitude"])) for p in places if p.get("latitude") and p.get("longitude")]
        if not pts:
            return None, None
        return (round(sum(p[0] for p in pts) / len(pts), 4), round(sum(p[1] for p in pts) / len(pts), 4))
    except Exception:
        return None, None


def lookup_pincode(pin):
    """Cached lookup. Returns dict or None (unknown PIN or outside services unreachable)."""
    if not valid_pin(pin):
        return None
    ref = db.collection("geo_pincodes").document(pin)
    try:
        snap = ref.get()
        if snap.exists:
            d = snap.to_dict() or {}
            fetched = d.get("fetchedAt")
            if fetched and datetime.now(timezone.utc) - fetched < timedelta(days=CACHE_DAYS):
                return d
    except Exception:
        logger.exception("geo cache read failed for %s", pin)
    try:
        data = _fetch_india_post(pin)
    except Exception:
        logger.exception("India Post lookup failed for %s", pin)
        return None
    if not data:
        return None
    lat, lng = _fetch_centre(pin)
    data.update({"pin": pin, "lat": lat, "lng": lng, "fetchedAt": datetime.now(timezone.utc)})
    try:
        ref.set(data)
    except Exception:
        logger.exception("geo cache write failed for %s", pin)
    return data


@geo_bp.route("/pincode/<pin>", methods=["GET"])
@limiter.limit("60 per minute")
def pincode(pin):
    if not valid_pin(pin):
        return jsonify({"error": "6 ank ka sahi PIN code likhiye."}), 400
    d = lookup_pincode(pin)
    if not d:
        return jsonify({"error": "Ye PIN code nahi mila ya abhi jaanch nahi ho paya. Thodi der baad try kijiye."}), 404
    return jsonify({"pin": pin, "state": d["state"], "district": d["district"], "block": d["block"],
                    "offices": d["offices"], "lat": d.get("lat"), "lng": d.get("lng")})
