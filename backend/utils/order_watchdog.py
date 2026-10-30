"""
Auto-cancels orders the seller never answered.

A buyer who orders and then hears nothing for hours loses trust in the whole
platform. This background thread looks at every order that is still
"Pending" and cancels the ones older than AUTO_CANCEL_MINUTES (default 30):
the stock goes back on the shelf, and both the buyer and the seller are told.

SAFETY: only orders where NO money has changed hands are cancelled — Cash on
Delivery and "UPI on Delivery". Orders already paid online (Razorpay) or by
advance UPI are never touched here, because cancelling those needs a refund
that a person should handle.

NOTE ON THE FREE RENDER PLAN: a sleeping server can't run this. Overdue
orders are cancelled as soon as the server is awake again (it checks a minute
after every start). To make it run on time, keep the server awake (e.g. with
UptimeRobot, or a paid Render plan).

Set AUTO_CANCEL_MINUTES=0 in Render's Environment to switch it off.
"""

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore

from utils.firebase_admin_init import db

logger = logging.getLogger(__name__)

try:
    AUTO_CANCEL_MINUTES = int(os.environ.get("AUTO_CANCEL_MINUTES", "30"))
except ValueError:
    AUTO_CANCEL_MINUTES = 30

CHECK_EVERY_SECONDS = 300      # look every 5 minutes
FIRST_CHECK_DELAY_SECONDS = 60  # and once, a minute after the server starts
_SAFE_PAYMENT_STATUSES = (None, "", "Cash on Delivery", "UPI on Delivery")

_started = False
_lock = threading.Lock()


def _variant_key(size, color):
    if not size and not color:
        return None
    return f"{size or ''}|{color or ''}"


def is_safe_to_cancel(order):
    """True only when no money has been paid for this order yet."""
    return (
        order.get("paymentMethod") in ("COD", "UPI")
        and not order.get("paymentVerified")
        and not order.get("paymentCollected")
        and order.get("paymentStatus") in _SAFE_PAYMENT_STATUSES
    )


def _cancel_order(order_ref):
    """Cancels one order and puts its stock back, in a single transaction.
    Returns the order's data if it was cancelled, or None (e.g. the seller
    accepted it a moment ago)."""

    @firestore.transactional
    def _txn(transaction):
        snap = order_ref.get(transaction=transaction)
        order = (snap.to_dict() or {}) if snap.exists else {}
        if order.get("status") != "Pending" or not is_safe_to_cancel(order):
            return None

        qty = int(order.get("quantity") or 1)
        product_ref = db.collection("vendors").document(order["productId"]) if order.get("productId") else None
        product = None
        if product_ref is not None:
            psnap = product_ref.get(transaction=transaction)  # all reads happen before any write
            product = (psnap.to_dict() or {}) if psnap.exists else None

        if product is not None:
            update = {
                "stock": firestore.Increment(qty),
                "unitsSold": firestore.Increment(-qty),
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
            vkey = _variant_key(order.get("selectedSize"), order.get("selectedColor"))
            vstock = product.get("variantStock")
            if isinstance(vstock, dict) and vkey in vstock:
                new_vstock = dict(vstock)
                new_vstock[vkey] = (vstock[vkey] or 0) + qty
                update["variantStock"] = new_vstock
            transaction.update(product_ref, update)

        transaction.update(order_ref, {
            "status": "Cancelled",
            "cancelledAt": datetime.now(timezone.utc),
            "cancelReason": f"Seller ne {AUTO_CANCEL_MINUTES} minute me accept nahi kiya",
            "autoCancelled": True,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        return order

    return _txn(db.transaction())


def _notify(uid, title, body, link):
    if not uid:
        return
    try:
        db.collection("users").document(uid).collection("notifications").document().set({
            "title": title, "body": body, "type": "order",
            "link": link, "read": False, "createdAt": datetime.now(timezone.utc),
        })
    except Exception:
        logger.exception("Order watchdog: could not notify %s", uid)


def scan_once(now=None):
    """One pass. Returns the ids of the orders it cancelled."""
    if AUTO_CANCEL_MINUTES <= 0:
        return []
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=AUTO_CANCEL_MINUTES)
    cancelled = []
    for snap in db.collection("orders").where("status", "==", "Pending").stream():
        order = snap.to_dict() or {}
        created = order.get("createdAt")
        if created is None or created > cutoff or not is_safe_to_cancel(order):
            continue
        try:
            done = _cancel_order(snap.reference)
        except Exception:
            logger.exception("Order watchdog: could not cancel order %s", snap.id)
            continue
        if not done:
            continue
        cancelled.append(snap.id)
        name = done.get("productName") or "aapka order"
        _notify(done.get("buyerUid"), "Order cancel ho gaya",
                f"Seller ne {AUTO_CANCEL_MINUTES} minute me \"{name}\" accept nahi kiya, isliye order cancel ho gaya. Aap dobara order kar sakte hain.",
                "orders.html")
        _notify(done.get("sellerUid"), "Order apne aap cancel ho gaya",
                f"\"{name}\" ka order {AUTO_CANCEL_MINUTES} minute tak accept nahi hua, isliye cancel kar diya gaya. Naye orders jaldi accept kijiye.",
                "seller-dashboard.html")
        logger.info("Order watchdog: auto-cancelled order %s (seller did not accept in %s min)", snap.id, AUTO_CANCEL_MINUTES)
    return cancelled


def _loop():
    time.sleep(FIRST_CHECK_DELAY_SECONDS)
    while True:
        try:
            scan_once()
        except Exception:
            logger.exception("Order watchdog loop error (will keep running)")
        time.sleep(CHECK_EVERY_SECONDS)


def start_order_watchdog():
    """Starts the background thread once per process."""
    global _started
    if AUTO_CANCEL_MINUTES <= 0:
        logger.info("Order watchdog is switched off (AUTO_CANCEL_MINUTES=0).")
        return
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="order-watchdog", daemon=True).start()
    logger.info("Order watchdog started (cancels unanswered COD/UPI-on-delivery orders after %s min).", AUTO_CANCEL_MINUTES)
