import { collection, addDoc, getDocs, query, where, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isPremiumSeller, countSellerActiveCoupons, FREE_TIER_LIMITS } from './premium-logic.js';

export async function addCoupon(db, sellerUid, code, discountType, value, refreshCallback) {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) { alert("Please enter a coupon code."); return; }
    if (!value || Number(value) <= 0) { alert("Please enter a valid discount value."); return; }
    if (discountType === 'percent' && Number(value) > 90) { alert("Percentage discount can't exceed 90%."); return; }

    const premium = await isPremiumSeller(db, sellerUid);
    if (!premium) {
        const activeCount = await countSellerActiveCoupons(db, sellerUid);
        if (activeCount >= FREE_TIER_LIMITS.maxActiveCoupons) {
            alert(`Free sellers can have ${FREE_TIER_LIMITS.maxActiveCoupons} active coupon at a time. Upgrade to Premium for unlimited coupons!`);
            return;
        }
    }

    try {
        await addDoc(collection(db, "coupons"), {
            code: cleanCode,
            sellerUid: sellerUid,
            discountType: discountType, // 'percent' or 'flat'
            value: Number(value),
            active: true,
            createdAt: new Date()
        });
        alert(`Coupon "${cleanCode}" created! 🎉`);
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error creating coupon: " + error.message);
    }
}

export async function loadMyCoupons(db, sellerUid) {
    const container = document.getElementById('couponsContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading coupons...</p>";

    try {
        const q = query(collection(db, "coupons"), where("sellerUid", "==", sellerUid));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="no-data">No coupons created yet.</div>`;
            return;
        }

        let html = "";
        snap.forEach(d => {
            const c = d.data();
            const discountLabel = c.discountType === 'percent' ? `${c.value}% OFF` : `₹${c.value} OFF`;
            html += `
                <div class="coupon-card ${c.active ? '' : 'inactive'}">
                    <div>
                        <span class="coupon-code">${c.code}</span>
                        <span class="coupon-discount">${discountLabel}</span>
                        ${!c.active ? '<span class="coupon-off-tag">Inactive</span>' : ''}
                    </div>
                    <div class="btn-group">
                        <button class="dash-action-btn ${c.active ? 'btn-cancel' : 'btn-accept'}" onclick="toggleCouponMain('${d.id}', ${!c.active})">${c.active ? 'Deactivate' : 'Activate'}</button>
                        <button class="btn-delete" onclick="deleteCouponMain('${d.id}')">🗑️</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load coupons.</p>`;
    }
}

export async function toggleCouponActive(db, couponId, active, refreshCallback) {
    try {
        await updateDoc(doc(db, "coupons", couponId), { active });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error updating coupon.");
    }
}

export async function deleteCoupon(db, couponId, refreshCallback) {
    if (!confirm("Delete this coupon?")) return;
    try {
        await deleteDoc(doc(db, "coupons", couponId));
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        alert("Error deleting coupon.");
    }
}

// Used at checkout to look up and validate a coupon code
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
