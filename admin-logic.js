import {
import { showToast } from './toast.js';
    collection, getDocs, query, where, doc, updateDoc, deleteDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Local caches — each list is fetched from Firestore ONCE per admin session.
// After any action (block, delete, approve, etc.) we patch these arrays directly
// and re-render from memory, instead of re-querying Firestore. This is the
// single biggest read-saver in the whole admin panel.
let cachedSellers = [];
let cachedBuyers = [];
let cachedProducts = [];
let cachedReports = [];
let cachedKyc = [];
let cachedReviews = [];

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

        const statusCounts = { Pending: 0, Accepted: 0, Shipped: 0, Delivered: 0, Cancelled: 0 };
        orders.forEach(o => {
            const s = o.status || 'Pending';
            if (statusCounts[s] !== undefined) statusCounts[s]++;
        });

        const sellerRevenue = {};
        orders.forEach(o => {
            if (o.status === 'Cancelled') return;
            const shop = o.shopName || 'Unknown Shop';
            sellerRevenue[shop] = (sellerRevenue[shop] || 0) + (Number(o.price) || 0);
        });
        const topSellers = Object.entries(sellerRevenue).sort((a, b) => b[1] - a[1]).slice(0, 5);

        const recentOrders = [...orders].sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        }).slice(0, 6);

        let totalRevenue = 0;
        orders.forEach(o => { if (o.status !== 'Cancelled') totalRevenue += Number(o.price) || 0; });

        renderCallback({
            totalSellers, totalBuyers, totalProducts: productsSnap.size, totalOrders: orders.length,
            totalRevenue, dayLabels, dayTotals, statusCounts, topSellers, recentOrders
        });
    } catch (error) {
        console.error("Error loading dashboard charts:", error);
    }
}

// ---------- REVIEW MODERATION ----------
function renderReviews() {
    const container = document.getElementById('reviewsAdminContainer');
    if (cachedReviews.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No reviews submitted yet.</div>`;
        return;
    }
    container.innerHTML = cachedReviews.map(r => `
        <div class="admin-row-card">
            <div class="arc-info">
                <h4>${'★'.repeat(r.rating || 0)}${'☆'.repeat(5 - (r.rating || 0))} — ${r.buyerName || 'Anonymous'}</h4>
                <p>${r.comment || '(no comment)'}</p>
                <p class="uid-tag">Product ID: ${r.productId || 'N/A'}</p>
            </div>
            <div class="arc-actions">
                <button class="admin-btn admin-btn-delete" onclick="deleteReviewMain('${r.id}')">🗑️ Remove</button>
            </div>
        </div>
    `).join('');
}

export async function loadAllReviews(db) {
    const container = document.getElementById('reviewsAdminContainer');
    container.innerHTML = "<p>Loading reviews...</p>";
    try {
        const snap = await getDocs(collection(db, "reviews"));
        cachedReviews = [];
        snap.forEach(d => cachedReviews.push({ id: d.id, ...d.data() }));
        cachedReviews.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });
        renderReviews();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load reviews.</p>`;
    }
}

export async function deleteReviewAdmin(db, reviewId) {
    try {
        await deleteDoc(doc(db, "reviews", reviewId));
        cachedReviews = cachedReviews.filter(r => r.id !== reviewId); // patch locally, no re-fetch
        renderReviews();
    } catch (error) {
        console.error(error);
        showToast("Error removing review.", 'error');
    }
}

// ---------- REPORTS ----------
function renderReports() {
    const container = document.getElementById('reportsContainer');
    if (cachedReports.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No reports submitted yet.</div>`;
        return;
    }
    container.innerHTML = cachedReports.map(r => {
        const resolved = r.status === 'Resolved';
        return `
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
    }).join('');
}

export async function loadReports(db) {
    const container = document.getElementById('reportsContainer');
    container.innerHTML = "<p>Loading reports...</p>";
    try {
        const snap = await getDocs(collection(db, "reports"));
        cachedReports = [];
        snap.forEach(d => cachedReports.push({ id: d.id, ...d.data() }));
        cachedReports.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });
        renderReports();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load reports.</p>`;
    }
}

export async function resolveReport(db, reportId) {
    try {
        await updateDoc(doc(db, "reports", reportId), { status: 'Resolved' });
        const r = cachedReports.find(x => x.id === reportId);
        if (r) r.status = 'Resolved';
        renderReports();
    } catch (error) {
        console.error(error);
        showToast("Error updating report.", 'error');
    }
}

// ---------- SELLER KYC REVIEW ----------
function renderKyc() {
    const container = document.getElementById('kycReviewContainer');
    if (cachedKyc.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No pending KYC submissions.</div>`;
        return;
    }
    container.innerHTML = cachedKyc.map(s => `
        <div class="admin-row-card">
            <div class="arc-info">
                <h4>${s.shopName || 'Unnamed Shop'}</h4>
                <p>Owner: ${s.ownerName || 'N/A'} &nbsp; | &nbsp; PAN: ${s.kycPan || 'N/A'} &nbsp; | &nbsp; Aadhar: xxxx-xxxx-${s.kycAadharLast4 || '----'}</p>
                <p class="uid-tag">Seller UID: ${s.id}</p>
            </div>
            <div class="arc-actions">
                <button class="admin-btn admin-btn-unblock" onclick="approveKycMain('${s.id}')">✅ Verify</button>
                <button class="admin-btn admin-btn-block" onclick="rejectKycMain('${s.id}')">❌ Reject</button>
            </div>
        </div>
    `).join('');
}

export async function loadPendingKyc(db) {
    const container = document.getElementById('kycReviewContainer');
    container.innerHTML = "<p>Loading KYC submissions...</p>";
    try {
        const q = query(collection(db, "sellers_profiles"), where("kycStatus", "==", "Pending"));
        const snap = await getDocs(q);
        cachedKyc = [];
        snap.forEach(d => cachedKyc.push({ id: d.id, ...d.data() }));
        renderKyc();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load KYC submissions.</p>`;
    }
}

export async function updateKycStatus(db, sellerUid, newStatus) {
    try {
        await updateDoc(doc(db, "sellers_profiles", sellerUid), { kycStatus: newStatus });
        // This seller no longer belongs in the "Pending" list once decided
        cachedKyc = cachedKyc.filter(s => s.id !== sellerUid);
        renderKyc();
    } catch (error) {
        console.error(error);
        showToast("Error updating KYC status.", 'error');
    }
}

// ---------- SELLERS ----------
function renderSellers() {
    const container = document.getElementById('sellersContainer');
    if (cachedSellers.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No sellers registered yet.</div>`;
        return;
    }
    container.innerHTML = cachedSellers.map(u => {
        const blocked = u.blocked === true;
        const isPremium = u.isPremium === true;
        return `
            <div class="admin-row-card ${blocked ? 'is-blocked' : ''}">
                <div class="arc-info">
                    <h4>${u.name || 'Unnamed'} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''} ${isPremium ? '<span class="blocked-tag" style="background:#ff9900; color:#111;">🌟 PREMIUM</span>' : ''}</h4>
                    <p>📞 ${u.phone || 'N/A'} &nbsp; ✉️ ${u.email || 'N/A'}</p>
                    <p class="uid-tag">UID: ${u.id}</p>
                </div>
                <div class="arc-actions">
                    <button class="admin-btn ${isPremium ? 'admin-btn-block' : 'admin-btn-unblock'}" onclick="togglePremiumMain('${u.id}', ${!isPremium})" style="${isPremium ? '' : 'background:#ff9900; color:#111;'}">
                        ${isPremium ? '⬇️ Remove Premium' : '🌟 Make Premium'}
                    </button>
                    <button class="admin-btn ${blocked ? 'admin-btn-unblock' : 'admin-btn-block'}" onclick="toggleBlockMain('${u.id}', ${!blocked})">
                        ${blocked ? '✅ Unblock' : '🚫 Block'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

export async function loadSellers(db) {
    const container = document.getElementById('sellersContainer');
    container.innerHTML = "<p>Loading sellers...</p>";
    try {
        const q = query(collection(db, "users"), where("role", "==", "seller"));
        const snap = await getDocs(q);

        const sellerDocs = snap.docs;
        const profileSnaps = await Promise.all(
            sellerDocs.map(d => getDoc(doc(db, "sellers_profiles", d.id)))
        );

        cachedSellers = sellerDocs.map((d, i) => {
            const profile = profileSnaps[i].exists() ? profileSnaps[i].data() : {};
            return { id: d.id, ...d.data(), isPremium: profile.isPremium === true };
        });

        renderSellers();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load sellers.</p>`;
    }
}

// ---------- BUYERS ----------
function renderBuyers() {
    const container = document.getElementById('buyersContainer');
    if (cachedBuyers.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No buyers registered yet.</div>`;
        return;
    }
    container.innerHTML = cachedBuyers.map(u => {
        const blocked = u.blocked === true;
        return `
            <div class="admin-row-card ${blocked ? 'is-blocked' : ''}">
                <div class="arc-info">
                    <h4>${u.name || 'Unnamed'} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''}</h4>
                    <p>📞 ${u.phone || 'N/A'} &nbsp; ✉️ ${u.email || 'N/A'}</p>
                    <p class="uid-tag">UID: ${u.id}</p>
                </div>
                <div class="arc-actions">
                    <button class="admin-btn ${blocked ? 'admin-btn-unblock' : 'admin-btn-block'}" onclick="toggleBlockMain('${u.id}', ${!blocked})">
                        ${blocked ? '✅ Unblock' : '🚫 Block'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

export async function loadBuyers(db) {
    const container = document.getElementById('buyersContainer');
    container.innerHTML = "<p>Loading buyers...</p>";
    try {
        const q = query(collection(db, "users"), where("role", "==", "customer"));
        const snap = await getDocs(q);
        cachedBuyers = [];
        snap.forEach(d => cachedBuyers.push({ id: d.id, ...d.data() }));
        renderBuyers();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load buyers.</p>`;
    }
}

// Shared by both Sellers and Buyers tabs — patches whichever cache the user belongs to.
export async function toggleBlockUser(db, uid, shouldBlock) {
    try {
        await updateDoc(doc(db, "users", uid), { blocked: shouldBlock });
        showToast(shouldBlock ? "User has been blocked." : "User has been unblocked.");

        const seller = cachedSellers.find(u => u.id === uid);
        if (seller) { seller.blocked = shouldBlock; renderSellers(); }

        const buyer = cachedBuyers.find(u => u.id === uid);
        if (buyer) { buyer.blocked = shouldBlock; renderBuyers(); }
    } catch (error) {
        console.error(error);
        showToast("Error updating user status.", 'error');
    }
}

export async function setSellerPremiumLocal(sellerUid, isPremium) {
    // Called after premium-logic.js's setSellerPremium succeeds, to patch the cache
    const seller = cachedSellers.find(u => u.id === sellerUid);
    if (seller) { seller.isPremium = isPremium; renderSellers(); }
}

// ---------- PRODUCTS ----------
function renderProducts() {
    const container = document.getElementById('productsContainer');
    if (cachedProducts.length === 0) {
        container.innerHTML = `<div class="admin-no-data">No products listed yet.</div>`;
        return;
    }
    container.innerHTML = cachedProducts.map(p => `
        <div class="admin-row-card">
            <img class="arc-thumb" src="${p.image || 'https://via.placeholder.com/60'}" alt="">
            <div class="arc-info">
                <h4>${p.name || 'Unnamed product'}</h4>
                <p>₹${p.price || 0} &nbsp; 🏪 ${p.shopName || 'N/A'}</p>
                <p class="uid-tag">Seller UID: ${p.sellerUid || 'N/A'}</p>
            </div>
            <div class="arc-actions">
                <button class="admin-btn admin-btn-delete" onclick="deleteProductMain('${p.id}')">🗑️ Remove</button>
            </div>
        </div>
    `).join('');
}

export async function loadAllProducts(db) {
    const container = document.getElementById('productsContainer');
    container.innerHTML = "<p>Loading all products...</p>";
    try {
        const snap = await getDocs(collection(db, "vendors"));
        cachedProducts = [];
        snap.forEach(d => cachedProducts.push({ id: d.id, ...d.data() }));
        renderProducts();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load products.</p>`;
    }
}

export async function deleteProductAdmin(db, productId) {
    try {
        await deleteDoc(doc(db, "vendors", productId));
        showToast("Product removed from the marketplace.");
        cachedProducts = cachedProducts.filter(p => p.id !== productId);
        renderProducts();
    } catch (error) {
        console.error(error);
        showToast("Error removing product.", 'error');
    }
}

// ---------- ORDERS (read-only view, filter is done in-memory once loaded) ----------
let cachedAllOrders = [];

export async function loadAllOrders(db, statusFilter = 'All') {
    const container = document.getElementById('ordersContainer');
    container.innerHTML = "<p>Loading orders...</p>";
    try {
        if (cachedAllOrders.length === 0) {
            const snap = await getDocs(collection(db, "orders"));
            cachedAllOrders = [];
            snap.forEach(d => cachedAllOrders.push({ id: d.id, ...d.data() }));
        }

        let orders = cachedAllOrders;
        if (statusFilter !== 'All') {
            orders = orders.filter(o => (o.status || 'Pending') === statusFilter);
        }
        orders = [...orders].sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        if (orders.length === 0) {
            container.innerHTML = `<div class="admin-no-data">No orders found for this filter.</div>`;
            return;
        }

        container.innerHTML = orders.map(o => `
            <div class="admin-row-card">
                <div class="arc-info">
                    <h4>📦 ${o.productName || 'Item'} (Qty: ${o.quantity || 1}) — ₹${o.price || 0}</h4>
                    <p>Buyer: ${o.buyerName || 'N/A'} &nbsp; | &nbsp; Shop: ${o.shopName || 'N/A'}</p>
                    <p class="uid-tag">Status: <strong>${o.status || 'Pending'}</strong></p>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load orders.</p>`;
    }
}
