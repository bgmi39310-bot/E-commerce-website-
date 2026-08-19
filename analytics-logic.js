import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function loadAnalytics(db, uid) {
    const container = document.getElementById('analyticsContainer');
    container.innerHTML = "<p>Crunching your shop numbers...</p>";

    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", uid));
        const snapshot = await getDocs(q);

        let orders = [];
        snapshot.forEach(docSnap => orders.push(docSnap.data()));

        if (orders.length === 0) {
            container.innerHTML = `<div class="no-data">No orders yet. Once buyers start ordering, your shop analytics will appear here.</div>`;
            return;
        }

        const counts = { Pending: 0, Accepted: 0, Shipped: 0, Cancelled: 0 };
        let totalRevenue = 0;
        const productFrequency = {};

        orders.forEach(o => {
            const status = o.status || 'Pending';
            if (counts[status] !== undefined) counts[status]++;

            if (status !== 'Cancelled') {
                totalRevenue += Number(o.price) || 0;
            }

            const pname = o.productName || 'Unknown';
            productFrequency[pname] = (productFrequency[pname] || 0) + (Number(o.quantity) || 1);
        });

        const totalOrders = orders.length;
        const topProductEntry = Object.entries(productFrequency).sort((a, b) => b[1] - a[1])[0];
        const topProduct = topProductEntry ? `${topProductEntry[0]} (${topProductEntry[1]} sold)` : 'N/A';

        const maxCount = Math.max(...Object.values(counts), 1);

        container.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-value">₹${totalRevenue.toFixed(0)}</div>
                    <div class="stat-label">Total Revenue</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${totalOrders}</div>
                    <div class="stat-label">Total Orders</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${counts.Pending}</div>
                    <div class="stat-label">Pending Right Now</div>
                </div>
            </div>

            <div class="top-product-box">🏆 Best Selling Product: <strong>${topProduct}</strong></div>

            <div class="bar-chart">
                ${['Pending', 'Accepted', 'Shipped', 'Cancelled'].map(status => `
                    <div class="bar-row">
                        <span class="bar-label">${status}</span>
                        <div class="bar-track">
                            <div class="bar-fill bar-${status}" style="width:${(counts[status] / maxCount * 100).toFixed(0)}%"></div>
                        </div>
                        <span class="bar-count">${counts[status]}</span>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (error) {
        console.error("Error loading analytics:", error);
        container.innerHTML = `<p style="color:red;">Unable to load analytics right now.</p>`;
    }
}

