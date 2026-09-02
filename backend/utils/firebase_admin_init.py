"""
Initializes the Firebase Admin SDK exactly once, however the credentials
were supplied (env var JSON string, Render Secret File, or a local file for
development). Every other module imports `db` and `auth` from here instead
of initializing Firebase again — Firebase Admin only allows one app
instance per process.
"""

import os
import json
import firebase_admin
from firebase_admin import credentials, firestore, auth as firebase_auth


def _load_credentials():
    # 1) Render "Secret File" or local dev file at this fixed path.
    secret_file_path = "/etc/secrets/firebase-service-account.json"
    if os.path.exists(secret_file_path):
        return credentials.Certificate(secret_file_path)

    # 2) Raw JSON string in an environment variable.
    raw_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if raw_json:
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_JSON is set but isn't valid JSON. "
                "Make sure you pasted the ENTIRE downloaded service account "
                "file content, on one line."
            ) from e
        return credentials.Certificate(parsed)

    # 3) Standard Google Application Default Credentials env var (a file path).
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return credentials.ApplicationDefault()

    raise RuntimeError(
        "No Firebase service account credentials found. Set "
        "FIREBASE_SERVICE_ACCOUNT_JSON (or a Render Secret File at "
        "/etc/secrets/firebase-service-account.json) — see backend/README.md."
    )


_app = firebase_admin.initialize_app(_load_credentials())

db = firestore.client()
auth = firebase_auth

