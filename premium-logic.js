import { doc, getDoc, updateDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const FREE_TIER_LIMITS = {
    maxProducts: 30,
    maxPhotosPerProduct: 1,
    maxActiveCoupons: 1,
    bulkUploadAllowed: false
};

export async function isPremiumSeller(db, uid) {
    try {
        const snap = await getDoc(doc(db, "sellers_profiles", uid));
        return snap.exists() && snap.data().isPremium === true;
    } catch (error) {
        console.error("Error checking premium status:", error);
        return false;
    }
}

export async function countSellerProducts(db, uid) {
    const q = query(collection(db, "vendors"), where("sellerUid", "==", uid));
    const snap = await getDocs(q);
    return snap.size;
}

export async function countSellerActiveCoupons(db, uid) {
    const q = query(collection(db, "coupons"), where("sellerUid", "==", uid), where("active", "==", true));
    const snap = await getDocs(q);
    return snap.size;
}

// ---------- ADMIN: toggle a seller's premium status ----------
export async function setSellerPremium(db, sellerUid, isPremium, refreshCallback) {
    try {
        await updateDoc(doc(db, "sellers_profiles", sellerUid), { isPremium });
        alert(isPremium ? "Seller upgraded to Premium! 🌟" : "Premium status removed for this seller.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error updating premium status:", error);
        alert("Error updating premium status. If this is a new shop with no profile yet, ask the seller to save their Shop Profile first.");
    }
}

// ---------- Renders a small badge for premium sellers (shop/product pages) ----------
export function renderPremiumBadge(isPremium) {
    if (!isPremium) return '';
    return `<span style="background:linear-gradient(135deg,#ffd700,#ff9900); color:#111; font-size:10.5px; font-weight:bold; padding:3px 9px; border-radius:10px; margin-left:6px;">🌟 PREMIUM SELLER</span>`;
}
