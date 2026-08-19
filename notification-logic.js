import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Tracks whether this is the first snapshot fire (existing orders on page load)
// so we only alert for orders that arrive AFTER the seller opens the dashboard,
// not for their entire order history every time they open the page.
let isFirstSnapshot = true;
let unreadCount = 0;

function seenKey(uid) {
    return `desimarket_last_seen_orders_${uid}`;
}

function getSeenIds(uid) {
    try {
        return new Set(JSON.parse(localStorage.getItem(seenKey(uid))) || []);
    } catch (e) {
        return new Set();
    }
}

function saveSeenIds(uid, idsSet) {
    // Keep the stored list from growing forever
    const arr = Array.from(idsSet).slice(-300);
    localStorage.setItem(seenKey(uid), JSON.stringify(arr));
}

function updateBellBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (unreadCount > 0) {
        badge.style.display = 'flex';
        badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
    } else {
        badge.style.display = 'none';
    }
}

function showBrowserNotification(order) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
        new Notification("🛍️ New Order Received!", {
            body: `${order.productName || 'A product'} — ₹${order.price || 0} from ${order.buyerName || 'a customer'}`,
            icon: "https://cdn-icons-png.flaticon.com/512/2331/2331966.png"
        });
    }
}

function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio not available, ignore */ }
}

export function listenForNewOrders(db, uid, onNewOrderCallback) {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }

    const seenIds = getSeenIds(uid);
    isFirstSnapshot = true;
    unreadCount = 0;
    updateBellBadge();

    const q = query(collection(db, "orders"), where("sellerUid", "==", uid));

    onSnapshot(q, (snapshot) => {
        const newOrders = [];

        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const orderId = change.doc.id;
                if (!seenIds.has(orderId)) {
                    seenIds.add(orderId);
                    if (!isFirstSnapshot) {
                        newOrders.push({ id: orderId, ...change.doc.data() });
                    }
                }
            }
        });

        saveSeenIds(uid, seenIds);

        if (!isFirstSnapshot && newOrders.length > 0) {
            unreadCount += newOrders.length;
            updateBellBadge();
            playChime();
            newOrders.forEach(showBrowserNotification);
            if (onNewOrderCallback) onNewOrderCallback(newOrders);
        }

        isFirstSnapshot = false;
    }, (error) => {
        console.error("Notification listener error:", error);
    });
}

export function clearUnreadNotifications() {
    unreadCount = 0;
    updateBellBadge();
}

