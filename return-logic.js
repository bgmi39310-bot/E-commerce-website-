import { doc, updateDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ---------- BUYER SIDE ----------
export async function submitReturnRequest(db, orderId, reason, refreshCallback) {
    if (!reason) { alert("Please select a reason for the return."); return; }
    try {
        await updateDoc(doc(db, "orders", orderId), {
            returnRequested: true,
            returnReason: reason,
            returnStatus: 'Pending',
            returnRequestedAt: new Date()
        });
        alert("Return request submitted. The seller will review it shortly.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Unable to submit return request right now.");
    }
}

// ---------- SELLER SIDE ----------
export async function loadReturnRequests(db, sellerUid) {
    const container = document.getElementById('returnsContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading return requests...</p>";

    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", sellerUid), where("returnRequested", "==", true));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="no-data">No return requests right now.</div>`;
            return;
        }

        let orders = [];
        snap.forEach(d => orders.push({ id: d.id, ...d.data() }));
        orders.sort((a, b) => {
            const ta = a.returnRequestedAt && a.returnRequestedAt.toDate ? a.returnRequestedAt.toDate() : 0;
            const tb = b.returnRequestedAt && b.returnRequestedAt.toDate ? b.returnRequestedAt.toDate() : 0;
            return tb - ta;
        });

        let html = "";
        orders.forEach(o => {
            const rStatus = o.returnStatus || 'Pending';
            html += `
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
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load return requests.</p>`;
    }
}

export async function updateReturnStatus(db, orderId, newReturnStatus, refreshCallback) {
    try {
        const updateData = { returnStatus: newReturnStatus };
        if (newReturnStatus === 'Approved') updateData.status = 'Returned';
        await updateDoc(doc(db, "orders", orderId), updateData);
        alert(`Return request ${newReturnStatus.toLowerCase()}.`);
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error updating return request.");
    }
}
