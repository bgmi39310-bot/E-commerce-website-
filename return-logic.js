import { doc, updateDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { sendNotification } from './notif-logic.js';

// ---------- BUYER SIDE ----------
// (Buyer's orders.html now uses a live onSnapshot listener, so a plain
// updateDoc here is enough — the buyer's screen updates automatically.)
export async function submitReturnRequest(db, orderId, reason) {
    if (!reason) { alert("Please select a reason for the return."); return; }
    try {
        await updateDoc(doc(db, "orders", orderId), {
            returnRequested: true,
            returnReason: reason,
            returnStatus: 'Pending',
            returnRequestedAt: new Date()
        });
        alert("Return request submitted. The seller will review it shortly.");
    } catch (error) {
        console.error(error);
        alert("Unable to submit return request right now.");
    }
}

// ---------- SELLER SIDE ----------
let cachedReturns = [];

function renderReturns() {
    const container = document.getElementById('returnsContainer');
    if (!container) return;

    if (cachedReturns.length === 0) {
        container.innerHTML = `<div class="no-data">No return requests right now.</div>`;
        return;
    }

    container.innerHTML = cachedReturns.map(o => {
        const rStatus = o.returnStatus || 'Pending';
        return `
            <div class="order-card">
                <div class="order-info">
                    <h4>📦 ${o.productName || 'Item'} — ₹${o.price || 0}</h4>
                    <p><strong>Buyer:</strong> ${o.buyerName || 'Customer'} &nbsp; <strong>Phone:</strong> ${o.buyerPhone || 'N/A'}</p>
                    <p><strong>Reason:</strong> ${o.returnReason || 'Not specified'}</p>
                    <p><strong>Status:</strong> <span style="font-weight:bold;">${rStatus}</span></p>
                    ${rStatus === 'Pending' ? `
                        <div class="btn-group">
                            <button class="dash-action-btn btn-accept" onclick="approveReturnMain('${o.id}')">✅ Approve Return</button>
                            <button class="dash-action-btn btn-cancel" onclick="rejectReturnMain('${o.id}')">❌ Reject</button>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

export async function loadReturnRequests(db, sellerUid) {
    const container = document.getElementById('returnsContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading return requests...</p>";

    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", sellerUid), where("returnRequested", "==", true));
        const snap = await getDocs(q);

        cachedReturns = [];
        snap.forEach(d => cachedReturns.push({ id: d.id, ...d.data() }));
        cachedReturns.sort((a, b) => {
            const ta = a.returnRequestedAt && a.returnRequestedAt.toDate ? a.returnRequestedAt.toDate() : 0;
            const tb = b.returnRequestedAt && b.returnRequestedAt.toDate ? b.returnRequestedAt.toDate() : 0;
            return tb - ta;
        });

        renderReturns();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load return requests.</p>`;
    }
}

export async function updateReturnStatus(db, orderId, newReturnStatus) {
    try {
        const order = cachedReturns.find(o => o.id === orderId);
        const updateData = { returnStatus: newReturnStatus };
        if (newReturnStatus === 'Approved') updateData.status = 'Returned';
        await updateDoc(doc(db, "orders", orderId), updateData);

        // Decided requests drop off the "pending returns" list — patch locally
        cachedReturns = cachedReturns.filter(o => o.id !== orderId);
        renderReturns();

        alert(`Return request ${newReturnStatus.toLowerCase()}.`);

        if (order && order.buyerUid) {
            sendNotification(db, order.buyerUid, {
                title: `Return ${newReturnStatus}: ${order.productName || 'Your item'}`,
                body: newReturnStatus === 'Approved'
                    ? 'Your return request was approved. Refund will be processed as per the seller\'s policy.'
                    : 'Your return request was rejected by the seller.',
                type: 'return_status',
                link: 'orders.html'
            });
        }
    } catch (error) {
        console.error(error);
        alert("Error updating return request.");
    }
}
