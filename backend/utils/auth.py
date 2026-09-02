"""
Decorators used to protect backend routes:

  @require_auth        -> caller must send a valid Firebase ID token
                           (any signed-in user, including anonymous).
  @require_admin        -> caller must send a valid Firebase ID token AND
                           their users/{uid} Firestore doc must have
                           isAdmin == true (same field the Firestore security
                           rules already trust for admin access).
  @require_cron_secret  -> for scheduled jobs, which have no user to sign in
                           as; protected by a shared secret header instead.

Both `require_auth` and `require_admin` attach the verified info to Flask's
`g` object as `g.uid` / `g.user`.
"""

import os
from functools import wraps
from flask import request, jsonify, g
from firebase_admin import auth as firebase_auth
from utils.firebase_admin_init import db


def _extract_id_token():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return header[len("Bearer "):].strip()


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _extract_id_token()
        if not token:
            return jsonify({"error": "Missing Authorization: Bearer <idToken> header."}), 401
        try:
            decoded = firebase_auth.verify_id_token(token)
        except Exception as e:
            return jsonify({"error": "Invalid or expired ID token.", "detail": str(e)}), 401
        g.uid = decoded["uid"]
        g.user = decoded
        return fn(*args, **kwargs)
    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _extract_id_token()
        if not token:
            return jsonify({"error": "Missing Authorization: Bearer <idToken> header."}), 401
        try:
            decoded = firebase_auth.verify_id_token(token)
        except Exception as e:
            return jsonify({"error": "Invalid or expired ID token.", "detail": str(e)}), 401

        user_doc = db.collection("users").document(decoded["uid"]).get()
        if not user_doc.exists or not user_doc.to_dict().get("isAdmin"):
            return jsonify({"error": "Admin access required."}), 403

        g.uid = decoded["uid"]
        g.user = decoded
        return fn(*args, **kwargs)
    return wrapper


def require_cron_secret(fn):
    """
    Protects scheduled/cron endpoints with a shared secret instead of a user
    login. Whatever calls this endpoint (Render Cron Job, cron-job.org, etc.)
    must send header:  X-Cron-Secret: <CRON_SECRET value>
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        expected = os.environ.get("CRON_SECRET")
        provided = request.headers.get("X-Cron-Secret")
        if not expected or not provided or provided != expected:
            return jsonify({"error": "Invalid or missing cron secret."}), 401
        return fn(*args, **kwargs)
    return wrapper

