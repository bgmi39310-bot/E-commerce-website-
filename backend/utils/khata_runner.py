"""
Monthly khata reminders. A seller can pick a "reminder date" (1-28) on each
customer's khata; on that day (from 9 AM IST) the customer — if they have the
khata linked on their phone and still owe money — gets a notification (and
the bell/push already wired to notifications picks it up). Each account is
reminded at most once per month (lastReminderMonth), so running more often
than needed is harmless.

Runs as a small background thread, the same way utils/subscription_runner.py
does. NOTE: like that runner, it only works while the backend is awake — on a
free Render plan that sleeps when idle, the reminder goes out the next time
the service wakes up the same day (or is skipped if it never does).
"""

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

CHECK_EVERY_SECONDS = 1800
FIRST_CHECK_DELAY_SECONDS = 150
REMIND_FROM_HOUR_IST = 9

_started = False
_lock = threading.Lock()


def _ist_now():
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)


def run_khata_reminders(now_ist=None):
    """One pass. Returns how many customers were reminded."""
    now_ist = now_ist or _ist_now()
    if now_ist.hour < REMIND_FROM_HOUR_IST:
        return 0
    month = now_ist.strftime("%Y-%m")
    per_seller = {}
    sent = 0
    for d in db.collection("khata_accounts").where("reminderDay", "==", now_ist.day).stream():
        a = d.to_dict() or {}
        if a.get("status") == "closed" or a.get("lastReminderMonth") == month:
            continue
        balance = a.get("totalCharged", 0) - a.get("totalPaid", 0)
        d.reference.update({"lastReminderMonth": month})      # mark first: never remind twice
        if balance <= 0 or not a.get("buyerUid"):
            continue
        try:
            db.collection("users").document(a["buyerUid"]).collection("notifications").document().set({
                "title": "📒 Mahine ke hisab ki yaad",
                "body": f"{a.get('shopName')}: aapka Rs {balance / 100:g} baaki hai. Poora hisab Mera Khata me dekhiye.",
                "type": "khata", "link": "khata.html", "read": False,
                "createdAt": datetime.now(timezone.utc),
            })
            sent += 1
            per_seller[a.get("sellerUid")] = per_seller.get(a.get("sellerUid"), 0) + 1
        except Exception:
            logger.exception("Khata reminder failed for account %s", d.id)
    for seller_uid, n in per_seller.items():
        try:
            db.collection("users").document(seller_uid).collection("notifications").document().set({
                "title": "📒 Reminder bhej diye gaye",
                "body": f"{n} grahakon ko mahine ke hisab ki yaad bhej di gayi.",
                "type": "khata", "link": "khata-seller.html", "read": False,
                "createdAt": datetime.now(timezone.utc),
            })
        except Exception:
            logger.exception("Khata reminder summary failed for seller %s", seller_uid)
    return sent


def _loop():
    time.sleep(FIRST_CHECK_DELAY_SECONDS)
    while True:
        try:
            run_khata_reminders()
        except Exception:
            logger.exception("Khata reminder loop error (will keep running)")
        time.sleep(CHECK_EVERY_SECONDS)


def start_khata_runner():
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="khata-runner", daemon=True).start()
    logger.info("Khata reminder runner started (checks every %ss).", CHECK_EVERY_SECONDS)
