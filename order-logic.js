import { collection, onSnapshot, doc, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let allOrders = [];
let currentStatusFilter = 'Pending';
let unsubscribeOrders = null;

// Live listener — once set up, order list AND status changes update automatically
// on screen without ever needing to re-fetch. This is the #1 fix for excess reads.
export function fetchDashboardOrders(db, uid, onOrdersUpdate) {
    const container = document.getElementById('dashboardOrdersContainer');

    if (unsubscribeOrders) {
        unsubscribeOrders();
        unsubscribeOrders = null;
    }

    const q = query(collection(db, "orders"), where("sellerUid", "==", uid));

    unsubscribeOrders = onSnapshot(q, (querySnapshot) => {
        allOrders = [];
        querySnapshot.forEach((docSnap) => {
            allOrders.push({ id: docSnap.id, ...docSnap.data() });
        });
        displayDashboardOrders();
        if (onOrdersUpdate) onOrdersUpdate(allOrders); // lets analytics recompute from the same data, no extra reads
    }, (error) => {
        console.error("Error fetching orders: ", error);
        container.innerHTML = "<p style='color:red;'>Error loading orders.</p>";
    });
}

export function stopListeningToOrders() {
    if (unsubscribeOrders) {
        unsubscribeOrders();
        unsubscribeOrders = null;
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
                    ${(order.selectedSize || order.selectedColor) ? `<p style="color:#6f42c1; font-weight:600;">${order.selectedSize ? 'Size: ' + order.selectedSize + ' ' : ''}${order.selectedColor ? 'Color: ' + order.selectedColor : ''}</p>` : ''}
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

// NOTE: these action functions no longer take/call a "refetch" callback.
// The onSnapshot listener above already picks up the change automatically.
export async function updateOrderStatus(db, orderId, newStatus) {
    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: newStatus, [newStatus.toLowerCase() + 'At']: new Date() });
    } catch (error) {
        console.error("Error updating status: ", error);
        alert("Error updating order status.");
    }
}

export async function markAsShipped(db, orderId) {
    try {
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: 'Shipped', shippedAt: new Date(), deliveryOTP: otp });
        alert("Order marked as Shipped! 🚚\n\nThe buyer will now see a Delivery OTP on their Orders page. Ask them for it when you hand over the package, to confirm delivery.");
    } catch (error) {
        console.error("Error marking shipped:", error);
        alert("Error updating order status.");
    }
}

export async function confirmDelivery(db, orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) {
        alert("Order not found. Please try again.");
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
    } catch (error) {
        console.error("Error confirming delivery:", error);
        alert("Error updating order status.");
    }
}
