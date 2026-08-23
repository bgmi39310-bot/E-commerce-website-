import {
    collection, getDocs, query, where, doc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ---------- DASHBOARD CHARTS DATA ----------
export async function loadDashboardCharts(db, renderCallback) {
    try {
        const [usersSnap, productsSnap, ordersSnap] = await Promise.all([
            getDocs(collection(db, "users")),
            getDocs(collection(db, "vendors")),
            getDocs(collection(db, "orders"))
        ]);

        let totalSellers = 0, totalBuyers = 0;
        usersSnap.forEach(d => {
            if (d.data().role === 'seller') totalSellers++; else totalBuyers++;
        });

        let orders = [];
        ordersSnap.forEach(d => orders.push({ id: d.id, ...d.data() }));

        // Revenue trend - last 7 days
        const dayLabels = [];
        const dayTotals = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dayLabels.push(d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
            dayTotals.push(0);
        }
        orders.forEach(o => {
            if (o.status === 'Cancelled') return;
            const created = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
            if (!created) return;
            const diffDays = Math.floor((new Date().setHours(0,0,0,0) - new Date(created).setHours(0,0,0,0)) / 86400000);
            if (diffDays >= 0 && diffDays <= 6) {
                dayTotals[6 - diffDays] += Number(o.price) || 0;
            }
        });

        // Status breakdown
        const statusCounts = { Pending: 0, Accepted: 0, Shipped: 0, Delivered: 0, Cancelled: 0 };
        orders.forEach(o => {
            const s = o.status || 'Pending';
            if (statusCounts[s] !== undefined) statusCounts[s]++;
        });

        // Top sellers by revenue
        const sellerRevenue = {};
        orders.forEach(o => {
            if (o.status === 'Cancelled') return;
            const shop = o.shopName || 'Unknown Shop';
            sellerRevenue[shop] = (sellerRevenue[shop] || 0) + (Number(o.price) || 0);
        });
        const topSellers = Object.entries(sellerRevenue).sort((a, b) => b[1] - a[1]).slice(0, 5);

        // Recent orders
        const recentOrders = [...orders].sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        }).slice(0, 6);

        let totalRevenue = 0;
        orders.forEach(o => { if (o.status !== 'Cancelled') totalRevenue += Number(o.price) || 0; });

        renderCallback({
            totalSellers,
            totalBuyers,
            totalProducts: productsSnap.size,
            totalOrders: orders.length,
            totalRevenue,
            dayLabels,
            dayTotals,
            statusCounts,
            topSellers,
            recentOrders
        });
    } catch (error) {
        console.error("Error loading dashboard charts:", error);
    }
}

// ---------- OVERVIEW ----------
export async function loadOverviewStats(db) {
    const container = document.getElementById('overviewContainer');
    container.innerHTML = "<p>Loading platform stats...</p>";

    try {
        const [usersSnap, productsSnap, ordersSnap] = await Promise.all([
            getDocs(collection(db, "users")),
            getDocs(collection(db, "vendors")),
            getDocs(collection(db, "orders"))
        ]);

        let totalSellers = 0, totalBuyers = 0;
        usersSnap.forEach(d => {
            const role = d.data().role;
            if (role === 'seller') totalSellers++;
            else totalBuyers++;
        });

        let totalRevenue = 0, activeOrders = 0;
        ordersSnap.forEach(d => {
            const o = d.data();
            if (o.status !== 'Cancelled') totalRevenue += Number(o.price) || 0;
            if (o.status === 'Pending' || o.status === 'Accepted') activeOrders++;
        });

        container.innerHTML = `
            <div class="admin-stats-grid">
                <div class="admin-stat-card"><div class="asv">${totalSellers}</div><div class="asl">Total Sellers</div></div>
                <div class="admin-stat-card"><div class="asv">${totalBuyers}</div><div class="asl">Total Buyers</div></div>
                <div class="admin-stat-card"><div class="asv">${productsSnap.size}</div><div class="asl">Total Products</div></div>
                <div class="admin-stat-card"><div class="asv">${ordersSnap.size}</div><div class="asl">Total Orders</div></div>
                <div class="admin-stat-card"><div class="asv">₹${totalRevenue.toFixed(0)}</div><div class="asl">Platform Revenue</div></div>
                <div class="admin-stat-card"><div class="asv">${activeOrders}</div><div class="asl">Active Orders</div></div>
            </div>
        `;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load stats.</p>`;
    }
}

// ---------- REPORTS ----------
export async function loadReports(db) {
    const container = document.getElementById('reportsContainer');
    container.innerHTML = "<p>Loading reports...</p>";

    try {
        const snap = await getDocs(collection(db, "reports"));
        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No reports submitted yet.</div>`;
            return;
        }

        let reports = [];
        snap.forEach(d => reports.push({ id: d.id, ...d.data() }));
        reports.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        let html = "";
        reports.forEach(r => {
            const resolved = r.status === 'Resolved';
            html += `
                <div class="admin-row-card ${resolved ? 'is-blocked' : ''}">
                    <div class="arc-info">
                        <h4>${r.productName || 'Unknown product'} ${resolved ? '<span class="blocked-tag">RESOLVED</span>' : ''}</h4>
                        <p>🏪 ${r.shopName || 'Unknown shop'} &nbsp; | &nbsp; Reason: <strong>${r.reason || 'N/A'}</strong></p>
                        ${r.details ? `<p>"${r.details}"</p>` : ''}
                        <p class="uid-tag">Product ID: ${r.productId || 'N/A'} | Seller UID: ${r.sellerUid || 'N/A'}</p>
                    </div>
                    ${!resolved ? `
                        <div class="arc-actions">
                            <button class="admin-btn admin-btn-delete" onclick="deleteReportedProductMain('${r.id}', '${r.productId}')">🗑️ Remove Product</button>
                            <button class="admin-btn admin-btn-unblock" onclick="dismissReportMain('${r.id}')">✅ Dismiss</button>
                        </div>
                    ` : ''}
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load reports.</p>`;
    }
}

export async function resolveReport(db, reportId, refreshCallback) {
    try {
        await updateDoc(doc(db, "reports", reportId), { status: 'Resolved' });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error updating report.");
    }
}

// ---------- SELLER KYC REVIEW ----------
export async function loadPendingKyc(db) {
    const container = document.getElementById('kycReviewContainer');
    container.innerHTML = "<p>Loading KYC submissions...</p>";

    try {
        const q = query(collection(db, "sellers_profiles"), where("kycStatus", "==", "Pending"));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No pending KYC submissions.</div>`;
            return;
        }

        let html = "";
        snap.forEach(d => {
            const s = d.data();
            html += `
                <div class="admin-row-card">
                    <div class="arc-info">
                        <h4>${s.shopName || 'Unnamed Shop'}</h4>
                        <p>Owner: ${s.ownerName || 'N/A'} &nbsp; | &nbsp; PAN: ${s.kycPan || 'N/A'} &nbsp; | &nbsp; Aadhar: xxxx-xxxx-${s.kycAadharLast4 || '----'}</p>
                        <p class="uid-tag">Seller UID: ${d.id}</p>
                    </div>
                    <div class="arc-actions">
                        <button class="admin-btn admin-btn-unblock" onclick="approveKycMain('${d.id}')">✅ Verify</button>
                        <button class="admin-btn admin-btn-block" onclick="rejectKycMain('${d.id}')">❌ Reject</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load KYC submissions.</p>`;
    }
}

export async function updateKycStatus(db, sellerUid, newStatus, refreshCallback) {
    try {
        await updateDoc(doc(db, "sellers_profiles", sellerUid), { kycStatus: newStatus });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error updating KYC status.");
    }
}

// ---------- SELLERS ----------
export async function loadSellers(db) {
    const container = document.getElementById('sellersContainer');
    container.innerHTML = "<p>Loading sellers...</p>";

    try {
        const q = query(collection(db, "users"), where("role", "==", "seller"));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No sellers registered yet.</div>`;
            return;
        }

        let html = "";
        snap.forEach(d => {
            const u = d.data();
            const blocked = u.blocked === true;
            html += `
                <div class="admin-row-card ${blocked ? 'is-blocked' : ''}">
                    <div class="arc-info">
                        <h4>${u.name || 'Unnamed'} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''}</h4>
                        <p>📞 ${u.phone || 'N/A'} &nbsp; ✉️ ${u.email || 'N/A'}</p>
                        <p class="uid-tag">UID: ${d.id}</p>
                    </div>
                    <div class="arc-actions">
                        <button class="admin-btn ${blocked ? 'admin-btn-unblock' : 'admin-btn-block'}" onclick="toggleBlockMain('${d.id}', ${!blocked})">
                            ${blocked ? '✅ Unblock' : '🚫 Block'}
                        </button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load sellers.</p>`;
    }
}

// ---------- BUYERS ----------
export async function loadBuyers(db) {
    const container = document.getElementById('buyersContainer');
    container.innerHTML = "<p>Loading buyers...</p>";

    try {
        const q = query(collection(db, "users"), where("role", "==", "customer"));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No buyers registered yet.</div>`;
            return;
        }

        let html = "";
        snap.forEach(d => {
            const u = d.data();
            const blocked = u.blocked === true;
            html += `
                <div class="admin-row-card ${blocked ? 'is-blocked' : ''}">
                    <div class="arc-info">
                        <h4>${u.name || 'Unnamed'} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''}</h4>
                        <p>📞 ${u.phone || 'N/A'} &nbsp; ✉️ ${u.email || 'N/A'}</p>
                        <p class="uid-tag">UID: ${d.id}</p>
                    </div>
                    <div class="arc-actions">
                        <button class="admin-btn ${blocked ? 'admin-btn-unblock' : 'admin-btn-block'}" onclick="toggleBlockMain('${d.id}', ${!blocked})">
                            ${blocked ? '✅ Unblock' : '🚫 Block'}
                        </button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load buyers.</p>`;
    }
}

export async function toggleBlockUser(db, uid, shouldBlock, refreshCallback) {
    try {
        await updateDoc(doc(db, "users", uid), { blocked: shouldBlock });
        alert(shouldBlock ? "User has been blocked." : "User has been unblocked.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error updating user status.");
    }
}

// ---------- PRODUCTS ----------
export async function loadAllProducts(db) {
    const container = document.getElementById('productsContainer');
    container.innerHTML = "<p>Loading all products...</p>";

    try {
        const snap = await getDocs(collection(db, "vendors"));

        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No products listed yet.</div>`;
            return;
        }

        let html = "";
        snap.forEach(d => {
            const p = d.data();
            html += `
                <div class="admin-row-card">
                    <img class="arc-thumb" src="${p.image || 'https://via.placeholder.com/60'}" alt="">
                    <div class="arc-info">
                        <h4>${p.name || 'Unnamed product'}</h4>
                        <p>₹${p.price || 0} &nbsp; 🏪 ${p.shopName || 'N/A'}</p>
                        <p class="uid-tag">Seller UID: ${p.sellerUid || 'N/A'}</p>
                    </div>
                    <div class="arc-actions">
                        <button class="admin-btn admin-btn-delete" onclick="deleteProductMain('${d.id}')">🗑️ Remove</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load products.</p>`;
    }
}

export async function deleteProductAdmin(db, productId, refreshCallback) {
    try {
        await deleteDoc(doc(db, "vendors", productId));
        alert("Product removed from the marketplace.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error removing product.");
    }
}

export async function loadAllOrders(db, statusFilter = 'All') {
    const container = document.getElementById('ordersContainer');
    container.innerHTML = "<p>Loading orders...</p>";

    try {
        const snap = await getDocs(collection(db, "orders"));
        let orders = [];
        snap.forEach(d => orders.push({ id: d.id, ...d.data() }));

        if (statusFilter !== 'All') {
            orders = orders.filter(o => (o.status || 'Pending') === statusFilter);
        }

        orders.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        if (orders.length === 0) {
            container.innerHTML = `<div class="admin-no-data">No orders found for this filter.</div>`;
            return;
        }

        let html = "";
        orders.forEach(o => {
            html += `
                <div class="admin-row-card">
                    <div class="arc-info">
                        <h4>📦 ${o.productName || 'Item'} (Qty: ${o.quantity || 1}) — ₹${o.price || 0}</h4>
                        <p>Buyer: ${o.buyerName || 'N/A'} &nbsp; | &nbsp; Shop: ${o.shopName || 'N/A'}</p>
                        <p class="uid-tag">Status: <strong>${o.status || 'Pending'}</strong></p>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load orders.</p>`;
    }
}
