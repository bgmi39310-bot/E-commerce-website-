import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';

// This is only called when the seller explicitly clicks "Download Report" —
// a one-time on-demand read is fine here since it's a deliberate user action,
// not something that should run automatically on every page interaction.
export async function downloadSalesReport(db, uid) {
    try {
        const q = query(collection(db, "orders"), where("sellerUid", "==", uid));
        const snap = await getDocs(q);

        if (snap.empty) {
            showToast("No orders yet to generate a report.", 'info');
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
        showToast("Unable to generate report right now.", 'error');
    }
}

// Pure render function — takes the orders array that order-logic.js's live
// listener already fetched, and just recomputes/redraws stats from it.
// NO Firestore query happens here anymore — this is the key read-saving change.
// Sales of the last 7 days (bar chart), this week vs last week, and the top
// 5 selling products. Pure calculation on the orders already loaded — no
// extra Firestore reads.
function buildWeeklyInsights(orders) {
    const DAY_NAMES = ['Ravi', 'Som', 'Mangal', 'Budh', 'Guru', 'Shukra', 'Shani'];
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOfDay(new Date());
    const dayMs = 24 * 60 * 60 * 1000;
    const counted = orders.filter(o => o.status !== 'Cancelled' && o.status !== 'Returned');

    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today.getTime() - i * dayMs);
        days.push({ date: d, label: i === 0 ? 'Aaj' : DAY_NAMES[d.getDay()], revenue: 0, orders: 0 });
    }
    let thisWeek = 0, lastWeek = 0;
    counted.forEach(o => {
        const ts = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
        if (!ts) return;
        const ageDays = Math.floor((today.getTime() - startOfDay(ts).getTime()) / dayMs);
        const amount = Number(o.price) || 0;
        if (ageDays >= 0 && ageDays <= 6) {
            const slot = days[6 - ageDays];
            slot.revenue += amount;
            slot.orders += 1;
            thisWeek += amount;
        } else if (ageDays >= 7 && ageDays <= 13) {
            lastWeek += amount;
        }
    });

    const maxDay = Math.max(...days.map(d => d.revenue), 1);
    let trend = '';
    if (lastWeek > 0) {
        const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
        trend = pct >= 0
            ? `<span style="color:#1a7f4b;">▲ ${pct}% pichhle hafte se zyada</span>`
            : `<span style="color:#c0392b;">▼ ${Math.abs(pct)}% pichhle hafte se kam</span>`;
    } else if (thisWeek > 0) {
        trend = `<span style="color:#1a7f4b;">🎉 Is hafte ki shuruaat achhi rahi!</span>`;
    }

    const bars = days.map(d => `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; min-width:0;">
            <div style="font-size:10px; color:#555; margin-bottom:3px;">${d.revenue > 0 ? '₹' + Math.round(d.revenue) : ''}</div>
            <div style="width:70%; max-width:34px; height:${Math.max(d.revenue / maxDay * 100, d.revenue > 0 ? 6 : 2)}%; background:${d.revenue > 0 ? 'linear-gradient(180deg,#ffb84d,#ff9900)' : '#e3e6e8'}; border-radius:5px 5px 0 0;"></div>
        </div>`).join('');
    const labels = days.map(d => `<div style="flex:1; text-align:center; font-size:10.5px; color:#555;">${d.label}</div>`).join('');

    // top 5 products by units sold
    const byProduct = {};
    counted.forEach(o => {
        const name = o.productName || 'Unknown';
        const row = byProduct[name] || (byProduct[name] = { qty: 0, revenue: 0 });
        row.qty += Number(o.quantity) || 1;
        row.revenue += Number(o.price) || 0;
    });
    const top = Object.entries(byProduct).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
    const topRows = top.map(([name, v], i) => `
        <div style="display:flex; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid #f0f0f0; font-size:13px;">
            <span>${['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]} ${escapeHtml(name)}</span>
            <span style="color:#555; white-space:nowrap;">${v.qty} bika · ₹${Math.round(v.revenue)}</span>
        </div>`).join('');

    return `
        <div style="background:#fff; border:1px solid #eee; border-radius:10px; padding:14px; margin:14px 0;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:4px; margin-bottom:10px;">
                <strong style="font-size:14.5px;">📈 Pichhle 7 din ki bikri</strong>
                <span style="font-size:12.5px;"><strong>₹${Math.round(thisWeek)}</strong> ${trend ? '· ' + trend : ''}</span>
            </div>
            <div style="display:flex; align-items:flex-end; gap:4px; height:130px;">${bars}</div>
            <div style="display:flex; gap:4px; margin-top:5px;">${labels}</div>
        </div>
        ${top.length ? `<div style="background:#fff; border:1px solid #eee; border-radius:10px; padding:14px; margin:14px 0;">
            <strong style="font-size:14.5px;">🏆 Sabse zyada bikne wale 5 products</strong>
            <div style="margin-top:8px;">${topRows}</div>
        </div>` : ''}`;
}

export function renderAnalyticsFromOrders(orders) {
    const container = document.getElementById('analyticsContainer');
    if (!container) return;

    if (!orders || orders.length === 0) {
        container.innerHTML = `<div class="no-data">No orders yet. Once buyers start ordering, your shop analytics will appear here.</div>`;
        return;
    }

    const counts = { Pending: 0, Accepted: 0, Shipped: 0, Delivered: 0, Cancelled: 0, Returned: 0 };
    let totalRevenue = 0;
    const productFrequency = {};

    orders.forEach(o => {
        const status = o.status || 'Pending';
        if (counts[status] !== undefined) counts[status]++;

        if (status !== 'Cancelled' && status !== 'Returned') {
            totalRevenue += Number(o.price) || 0;
        }

        const pname = o.productName || 'Unknown';
        productFrequency[pname] = (productFrequency[pname] || 0) + (Number(o.quantity) || 1);
    });

    const totalOrders = orders.length;
    const fulfillmentRate = totalOrders > 0 ? ((counts.Delivered / totalOrders) * 100).toFixed(0) : 0;
    const cancellationRate = totalOrders > 0 ? ((counts.Cancelled / totalOrders) * 100).toFixed(0) : 0;
    const topProductEntry = Object.entries(productFrequency).sort((a, b) => b[1] - a[1])[0];
    const topProduct = topProductEntry ? `${escapeHtml(topProductEntry[0])} (${topProductEntry[1]} sold)` : 'N/A';

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

        ${buildWeeklyInsights(orders)}

        <div class="bar-chart">
            ${['Pending', 'Accepted', 'Shipped', 'Delivered', 'Cancelled', 'Returned'].map(status => `
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
