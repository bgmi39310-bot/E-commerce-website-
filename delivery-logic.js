import {
    doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, limit, orderBy,
    getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { sendNotification } from './notif-logic.js';
import { initPickerMap, distanceKm } from './map-utils.js';

// ============================================================================
// PROFILE
// ============================================================================

let deliveryMapController = null;
let pickedDeliveryLat = null;
let pickedDeliveryLng = null;
let lastLoadedDeliveryLat = null;
let lastLoadedDeliveryLng = null;

async function ensureDeliveryLocationMap(initialLat, initialLng) {
    if (deliveryMapController) { deliveryMapController.invalidateSize(); return; }
    if (typeof initialLat === 'number' && typeof initialLng === 'number') {
        pickedDeliveryLat = initialLat;
        pickedDeliveryLng = initialLng;
    }
    const mapEl = document.getElementById('deliveryLocationMap');
    if (!mapEl) return; // this page/section doesn't have a map — fine, location is optional anyway
    try {
        deliveryMapController = await initPickerMap('deliveryLocationMap', (latlng) => {
            pickedDeliveryLat = latlng.lat;
            pickedDeliveryLng = latlng.lng;
            const statusEl = document.getElementById('deliveryLocationStatus');
            if (statusEl) statusEl.textContent = `📍 Base location set (${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}).`;
        }, initialLat, initialLng);
    } catch (error) {
        console.error('Could not load delivery location map:', error);
    }
}

export async function useMyLocationForDelivery() {
    if (!deliveryMapController) await ensureDeliveryLocationMap();
    if (!deliveryMapController) return;
    try {
        await deliveryMapController.useCurrentLocation();
        showToast('Base location set from your device. 📍');
    } catch (error) {
        showToast("Couldn't get your location — please allow location access, or tap the map to set it manually.", 'error');
    }
}

export function refreshDeliveryLocationMap() {
    ensureDeliveryLocationMap(lastLoadedDeliveryLat, lastLoadedDeliveryLng);
}

// Whatever location is currently pinned on the (already-open) location
// picker map — used by the "find nearby villages" button, which needs to
// know where to search from before the profile is even saved.
export function getCurrentPinLatLng() {
    if (typeof pickedDeliveryLat !== 'number' || typeof pickedDeliveryLng !== 'number') return null;
    return { lat: pickedDeliveryLat, lng: pickedDeliveryLng };
}

// Normalizes a profile doc so callers never have to think about the old
// single-`village` shape from before multi-village support existed —
// everything downstream just uses `villages` (an array).
function normalizeProfile(profile) {
    if (!profile) return null;
    let villages = Array.isArray(profile.villages) ? profile.villages : [];
    if (villages.length === 0 && profile.village) villages = [profile.village]; // migrate old single-village profiles
    return {
        ...profile,
        villages,
        feeType: profile.feeType || 'per_order',
        feeAmount: typeof profile.feeAmount === 'number' ? profile.feeAmount : 0,
        maxDistanceKm: typeof profile.maxDistanceKm === 'number' ? profile.maxDistanceKm : null
    };
}

// Looks at shops that have already pinned their location (sellers_profiles
// with lat/lng set) and suggests village/city names within `radiusKm` of
// the delivery partner's own pinned location — a one-click way to add
// nearby areas instead of typing them all out. There's no separate
// geocoded village database in this app; shop locations already entered by
// sellers are the best available source of "known villages with coordinates".
export async function suggestNearbyVillages(db, lat, lng, radiusKm = 5) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return [];
    try {
        const snap = await getDocs(query(collection(db, "sellers_profiles"), limit(300)));
        const seen = new Map(); // village name (lowercased) -> {name, distanceKm}
        snap.forEach(d => {
            const s = d.data();
            if (typeof s.lat !== 'number' || typeof s.lng !== 'number' || !s.city) return;
            const dist = distanceKm(lat, lng, s.lat, s.lng);
            if (dist > radiusKm) return;
            const key = s.city.trim().toLowerCase();
            if (!key) return;
            const existing = seen.get(key);
            if (!existing || dist < existing.distanceKm) {
                seen.set(key, { name: s.city.trim(), distanceKm: dist });
            }
        });
        return [...seen.values()].sort((a, b) => a.distanceKm - b.distanceKm);
    } catch (error) {
        console.error("Error suggesting nearby villages:", error);
        return [];
    }
}

export async function loadDeliveryProfile(db, uid) {
    const docSnap = await getDoc(doc(db, "delivery_profiles", uid));
    if (docSnap.exists()) {
        const profile = normalizeProfile(docSnap.data());
        lastLoadedDeliveryLat = typeof profile.lat === 'number' ? profile.lat : null;
        lastLoadedDeliveryLng = typeof profile.lng === 'number' ? profile.lng : null;
        return profile;
    }
    return null;
}

// `villages` here is an ARRAY (a delivery partner can serve more than one
// village/area — they're not locked into just one like before).
// `feeType` is how they charge for a delivery:
//   'per_order' — a flat ₹ amount for EACH order/parcel delivered
//   'per_trip'  — a flat ₹ amount for a whole trip, no matter how many
//                 orders (possibly from different shops going to the same
//                 area) are bundled into it
//   'per_km'    — a ₹ rate per kilometre travelled
// DesiMarket doesn't compute per-km pricing automatically — it's shown so
// sellers/buyers know the rate to expect and agree the actual amount with
// the delivery partner directly.
export async function saveDeliveryProfile(db, uid, { name, phone, villages, vehicleType, feeType, feeAmount, maxDistanceKm }) {
    const cleanVillages = (villages || []).map(v => v.trim()).filter(Boolean);
    if (!name || !phone || cleanVillages.length === 0) {
        showToast("Please fill in your name, phone, and at least one village/area you serve.", 'error');
        return false;
    }
    if (cleanVillages.length > 25) {
        showToast("Please list 25 villages/areas or fewer.", 'error');
        return false;
    }
    const validFeeTypes = ['per_order', 'per_trip', 'per_km'];
    try {
        await setDoc(doc(db, "delivery_profiles", uid), {
            uid, name, phone,
            villages: cleanVillages,
            village: cleanVillages[0], // kept in sync for any old code path that still reads the singular field
            vehicleType: vehicleType || 'bike',
            feeType: validFeeTypes.includes(feeType) ? feeType : 'per_order',
            feeAmount: Number(feeAmount) || 0,
            maxDistanceKm: maxDistanceKm ? Number(maxDistanceKm) : null,
            lat: pickedDeliveryLat,
            lng: pickedDeliveryLng,
            isAvailable: true, // default to available right after setting up — they can toggle off any time
            updatedAt: new Date()
        }, { merge: true });
        showToast("Delivery profile saved! 🚚");
        return true;
    } catch (error) {
        console.error(error);
        showToast("Error saving profile: " + error.message, 'error');
        return false;
    }
}

export async function setDeliveryAvailability(db, uid, isAvailable) {
    try {
        await updateDoc(doc(db, "delivery_profiles", uid), { isAvailable });
        showToast(isAvailable ? "You're now marked as Available. 🟢" : "You're now marked as Busy. 🔴");
    } catch (error) {
        console.error(error);
        showToast("Error updating availability.", 'error');
    }
}

// ============================================================================
// JOB BOARD — open delivery requests any delivery partner serving that
// village can claim. Village-text matching, same pattern as "Sellers Near
// You" elsewhere in the app — no GPS required to use this.
// ============================================================================

export async function loadJobBoard(db, villages) {
    const list = (villages || []).slice(0, 30); // Firestore "in" supports at most 30 values
    if (list.length === 0) return [];
    try {
        const q = query(
            collection(db, "orders"),
            where("deliveryRequestStatus", "==", "open"),
            where("buyerCity", "in", list),
            limit(50)
        );
        const snap = await getDocs(q);
        const jobs = [];
        snap.forEach(d => jobs.push({ id: d.id, ...d.data() }));
        return jobs;
    } catch (error) {
        console.error("Error loading job board:", error);
        throw error;
    }
}

// A delivery partner claims an OPEN job-board order for themselves. Their
// CURRENT fee is snapshotted onto the order at this moment — so it stays
// accurate for this delivery's history/earnings even if they change their
// rate later.
export async function claimDeliveryJob(db, orderId, deliveryBoy) {
    try {
        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists() || snap.data().deliveryRequestStatus !== 'open') {
            showToast("This delivery has already been claimed by someone else.", 'error');
            return false;
        }
        await updateDoc(orderRef, {
            deliveryBoyUid: deliveryBoy.uid,
            deliveryBoyName: deliveryBoy.name,
            deliveryBoyPhone: deliveryBoy.phone,
            deliveryRequestStatus: 'assigned',
            deliveryFeeType: deliveryBoy.feeType || 'per_order',
            deliveryFeeAmount: deliveryBoy.feeAmount || 0
        });
        const order = snap.data();
        if (order.sellerUid) {
            sendNotification(db, order.sellerUid, {
                title: `Delivery partner found for order`,
                body: `${deliveryBoy.name} will pick up "${order.productName || 'your item'}" for delivery.`,
                type: 'delivery_claimed',
                link: 'seller-dashboard.html'
            });
        }
        showToast("Delivery claimed! It now shows in 'My Deliveries'.");
        return true;
    } catch (error) {
        console.error(error);
        showToast("Error claiming this delivery.", 'error');
        return false;
    }
}

// ============================================================================
// MY DELIVERIES — orders assigned to (or claimed by) this delivery partner,
// regardless of which shop they came from.
// ============================================================================

export async function loadMyDeliveries(db, uid) {
    try {
        const q = query(
            collection(db, "orders"),
            where("deliveryBoyUid", "==", uid),
            where("status", "in", ["Accepted", "Shipped"]), // Pending isn't ready for pickup yet; Delivered/Cancelled don't need action
            limit(100)
        );
        const snap = await getDocs(q);
        const deliveries = [];
        snap.forEach(d => deliveries.push({ id: d.id, ...d.data() }));
        return deliveries;
    } catch (error) {
        console.error("Error loading my deliveries:", error);
        throw error;
    }
}

// A delivery partner backing out of an assignment they haven't picked up
// yet — reopens it on the job board rather than leaving the seller stuck.
export async function declineDeliveryAssignment(db, orderId) {
    try {
        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) return;
        if (snap.data().status === 'Shipped') {
            showToast("This order has already been picked up — you can't back out now. Please contact the seller directly.", 'error');
            return;
        }
        await updateDoc(orderRef, {
            deliveryBoyUid: null,
            deliveryBoyName: null,
            deliveryBoyPhone: null,
            deliveryRequestStatus: 'open'
        });
        showToast("Assignment declined — it's back on the job board for someone else.");
    } catch (error) {
        console.error(error);
        showToast("Error declining this assignment.", 'error');
    }
}

// ============================================================================
// STATS & HISTORY — the "how many done, how many left, how much earned"
// view every delivery-app dashboard has.
// ============================================================================

export async function getDeliveryStats(db, uid) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const [deliveredTotalSnap, deliveredTodaySnap, activeSnap] = await Promise.all([
        getCountFromServer(query(
            collection(db, "orders"),
            where("deliveryBoyUid", "==", uid),
            where("status", "==", "Delivered")
        )),
        getCountFromServer(query(
            collection(db, "orders"),
            where("deliveryBoyUid", "==", uid),
            where("status", "==", "Delivered"),
            where("deliveredAt", ">=", todayStart)
        )),
        getCountFromServer(query(
            collection(db, "orders"),
            where("deliveryBoyUid", "==", uid),
            where("status", "in", ["Accepted", "Shipped"])
        )),
    ]);

    return {
        deliveredTotal: deliveredTotalSnap.data().count,
        deliveredToday: deliveredTodaySnap.data().count,
        active: activeSnap.data().count
    };
}

// Recent completed deliveries, most recent first — the earnings/history log.
export async function loadDeliveryHistory(db, uid) {
    const q = query(
        collection(db, "orders"),
        where("deliveryBoyUid", "==", uid),
        where("status", "==", "Delivered"),
        orderBy("deliveredAt", "desc"),
        limit(100)
    );
    const snap = await getDocs(q);
    const history = [];
    snap.forEach(d => history.push({ id: d.id, ...d.data() }));
    return history;
}

// ============================================================================
// SELLER SIDE — finding delivery partners and posting/assigning orders.
// (Used from seller-dashboard.html.)
// ============================================================================

// Village-specific search (kept for the "assign to this order's exact
// destination village" flow).
export async function findAvailableDeliveryBoys(db, village) {
    if (!village) return [];
    try {
        const q = query(
            collection(db, "delivery_profiles"),
            where("villages", "array-contains", village),
            where("isAvailable", "==", true),
            limit(50)
        );
        const snap = await getDocs(q);
        const boys = [];
        snap.forEach(d => boys.push({ id: d.id, ...normalizeProfile(d.data()) }));
        return boys;
    } catch (error) {
        console.error("Error finding delivery partners:", error);
        throw error;
    }
}

// The full "who's live right now" directory — every available delivery
// partner platform-wide, regardless of village, so a seller can browse
// everyone rather than only exact village-text matches. If the seller has
// a shop location pinned (lat/lng), results are sorted nearest-first;
// otherwise they're shown in whatever order Firestore returns them.
export async function loadAllAvailableDeliveryPartners(db, myLat, myLng) {
    const q = query(
        collection(db, "delivery_profiles"),
        where("isAvailable", "==", true),
        limit(200)
    );
    const snap = await getDocs(q);
    let boys = [];
    snap.forEach(d => boys.push({ id: d.id, ...normalizeProfile(d.data()) }));

    if (typeof myLat === 'number' && typeof myLng === 'number') {
        boys = boys.map(b => ({
            ...b,
            distanceKm: (typeof b.lat === 'number' && typeof b.lng === 'number')
                ? distanceKm(myLat, myLng, b.lat, b.lng)
                : null
        })).sort((a, b) => {
            if (a.distanceKm === null && b.distanceKm === null) return 0;
            if (a.distanceKm === null) return 1;
            if (b.distanceKm === null) return -1;
            return a.distanceKm - b.distanceKm;
        });
    }
    return boys;
}

// Puts an order on the open job board for any delivery partner serving that village to claim.
export async function postOrderToJobBoard(db, orderId) {
    try {
        await updateDoc(doc(db, "orders", orderId), {
            deliveryRequestStatus: 'open',
            deliveryBoyUid: null,
            deliveryBoyName: null,
            deliveryBoyPhone: null
        });
        showToast("Posted to the delivery job board. 📋");
    } catch (error) {
        console.error(error);
        showToast("Error posting this order for delivery.", 'error');
    }
}

// Directly assigns one order to a specific delivery partner (skips the job
// board). Their current fee is snapshotted onto the order, same as claiming.
export async function assignOrderToDeliveryBoy(db, orderId, deliveryBoy) {
    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, {
            deliveryBoyUid: deliveryBoy.id,
            deliveryBoyName: deliveryBoy.name,
            deliveryBoyPhone: deliveryBoy.phone,
            deliveryRequestStatus: 'assigned',
            deliveryFeeType: deliveryBoy.feeType || 'per_order',
            deliveryFeeAmount: deliveryBoy.feeAmount || 0
        });
        sendNotification(db, deliveryBoy.id, {
            title: 'New delivery assignment',
            body: `A shop has asked you to deliver an order${deliveryBoy.villages && deliveryBoy.villages[0] ? ' in ' + deliveryBoy.villages[0] : ''}.`,
            type: 'delivery_assigned',
            link: 'delivery-dashboard.html'
        });
        showToast(`Assigned to ${deliveryBoy.name}. 🚚`);
    } catch (error) {
        console.error(error);
        showToast("Error assigning this order.", 'error');
    }
}

// Seller taking delivery back in-house after posting/assigning it.
export async function cancelDeliveryRequest(db, orderId) {
    try {
        await updateDoc(doc(db, "orders", orderId), {
            deliveryRequestStatus: null,
            deliveryBoyUid: null,
            deliveryBoyName: null,
            deliveryBoyPhone: null
        });
        showToast("Delivery request cancelled — this order is back to self-delivery.");
    } catch (error) {
        console.error(error);
        showToast("Error cancelling delivery request.", 'error');
    }
}
