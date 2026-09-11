import { doc, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Canonical key for a size/color combination, used to look things up in a
// product's `variantStock` map. Both empty means "no variant" (returns
// null) — a plain product with no sizes/colors at all.
//
// IMPORTANT: this exact format is also used by product-logic.js when
// sellers set up per-variant stock, and by product.html when a buyer
// selects a size/color. All three must stay in agreement.
export function buildVariantKey(size, color) {
    if (!size && !color) return null;
    return `${size || ''}|${color || ''}`;
}

// Safely decreases a single product's stock using a transaction, so two buyers
// purchasing at the same moment can never oversell past what's actually available.
//
// If the product has a `variantStock` map AND the buyer picked a
// size/color combination that's IN that map, the specific combination's
// count is checked and decremented too — not just the overall total — so
// selling out of "Red / M" can't silently keep letting people order it
// just because "Blue / L" still has stock. Sellers who never set up
// per-variant stock are unaffected; only the overall `stock` field is used
// for them, exactly as before.
//
// Returns the LIVE product facts (price, sellerUid, shopName,
// returnWindowDays, name) read inside the same transaction. Callers should
// use these — not a cached cart item — to build the order, so a stale or
// tampered price sitting in localStorage can never end up on a real order.
export async function decrementStock(db, productId, qty, variantKey) {
    if (!productId) return null; // nothing to decrement for products without an id
    const productRef = doc(db, "vendors", productId);
    let liveData = null;

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(productRef);
        if (!snap.exists()) throw new Error("This product is no longer available.");

        const data = snap.data();
        const currentStock = data.stock !== undefined ? data.stock : 10;

        const variantStock = data.variantStock && typeof data.variantStock === 'object' ? { ...data.variantStock } : null;
        const tracksThisVariant = variantStock && variantKey && Object.prototype.hasOwnProperty.call(variantStock, variantKey);

        if (tracksThisVariant) {
            const variantAvailable = variantStock[variantKey];
            if (variantAvailable < qty) {
                throw new Error(`Only ${variantAvailable} left for this option. Please reduce the quantity or pick another size/color.`);
            }
        }
        if (currentStock < qty) {
            throw new Error(`Only ${currentStock} left in stock for "${data.name}". Please reduce the quantity.`);
        }

        const update = { stock: currentStock - qty, unitsSold: (data.unitsSold || 0) + qty };
        if (tracksThisVariant) {
            variantStock[variantKey] = variantStock[variantKey] - qty;
            update.variantStock = variantStock;
        }
        transaction.update(productRef, update);

        liveData = {
            price: data.price !== undefined ? data.price : 0,
            name: data.name,
            sellerUid: data.sellerUid || null,
            shopName: data.shopName || 'Local Shop',
            returnWindowDays: data.returnWindowDays !== undefined ? data.returnWindowDays : 7
        };
    });

    return liveData;
}

// Decrements stock for every item in a cart. Runs one-by-one so a clear,
// specific error can be shown if any single item doesn't have enough stock.
// Returns an array of live product facts (same order as cartItems) — see
// decrementStock() above for why callers should use these instead of the
// cached cart values.
export async function decrementStockForCart(db, cartItems) {
    const results = [];
    for (const item of cartItems) {
        const variantKey = buildVariantKey(item.selectedSize, item.selectedColor);
        const liveData = await decrementStock(db, item.id, parseInt(item.qty) || 1, variantKey);
        results.push(liveData);
    }
    return results;
}

// Gives stock back for one order's worth of quantity — used when an order
// is cancelled, so a cancelled order doesn't leave that stock stuck as
// "sold" forever. Restores both the overall total AND the specific
// size/color combination (if that product tracks per-variant stock),
// mirroring however it was originally decremented.
// Safe to call even if the product/variant has since been deleted — it
// just does nothing in that case rather than throwing, since there's
// nothing left to restore stock on.
export async function restoreStock(db, productId, qty, variantKey) {
    if (!productId || !qty) return;
    const productRef = doc(db, "vendors", productId);

    try {
        await runTransaction(db, async (transaction) => {
            const snap = await transaction.get(productRef);
            if (!snap.exists()) return; // product deleted since — nothing to restore

            const data = snap.data();
            const currentSold = data.unitsSold || 0;
            const currentStock = data.stock !== undefined ? data.stock : 0;
            const update = { stock: currentStock + qty, unitsSold: Math.max(0, currentSold - qty) };

            const variantStock = data.variantStock && typeof data.variantStock === 'object' ? { ...data.variantStock } : null;
            if (variantStock && variantKey && Object.prototype.hasOwnProperty.call(variantStock, variantKey)) {
                variantStock[variantKey] = (variantStock[variantKey] || 0) + qty;
                update.variantStock = variantStock;
            }

            transaction.update(productRef, update);
        });
    } catch (error) {
        // Restoring stock is a best-effort side effect of cancelling — if it
        // fails, the cancellation itself should still go through rather than
        // leaving the buyer stuck. Log it so it can be reconciled manually.
        console.error('Failed to restore stock for', productId, error);
    }
}
