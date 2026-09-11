"""
Payment endpoints. Real payment verification MUST happen server-side —
a client can't be trusted to say "yes I paid", since a malicious buyer
could just skip the payment and call the "mark as paid" step directly.

Flow:
  1. Frontend calls POST /api/payments/create-order with the cart total.
     We create a Razorpay Order (server-to-server) and return its ID.
  2. Frontend opens the Razorpay Checkout widget with that order ID.
  3. After the buyer pays, Razorpay gives the frontend a payment ID,
     order ID, and signature. The frontend sends those + a bare list of
     { productId, quantity, selectedSize, selectedColor } + a coupon code
     to POST /api/payments/verify-and-place-order.
  4. We verify the signature ourselves using the secret key (never
     exposed to the browser). Only if it's genuinely valid do we write
     the order(s) to Firestore — via firebase-admin, which bypasses the
     client security rules entirely, so this is the one place allowed
     to set a trusted "paymentVerified: true" flag.

IMPORTANT — everything the buyer paid for is re-derived from Firestore
here, not trusted from the request body:
  - product price, name, seller, shop name, return window  -> from
    the `vendors` doc, never from the client.
  - coupon discount                                          -> from the
    `coupons` doc (looked up by code), recomputed the same way the
    frontend UI does, never trusted as a raw discount amount.
  - stock                                                     -> reserved
    (decremented) in ONE Firestore transaction across every item in the
    order, so it can never be oversold, and it only happens here, AFTER
    payment is confirmed captured — never client-side, and never before
    payment succeeds. If stock is insufficient for any item, the entire
    payment is refunded and no order is created.
"""

import os
import hmac
import hashlib
from datetime import datetime, timezone

import razorpay
from flask import Blueprint, request, jsonify, g
from firebase_admin import firestore

from utils.auth import require_auth
from utils.firebase_admin_init import db

payments_bp = Blueprint("payments", __name__, url_prefix="/api/payments")

_razorpay_client = razorpay.Client(
    auth=(os.environ.get("RAZORPAY_KEY_ID", ""), os.environ.get("RAZORPAY_KEY_SECRET", ""))
)


class InsufficientStock(Exception):
    def __init__(self, product_name, available):
        self.product_name = product_name
        self.available = available


@payments_bp.route("/create-order", methods=["POST"])
@require_auth
def create_order():
    data = request.get_json(silent=True) or {}
    amount_rupees = data.get("amount")
    if not isinstance(amount_rupees, (int, float)) or amount_rupees <= 0:
        return jsonify({"error": "A positive 'amount' (in rupees) is required."}), 400

    # Sanity ceiling — catches accidental/garbage amounts (e.g. a client-side
    # unit bug sending paise instead of rupees) before we ever call Razorpay.
    if amount_rupees > 1_000_000:
        return jsonify({"error": "Order amount is unreasonably large."}), 400

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


def _refund_and_fail(payment_id, amount_paise, message):
    """
    Used when we must reject an order AFTER Razorpay has already captured
    payment (we only find out the price doesn't match, or stock ran out,
    once we've looked the real data up in Firestore — which is necessarily
    after the buyer has paid). Refunding here means a rejected order never
    silently keeps the buyer's money.
    """
    try:
        _razorpay_client.payment.refund(payment_id, {"amount": amount_paise})
    except Exception as e:
        return jsonify({
            "error": message + " Automatic refund also failed — please contact "
                     f"support with payment ID {payment_id}.",
            "detail": str(e),
        }), 400
    return jsonify({"error": message + " Your payment has been refunded."}), 400


@payments_bp.route("/verify-and-place-order", methods=["POST"])
@require_auth
def verify_and_place_order():
    data = request.get_json(silent=True) or {}
    razorpay_order_id = data.get("razorpay_order_id")
    razorpay_payment_id = data.get("razorpay_payment_id")
    razorpay_signature = data.get("razorpay_signature")
    items = data.get("items")  # [{ productId, quantity, selectedSize, selectedColor }, ...]
    delivery = data.get("delivery") or {}  # { name, phone, address }
    coupon_code = (data.get("couponCode") or "").strip().upper() or None

    if not all([razorpay_order_id, razorpay_payment_id, razorpay_signature]):
        return jsonify({"error": "Missing Razorpay payment fields."}), 400
    if not items or not isinstance(items, list):
        return jsonify({"error": "No items to order."}), 400

    if not _signature_is_valid(razorpay_order_id, razorpay_payment_id, razorpay_signature):
        return jsonify({"error": "Payment signature verification failed. This payment was not accepted."}), 400

    try:
        rp_payment = _razorpay_client.payment.fetch(razorpay_payment_id)
    except Exception as e:
        return jsonify({"error": "Could not confirm payment with Razorpay.", "detail": str(e)}), 502

    if rp_payment.get("status") != "captured":
        return jsonify({"error": f"Payment status is '{rp_payment.get('status')}', not captured."}), 400

    paid_paise = rp_payment.get("amount", 0)

    # ---------------------------------------------------------------
    # 1) Re-derive every product fact from Firestore. Price, seller,
    #    product name, shop name — none of it is trusted from the client.
    # ---------------------------------------------------------------
    verified_items = []
    for raw in items:
        product_id = raw.get("productId")
        try:
            qty = int(raw.get("quantity") or 1)
        except (TypeError, ValueError):
            qty = 0
        if not product_id or qty <= 0:
            return jsonify({"error": "Invalid item in order."}), 400

        snap = db.collection("vendors").document(product_id).get()
        if not snap.exists:
            return _refund_and_fail(razorpay_payment_id, paid_paise,
                f"Product '{product_id}' is no longer available.")
        pdata = snap.to_dict() or {}

        verified_items.append({
            "productId": product_id,
            "productName": pdata.get("name") or "Item",
            "shopName": pdata.get("shopName") or "Local Shop",
            "sellerUid": pdata.get("sellerUid"),
            "returnWindowDays": pdata.get("returnWindowDays", 7),
            "selectedSize": raw.get("selectedSize"),
            "selectedColor": raw.get("selectedColor"),
            "unitPrice": float(pdata.get("price") or 0),
            "quantity": qty,
        })

    # ---------------------------------------------------------------
    # 2) Re-validate the coupon (if any) and recompute its discount
    #    ourselves — same proportional-share rule the checkout UI uses,
    #    never a discount amount trusted from the client.
    # ---------------------------------------------------------------
    discount_total = 0.0
    coupon_seller = None
    coupon_doc_ref = None
    now = datetime.now(timezone.utc)
    if coupon_code:
        cq = list(
            db.collection("coupons")
              .where("code", "==", coupon_code)
              .where("active", "==", True)
              .limit(1)
              .stream()
        )
        if cq:
            coupon = cq[0].to_dict() or {}
            expiry_date = coupon.get("expiryDate")
            usage_limit = coupon.get("usageLimit")
            used_count = coupon.get("usedCount") or 0
            is_expired = bool(expiry_date) and expiry_date < now.strftime("%Y-%m-%d")
            is_used_up = bool(usage_limit) and used_count >= usage_limit

            if not is_expired and not is_used_up:
                coupon_seller = coupon.get("sellerUid")
                coupon_doc_ref = cq[0].reference
                eligible = sum(
                    i["unitPrice"] * i["quantity"] for i in verified_items
                    if i["sellerUid"] == coupon_seller
                )
                if eligible > 0:
                    value = float(coupon.get("value") or 0)
                    if coupon.get("discountType") == "percent":
                        discount_total = min(eligible * (value / 100), eligible)
                    else:
                        discount_total = min(value, eligible)
        # An invalid/inactive/expired/used-up code is silently ignored (no
        # discount) rather than failing the whole order — the frontend would
        # never have shown it as "applied" if it wasn't valid.

    eligible_subtotal = sum(
        i["unitPrice"] * i["quantity"] for i in verified_items
        if coupon_seller and i["sellerUid"] == coupon_seller
    )
    for i in verified_items:
        line_total = i["unitPrice"] * i["quantity"]
        if coupon_seller and i["sellerUid"] == coupon_seller and eligible_subtotal > 0:
            share = (line_total / eligible_subtotal) * discount_total
            line_total = max(0.0, line_total - share)
        i["finalPrice"] = round(line_total, 2)

    expected_paise = round(sum(i["finalPrice"] for i in verified_items) * 100)

    # ---------------------------------------------------------------
    # 3) The amount actually paid must match what we independently
    #    computed from real product prices + real coupon math.
    # ---------------------------------------------------------------
    if abs(paid_paise - expected_paise) > 1:  # allow 1 paise rounding slack
        return _refund_and_fail(razorpay_payment_id, paid_paise,
            "Paid amount does not match the verified order total.")

    # ---------------------------------------------------------------
    # 4) Reserve stock for every item in ONE Firestore transaction, so
    #    concurrent buyers can never oversell, and nothing is decremented
    #    until we're past every check above. If any item is short, the
    #    WHOLE payment is refunded and nothing is created — better than
    #    silently keeping money for something we can't fulfil.
    # ---------------------------------------------------------------
    product_refs = [db.collection("vendors").document(i["productId"]) for i in verified_items]

    def _variant_key(size, color):
        if not size and not color:
            return None
        return f"{size or ''}|{color or ''}"

    @firestore.transactional
    def _reserve_stock(transaction):
        snaps = [ref.get(transaction=transaction) for ref in product_refs]
        updates = []
        for ref, i, snap in zip(product_refs, verified_items, snaps):
            pdata = snap.to_dict() or {} if snap.exists else {}
            current_stock = pdata.get("stock", 0)
            if current_stock < i["quantity"]:
                raise InsufficientStock(i["productName"], current_stock)

            update = {
                "stock": firestore.Increment(-i["quantity"]),
                "unitsSold": firestore.Increment(i["quantity"]),
            }

            # If this product tracks stock per size/color combination, check
            # AND decrement that specific combination too — not just the
            # overall total — so selling out of one size/color can't
            # silently keep letting people order it via another combo that
            # still has stock.
            variant_key = _variant_key(i.get("selectedSize"), i.get("selectedColor"))
            variant_stock = pdata.get("variantStock")
            if isinstance(variant_stock, dict) and variant_key in variant_stock:
                available = variant_stock[variant_key]
                if available < i["quantity"]:
                    label = f"{i['productName']} ({variant_key.replace('|', ' / ').strip(' /')})"
                    raise InsufficientStock(label, available)
                new_variant_stock = dict(variant_stock)
                new_variant_stock[variant_key] = available - i["quantity"]
                update["variantStock"] = new_variant_stock

            updates.append((ref, update))

        for ref, update in updates:
            transaction.update(ref, update)

    try:
        _reserve_stock(db.transaction())
    except InsufficientStock as e:
        return _refund_and_fail(razorpay_payment_id, paid_paise,
            f"'{e.product_name}' only has {e.available} left in stock.")

    # ---------------------------------------------------------------
    # 5) Stock is reserved and payment is verified — now create the
    #    orders + seller notifications, all using server-verified data.
    # ---------------------------------------------------------------
    created_order_ids = []
    batch = db.batch()

    for item in verified_items:
        order_ref = db.collection("orders").document()
        batch.set(order_ref, {
            "productId": item["productId"],
            "productName": item["productName"],
            "shopName": item["shopName"],
            "sellerUid": item["sellerUid"],
            "returnWindowDays": item["returnWindowDays"],
            "selectedSize": item["selectedSize"],
            "selectedColor": item["selectedColor"],
            "price": item["finalPrice"],
            "quantity": item["quantity"],
            "couponCode": coupon_code if (coupon_seller and item["sellerUid"] == coupon_seller) else None,
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

        if item["sellerUid"]:
            notif_ref = db.collection("users").document(item["sellerUid"]).collection("notifications").document()
            batch.set(notif_ref, {
                "title": f"New order: {item['productName']} (Qty {item['quantity']})",
                "body": f"From {delivery.get('name') or 'a buyer'} — ₹{item['finalPrice']:.0f}, payment verified ✅",
                "type": "new_order",
                "link": "seller-dashboard.html",
                "read": False,
                "createdAt": now,
            })

    if coupon_doc_ref and coupon_seller and any(i["sellerUid"] == coupon_seller for i in verified_items):
        batch.update(coupon_doc_ref, {"usedCount": firestore.Increment(1)})

    batch.commit()

    return jsonify({"success": True, "orderIds": created_order_ids})
