import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function loadPayoutSummary(db, uid) {
    const container = document.getElementById('payoutContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading earnings...</p>";

    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", uid));
        const snap = await getDocs(q);

        let delivered = 0, inTransit = 0, cancelled = 0;

        snap.forEach(d => {
            const o = d.data();
            const amount = Number(o.price) || 0;
            if (o.status === 'Delivered') delivered += amount;
            else if (o.status === 'Cancelled') cancelled += amount;
            else inTransit += amount; // Pending / Accepted / Shipped
        });

        container.innerHTML = `
            <div class="payout-grid">
                <div class="payout-card earned">
                    <div class="payout-value">₹${delivered.toFixed(0)}</div>
                    <div class="payout-label">Total Earned (Delivered)</div>
                </div>
                <div class="payout-card pending">
                    <div class="payout-value">₹${inTransit.toFixed(0)}</div>
                    <div class="payout-label">In Progress (Not Yet Delivered)</div>
                </div>
                <div class="payout-card lost">
                    <div class="payout-value">₹${cancelled.toFixed(0)}</div>
                    <div class="payout-label">Cancelled / Returned</div>
                </div>
            </div>
            <p class="payout-note">💡 Since DesiMarket currently uses Cash on Delivery / direct UPI, payments go straight from buyer to you. This is your earnings summary, not a pending transfer from DesiMarket.</p>
        `;
    } catch (error) {
        console.error("Error loading payout summary:", error);
        container.innerHTML = `<p style="color:red;">Unable to load earnings right now.</p>`;
    }
}

