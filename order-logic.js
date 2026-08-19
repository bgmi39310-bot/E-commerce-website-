import { collection, getDocs, doc, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let allOrders = [];
let currentStatusFilter = 'Pending';

export async function fetchDashboardOrders(db, uid) {
    const container = document.getElementById('dashboardOrdersContainer');
    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", uid));
        const querySnapshot = await getDocs(q);
        allOrders = [];
        querySnapshot.forEach((docSnap) => {
            allOrders.push({ id: docSnap.id, ...docSnap.data() });
        });
        displayDashboardOrders();
    } catch (error) {
        console.error("Error fetching orders: ", error);
        container.innerHTML = "<p style='color:red;'>Error loading orders.</p>";
    }
}

export function filterOrders(status) {
    currentStatusFilter = status;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if(status === 'Pending') document.getElementById('tabPending').classList.add('active');
    if(status === 'Accepted') document.getElementById('tabAccepted').classList.add('active');
    if(status === 'Shipped') document.getElementById('tabShipped').classList.add('active');
    if(status === 'Cancelled') document.getElementById('tabCancelled').classList.add('active');

    displayDashboardOrders();
}

function displayDashboardOrders() {
    const container = document.getElementById('dashboardOrdersContainer');
    const filtered = allOrders.filter(o => (o.status || 'Pending') === currentStatusFilter);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="no-data">No ${currentStatusFilter} orders found for your account.</div>`;
        return;
    }

    let html = "";
    filtered.forEach(order => {
        html += `
            <div class="order-card">
                <div class="order-info">
                    <h4>📦 ${order.productName || 'Item'} (Qty: ${order.quantity || 1})</h4>
                    <p><strong>Buyer:</strong> ${order.buyerName || 'Customer'}</p>
                    <p><strong>Phone:</strong> ${order.buyerPhone || 'N/A'}</p>
                    <p><strong>Address:</strong> ${order.buyerAddress || 'N/A'}</p>
                    <p><strong>Amount:</strong> ₹${order.price || 0}</p>
                    <p><strong>Status:</strong> <span style="font-weight:bold; color:#007600;">${order.status || 'Pending'}</span></p>
                    
                    <div class="btn-group">
                        <a href="tel:${order.buyerPhone}" class="call-btn">📞 Call Buyer</a>
                        ${currentStatusFilter === 'Pending' ? `<button class="dash-action-btn btn-accept" onclick="updateOrderStatus('${order.id}', 'Accepted')">Accept</button>` : ''}
                        ${currentStatusFilter === 'Accepted' ? `<button class="dash-action-btn btn-ship" onclick="updateOrderStatus('${order.id}', 'Shipped')">Mark Shipped</button>` : ''}
                        ${currentStatusFilter !== 'Cancelled' && currentStatusFilter !== 'Shipped' ? `<button class="dash-action-btn btn-cancel" onclick="updateOrderStatus('${order.id}', 'Cancelled')">Cancel</button>` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

export async function updateOrderStatus(db, orderId, newStatus, uid, fetchOrdersCallback) {
    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: newStatus });
        alert(`Order marked as ${newStatus}!`);
        fetchOrdersCallback(db, uid);
    } catch (error) {
        console.error("Error updating status: ", error);
        alert("Error updating order status.");
    }
}

