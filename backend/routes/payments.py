"""
Payment endpoints. Real payment verification MUST happen server-side —
a client can't be trusted to say "yes I paid", since a malicious buyer
could just skip the payment and call the "mark as paid" step directly.

Flow:
  1. Frontend calls POST /api/payments/create-order with the cart total.
     We create a Razorpay Order (server-to-server) and return its ID.
  2. Frontend opens the Razorpay Checkout widget with that order ID.
  3. After the buyer pays, Razorpay gives the frontend a payment ID,
     order ID, and signature. The frontend sends those + the order
     details (cart items, delivery address, etc.) to
     POST /api/payments/verify-and-place-order.
  4. We verify the signature ourselves using the secret key (never
     exposed to the browser). Only if it's genuinely valid do we write
     the order(s) to Firestore — via firebase-admin, which bypasses the
     client security rules entirely, so this is the one place allowed
     to set a trusted "paymentVerified: true" flag.
"""

import os
import hmac
import hashlib
from datetime import datetime, timezone

import razorpay
from flask import Blueprint, request, jsonify, g

from utils.auth import require_auth
from utils.firebase_admin_init import db

payments_bp = Blueprint("payments", __name__, url_prefix="/api/payments")

_razorpay_client = razorpay.Client(
    auth=(os.environ.get("RAZORPAY_KEY_ID", ""), os.environ.get("RAZORPAY_KEY_SECRET", ""))
)


@payments_bp.route("/create-order", methods=["POST"])
@require_auth
def create_order():
    data = request.get_json(silent=True) or {}
    amount_rupees = data.get("amount")
    if not isinstance(amount_rupees, (int, float)) or amount_rupees <= 0:
        return jsonify({"error": "A positive 'amount' (in rupees) is required."}), 400

    amount_paise = int(round(amount_rupees * 100))

    try:
        rp_order = _razorpay_client.order.create({
            "amount": amount_paise,
            "currency": "INR",
            "receipt": f"dm_{g.uid[:12]}_{int(datetime.now(timezone.utc).timestamp())}",
            "notes": {"buyerUid": g.uid},
        })
    except Exception as e:
        return jsonify({"error": "Could not create payment order.", "detail": str(e)}), 502

    return jsonify({
        "razorpayOrderId": rp_order["id"],
        "amount": amount_paise,
        "currency": "INR",
        "keyId": os.environ.get("RAZORPAY_KEY_ID", ""),  # the PUBLIC key — safe to send to the browser
    })


def _signature_is_valid(order_id, payment_id, signature):
    secret = os.environ.get("RAZORPAY_KEY_SECRET", "").encode()
    payload = f"{order_id}|{payment_id}".encode()
    expected = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


@payments_bp.route("/verify-and-place-order", methods=["POST"])
@require_auth
def verify_and_place_order():
    data = request.get_json(silent=True) or {}
    razorpay_order_id = data.get("razorpay_order_id")
    razorpay_payment_id = data.get("razorpay_payment_id")
    razorpay_signature = data.get("razorpay_signature")
    items = data.get("items")  # [{ productId, productName, shopName, sellerUid, price, quantity, selectedSize, selectedColor, returnWindowDays }, ...]
    delivery = data.get("delivery") or {}  # { name, phone, address }

    if not all([razorpay_order_id, razorpay_payment_id, razorpay_signature]):
        return jsonify({"error": "Missing Razorpay payment fields."}), 400
    if not items or not isinstance(items, list):
        return jsonify({"error": "No items to order."}), 400

    if not _signature_is_valid(razorpay_order_id, razorpay_payment_id, razorpay_signature):
        return jsonify({"error": "Payment signature verification failed. This payment was not accepted."}), 400

    # Also confirm the AMOUNT actually paid matches the items being ordered —
    # signature verification alone only proves the payment is genuine, not
    # that its amount matches what's being claimed here.
    try:
        rp_payment = _razorpay_client.payment.fetch(razorpay_payment_id)
    except Exception as e:
        return jsonify({"error": "Could not confirm payment with Razorpay.", "detail": str(e)}), 502

    if rp_payment.get("status") != "captured":
        return jsonify({"error": f"Payment status is '{rp_payment.get('status')}', not captured."}), 400

    paid_paise = rp_payment.get("amount", 0)
    expected_paise = round(sum((item.get("price") or 0) for item in items) * 100)
    if abs(paid_paise - expected_paise) > 1:  # allow 1 paise rounding slack
        return jsonify({"error": "Paid amount does not match the order total."}), 400

    created_order_ids = []
    batch = db.batch()
    now = datetime.now(timezone.utc)

    for item in items:
        order_ref = db.collection("orders").document()
        batch.set(order_ref, {
            "productId": item.get("productId"),
            "productName": item.get("productName"),
            "shopName": item.get("shopName") or "Local Shop",
            "sellerUid": item.get("sellerUid"),
            "returnWindowDays": item.get("returnWindowDays", 7),
            "selectedSize": item.get("selectedSize"),
            "selectedColor": item.get("selectedColor"),
            "price": item.get("price"),
            "quantity": item.get("quantity", 1),
            "buyerUid": g.uid,
            "buyerName": delivery.get("name"),
            "buyerPhone": delivery.get("phone"),
            "buyerAddress": delivery.get("address"),
            "paymentMethod": "Razorpay",
            "paymentVerified": True,
            "razorpayOrderId": razorpay_order_id,
            "razorpayPaymentId": razorpay_payment_id,
            "status": "Pending",
            "createdAt": now,
        })
        created_order_ids.append(order_ref.id)

        # Notify the seller — written in the same shape notif-logic.js
        # already reads on the frontend, so it shows up in their existing
        # notification bell automatically.
        if item.get("sellerUid"):
            notif_ref = db.collection("users").document(item["sellerUid"]).collection("notifications").document()
            batch.set(notif_ref, {
                "title": f"New order: {item.get('productName') or 'Item'} (Qty {item.get('quantity', 1)})",
                "body": f"From {delivery.get('name') or 'a buyer'} — ₹{(item.get('price') or 0):.0f}, payment verified ✅",
                "type": "new_order",
                "link": "seller-dashboard.html",
                "read": False,
                "createdAt": now,
            })

    batch.commit()

    return jsonify({"success": True, "orderIds": created_order_ids})
