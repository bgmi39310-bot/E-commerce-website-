"""
Sends a phone/browser push notification whenever a new in-app notification is
created for someone (new order, order accepted, low stock, auto-cancel...).

HOW: one live listener watches every NEW document in every user's
`notifications` subcollection (a Firestore "collection group"). For each one
it looks up that user's saved device tokens (users/<uid>/pushTokens) and
sends the same title/body through Firebase Cloud Messaging. Tokens that are
no longer valid (app uninstalled, permission removed) are deleted.

It starts listening from the moment the server starts, so old notifications
are never re-sent. A sleeping free Render server can't send pushes — they
go out while the server is awake (an UptimeRobot ping or a paid plan keeps
it awake).

ONE-TIME FIRESTORE INDEX: this listener needs a "collection group" index on
`notifications.createdAt`. If the Render logs show an error mentioning
"COLLECTION_GROUP" and a long console.firebase.google.com link, open that
link and press "Create index" (same as the earlier index links).

Set PUSH_ENABLED=0 in Render's Environment to switch it off.
"""

import hashlib
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from firebase_admin import messaging

from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

_started = False
_lock = threading.Lock()
_seen = []          # recent notification ids, so one is never sent twice
_SEEN_LIMIT = 500
_watch = None       # keep a reference so the listener isn't garbage-collected


def _short(value, limit):
    return str(value or "")[:limit]


def _send_push(uid, notif):
    if not uid:
        return
    try:
        docs = list(db.collection("users").document(uid).collection("pushTokens").stream())
        tokens = [(d.id, (d.to_dict() or {}).get("token")) for d in docs]
        tokens = [(i, t) for i, t in tokens if t]
        if not tokens:
            return

        message = messaging.MulticastMessage(
            tokens=[t for _, t in tokens][:500],
            data={
                "title": _short(notif.get("title"), 120) or "DesiMarket",
                "body": _short(notif.get("body"), 200),
                "link": _short(notif.get("link"), 200) or "index.html",
            },
            webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "86400"}),
        )
        send = getattr(messaging, "send_each_for_multicast", None) or messaging.send_multicast
        response = send(message)

        # Remove tokens that are no longer valid.
        for (doc_id, _), result in zip(tokens, response.responses):
            if result.success:
                continue
            if isinstance(result.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                db.collection("users").document(uid).collection("pushTokens").document(doc_id).delete()
        logger.info("Push sent to %s: %s ok, %s failed", uid, response.success_count, response.failure_count)
    except Exception:
        logger.exception("Could not send a push notification to %s", uid)


def _on_snapshot(col_snapshot, changes, read_time):
    for change in changes:
        if change.type.name != "ADDED":
            continue
        doc = change.document
        with _lock:
            if doc.id in _seen:
                continue
            _seen.append(doc.id)
            if len(_seen) > _SEEN_LIMIT:
                del _seen[: _SEEN_LIMIT // 2]
        parent_doc = doc.reference.parent.parent  # users/<uid>
        uid = parent_doc.id if parent_doc is not None else None
        # Send on its own thread so the listener is never held up.
        threading.Thread(target=_send_push, args=(uid, doc.to_dict() or {}), daemon=True).start()


def start_push_sender():
    """Starts the live listener once per process."""
    global _started, _watch
    if os.environ.get("PUSH_ENABLED", "1") == "0":
        logger.info("Push sender is switched off (PUSH_ENABLED=0).")
        return
    with _lock:
        if _started:
            return
        _started = True
    try:
        since = datetime.now(timezone.utc) - timedelta(seconds=10)
        query = db.collection_group("notifications").where("createdAt", ">", since)
        _watch = query.on_snapshot(_on_snapshot)
        logger.info("Push sender started (listening for new notifications).")
    except Exception:
        logger.exception("Push sender could not start (the site keeps working without push)")
