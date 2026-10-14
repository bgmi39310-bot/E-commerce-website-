import { collection, getDocs, query, where, doc, updateDoc, deleteDoc, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';
import { BACKEND_BASE_URL } from './order-api.js';

// Local cache so toggling/deleting a coupon never needs to re-query Firestore.
let cachedCoupons = [];

function formatExpiry(expiryDate) {
    if (!expiryDate) return '';
    const d = new Date(expiryDate + 'T23:59:59');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderCoupons() {
    const container = document.getElementById('couponsContainer');
    if (!container) return;

    if (cachedCoupons.length === 0) {
        container.innerHTML = `<div class="no-data">No coupons created yet.</div>`;
        return;
    }

    container.innerHTML = cachedCoupons.map(c => {
        const discountLabel = c.discountType === 'percent' ? `${c.value}% OFF` : `₹${c.value} OFF`;
        const expiryText = formatExpiry(c.expiryDate);
        const usageText = c.usageLimit ? `${c.usedCount || 0}/${c.usageLimit} used` : `${c.usedCount || 0} used`;
        return `
            <div class="coupon-card ${c.active ? '' : 'inactive'}">
                <div>
                    <span class="coupon-code">${escapeHtml(c.code)}</span>
                    <span class="coupon-discount">${discountLabel}</span>
                    ${!c.active ? '<span class="coupon-off-tag">Inactive</span>' : ''}
                    <div style="font-size:12px; color:#666; margin-top:4px;">
                        ${expiryText ? `Expires ${expiryText} · ` : 'No expiry · '}${usageText}
                    </div>
                </div>
                <div class="btn-group">
                    <button class="dash-action-btn ${c.active ? 'btn-cancel' : 'btn-accept'}" onclick="toggleCouponMain('${c.id}', ${!c.active})">${c.active ? 'Deactivate' : 'Activate'}</button>
                    <button class="btn-delete" onclick="deleteCouponMain('${c.id}')">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

export async function loadMyCoupons(db, sellerUid) {
    const container = document.getElementById('couponsContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading coupons...</p>";

    try {
        const q = query(collection(db, "coupons"), where("sellerUid", "==", sellerUid));
        const snap = await getDocs(q);
        cachedCoupons = [];
        snap.forEach(d => cachedCoupons.push({ id: d.id, ...d.data() }));
        renderCoupons();
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load coupons.</p>`;
    }
}

export async function addCoupon(db, currentLoggedInUser, code, discountType, value, expiryDate, usageLimit) {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) { showToast("Please enter a coupon code.", 'error'); return; }
    if (!value || Number(value) <= 0) { showToast("Please enter a valid discount value.", 'error'); return; }
    if (discountType === 'percent' && Number(value) > 90) { showToast("Percentage discount can't exceed 90%.", 'error'); return; }
    if (expiryDate) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (new Date(expiryDate) < today) { showToast("Expiry date can't be in the past.", 'error'); return; }
    }
    if (usageLimit && Number(usageLimit) <= 0) { showToast("Usage limit must be at least 1.", 'error'); return; }

    try {
        // The Premium active-coupon-count gate and the sitewide duplicate-code
        // check both re-run server-side now (see backend/routes/coupons.py) —
        // the old gate was a client-side isPremiumSeller() check only,
        // bypassable by calling the Firestore SDK directly regardless of plan.
        const idToken = await currentLoggedInUser.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/coupons`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({
                code: cleanCode,
                discountType,
                value: Number(value),
                expiryDate: expiryDate || null,
                usageLimit: usageLimit ? Number(usageLimit) : null
            })
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.error || 'Could not create coupon.');

        cachedCoupons.unshift({
            id: result.couponId, code: cleanCode, sellerUid: currentLoggedInUser.uid,
            discountType, value: Number(value), expiryDate: expiryDate || null,
            usageLimit: usageLimit ? Number(usageLimit) : null, usedCount: 0, active: true
        }); // patch locally, no re-fetch
        renderCoupons();
        showToast(`Coupon "${cleanCode}" created! 🎉`);
    } catch (error) {
        console.error(error);
        showToast("Error creating coupon: " + error.message, 'error');
    }
}

export async function toggleCouponActive(db, couponId, active) {
    try {
        await updateDoc(doc(db, "coupons", couponId), { active });
        const c = cachedCoupons.find(x => x.id === couponId);
        if (c) c.active = active;
        renderCoupons();
    } catch (error) {
        console.error(error);
        showToast("Error updating coupon.", 'error');
    }
}

export async function deleteCoupon(db, couponId) {
    if (!confirm("Delete this coupon?")) return;
    try {
        await deleteDoc(doc(db, "coupons", couponId));
        cachedCoupons = cachedCoupons.filter(c => c.id !== couponId);
        renderCoupons();
    } catch (error) {
        console.error(error);
        showToast("Error deleting coupon.", 'error');
    }
}

// Used at checkout — a separate, deliberate lookup, not part of the seller's own list.
// Returns null for anything a buyer shouldn't be able to apply: not found,
// inactive, expired, or already used up to its usage limit.
export async function validateCoupon(db, code) {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) return null;

    try {
        const q = query(collection(db, "coupons"), where("code", "==", cleanCode), where("active", "==", true));
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const d = snap.docs[0];
        const coupon = { id: d.id, ...d.data() };

        if (coupon.expiryDate) {
            const expiry = new Date(coupon.expiryDate + 'T23:59:59');
            if (Date.now() > expiry.getTime()) return null; // expired
        }
        if (coupon.usageLimit && (coupon.usedCount || 0) >= coupon.usageLimit) return null; // used up

        return coupon;
    } catch (error) {
        console.error(error);
        return null;
    }
}

// Called once an order using this coupon has actually been placed — keeps
// usedCount accurate so the usageLimit check above means something.
export async function recordCouponUsage(db, couponId) {
    if (!couponId) return;
    try {
        await updateDoc(doc(db, "coupons", couponId), { usedCount: increment(1) });
    } catch (error) {
        // Non-fatal: the order itself already went through. Worst case the
        // usage count is slightly under-counted, not over — safe direction to fail in.
        console.error('Failed to record coupon usage', error);
    }
}
