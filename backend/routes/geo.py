"""
PIN code -> Rajya / Zila / Tehsil(Block) / Post Offices (+ approximate centre point).

Why: people should pick their place by typing a 6-digit PIN and tapping their
village from a list, never by typing long names. That removes spelling
mistakes, and gives every post a clean (state, district, block, village) plus
a lat/lng, so "5-10 km ke andar" and "Purab mein 3 km door" become possible.

Data sources (all free, no key):
  * India Post public API  https://api.postalpincode.in/pincode/<pin>
        -> state, district, block, list of post offices for that PIN
  * Zippopotam            https://api.zippopotam.us/in/<pin>      (best effort)
        -> approximate lat/lng of the PIN. Coverage is not guaranteed; when it
           has no answer we simply return lat/lng = null and the app falls back
           to district-level filtering (or the person can tap "📍 meri location").
  * OpenStreetMap Nominatim (fallback only, when India Post is down/slow)
        -> state, district and lat/lng, but NO post-office list, so the person
           types their village by hand. Cached for just 1 day so the proper
           India Post answer replaces it as soon as that service is back.
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
HTTP_TIMEOUT = 15              # India Post is often slow; 6 s was too short
ATTEMPTS = 2
OSM_URL = "https://nominatim.openstreetmap.org/search"
OSM_HEADERS = {"User-Agent": "DesiMarket/1.0 (PIN lookup; contact via site)"}
FALLBACK_CACHE_DAYS = 1
PIN_RE = re.compile(r"^[1-9]\d{5}$")


def valid_pin(pin):
    return bool(PIN_RE.match(str(pin or "")))


def _get_json(url, **kw):
    """GET with one retry. Raises if the service could not be reached / answered badly."""
    last = None
    for _ in range(ATTEMPTS):
        try:
            r = requests.get(url, timeout=HTTP_TIMEOUT, **kw)
            r.raise_for_status()
            return r.json()
        except Exception as e:           # timeout, SSL, 5xx, bad JSON ...
            last = e
    raise last


def _fetch_india_post(pin):
    """dict if found, None if India Post definitively has no such PIN. Raises if it is unreachable."""
    body = _get_json(INDIA_POST_URL.format(pin=pin))
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


def _fetch_osm(pin):
    """Fallback: state / district / lat-lng from OpenStreetMap (no post offices). None if nothing usable."""
    try:
        rows = _get_json(OSM_URL, params={"postalcode": pin, "country": "India", "format": "json",
                                         "addressdetails": 1, "limit": 1}, headers=OSM_HEADERS)
    except Exception:
        logger.exception("OSM fallback failed for %s", pin)
        return None
    if not rows:
        return None
    a = rows[0].get("address") or {}
    state = (a.get("state") or "").strip()
    district = (a.get("state_district") or a.get("county") or a.get("city") or "").strip()
    if not state or not district:
        return None
    block = (a.get("county") or "").strip()
    try:
        lat, lng = round(float(rows[0]["lat"]), 4), round(float(rows[0]["lon"]), 4)
    except (KeyError, TypeError, ValueError):
        lat = lng = None
    return {"state": state, "district": district, "block": block if block.lower() != district.lower() else "",
            "offices": [], "lat": lat, "lng": lng}


def lookup_pincode_ex(pin):
    """
    -> (data | None, status)  status: "ok" | "notfound" (PIN does not exist) | "unavailable" (services down).
    Cached in Firestore: 90 days for India Post answers, 1 day for the OSM fallback.
    """
    if not valid_pin(pin):
        return None, "notfound"
    ref = db.collection("geo_pincodes").document(pin)
    now = datetime.now(timezone.utc)
    try:
        snap = ref.get()
        if snap.exists:
            d = snap.to_dict() or {}
            ttl = FALLBACK_CACHE_DAYS if d.get("source") == "osm" else CACHE_DAYS
            fetched = d.get("fetchedAt")
            if fetched and now - fetched < timedelta(days=ttl):
                return d, "ok"
    except Exception:
        logger.exception("geo cache read failed for %s", pin)

    data, source = None, "indiapost"
    try:
        data = _fetch_india_post(pin)
        if data is None:
            return None, "notfound"
    except Exception:
        logger.exception("India Post lookup failed for %s — trying fallback", pin)
        data = _fetch_osm(pin)
        source = "osm"
        if data is None:
            return None, "unavailable"

    if source == "indiapost":
        lat, lng = _fetch_centre(pin)
        data.update({"lat": lat, "lng": lng})
    data.update({"pin": pin, "source": source, "fetchedAt": now})
    try:
        ref.set(data)
    except Exception:
        logger.exception("geo cache write failed for %s", pin)
    return data, "ok"


def lookup_pincode(pin):
    """Cached lookup. Returns dict or None (unknown PIN or outside services unreachable)."""
    return lookup_pincode_ex(pin)[0]


@geo_bp.route("/pincode/<pin>", methods=["GET"])
@limiter.limit("60 per minute")
def pincode(pin):
    if not valid_pin(pin):
        return jsonify({"error": "6 ank ka sahi PIN code likhiye."}), 400
    d, status = lookup_pincode_ex(pin)
    if status == "notfound":
        return jsonify({"error": "Ye PIN code India Post me nahi mila. Ek baar dobara check kijiye."}), 404
    if status == "unavailable":
        return jsonify({"error": "PIN jaanchne wali service abhi busy hai."}), 503
    return jsonify({"pin": pin, "state": d["state"], "district": d["district"], "block": d.get("block", ""),
                    "offices": d.get("offices", []), "lat": d.get("lat"), "lng": d.get("lng"),
                    "source": d.get("source", "indiapost")})
