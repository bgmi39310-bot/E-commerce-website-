import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// This is only called when the seller explicitly clicks "Download Report" —
// a one-time on-demand read is fine here since it's a deliberate user action,
// not something that should run automatically on every page interaction.
export async function downloadSalesReport(db, uid) {
    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", uid));
        const snap = await getDocs(q);

        if (snap.empty) {
            alert("No orders yet to generate a report.");
            return;
        }

        let orders = [];
        snap.forEach(d => orders.push(d.data()));
        orders.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

        const header = ['Date', 'Product', 'Quantity', 'Amount (₹)', 'Buyer Name', 'Buyer Phone', 'Payment Method', 'Status'];
        const rows = orders.map(o => {
            const d = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleDateString('en-IN') : '';
            return [d, o.productName || '', o.quantity || 1, o.price || 0, o.buyerName || '', o.buyerPhone || '', o.paymentMethod || '', o.status || 'Pending']
                .map(escapeCsv).join(',');
        });

        const csvContent = [header.map(escapeCsv).join(','), ...rows].join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `DesiMarket_Sales_Report_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error("Error generating sales report:", error);
        alert("Unable to generate report right now.");
    }
}

// Pure render function — takes the orders array that order-logic.js's live
// listener already fetched, and just recomputes/redraws stats from it.
// NO Firestore query happens here anymore — this is the key read-saving change.
export function renderAnalyticsFromOrders(orders) {
    const container = document.getElementById('analyticsContainer');
    if (!container) return;

    if (!orders || orders.length === 0) {
        container.innerHTML = `<div class="no-data">No orders yet. Once buyers start ordering, your shop analytics will appear here.</div>`;
        return;
    }

    const counts = { Pending: 0, Accepted: 0, Shipped: 0, Delivered: 0, Cancelled: 0 };
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
    const fulfillmentRate = totalOrders > 0 ? ((counts.Delivered / totalOrders) * 100).toFixed(0) : 0;
    const cancellationRate = totalOrders > 0 ? ((counts.Cancelled / totalOrders) * 100).toFixed(0) : 0;
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
            <div class="stat-card">
                <div class="stat-value" style="color:#28a745;">${fulfillmentRate}%</div>
                <div class="stat-label">Fulfillment Rate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:${cancellationRate > 15 ? '#dc3545' : '#232f3e'};">${cancellationRate}%</div>
                <div class="stat-label">Cancellation Rate</div>
            </div>
        </div>

        <div class="top-product-box">🏆 Best Selling Product: <strong>${topProduct}</strong></div>

        <div class="bar-chart">
            ${['Pending', 'Accepted', 'Shipped', 'Delivered', 'Cancelled'].map(status => `
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
}
