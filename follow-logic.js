import { doc, setDoc, deleteDoc, getDoc, getDocs, collection, serverTimestamp, writeBatch, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Data model (kept denormalized on both sides so we can cheaply answer both
// "which shops does this buyer follow?" and "how many followers does this
// seller have?" without extra composite queries):
//   users/{buyerUid}/following/{sellerUid}          -> { shopName, logo, city, followedAt }
//   sellers_profiles/{sellerUid}/followers/{buyerUid} -> { followedAt }
//   sellers_profiles/{sellerUid}.followerCount        -> running total (see below)
//
// IMPORTANT: both sides are written/removed together using a writeBatch, so
// they either both succeed or both fail — no more half-followed state where
// one side exists and the other doesn't (which is what made the Follow
// button look broken/stuck before).
//
// READ COST NOTE: the follower *count* is kept as a running number
// (`followerCount`) on the seller's own profile doc, updated with
// increment()/decrement() in the same batch as the follow/unfollow. This
// means showing "👥 142 Followers" anywhere costs exactly ONE document read,
// no matter how many followers a shop actually has — instead of reading
// every single follower document just to count them (which is what this
// used to do, and would get expensive fast for a popular shop).

export async function followSeller(db, buyerUid, sellerUid, sellerData) {
    if (!buyerUid || !sellerUid || buyerUid === sellerUid) return;

    const batch = writeBatch(db);
    batch.set(doc(db, "users", buyerUid, "following", sellerUid), {
        shopName: sellerData?.shopName || "Local Seller",
        logo: sellerData?.logo || "",
        city: sellerData?.city || "",
        followedAt: serverTimestamp()
    });
    batch.set(doc(db, "sellers_profiles", sellerUid, "followers", buyerUid), {
        followedAt: serverTimestamp()
    });
    batch.update(doc(db, "sellers_profiles", sellerUid), { followerCount: increment(1) });
    await batch.commit();
}

export async function unfollowSeller(db, buyerUid, sellerUid) {
    if (!buyerUid || !sellerUid) return;
    const batch = writeBatch(db);
    batch.delete(doc(db, "users", buyerUid, "following", sellerUid));
    batch.delete(doc(db, "sellers_profiles", sellerUid, "followers", buyerUid));
    batch.update(doc(db, "sellers_profiles", sellerUid), { followerCount: increment(-1) });
    await batch.commit();
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

// ONE read, regardless of follower count — see the READ COST NOTE above.
// (Old behaviour read every single follower doc just to count them; a shop
// with 5,000 followers would have cost 5,000 reads every time someone
// looked at its follower count. This is now always exactly 1 read.)
export async function getFollowerCount(db, sellerUid) {
    if (!sellerUid) return 0;
    try {
        const snap = await getDoc(doc(db, "sellers_profiles", sellerUid));
        if (!snap.exists()) return 0;
        return Math.max(0, snap.data().followerCount || 0);
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
