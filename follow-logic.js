import { doc, setDoc, deleteDoc, getDoc, getDocs, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Data model (kept denormalized on both sides so we can cheaply answer both
// "which shops does this buyer follow?" and "how many followers does this
// seller have?" without extra composite queries):
//   users/{buyerUid}/following/{sellerUid}          -> { shopName, logo, city, followedAt }
//   sellers_profiles/{sellerUid}/followers/{buyerUid} -> { followedAt }

export async function followSeller(db, buyerUid, sellerUid, sellerData) {
    if (!buyerUid || !sellerUid || buyerUid === sellerUid) return;

    await setDoc(doc(db, "users", buyerUid, "following", sellerUid), {
        shopName: sellerData?.shopName || "Local Seller",
        logo: sellerData?.logo || "",
        city: sellerData?.city || "",
        followedAt: serverTimestamp()
    });

    await setDoc(doc(db, "sellers_profiles", sellerUid, "followers", buyerUid), {
        followedAt: serverTimestamp()
    });
}

export async function unfollowSeller(db, buyerUid, sellerUid) {
    if (!buyerUid || !sellerUid) return;
    await deleteDoc(doc(db, "users", buyerUid, "following", sellerUid));
    await deleteDoc(doc(db, "sellers_profiles", sellerUid, "followers", buyerUid));
}

export async function isFollowingSeller(db, buyerUid, sellerUid) {
    if (!buyerUid || !sellerUid) return false;
    try {
        const snap = await getDoc(doc(db, "users", buyerUid, "following", sellerUid));
        return snap.exists();
    } catch (e) {
        console.error("isFollowingSeller error:", e);
        return false;
    }
}

// Returns an array of { id: sellerUid, shopName, logo, city } for every
// seller this buyer currently follows.
export async function getFollowedSellers(db, buyerUid) {
    if (!buyerUid) return [];
    try {
        const snap = await getDocs(collection(db, "users", buyerUid, "following"));
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        return list;
    } catch (e) {
        console.error("getFollowedSellers error:", e);
        return [];
    }
}

export async function getFollowerCount(db, sellerUid) {
    if (!sellerUid) return 0;
    try {
        const snap = await getDocs(collection(db, "sellers_profiles", sellerUid, "followers"));
        return snap.size;
    } catch (e) {
        console.error("getFollowerCount error:", e);
        return 0;
    }
}

// Toggles follow state and returns the new boolean state — handy for wiring
// straight up to a button's onclick without the caller tracking state itself.
export async function toggleFollowSeller(db, buyerUid, sellerUid, sellerData) {
    const currentlyFollowing = await isFollowingSeller(db, buyerUid, sellerUid);
    if (currentlyFollowing) {
        await unfollowSeller(db, buyerUid, sellerUid);
        return false;
    } else {
        await followSeller(db, buyerUid, sellerUid, sellerData);
        return true;
    }
}
