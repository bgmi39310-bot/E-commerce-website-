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
    if(status === 'Delivered') document.getElementById('tabDelivered').classList.add('active');
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
                    ${currentStatusFilter === 'Shipped' ? `<p style="color:#6f42c1; font-size:13px;"><strong>🔐 Ask the buyer for their Delivery OTP to confirm handover.</strong></p>` : ''}

                    <div class="btn-group">
                        <a href="tel:${order.buyerPhone}" class="call-btn">📞 Call Buyer</a>
                        ${currentStatusFilter === 'Pending' ? `<button class="dash-action-btn btn-accept" onclick="updateOrderStatus('${order.id}', 'Accepted')">Accept</button>` : ''}
                        ${currentStatusFilter === 'Accepted' ? `<button class="dash-action-btn btn-ship" onclick="markShippedMain('${order.id}')">Mark Shipped</button>` : ''}
                        ${currentStatusFilter === 'Shipped' ? `<button class="dash-action-btn btn-delivered" onclick="confirmDeliveryMain('${order.id}')">✅ Confirm Delivery (Enter OTP)</button>` : ''}
                        ${(currentStatusFilter === 'Pending' || currentStatusFilter === 'Accepted') ? `<button class="dash-action-btn btn-cancel" onclick="updateOrderStatus('${order.id}', 'Cancelled')">Cancel</button>` : ''}
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
        await updateDoc(orderRef, { status: newStatus, [newStatus.toLowerCase() + 'At']: new Date() });
        alert(`Order marked as ${newStatus}!`);
        fetchOrdersCallback(db, uid);
    } catch (error) {
        console.error("Error updating status: ", error);
        alert("Error updating order status.");
    }
}

// Generates a 4-digit delivery OTP when the seller ships the order.
// The OTP is stored on the order and shown ONLY to the buyer (never to the seller ahead of time).
export async function markAsShipped(db, orderId, uid, fetchOrdersCallback) {
    try {
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: 'Shipped', shippedAt: new Date(), deliveryOTP: otp });
        alert("Order marked as Shipped! 🚚\n\nThe buyer will now see a Delivery OTP on their Orders page. Ask them for it when you hand over the package, to confirm delivery.");
        fetchOrdersCallback(db, uid);
    } catch (error) {
        console.error("Error marking shipped:", error);
        alert("Error updating order status.");
    }
}

// Seller must enter the OTP the buyer received to confirm the order was actually delivered.
export async function confirmDelivery(db, orderId, uid, fetchOrdersCallback) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) {
        alert("Order not found. Please refresh and try again.");
        return;
    }

    const enteredOtp = prompt("Enter the 4-digit Delivery OTP given by the buyer:");
    if (enteredOtp === null) return; // seller cancelled the prompt

    if (enteredOtp.trim() !== (order.deliveryOTP || '')) {
        alert("❌ Incorrect OTP. Please ask the buyer again — the order will not be marked delivered until the correct OTP is entered.");
        return;
    }

    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: 'Delivered', deliveredAt: new Date() });
        alert("✅ Delivery confirmed! Order marked as Delivered.");
        fetchOrdersCallback(db, uid);
    } catch (error) {
        console.error("Error confirming delivery:", error);
        alert("Error updating order status.");
    }
}
