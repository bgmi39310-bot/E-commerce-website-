"""
Scheduled housekeeping tasks. These are plain HTTP endpoints (not "always
running" jobs) protected by a shared secret — see require_cron_secret.
Trigger them periodically using Render's Cron Job service (see render.yaml)
or any external scheduler (cron-job.org, GitHub Actions schedule, etc.)
hitting these URLs with the X-Cron-Secret header.

IMPORTANT / HONEST LIMITATION: a true "cart abandonment reminder" isn't
possible yet, because carts currently live only in each browser's
localStorage — the backend has no way to see what's in someone's cart.
That would need cart data to move into Firestore first. Flagging this
rather than faking it.
"""

from datetime import datetime, timezone, timedelta
from flask import Blueprint, jsonify
from firebase_admin import auth as firebase_auth

from utils.auth import require_cron_secret
from utils.firebase_admin_init import db

cron_bp = Blueprint("cron", __name__, url_prefix="/api/cron")

ANONYMOUS_ACCOUNT_MAX_AGE_DAYS = 30


@cron_bp.route("/cleanup-anonymous-users", methods=["POST"])
@require_cron_secret
def cleanup_anonymous_users():
    """
    Deletes anonymous Firebase Auth accounts that are older than
    ANONYMOUS_ACCOUNT_MAX_AGE_DAYS AND have never placed an order — keeps
    Firebase Auth from accumulating one throwaway account per guest visitor
    forever. Anyone who actually bought something is left untouched even if
    they never made a real account, since their order history depends on
    that UID.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=ANONYMOUS_ACCOUNT_MAX_AGE_DAYS)
    deleted = []
    skipped_has_orders = 0
    checked = 0
    page = firebase_auth.list_users()

    while page:
        for user in page.users:
            checked += 1
            is_anonymous = len(user.provider_data) == 0
            if not is_anonymous:
                continue
            created_at = datetime.fromtimestamp(user.user_metadata.creation_timestamp / 1000, tz=timezone.utc)
            if created_at > cutoff:
                continue

            has_orders = list(db.collection("orders").where("buyerUid", "==", user.uid).limit(1).stream())
            if has_orders:
                skipped_has_orders += 1
                continue

            firebase_auth.delete_user(user.uid)
            deleted.append(user.uid)

        page = page.get_next_page()

    return jsonify({
        "checked": checked,
        "deleted": len(deleted),
        "skippedHadOrders": skipped_has_orders,
    })


@cron_bp.route("/return-window-reminders", methods=["POST"])
@require_cron_secret
def return_window_reminders():
    """
    For orders delivered ~1 day before their return window closes, sends the
    buyer a friendly reminder notification ("last day to request a return")
    — using the same notifications collection the bell already listens to.
    Runs safely more than once a day; skips orders already reminded.
    """
    now = datetime.now(timezone.utc)
    reminded = 0
    checked = 0

    orders = db.collection("orders").where("status", "==", "Delivered").stream()
    for order_doc in orders:
        checked += 1
        order = order_doc.to_dict()
        if order.get("returnReminderSent") or order.get("returnRequested"):
            continue
        return_window_days = order.get("returnWindowDays", 7)
        if not return_window_days or return_window_days <= 0:
            continue
        delivered_at = order.get("deliveredAt")
        if not delivered_at:
            continue
        delivered_dt = delivered_at if isinstance(delivered_at, datetime) else delivered_at.ToDatetime()
        if delivered_dt.tzinfo is None:
            delivered_dt = delivered_dt.replace(tzinfo=timezone.utc)

        days_left = return_window_days - (now - delivered_dt).days
        if days_left != 1:  # only fire the day before it closes
            continue

        buyer_uid = order.get("buyerUid")
        if not buyer_uid:
            continue

        db.collection("users").document(buyer_uid).collection("notifications").add({
            "title": f"Last day to return: {order.get('productName') or 'your item'}",
            "body": "Your return window closes tomorrow. Request a return now if you need one.",
            "type": "return_status",
            "link": "orders.html",
            "read": False,
            "createdAt": now,
        })
        order_doc.reference.set({"returnReminderSent": True}, merge=True)
        reminded += 1

    return jsonify({"checked": checked, "remindersSent": reminded})
