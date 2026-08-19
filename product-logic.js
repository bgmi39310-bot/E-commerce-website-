import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function addProductToFirebase(db, currentLoggedInUser, fetchProductsCallback) {
    if (!currentLoggedInUser) return;
    
    const name = document.getElementById('pName').value.trim();
    const priceVal = document.getElementById('pPrice').value.trim();
    const imageUrl = document.getElementById('pImageFile').value.trim();

    if (!name || !priceVal) { alert("Please enter Product Name and Price!"); return; }

    const shopNameVal = document.getElementById('shopName').value.trim();
    if (!shopNameVal) { alert("Please save Shop Profile first!"); return; }

    try {
        await addDoc(collection(db, "vendors"), {
            name: name,
            price: Number(priceVal),
            unit: document.getElementById('pUnit').value,
            material: document.getElementById('pMaterial').value.trim() || "100% Original",
            warranty: document.getElementById('pWarranty').value.trim() || "Verified Quality",
            image: imageUrl || "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&auto=format&fit=crop&q=80",
            description: document.getElementById('pDesc').value.trim() || `${name} available in best quality.`,
            shopName: shopNameVal,
            sellerUid: currentLoggedInUser.uid,
            createdAt: new Date()
        });

        alert("Product Added Successfully to Database! 🎉");
        document.getElementById('pName').value = '';
        document.getElementById('pPrice').value = '';
        document.getElementById('pMaterial').value = '';
        document.getElementById('pWarranty').value = '';
        document.getElementById('pImageFile').value = '';
        document.getElementById('pDesc').value = '';
        
        fetchProductsCallback(currentLoggedInUser.uid);
    } catch (error) {
        console.error("Error adding product: ", error);
        alert("Error: " + error.message);
    }
}

export async function fetchMyListedProducts(db, uid) {
    const container = document.getElementById('myProductsContainer');
    container.innerHTML = "<p>Loading your products...</p>";

    try {
        const q = query(collection(db, "vendors"), where("sellerUid", "==", uid));
        const querySnapshot = await getDocs(q);
        
        if (querySnapshot.empty) {
            container.innerHTML = "<div class='no-data'>No products listed by you yet.</div>";
            return;
        }

        let html = "";
        querySnapshot.forEach((docSnap) => {
            const prod = docSnap.data();
            html += `
                <div class="product-item-card">
                    <div style="display: flex; gap: 15px; align-items: center;">
                        <img src="${prod.image || 'https://via.placeholder.com/60'}" class="product-thumb" alt="Product">
                        <div class="product-info">
                            <h4>${prod.name}</h4>
                            <p><strong>Price:</strong> ₹${prod.price} (${prod.unit || 'Per Piece'})</p>
                        </div>
                    </div>
                    <div class="btn-group">
                        <button class="btn-edit" onclick="editProduct('${docSnap.id}', ${prod.price})">✏️ Edit</button>
                        <button class="btn-delete" onclick="deleteProduct('${docSnap.id}')">🗑️ Delete</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error("Error loading products: ", error);
        container.innerHTML = "<p style='color:red;'>Error loading your products.</p>";
    }
}

export function editProduct(db, productId, currentPrice, uid, fetchProductsCallback) {
    const newPrice = prompt("Enter new price:", currentPrice);
    if (newPrice !== null && newPrice.trim() !== "") {
        const updatedPrice = Number(newPrice);
        if (isNaN(updatedPrice)) {
            alert("Please enter a valid number for the price!");
            return;
        }
        updateDoc(doc(db, "vendors", productId), {
            price: updatedPrice
        }).then(() => {
            alert("Product price updated successfully! 🎉");
            fetchProductsCallback(uid);
        }).catch((error) => {
            alert("Error updating price: " + error.message);
        });
    }
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

