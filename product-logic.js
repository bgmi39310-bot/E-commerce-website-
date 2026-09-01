import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isPremiumSeller, countSellerProducts, FREE_TIER_LIMITS } from './premium-logic.js';
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';

// Keeps track of the active listener so we never stack up duplicate onSnapshot
// subscriptions (which would waste Firestore reads) if this gets called more than once.
let unsubscribeMyProducts = null;

const LOW_STOCK_THRESHOLD = 5;
// Tracks each product's previous stock level so we only alert ONCE when it
// crosses below the threshold, not on every single snapshot re-render.
const previousStockLevels = {};

export async function addProductToFirebase(db, currentLoggedInUser, fetchProductsCallback) {
    if (!currentLoggedInUser) return;

    const name = document.getElementById('pName').value.trim();
    const priceVal = document.getElementById('pPrice').value.trim();
    const imageUrl = document.getElementById('pImageFile').value.trim();
    const imageUrl2 = document.getElementById('pImageFile2').value.trim();
    const imageUrl3 = document.getElementById('pImageFile3').value.trim();
    const imageUrl4 = document.getElementById('pImageFile4').value.trim();
    const stockVal = document.getElementById('pStock').value.trim();
    const sizesVal = document.getElementById('pSizes').value.trim();
    const categoryVal = document.getElementById('pCategory').value;
    const colorsVal = document.getElementById('pColors').value.trim();

    if (!name || !priceVal) { showToast("Please enter Product Name and Price!", 'error'); return; }

    // ---------- Free vs Premium limits ----------
    const premium = await isPremiumSeller(db, currentLoggedInUser.uid);
    if (!premium) {
        const currentCount = await countSellerProducts(db, currentLoggedInUser.uid);
        if (currentCount >= FREE_TIER_LIMITS.maxProducts) {
            showToast(`Free sellers can list up to ${FREE_TIER_LIMITS.maxProducts} products. Upgrade to Premium for unlimited listings!`, 'error');
            return;
        }
    }

    const shopNameVal = document.getElementById('shopName').value.trim();
    if (!shopNameVal) { showToast("Please save Shop Profile first!", 'error'); return; }

    const defaultImg = "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&auto=format&fit=crop&q=80";
    let imagesArray = [imageUrl, imageUrl2, imageUrl3, imageUrl4].filter(url => url !== '');
    if (!premium && imagesArray.length > FREE_TIER_LIMITS.maxPhotosPerProduct) {
        imagesArray = imagesArray.slice(0, FREE_TIER_LIMITS.maxPhotosPerProduct);
    }
    if (imagesArray.length === 0) imagesArray.push(defaultImg);

    try {
        await addDoc(collection(db, "vendors"), {
            name: name,
            price: Number(priceVal),
            unit: document.getElementById('pUnit').value,
            material: document.getElementById('pMaterial').value.trim() || "100% Original",
            warranty: document.getElementById('pWarranty').value.trim() || "Verified Quality",
            image: imagesArray[0],
            images: imagesArray,
            description: document.getElementById('pDesc').value.trim() || `${name} available in best quality.`,
            shopName: shopNameVal,
            sellerUid: currentLoggedInUser.uid,
            stock: stockVal === '' ? 10 : Number(stockVal),
            sizes: sizesVal ? sizesVal.split(',').map(s => s.trim()).filter(s => s) : [],
            category: categoryVal || 'other',
            colors: colorsVal ? colorsVal.split(',').map(c => c.trim()).filter(c => c) : [],
            createdAt: new Date()
        });

        showToast("Product Added Successfully to Database! 🎉");
        document.getElementById('pName').value = '';
        document.getElementById('pPrice').value = '';
        document.getElementById('pMaterial').value = '';
        document.getElementById('pWarranty').value = '';
        document.getElementById('pImageFile').value = '';
        document.getElementById('pImageFile2').value = '';
        document.getElementById('pImageFile3').value = '';
        document.getElementById('pImageFile4').value = '';
        document.getElementById('pDesc').value = '';
        document.getElementById('pStock').value = '';
        document.getElementById('pSizes').value = '';
        document.getElementById('pCategory').value = '';
        document.getElementById('pColors').value = '';

        fetchProductsCallback(currentLoggedInUser.uid);
    } catch (error) {
        console.error("Error adding product: ", error);
        showToast("Error: " + error.message, 'error');
    }
}

export function stopListeningToMyProducts() {
    if (unsubscribeMyProducts) {
        unsubscribeMyProducts();
        unsubscribeMyProducts = null;
    }
}

export function fetchMyListedProducts(db, uid, onLowStockUpdate) {
    const container = document.getElementById('myProductsContainer');
    container.innerHTML = "<p>Loading your products...</p>";

    // Stop any previous listener before starting a new one
    if (unsubscribeMyProducts) {
        unsubscribeMyProducts();
        unsubscribeMyProducts = null;
    }

    const q = query(collection(db, "vendors"), where("sellerUid", "==", uid));

    unsubscribeMyProducts = onSnapshot(q, (querySnapshot) => {
        if (querySnapshot.empty) {
            container.innerHTML = "<div class='no-data'>No products listed by you yet.</div>";
            if (onLowStockUpdate) onLowStockUpdate([]);
            return;
        }

        let html = "";
        const lowStockList = [];

        querySnapshot.forEach((docSnap) => {
            const prod = docSnap.data();
            const stock = prod.stock !== undefined ? prod.stock : 10;
            const outOfStock = stock <= 0;
            const isLow = stock > 0 && stock <= LOW_STOCK_THRESHOLD;

            let stockTag;
            if (outOfStock) stockTag = '<span class="stock-tag out">Out of Stock</span>';
            else if (isLow) stockTag = `<span class="stock-tag low">⚠️ Only ${stock} left</span>`;
            else stockTag = `<span class="stock-tag in">${stock} in stock</span>`;

            if (outOfStock || isLow) {
                lowStockList.push({ id: docSnap.id, name: prod.name, stock });
            }

            // Fire a one-time browser notification only when stock NEWLY crosses
            // into low/out territory (not on every re-render of the same value).
            const prevStock = previousStockLevels[docSnap.id];
            if (prevStock !== undefined && prevStock > LOW_STOCK_THRESHOLD && (outOfStock || isLow)) {
                if ("Notification" in window && Notification.permission === "granted") {
                    new Notification("⚠️ Low Stock Alert", {
                        body: `${prod.name} is ${outOfStock ? 'out of stock' : 'running low (' + stock + ' left)'}.`
                    });
                }
            }
            previousStockLevels[docSnap.id] = stock;
            myProductsCache[docSnap.id] = { id: docSnap.id, ...prod };

            html += `
                <div class="product-item-card">
                    <div style="display: flex; gap: 15px; align-items: center;">
                        <img src="${prod.image || 'https://via.placeholder.com/60'}" class="product-thumb" alt="Product">
                        <div class="product-info">
                            <h4>${escapeHtml(prod.name)} ${stockTag}</h4>
                            <p><strong>Price:</strong> ₹${prod.price} (${escapeHtml(prod.unit || 'Per Piece')})</p>
                            <p style="font-size:12px; color:#888;">👁️ ${prod.views || 0} views &nbsp; | &nbsp; 🛒 ${prod.unitsSold || 0} sold</p>
                        </div>
                    </div>
                    <div class="btn-group">
                        <button class="btn-edit" onclick="openEditProductFromCache('${docSnap.id}')">✏️ Edit</button>
                        <button class="btn-delete" onclick="deleteProduct('${docSnap.id}')">🗑️ Delete</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        if (onLowStockUpdate) onLowStockUpdate(lowStockList);
    }, (error) => {
        console.error("Error loading products: ", error);
        container.innerHTML = "<p style='color:red;'>Error loading your products.</p>";
    });
}

// Keeps the seller's own products around in module scope so the Edit button
// can hand the full product object to the modal without needing to re-fetch
// it or embed a fragile JSON blob inside an HTML attribute.
const myProductsCache = {};

window.openEditProductFromCache = function(productId) {
    const product = myProductsCache[productId];
    if (product) openEditProductModal(product);
};

let editingProductId = null;

// Opens the Edit Product modal pre-filled with everything about this
// product (not just price/stock) — name, category, unit, description,
// material, warranty, sizes, colors, and all 4 photos.
export function openEditProductModal(product) {
    editingProductId = product.id;
    document.getElementById('epId').value = product.id;
    document.getElementById('epName').value = product.name || '';
    document.getElementById('epPrice').value = product.price || '';
    document.getElementById('epCategory').value = product.category || '';
    document.getElementById('epUnit').value = product.unit || 'Per Piece';
    document.getElementById('epMaterial').value = product.material || '';
    document.getElementById('epWarranty').value = product.warranty || '';
    document.getElementById('epStock').value = product.stock !== undefined ? product.stock : 10;
    document.getElementById('epSizes').value = (product.sizes || []).join(', ');
    document.getElementById('epColors').value = (product.colors || []).join(', ');
    document.getElementById('epDesc').value = product.description || '';
    const images = product.images && product.images.length ? product.images : [product.image || ''];
    document.getElementById('epImageFile').value = images[0] || '';
    document.getElementById('epImageFile2').value = images[1] || '';
    document.getElementById('epImageFile3').value = images[2] || '';
    document.getElementById('epImageFile4').value = images[3] || '';
    document.getElementById('editProductModal').classList.add('active');
}

export function closeEditProductModal() {
    document.getElementById('editProductModal').classList.remove('active');
    editingProductId = null;
}

export async function saveProductEdits(db, uid, fetchProductsCallback) {
    const productId = document.getElementById('epId').value || editingProductId;
    if (!productId) return;

    const name = document.getElementById('epName').value.trim();
    const priceVal = document.getElementById('epPrice').value.trim();
    if (!name || !priceVal) { showToast("Please enter Product Name and Price!", 'error'); return; }

    const stockVal = document.getElementById('epStock').value.trim();
    const sizesVal = document.getElementById('epSizes').value.trim();
    const colorsVal = document.getElementById('epColors').value.trim();

    const imageUrl = document.getElementById('epImageFile').value.trim();
    const imageUrl2 = document.getElementById('epImageFile2').value.trim();
    const imageUrl3 = document.getElementById('epImageFile3').value.trim();
    const imageUrl4 = document.getElementById('epImageFile4').value.trim();
    const defaultImg = "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&auto=format&fit=crop&q=80";
    let imagesArray = [imageUrl, imageUrl2, imageUrl3, imageUrl4].filter(url => url !== '');
    if (imagesArray.length === 0) imagesArray.push(defaultImg);

    try {
        await updateDoc(doc(db, "vendors", productId), {
            name: name,
            price: Number(priceVal),
            unit: document.getElementById('epUnit').value,
            category: document.getElementById('epCategory').value || 'other',
            material: document.getElementById('epMaterial').value.trim() || "100% Original",
            warranty: document.getElementById('epWarranty').value.trim() || "Verified Quality",
            image: imagesArray[0],
            images: imagesArray,
            description: document.getElementById('epDesc').value.trim() || `${name} available in best quality.`,
            stock: stockVal === '' ? 0 : Number(stockVal),
            sizes: sizesVal ? sizesVal.split(',').map(s => s.trim()).filter(s => s) : [],
            colors: colorsVal ? colorsVal.split(',').map(c => c.trim()).filter(c => c) : []
        });
        showToast("Product updated successfully! 🎉");
        closeEditProductModal();
        fetchProductsCallback(uid);
    } catch (error) {
        showToast("Error updating product: " + error.message, 'error');
    }
}

export async function deleteProduct(db, productId, uid, fetchProductsCallback) {
    if (confirm("Are you sure you want to delete this product?")) {
        try {
            await deleteDoc(doc(db, "vendors", productId));
            showToast("Product deleted successfully!");
            fetchProductsCallback(uid);
        } catch (error) {
            console.error("Error deleting product: ", error);
            showToast("Error deleting product.", 'error');
        }
    }
}
