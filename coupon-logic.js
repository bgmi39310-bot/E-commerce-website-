import { collection, addDoc, getDocs, query, where, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isPremiumSeller, countSellerActiveCoupons, FREE_TIER_LIMITS } from './premium-logic.js';

// Local cache so toggling/deleting a coupon never needs to re-query Firestore.
let cachedCoupons = [];

function renderCoupons() {
    const container = document.getElementById('couponsContainer');
    if (!container) return;

    if (cachedCoupons.length === 0) {
        container.innerHTML = `<div class="no-data">No coupons created yet.</div>`;
        return;
    }

    container.innerHTML = cachedCoupons.map(c => {
        const discountLabel = c.discountType === 'percent' ? `${c.value}% OFF` : `₹${c.value} OFF`;
        return `
            <div class="coupon-card ${c.active ? '' : 'inactive'}">
                <div>
                    <span class="coupon-code">${c.code}</span>
                    <span class="coupon-discount">${discountLabel}</span>
                    ${!c.active ? '<span class="coupon-off-tag">Inactive</span>' : ''}
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

export async function addCoupon(db, sellerUid, code, discountType, value) {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) { alert("Please enter a coupon code."); return; }
    if (!value || Number(value) <= 0) { alert("Please enter a valid discount value."); return; }
    if (discountType === 'percent' && Number(value) > 90) { alert("Percentage discount can't exceed 90%."); return; }

    const premium = await isPremiumSeller(db, sellerUid);
    if (!premium) {
        const activeCount = cachedCoupons.filter(c => c.active).length;
        if (activeCount >= FREE_TIER_LIMITS.maxActiveCoupons) {
            alert(`Free sellers can have ${FREE_TIER_LIMITS.maxActiveCoupons} active coupon at a time. Upgrade to Premium for unlimited coupons!`);
            return;
        }
    }

    try {
        const newCoupon = {
            code: cleanCode,
            sellerUid: sellerUid,
            discountType: discountType,
            value: Number(value),
            active: true,
            createdAt: new Date()
        };
        const docRef = await addDoc(collection(db, "coupons"), newCoupon);
        cachedCoupons.unshift({ id: docRef.id, ...newCoupon }); // patch locally, no re-fetch
        renderCoupons();
        alert(`Coupon "${cleanCode}" created! 🎉`);
    } catch (error) {
        console.error(error);
        alert("Error creating coupon: " + error.message);
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
        alert("Error updating coupon.");
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
        alert("Error deleting coupon.");
    }
}

// Used at checkout — a separate, deliberate lookup, not part of the seller's own list.
export async function validateCoupon(db, code) {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) return null;

    try {
        const q = query(collection(db, "coupons"), where("code", "==", cleanCode), where("active", "==", true));
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const d = snap.docs[0];
        return { id: d.id, ...d.data() };
    } catch (error) {
        console.error(error);
        return null;
    }
}
