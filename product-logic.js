import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isPremiumSeller, countSellerProducts, FREE_TIER_LIMITS } from './premium-logic.js';

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
    const colorsVal = document.getElementById('pColors').value.trim();

    if (!name || !priceVal) { alert("Please enter Product Name and Price!"); return; }

    // ---------- Free vs Premium limits ----------
    const premium = await isPremiumSeller(db, currentLoggedInUser.uid);
    if (!premium) {
        const currentCount = await countSellerProducts(db, currentLoggedInUser.uid);
        if (currentCount >= FREE_TIER_LIMITS.maxProducts) {
            alert(`Free sellers can list up to ${FREE_TIER_LIMITS.maxProducts} products. Upgrade to Premium for unlimited listings!`);
            return;
        }
    }

    const shopNameVal = document.getElementById('shopName').value.trim();
    if (!shopNameVal) { alert("Please save Shop Profile first!"); return; }

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
            colors: colorsVal ? colorsVal.split(',').map(c => c.trim()).filter(c => c) : [],
            createdAt: new Date()
        });

        alert("Product Added Successfully to Database! 🎉");
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
        document.getElementById('pColors').value = '';

        fetchProductsCallback(currentLoggedInUser.uid);
    } catch (error) {
        console.error("Error adding product: ", error);
        alert("Error: " + error.message);
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

            html += `
                <div class="product-item-card">
                    <div style="display: flex; gap: 15px; align-items: center;">
                        <img src="${prod.image || 'https://via.placeholder.com/60'}" class="product-thumb" alt="Product">
                        <div class="product-info">
                            <h4>${prod.name} ${stockTag}</h4>
                            <p><strong>Price:</strong> ₹${prod.price} (${prod.unit || 'Per Piece'})</p>
                            <p style="font-size:12px; color:#888;">👁️ ${prod.views || 0} views &nbsp; | &nbsp; 🛒 ${prod.unitsSold || 0} sold</p>
                        </div>
                    </div>
                    <div class="btn-group">
                        <button class="btn-edit" onclick="editProduct('${docSnap.id}', ${prod.price}, ${stock})">✏️ Edit</button>
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

export function editProduct(db, productId, currentPrice, currentStock, uid, fetchProductsCallback) {
    const newPrice = prompt("Enter new price:", currentPrice);
    if (newPrice === null || newPrice.trim() === "") return;
    const updatedPrice = Number(newPrice);
    if (isNaN(updatedPrice)) {
        alert("Please enter a valid number for the price!");
        return;
    }

    const newStock = prompt("Enter updated stock quantity:", currentStock !== undefined ? currentStock : 10);
    if (newStock === null || newStock.trim() === "") return;
    const updatedStock = Number(newStock);
    if (isNaN(updatedStock) || updatedStock < 0) {
        alert("Please enter a valid stock quantity (0 or more)!");
        return;
    }

    updateDoc(doc(db, "vendors", productId), {
        price: updatedPrice,
        stock: updatedStock
    }).then(() => {
        alert("Product updated successfully! 🎉");
        fetchProductsCallback(uid);
    }).catch((error) => {
        alert("Error updating product: " + error.message);
    });
}

export async function deleteProduct(db, productId, uid, fetchProductsCallback) {
    if (confirm("Are you sure you want to delete this product?")) {
        try {
            await deleteDoc(doc(db, "vendors", productId));
            alert("Product deleted successfully!");
            fetchProductsCallback(uid);
        } catch (error) {
            console.error("Error deleting product: ", error);
            alert("Error deleting product.");
        }
    }
}
