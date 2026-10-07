import { collection, query, where, getAggregateFromServer, sum } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Used to read EVERY order a seller has ever received just to add up three
// totals — for a seller with hundreds/thousands of orders over time, that's
// hundreds/thousands of Firestore reads every single time this card loads.
// Firestore's sum() aggregation computes the total server-side and bills
// each query as ~1 read, regardless of how many orders match it — so this
// is now 3 reads total (one per bucket below) no matter how much order
// history a seller has built up.
export async function loadPayoutSummary(db, uid) {
    const container = document.getElementById('payoutContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading earnings...</p>";

    try {
        const base = collection(db, "orders");

        const [deliveredSnap, cancelledSnap, inTransitSnap] = await Promise.all([
            getAggregateFromServer(
                query(base, where("sellerUid", "==", uid), where("status", "==", "Delivered")),
                { total: sum("price") }
            ),
            getAggregateFromServer(
                query(base, where("sellerUid", "==", uid), where("status", "in", ["Cancelled", "Returned"])),
                { total: sum("price") }
            ),
            getAggregateFromServer(
                query(base, where("sellerUid", "==", uid), where("status", "in", ["Pending", "Accepted", "Shipped"])),
                { total: sum("price") }
            ),
        ]);

        const delivered = deliveredSnap.data().total || 0;
        const cancelled = cancelledSnap.data().total || 0;
        const inTransit = inTransitSnap.data().total || 0;

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
