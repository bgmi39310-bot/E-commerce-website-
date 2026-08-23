import { doc, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Decreases stock for a SPECIFIC variant option (e.g. "Medium" size) of a product,
// using a transaction so concurrent buyers can never oversell a variant.
export async function decrementVariantStock(db, productId, variantOptionName, qty) {
    const productRef = doc(db, "vendors", productId);

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(productRef);
        if (!snap.exists()) throw new Error("This product is no longer available.");

        const data = snap.data();
        const variants = Array.isArray(data.variants) ? [...data.variants] : [];
        const idx = variants.findIndex(v => v.name === variantOptionName);

        if (idx === -1) throw new Error(`The selected option "${variantOptionName}" is no longer available.`);

        const currentStock = variants[idx].stock !== undefined ? variants[idx].stock : 0;
        if (currentStock < qty) {
            throw new Error(`Only ${currentStock} left for "${variantOptionName}". Please reduce the quantity.`);
        }

        variants[idx] = { ...variants[idx], stock: currentStock - qty };
        const currentSold = data.unitsSold || 0;
        transaction.update(productRef, { variants, unitsSold: currentSold + qty });
    });
}

// Safely decreases a single product's stock using a transaction, so two buyers
// purchasing at the same moment can never oversell past what's actually available.
export async function decrementStock(db, productId, qty) {
    if (!productId) return; // nothing to decrement for products without an id
    const productRef = doc(db, "vendors", productId);

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(productRef);
        if (!snap.exists()) throw new Error("This product is no longer available.");

        const data = snap.data();
        const currentStock = data.stock !== undefined ? data.stock : 10;

        if (currentStock < qty) {
            throw new Error(`Only ${currentStock} left in stock for "${data.name}". Please reduce the quantity.`);
        }

        const currentSold = data.unitsSold || 0;
        transaction.update(productRef, { stock: currentStock - qty, unitsSold: currentSold + qty });
    });
}

// Decrements stock for every item in a cart. Runs one-by-one so a clear,
// specific error can be shown if any single item doesn't have enough stock.
export async function decrementStockForCart(db, cartItems) {
    for (const item of cartItems) {
        await decrementStock(db, item.id, parseInt(item.qty) || 1);
    }
}
