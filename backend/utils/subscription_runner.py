"""
Places the scheduled "roz ka order" (subscription) orders.

Every 10 minutes (and once a minute and a half after the server starts) this
checks all ACTIVE subscriptions. A subscription is due when its next order
date has arrived and it is past its order hour (6 AM India time). For each
due one it:
  1. claims it in a transaction (moves the next date forward FIRST, so the
     same day can never produce two orders, even if two checks overlap),
  2. places a normal order through the same safe code the checkout uses
     (real price, stock reserved, seller notified),
  3. tells the buyer — either "aaj ka order ban gaya" or why it couldn't
     (e.g. the product is out of stock today).

Missed days are NOT made up: if the server was asleep all morning, today's
order is placed when it wakes up, and the next date moves forward from today.

NOTE ON THE FREE RENDER PLAN: a sleeping server can't place orders. Keep it
awake (UptimeRobot every 5 minutes, or a paid plan) so morning orders go out
on time.
"""

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore

from routes.payments import (
    InsufficientStock, OrderError,
    _apply_coupon, _build_verified_items, _create_orders, _reserve_stock,
)
from routes.subscriptions import FREQUENCY_DAYS, ist_now
from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

CHECK_EVERY_SECONDS = 600
FIRST_CHECK_DELAY_SECONDS = 90

_started = False
_lock = threading.Lock()


def is_due(sub, now_ist):
    if sub.get("status") != "active":
        return False
    next_run = sub.get("nextRunDate")
    if not next_run:
        return False
    today = now_ist.date().isoformat()
    if next_run < today:
        return True
    return next_run == today and now_ist.hour >= int(sub.get("runHour") or 6)


def _claim(ref, today_iso, now_ist):
    """Moves the next order date forward in a transaction. Returns the
    subscription data if THIS call got the right to place today's order."""

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        sub = (snap.to_dict() or {}) if snap.exists else {}
        if not is_due(sub, now_ist):
            return None
        step = FREQUENCY_DAYS.get(sub.get("frequency"), 1)
        next_date = (now_ist.date() + timedelta(days=step)).isoformat()
        transaction.update(ref, {"nextRunDate": next_date, "lastRunDate": today_iso})
        return sub

    return _txn(db.transaction())


def _place_order(sub, sub_id):
    items = [{
        "productId": sub["productId"],
        "quantity": sub["quantity"],
        "selectedSize": sub.get("selectedSize"),
        "selectedColor": sub.get("selectedColor"),
    }]
    verified = _build_verified_items(items)
    coupon_seller, coupon_ref = _apply_coupon(verified, None)
    _reserve_stock(verified)
    method = sub.get("paymentMethod") or "COD"
    extra = {
        "paymentVerified": False,
        "paymentStatus": "Cash on Delivery" if method == "COD" else "UPI on Delivery",
        "subscriptionId": sub_id,
    }
    return _create_orders(
        verified, sub["buyerUid"], sub.get("delivery") or {}, None, coupon_seller, coupon_ref,
        payment_method=method, extra_order_fields=extra,
        notif_suffix=" — 🔁 roz ke order (subscription) se",
    )


def _notify_buyer(uid, title, body):
    try:
        db.collection("users").document(uid).collection("notifications").document().set({
            "title": title, "body": body, "type": "order", "link": "subscriptions.html",
            "read": False, "createdAt": datetime.now(timezone.utc),
        })
    except Exception:
        logger.exception("Subscription runner: could not notify %s", uid)


def run_due_subscriptions(now_ist=None):
    """One pass. Returns the subscription ids it placed an order for."""
    now_ist = now_ist or ist_now()
    today = now_ist.date().isoformat()
    placed = []
    for snap in db.collection("subscriptions").where("status", "==", "active").stream():
        if not is_due(snap.to_dict() or {}, now_ist):
            continue
        try:
            sub = _claim(snap.reference, today, now_ist)
        except Exception:
            logger.exception("Subscription runner: could not claim %s", snap.id)
            continue
        if not sub:
            continue

        name = sub.get("productName") or "product"
        try:
            _place_order(sub, snap.id)
            snap.reference.update({"ordersPlaced": firestore.Increment(1), "lastResult": f"{today}: order ban gaya"})
            _notify_buyer(sub["buyerUid"], "🔁 Aaj ka order ban gaya",
                          f"{name} x{sub.get('quantity', 1)} ka order {sub.get('shopName') or 'dukaan'} ko bhej diya gaya hai.")
            placed.append(snap.id)
        except InsufficientStock as e:
            reason = f"'{e.product_name}' stock me nahi hai"
            snap.reference.update({"lastResult": f"{today}: {reason}"})
            _notify_buyer(sub["buyerUid"], "Aaj ka order nahi ban paya", f"{reason}. Agli baari dobara koshish hogi.")
        except OrderError as e:
            snap.reference.update({"lastResult": f"{today}: {e.message}"})
            _notify_buyer(sub["buyerUid"], "Aaj ka order nahi ban paya", f"{e.message}. Subscription check kijiye.")
        except Exception:
            logger.exception("Subscription runner: order failed for %s", snap.id)
            snap.reference.update({"lastResult": f"{today}: kuch gadbad hui, agli baari dobara koshish hogi"})
    return placed


def _loop():
    time.sleep(FIRST_CHECK_DELAY_SECONDS)
    while True:
        try:
            run_due_subscriptions()
        except Exception:
            logger.exception("Subscription runner loop error (will keep running)")
        time.sleep(CHECK_EVERY_SECONDS)


def start_subscription_runner():
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="subscription-runner", daemon=True).start()
    logger.info("Subscription runner started (checks every %ss).", CHECK_EVERY_SECONDS)
