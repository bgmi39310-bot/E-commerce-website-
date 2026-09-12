import {
    doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, limit, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { sendNotification } from './notif-logic.js';
import { initPickerMap } from './map-utils.js';

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

export async function loadDeliveryProfile(db, uid) {
    const docSnap = await getDoc(doc(db, "delivery_profiles", uid));
    if (docSnap.exists()) {
        const profile = docSnap.data();
        lastLoadedDeliveryLat = typeof profile.lat === 'number' ? profile.lat : null;
        lastLoadedDeliveryLng = typeof profile.lng === 'number' ? profile.lng : null;
        return profile;
    }
    return null;
}

export async function saveDeliveryProfile(db, uid, { name, phone, village, vehicleType }) {
    if (!name || !phone || !village) {
        showToast("Please fill in your name, phone, and service village/area.", 'error');
        return false;
    }
    try {
        await setDoc(doc(db, "delivery_profiles", uid), {
            uid, name, phone, village, vehicleType: vehicleType || 'bike',
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

export async function loadJobBoard(db, village) {
    if (!village) return [];
    try {
        const q = query(
            collection(db, "orders"),
            where("deliveryRequestStatus", "==", "open"),
            where("buyerCity", "==", village),
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

// A delivery partner claims an OPEN job-board order for themselves.
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
            deliveryRequestStatus: 'assigned'
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
// SELLER SIDE — finding delivery partners and posting/assigning orders.
// (Used from seller-dashboard.html.)
// ============================================================================

export async function findAvailableDeliveryBoys(db, village) {
    if (!village) return [];
    try {
        const q = query(
            collection(db, "delivery_profiles"),
            where("village", "==", village),
            where("isAvailable", "==", true),
            limit(50)
        );
        const snap = await getDocs(q);
        const boys = [];
        snap.forEach(d => boys.push({ id: d.id, ...d.data() }));
        return boys;
    } catch (error) {
        console.error("Error finding delivery partners:", error);
        throw error;
    }
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

// Directly assigns one order to a specific delivery partner (skips the job board).
export async function assignOrderToDeliveryBoy(db, orderId, deliveryBoy) {
    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, {
            deliveryBoyUid: deliveryBoy.id,
            deliveryBoyName: deliveryBoy.name,
            deliveryBoyPhone: deliveryBoy.phone,
            deliveryRequestStatus: 'assigned'
        });
        sendNotification(db, deliveryBoy.id, {
            title: 'New delivery assignment',
            body: `A shop has asked you to deliver an order in ${deliveryBoy.village || 'your area'}.`,
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
