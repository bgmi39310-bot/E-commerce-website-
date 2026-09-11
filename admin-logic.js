import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';
import {
    collection, getDocs, query, where, doc, updateDoc, deleteDoc, getDoc,
    getCountFromServer, getAggregateFromServer, sum, limit, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Local caches — each list is fetched from Firestore ONCE per admin session.
// After any action (block, delete, approve, etc.) we patch these arrays directly
// and re-render from memory, instead of re-querying Firestore. This is the
// single biggest read-saver in the whole admin panel.
//
// Every list below is also capped (see LIST_FETCH_LIMIT) and sorted newest
// first, so as the marketplace grows, the admin panel keeps loading fast
// and cheap instead of downloading every document in every collection on
// every visit — which is what it used to do.
const LIST_FETCH_LIMIT = 300;

let cachedSellers = [];
let cachedBuyers = [];
let cachedProducts = [];
let cachedReports = [];
let cachedKyc = [];
let cachedReviews = [];

// ---------- DASHBOARD CHARTS DATA ----------
export async function loadDashboardCharts(db, renderCallback) {
    const errors = [];
    const now = new Date();
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(now.getDate() - 29); thirtyDaysAgo.setHours(0, 0, 0, 0);

    // Each section below is isolated in its OWN try/catch. Previously one
    // failing query (e.g. a Firestore composite index that hasn't been
    // created yet for a new query shape) would throw out of a single big
    // Promise.all and silently abort the ENTIRE dashboard render — every
    // panel stuck on "Loading..." forever with no visible error. Now a
    // failure in one section just leaves THAT section showing a clear
    // error, while everything else that succeeded still renders.

    // ---- Exact platform-wide counts via Firestore's count() aggregation.
    let totalSellers = 0, totalBuyers = 0, totalProducts = 0, totalOrders = 0;
    let statusCounts = { Pending: 0, Accepted: 0, Shipped: 0, Delivered: 0, Cancelled: 0 };
    try {
        const [
            sellersCountSnap, buyersCountSnap, productsCountSnap, ordersCountSnap,
            pendingCountSnap, acceptedCountSnap, shippedCountSnap, deliveredCountSnap, cancelledCountSnap,
        ] = await Promise.all([
            getCountFromServer(query(collection(db, "users"), where("role", "==", "seller"))),
            getCountFromServer(query(collection(db, "users"), where("role", "==", "customer"))),
            getCountFromServer(collection(db, "vendors")),
            getCountFromServer(collection(db, "orders")),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "Pending"))),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "Accepted"))),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "Shipped"))),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "Delivered"))),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "Cancelled"))),
        ]);
        totalSellers = sellersCountSnap.data().count;
        totalBuyers = buyersCountSnap.data().count;
        totalProducts = productsCountSnap.data().count;
        totalOrders = ordersCountSnap.data().count;
        statusCounts = {
            Pending: pendingCountSnap.data().count,
            Accepted: acceptedCountSnap.data().count,
            Shipped: shippedCountSnap.data().count,
            Delivered: deliveredCountSnap.data().count,
            Cancelled: cancelledCountSnap.data().count,
        };
    } catch (error) {
        console.error("Dashboard: count queries failed —", error);
        errors.push('counts');
    }

    // ---- Lifetime revenue via sum() aggregation. Isolated separately from
    // the counts above because it's the query most likely to need a
    // Firestore composite index (an inequality filter + an aggregation
    // together) — if Firestore hasn't been asked to create that index yet,
    // this specific query throws an error that INCLUDES A DIRECT LINK to
    // create it. That link only shows up in the browser console.
    let totalRevenue = 0;
    try {
        const revenueSnap = await getAggregateFromServer(
            query(collection(db, "orders"), where("status", "!=", "Cancelled")),
            { totalRevenue: sum("price") }
        );
        totalRevenue = revenueSnap.data().totalRevenue || 0;
    } catch (error) {
        console.error("Dashboard: revenue sum query failed — if this says 'requires an index', open the link Firestore printed right above this line in the console to create it:", error);
        errors.push('revenue');
    }

    // ---- 7-day revenue chart + "Top Sellers" (last 30 days).
    let dayLabels = [], dayTotals = [], topSellers = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dayLabels.push(d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
        dayTotals.push(0);
    }
    try {
        const recentSnap = await getDocs(query(
            collection(db, "orders"),
            where("createdAt", ">=", thirtyDaysAgo),
            limit(1000)
        ));
        let recentOrdersAll = [];
        recentSnap.forEach(d => recentOrdersAll.push({ id: d.id, ...d.data() }));

        recentOrdersAll.forEach(o => {
            if (o.status === 'Cancelled') return;
            const created = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
            if (!created) return;
            const diffDays = Math.floor((new Date().setHours(0,0,0,0) - new Date(created).setHours(0,0,0,0)) / 86400000);
            if (diffDays >= 0 && diffDays <= 6) {
                dayTotals[6 - diffDays] += Number(o.price) || 0;
            }
        });

        const sellerRevenue = {};
        recentOrdersAll.forEach(o => {
            if (o.status === 'Cancelled') return;
            const shop = o.shopName || 'Unknown Shop';
            sellerRevenue[shop] = (sellerRevenue[shop] || 0) + (Number(o.price) || 0);
        });
        topSellers = Object.entries(sellerRevenue).sort((a, b) => b[1] - a[1]).slice(0, 5);
    } catch (error) {
        console.error("Dashboard: 30-day orders query failed —", error);
        errors.push('recentActivity');
    }

    // ---- "Recent Orders" — its own small, precise query.
    let recentOrders = [];
    try {
        const latestSnap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(6)));
        latestSnap.forEach(d => recentOrders.push({ id: d.id, ...d.data() }));
    } catch (error) {
        console.error("Dashboard: recent orders query failed —", error);
        errors.push('recentOrders');
    }

    renderCallback({
        totalSellers, totalBuyers, totalProducts, totalOrders,
        totalRevenue, dayLabels, dayTotals, statusCounts, topSellers, recentOrders,
        errors // non-empty = some section(s) failed; check the console for details/index links
    });
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
                <h4>${'★'.repeat(r.rating || 0)}${'☆'.repeat(5 - (r.rating || 0))} — ${escapeHtml(r.buyerName || 'Anonymous')}</h4>
                <p>${escapeHtml(r.comment || '(no comment)')}</p>
                <p class="uid-tag">Product ID: ${escapeHtml(r.productId || 'N/A')}</p>
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
        const snap = await getDocs(query(collection(db, "reviews"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT)));
        cachedReviews = [];
        snap.forEach(d => cachedReviews.push({ id: d.id, ...d.data() }));
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
                    <h4>${escapeHtml(r.productName || 'Unknown product')} ${resolved ? '<span class="blocked-tag">RESOLVED</span>' : ''}</h4>
                    <p>🏪 ${escapeHtml(r.shopName || 'Unknown shop')} &nbsp; | &nbsp; Reason: <strong>${escapeHtml(r.reason || 'N/A')}</strong></p>
                    ${r.details ? `<p>"${escapeHtml(r.details)}"</p>` : ''}
                    <p class="uid-tag">Product ID: ${escapeHtml(r.productId || 'N/A')} | Seller UID: ${escapeHtml(r.sellerUid || 'N/A')}</p>
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
        const snap = await getDocs(query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT)));
        cachedReports = [];
        snap.forEach(d => cachedReports.push({ id: d.id, ...d.data() }));
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

// Marking a report Resolved AND removing the product it was about used to
// be two completely separate, unawaited Firestore calls — either one could
// fail independently of the other, leaving the report marked "Resolved"
// while the reported product was still live (or vice versa). A single
// batch commits both writes together, or neither.
export async function resolveReportAndDeleteProduct(db, reportId, productId) {
    try {
        const batch = writeBatch(db);
        batch.set(doc(db, "reports", reportId), { status: 'Resolved' }, { merge: true });
        batch.delete(doc(db, "vendors", productId));
        await batch.commit();

        const r = cachedReports.find(x => x.id === reportId);
        if (r) r.status = 'Resolved';
        cachedProducts = cachedProducts.filter(p => p.id !== productId);
        renderReports();
        renderProducts();
        showToast("Product removed and report resolved.");
    } catch (error) {
        console.error(error);
        showToast("Error resolving report / removing product.", 'error');
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
                <h4>${escapeHtml(s.shopName || 'Unnamed Shop')}</h4>
                <p>Owner: ${escapeHtml(s.ownerName || 'N/A')} &nbsp; | &nbsp; PAN: ${escapeHtml(s.kycPan || 'N/A')} &nbsp; | &nbsp; Aadhar: xxxx-xxxx-${escapeHtml(s.kycAadharLast4 || '----')}</p>
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
        const q = query(collection(db, "sellers_profiles"), where("kycStatus", "==", "Pending"), limit(LIST_FETCH_LIMIT));
        const snap = await getDocs(q);
        cachedKyc = [];
        // PAN/Aadhar live in the separate seller_private_kyc collection now
        // (not on the public sellers_profiles doc) — fetch each one so the
        // admin can still review it here.
        for (const d of snap.docs) {
            const privSnap = await getDoc(doc(db, "seller_private_kyc", d.id));
            const priv = privSnap.exists() ? privSnap.data() : {};
            cachedKyc.push({ id: d.id, ...d.data(), kycPan: priv.pan, kycAadharLast4: priv.aadharLast4 });
        }
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
                    <h4>${escapeHtml(u.name || 'Unnamed')} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''} ${isPremium ? '<span class="blocked-tag" style="background:#ff9900; color:#111;">🌟 PREMIUM</span>' : ''}</h4>
                    <p>📞 ${escapeHtml(u.phone || 'N/A')} &nbsp; ✉️ ${escapeHtml(u.email || 'N/A')}</p>
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
        const q = query(collection(db, "users"), where("role", "==", "seller"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT));
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
                    <h4>${escapeHtml(u.name || 'Unnamed')} ${blocked ? '<span class="blocked-tag">BLOCKED</span>' : ''}</h4>
                    <p>📞 ${escapeHtml(u.phone || 'N/A')} &nbsp; ✉️ ${escapeHtml(u.email || 'N/A')}</p>
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
        const q = query(collection(db, "users"), where("role", "==", "customer"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT));
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
                <h4>${escapeHtml(p.name || 'Unnamed product')}</h4>
                <p>₹${p.price || 0} &nbsp; 🏪 ${escapeHtml(p.shopName || 'N/A')}</p>
                <p class="uid-tag">Seller UID: ${escapeHtml(p.sellerUid || 'N/A')}</p>
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
        const snap = await getDocs(query(collection(db, "vendors"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT)));
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
            const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(LIST_FETCH_LIMIT)));
            cachedAllOrders = [];
            snap.forEach(d => cachedAllOrders.push({ id: d.id, ...d.data() }));
        }

        let orders = cachedAllOrders;
        if (statusFilter !== 'All') {
            orders = orders.filter(o => (o.status || 'Pending') === statusFilter);
        }
        // cachedAllOrders is already newest-first from the query above

        if (orders.length === 0) {
            container.innerHTML = `<div class="admin-no-data">No orders found for this filter.</div>`;
            return;
        }

        container.innerHTML = `
            <p style="font-size:12px; color:#8a94a6; margin-bottom:10px;">Showing the ${LIST_FETCH_LIMIT} most recent orders${statusFilter !== 'All' ? ` (filtered to "${statusFilter}")` : ''}.</p>
            ${orders.map(o => `
            <div class="admin-row-card">
                <div class="arc-info">
                    <h4>📦 ${escapeHtml(o.productName || 'Item')} (Qty: ${o.quantity || 1}) — ₹${o.price || 0}</h4>
                    <p>Buyer: ${escapeHtml(o.buyerName || 'N/A')} &nbsp; | &nbsp; Shop: ${escapeHtml(o.shopName || 'N/A')}</p>
                    <p class="uid-tag">Status: <strong>${o.status || 'Pending'}</strong></p>
                </div>
            </div>
        `).join('')}`;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load orders.</p>`;
    }
}
