// Cart and Wishlist used to live under ONE fixed localStorage key ('cart',
// 'wishlist') for the whole browser. On a shared/family device, or a shop
// kiosk, that meant whoever used the browser last would see — and could
// accidentally check out — the PREVIOUS person's cart or wishlist.
//
// They're now scoped per signed-in user (uid), so each account gets its
// own bucket on the same device/browser. Logged-out visitors share one
// common "guest" bucket, same as the old behaviour, since there's no way
// to tell different logged-out people on the same device apart anyway —
// and it lets someone add to cart before they've logged in without losing it.
import { auth } from './firebase-config.js';

function scopedKey(base) {
    const uid = auth.currentUser ? auth.currentUser.uid : 'guest';
    return `${base}_${uid}`;
}

export function getCart() {
    try { return JSON.parse(localStorage.getItem(scopedKey('cart'))) || []; }
    catch { return []; }
}
export function saveCart(cart) {
    localStorage.setItem(scopedKey('cart'), JSON.stringify(cart));
}
export function clearCart() {
    localStorage.removeItem(scopedKey('cart'));
}

export function getWishlist() {
    try { return JSON.parse(localStorage.getItem(scopedKey('wishlist'))) || []; }
    catch { return []; }
}
export function saveWishlist(list) {
    localStorage.setItem(scopedKey('wishlist'), JSON.stringify(list));
}

// Call once, right after a user signs in (inside onAuthStateChanged), so:
//   1) anything added to cart/wishlist BEFORE logging in on this device
//      follows them into their own account instead of being lost, and
//   2) anyone with a cart/wishlist saved under the OLD unscoped keys
//      (from before this change shipped) doesn't just lose it.
// Never overwrites a cart/wishlist the user already has of their own.
export function migrateLegacyCartData(uid) {
    try {
        const userCartKey = `cart_${uid}`;
        const userWishKey = `wishlist_${uid}`;

        const guestCart = localStorage.getItem('cart_guest');
        if (guestCart && !localStorage.getItem(userCartKey)) localStorage.setItem(userCartKey, guestCart);
        const guestWishlist = localStorage.getItem('wishlist_guest');
        if (guestWishlist && !localStorage.getItem(userWishKey)) localStorage.setItem(userWishKey, guestWishlist);
        localStorage.removeItem('cart_guest');
        localStorage.removeItem('wishlist_guest');

        // One-time migration from the OLD, unscoped keys used before
        // per-user scoping existed.
        const oldCart = localStorage.getItem('cart');
        if (oldCart && !localStorage.getItem(userCartKey)) localStorage.setItem(userCartKey, oldCart);
        const oldWishlist = localStorage.getItem('wishlist');
        if (oldWishlist && !localStorage.getItem(userWishKey)) localStorage.setItem(userWishKey, oldWishlist);
        localStorage.removeItem('cart');
        localStorage.removeItem('wishlist');
    } catch (e) {
        console.error('Cart/wishlist migration failed', e);
    }
}
