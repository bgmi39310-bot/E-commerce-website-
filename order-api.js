// ============================================================================
// DesiMarket — shared helper for placing orders through the backend.
//
// WHY THIS EXISTS: COD/UPI orders used to be written straight to Firestore
// by the browser, with a `price` field nobody re-checked — so editing that
// value in dev tools (or calling the Firestore SDK directly) could place a
// real order at a fake price. Every order now goes through the backend
// instead, which re-derives price, seller and stock from Firestore itself
// before creating anything. See backend/routes/payments.py for the full
// explanation.
//
// Used by checkout.html (cart checkout) and product.html (Buy Now) for
// COD/UPI orders. The Razorpay flow has its own two-step
// create-order/verify-and-place-order calls (see checkout.html) since real
// money moves through it — this helper only covers the no-payment-gateway
// paths.
// ============================================================================

// Backend URL for the Flask API (payments/admin/cron) — see render.yml.
// Update this if you ever rename the vande-market-api service (its URL
// changes with the name) or move to a custom domain.
export const BACKEND_BASE_URL = 'https://vande-market-api.onrender.com';

// `user` must be the Firebase Auth user object (so we can mint a fresh ID
// token). `order` is { items, delivery, couponCode, paymentMethod }:
//   items:        [{ productId, quantity, selectedSize, selectedColor }, ...]
//   delivery:     { name, phone, address, city }
//   couponCode:   string or null
//   paymentMethod: 'COD' | 'UPI'
// Returns { success, orderIds } on success. Throws an Error with a
// user-facing message on failure (invalid item, out of stock, etc).
export async function placeOrderViaBackend(user, order) {
    const idToken = await user.getIdToken();

    const res = await fetch(`${BACKEND_BASE_URL}/api/payments/place-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify(order)
    });

    let data;
    try {
        data = await res.json();
    } catch (e) {
        data = {};
    }

    if (!res.ok) {
        throw new Error(data.error || 'Could not place order. Please try again.');
    }
    return data;
}

