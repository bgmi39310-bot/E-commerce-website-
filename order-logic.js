import { doc, updateDoc, getDoc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { sendNotification } from './notif-logic.js';
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';
import { restoreStock, buildVariantKey } from './stock-logic.js';
import { deltaSync, updateInDeltaSyncCache } from './delta-sync-logic.js';
import { auth } from './firebase-config.js';
import { BACKEND_BASE_URL } from './order-api.js';

let allOrders = [];

// Lets other modules (like the analytics render, triggered separately from
// the Orders tab menu) read the CURRENT already-fetched order list without
// needing their own Firestore query.
export function getCurrentOrders() {
    return allOrders;
}
let currentStatusFilter = 'Pending';

// Delta-synced (see delta-sync-logic.js) — a seller with a long order
// history used to have their ENTIRE history re-read via a live listener
// every single time this loaded, and again on every status change while
// the tab stayed open. This instead only re-reads orders that changed
// since the last sync, cached in localStorage. The trade-off: a new order
// or status change from elsewhere (another tab, the buyer, a delivery
// partner) now shows up on the next reload/tab-revisit rather than
// instantly — same trade-off already made for the notification bell.
let lastFetchArgs = null;

// The orders list is loaded with delta-sync (no live listener), so after the
// seller taps Accept / Ship / Deliver the screen would keep showing the old
// state until a manual refresh — and a second tap on the same button was
// possible. This applies the change to the on-screen list and the saved
// cache immediately, right after the write succeeded.
function applyLocalOrderChange(orderId, changes) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return; // e.g. delivery-dashboard, which keeps its own list
    Object.assign(order, changes);
    if (lastFetchArgs) {
        const uid = lastFetchArgs[1];
        updateInDeltaSyncCache(`orders:seller:${uid}`, orderId, changes);
    }
    displayDashboardOrders();
    if (lastFetchArgs && lastFetchArgs[2]) lastFetchArgs[2](allOrders);
}

// Orders whose action is running right now — stops a double-tap from
// sending the same Accept / Ship / Deliver twice.
const busyOrders = new Set();

// ---------------------------------------------------------------------------
// Pay-at-delivery (COD / "UPI on Delivery"): whoever hands the order over
// collects the money from the buyer (UPI or cash) right BEFORE the delivery
// OTP step. Razorpay / advance-UPI orders skip this.
// ---------------------------------------------------------------------------
export function needsPaymentCollection(order) {
    if (!order) return false;
    if (!['COD', 'UPI'].includes(order.paymentMethod)) return false;
    if (order.paymentVerified === true || order.paymentCollected === true) return false;
    return !['Awaiting Seller Confirmation', 'Payment Not Received'].includes(order.paymentStatus);
}

function askPaymentModal(order, profile, isPartner) {
    return new Promise(resolve => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:99999; display:flex; align-items:center; justify-content:center; padding:16px;';
        const wantsUpi = order.paymentMethod === 'UPI';
        const upiId = profile && profile.upiId ? escapeHtml(profile.upiId) : '';
        const qr = profile && profile.upiQr ? escapeHtml(profile.upiQr) : '';
        wrap.innerHTML = `
            <div style="background:#fff; border-radius:10px; max-width:380px; width:100%; max-height:92vh; overflow:auto; padding:18px; text-align:center; font-family:inherit;">
                <h3 style="margin:0 0 6px;">💰 Payment collect karo</h3>
                <div style="font-size:30px; font-weight:800; color:#c7511f;">₹${order.price || 0}</div>
                <p style="font-size:13px; color:#555; margin:6px 0 10px;">Buyer ne <strong>${wantsUpi ? 'UPI' : 'Cash (COD)'}</strong> chuna tha, lekin wo ab UPI ya cash, kuch bhi de sakta hai.</p>
                ${(upiId || qr) ? `
                    <div style="background:#fff8ee; border:1px dashed #fa8900; border-radius:8px; padding:10px; margin-bottom:10px;">
                        <p style="margin:0 0 6px; font-size:13px;">UPI se dene ke liye buyer ko ${isPartner ? 'apna' : 'aapka'} UPI dikhao:</p>
                        ${upiId ? `<p style="margin:0 0 6px; font-weight:700; word-break:break-all;">${upiId}</p>` : ''}
                        ${qr ? `<img src="${qr}" alt="QR" style="max-width:200px; width:100%; border-radius:6px;">` : ''}
                    </div>` : `<p style="font-size:12px; color:#c0392b;">UPI ID/QR profile me nahi hai. Profile me daal do, to buyer scan kar sakega.</p>`}
                <button id="payUpiBtn" style="width:100%; padding:12px; margin-bottom:8px; border:none; border-radius:6px; background:#007600; color:#fff; font-weight:700; font-size:15px;">📱 UPI se mil gaya</button>
                <button id="payCashBtn" style="width:100%; padding:12px; margin-bottom:8px; border:none; border-radius:6px; background:#232f3e; color:#fff; font-weight:700; font-size:15px;">💵 Cash mil gaya</button>
                <button id="payNoBtn" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; background:#fff; font-size:14px;">Abhi nahi</button>
            </div>`;
        document.body.appendChild(wrap);
        const done = v => { wrap.remove(); resolve(v); };
        wrap.querySelector('#payUpiBtn').onclick = () => done('UPI');
        wrap.querySelector('#payCashBtn').onclick = () => done('CASH');
        wrap.querySelector('#payNoBtn').onclick = () => done(null);
    });
}

async function collectPayment(db, order) {
    const user = auth.currentUser;
    if (!user) { showToast('Please login again.', 'error'); return false; }
    const isPartner = !!order.deliveryBoyUid;
    const handlerUid = order.deliveryBoyUid || order.sellerUid;
    if (user.uid !== handlerUid) {
        showToast(isPartner ? 'Is order ka payment delivery partner collect karega.' : 'Ye order aapka nahi hai.', 'error');
        return false;
    }
    let profile = {};
    try {
        const snap = await getDoc(doc(db, isPartner ? 'delivery_profiles' : 'sellers_profiles', user.uid));
        if (snap.exists()) profile = snap.data();
    } catch (e) { /* modal still works without UPI details */ }

    const method = await askPaymentModal(order, profile, isPartner);
    if (!method) return false;

    try {
        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/payments/collect-delivery-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ orderId: order.id, method })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not record the payment.');
        order.paymentCollected = true;
        order.paymentStatus = 'Payment Collected';
        showToast('Payment record ho gaya ✅ Ab buyer se OTP lo.');
        return true;
    } catch (e) {
        showToast(e.message, 'error');
        return false;
    }
}

// Delivered order whose payment was never recorded: the seller fills it in later.
function askRecordModal(order) {
    return new Promise(resolve => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:99999; display:flex; align-items:center; justify-content:center; padding:16px;';
        const sel = 'width:100%; padding:10px; margin:4px 0 12px; border:1px solid #ccc; border-radius:6px; font-size:14px;';
        wrap.innerHTML = `
            <div style="background:#fff; border-radius:10px; max-width:360px; width:100%; padding:18px; font-family:inherit;">
                <h3 style="margin:0 0 4px;">✏️ Payment update karo</h3>
                <p style="font-size:13px; color:#555; margin:0 0 12px;">₹${order.price || 0} kisne collect kiya tha?</p>
                <label style="font-size:13px; font-weight:600;">Kisne liya</label>
                <select id="recBy" style="${sel}">
                    <option value="seller">Maine khud liya</option>
                    ${order.deliveryBoyUid ? `<option value="delivery">Delivery partner ne liya${order.deliveryBoyName ? ' (' + escapeHtml(order.deliveryBoyName) + ')' : ''}</option>` : ''}
                </select>
                <label style="font-size:13px; font-weight:600;">Kaise mila</label>
                <select id="recMethod" style="${sel}">
                    <option value="UPI">UPI se</option>
                    <option value="CASH">Cash me</option>
                </select>
                <button id="recSave" style="width:100%; padding:12px; margin-bottom:8px; border:none; border-radius:6px; background:#007600; color:#fff; font-weight:700; font-size:15px;">Save</button>
                <button id="recCancel" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; background:#fff; font-size:14px;">Cancel</button>
            </div>`;
        document.body.appendChild(wrap);
        const done = v => { wrap.remove(); resolve(v); };
        wrap.querySelector('#recSave').onclick = () => done({
            collectedBy: wrap.querySelector('#recBy').value,
            method: wrap.querySelector('#recMethod').value
        });
        wrap.querySelector('#recCancel').onclick = () => done(null);
    });
}

window.recordMissingPayment = async function(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) { showToast('Order not found. Refresh karo.', 'error'); return; }
    const choice = await askRecordModal(order);
    if (!choice) return;
    try {
        const user = auth.currentUser;
        if (!user) throw new Error('Please login again.');
        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/payments/record-missing-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ orderId, collectedBy: choice.collectedBy, method: choice.method })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not update the payment.');
        showToast('Payment update ho gaya ✅');
        if (lastFetchArgs) await fetchDashboardOrders(...lastFetchArgs);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

// Seller: "delivery partner ne jo paisa collect kiya tha wo mujhe mil gaya".
window.settleDeliveryPayment = async function(orderId) {
    if (!confirm('Kya delivery partner ne ye paisa aapko de diya hai?')) return;
    try {
        const user = auth.currentUser;
        if (!user) throw new Error('Please login again.');
        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/payments/settle-delivery-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ orderId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not update.');
        showToast('Hisaab band ✅');
        if (lastFetchArgs) await fetchDashboardOrders(...lastFetchArgs);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

// Seller says whether a direct-UPI payment really reached their account.
// Goes through the backend (only the real seller of the order may do this).
window.confirmUpiPayment = async function(orderId, received) {
    const ask = received
        ? 'Kya aapke UPI account me ye payment aa gaya hai? Apna UPI app dekhkar confirm karo.'
        : 'Kya aapko ye payment NAHI mila? Buyer ko bata diya jaayega.';
    if (!confirm(ask)) return;
    try {
        const user = auth.currentUser;
        if (!user) throw new Error('Please login again.');
        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/payments/confirm-upi-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ orderId, received })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not update payment status.');
        showToast(received ? 'Payment confirmed ✅ Ab order Accept kar sakte ho.' : 'Marked as payment not received.');
        if (lastFetchArgs) await fetchDashboardOrders(...lastFetchArgs);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

export async function fetchDashboardOrders(db, uid, onOrdersUpdate) {
    lastFetchArgs = [db, uid, onOrdersUpdate];
    const container = document.getElementById('dashboardOrdersContainer');
    try {
        allOrders = await deltaSync(db, {
            collectionPath: 'orders',
            whereField: 'sellerUid',
            whereValue: uid,
            storageKey: `orders:seller:${uid}`
        });
        displayDashboardOrders();
        if (onOrdersUpdate) onOrdersUpdate(allOrders); // lets analytics recompute from the same data, no extra reads
    } catch (error) {
        console.error("Error fetching orders: ", error);
        // TEMPORARY: showing the real error message on screen so the exact
        // cause can be diagnosed from a screenshot, without devtools.
        if (container) container.innerHTML = `<p style="color:red;">Debug error: ${escapeHtml(error.code || '')} ${escapeHtml(error.message || String(error))}</p>`;
    }
}

// Kept as a no-op so existing callers (seller-dashboard.html's pagehide
// cleanup) don't need to change — there's no live listener to tear down
// anymore, delta-sync is just a one-time fetch per call.
export function stopListeningToOrders() {}

export function filterOrders(status) {
    currentStatusFilter = status;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if(status === 'Pending') document.getElementById('tabPending').classList.add('active');
    if(status === 'Accepted') document.getElementById('tabAccepted').classList.add('active');
    if(status === 'Shipped') document.getElementById('tabShipped').classList.add('active');
    if(status === 'Delivered') document.getElementById('tabDelivered').classList.add('active');
    if(status === 'Cancelled') document.getElementById('tabCancelled').classList.add('active');
    if(status === 'Returned') document.getElementById('tabReturned').classList.add('active');

    displayDashboardOrders();
}

function displayDashboardOrders() {
    const container = document.getElementById('dashboardOrdersContainer');
    const filtered = allOrders.filter(o => (o.status || 'Pending') === currentStatusFilter);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="no-data">No ${currentStatusFilter} orders found for your account.</div>`;
        return;
    }

    let html = "";
    filtered.forEach(order => {
        const productNameSafe = escapeHtml(order.productName || 'Item');
        const sizeSafe = escapeHtml(order.selectedSize || '');
        const colorSafe = escapeHtml(order.selectedColor || '');
        const buyerNameSafe = escapeHtml(order.buyerName || 'Customer');
        const buyerPhoneSafe = escapeHtml(order.buyerPhone || 'N/A');
        const buyerAddressSafe = escapeHtml(order.buyerAddress || 'N/A');

        // Delivery-partner status line — only relevant once the order is
        // Accepted and the seller has either posted it to the job board or
        // assigned it directly. Self-delivering sellers never see this.
        let deliveryLine = '';
        if (order.deliveryRequestStatus === 'open') {
            deliveryLine = `<p style="color:#b8860b; font-size:13px;"><strong>📋 On delivery job board</strong> — waiting for a delivery partner to claim it.</p>`;
        } else if (order.deliveryRequestStatus === 'assigned' && order.deliveryBoyName) {
            deliveryLine = `<p style="color:#007185; font-size:13px;"><strong>🚚 Assigned to:</strong> ${escapeHtml(order.deliveryBoyName)} (${escapeHtml(order.deliveryBoyPhone || 'N/A')})</p>`;
        }

        // ---- Payment line (COD / direct UPI with seller confirmation) ----
        const awaitingUpi = order.paymentStatus === 'Awaiting Seller Confirmation';
        const upiNotReceived = order.paymentStatus === 'Payment Not Received';
        let paymentLine = '';
        if (awaitingUpi) {
            paymentLine = `
                <div style="background:#fff3e0; border:1px solid #fa8900; border-radius:6px; padding:10px; margin:8px 0;">
                    <p style="margin:0 0 6px;"><strong>💸 UPI payment — confirm karo</strong></p>
                    <p style="margin:0 0 8px; font-size:13px;">Buyer ne ₹${order.price || 0} bheja hai. UTR: <strong>${escapeHtml(order.upiUtr || '')}</strong><br>Apna UPI app kholkar dekho ki ye paisa aaya hai ya nahi.</p>
                    <button class="dash-action-btn btn-accept" onclick="confirmUpiPayment('${order.id}', true)">✅ Payment mila</button>
                    <button class="dash-action-btn btn-cancel" onclick="confirmUpiPayment('${order.id}', false)">❌ Payment nahi mila</button>
                </div>`;
        } else if (order.paymentStatus === 'Payment Received') {
            paymentLine = `<p style="color:#007600; font-size:13px;"><strong>✅ UPI payment received</strong> (UTR ${escapeHtml(order.upiUtr || '')})</p>`;
        } else if (upiNotReceived) {
            paymentLine = `<p style="color:#c0392b; font-size:13px;"><strong>❌ UPI payment not received</strong> — order Cancel kar do ya buyer se baat karo.</p>`;
        } else if (order.paymentStatus === 'Payment Collected') {
            const byWho = order.paymentCollectedBy === 'delivery' ? `delivery partner${order.paymentCollectedByName ? ' (' + escapeHtml(order.paymentCollectedByName) + ')' : ''}` : 'aapne khud';
            paymentLine = `<p style="color:#007600; font-size:13px;"><strong>✅ ₹${order.paymentCollectedAmount || order.price || 0} collect hua</strong> — ${byWho}, ${order.paymentCollectedMethod === 'UPI' ? 'UPI se' : 'cash me'}.</p>`;
            if (order.settlementStatus === 'Pending') {
                paymentLine += `
                    <div style="background:#fff3e0; border:1px solid #fa8900; border-radius:6px; padding:8px; margin:6px 0;">
                        <p style="margin:0 0 6px; font-size:13px;">💰 Ye paisa delivery partner ke paas hai. Unse lekar neeche dabao.</p>
                        <button class="dash-action-btn btn-accept" onclick="settleDeliveryPayment('${order.id}')">✅ Partner se mil gaya</button>
                    </div>`;
            }
        } else if (order.status === 'Delivered' && needsPaymentCollection(order)) {
            paymentLine = `
                <div style="background:#fdecea; border:1px solid #c0392b; border-radius:6px; padding:8px; margin:6px 0;">
                    <p style="margin:0 0 6px; font-size:13px; color:#c0392b;"><strong>⚠️ ₹${order.price || 0} ka payment record nahi hua.</strong> Delivery partner ya buyer se pooch lo, phir neeche update karo.</p>
                    <button class="dash-action-btn btn-accept" onclick="recordMissingPayment('${order.id}')">✏️ Payment update karo</button>
                </div>`;
        } else if (order.paymentMethod === 'COD') {
            paymentLine = `<p style="font-size:13px;"><strong>💵 Cash on Delivery</strong> — delivery par ₹${order.price || 0} lena hai.</p>`;
        } else if (order.paymentMethod === 'UPI') {
            paymentLine = `<p style="font-size:13px;"><strong>📱 UPI on Delivery</strong> — delivery par ₹${order.price || 0} collect karna hai (UPI ya cash).</p>`;
        }
        const canAccept = !awaitingUpi && !upiNotReceived;

        html += `
            <div class="order-card">
                <div class="order-info">
                    <h4>📦 ${productNameSafe} (Qty: ${order.quantity || 1})</h4>
                    ${(order.selectedSize || order.selectedColor) ? `<p style="color:#6f42c1; font-weight:600;">${sizeSafe ? 'Size: ' + sizeSafe + ' ' : ''}${colorSafe ? 'Color: ' + colorSafe : ''}</p>` : ''}
                    <p><strong>Buyer:</strong> ${buyerNameSafe}</p>
                    <p><strong>Phone:</strong> ${buyerPhoneSafe}</p>
                    <p><strong>Address:</strong> ${buyerAddressSafe}</p>
                    <p><strong>Amount:</strong> ₹${order.price || 0}</p>
                    <p><strong>Status:</strong> <span style="font-weight:bold; color:#007600;">${order.status || 'Pending'}</span></p>
                    ${paymentLine}
                    ${deliveryLine}
                    ${currentStatusFilter === 'Shipped' ? `<p style="color:#6f42c1; font-size:13px;"><strong>🔐 Ask whoever hands it over (you or your delivery partner) to get the buyer's Delivery OTP to confirm handover.</strong></p>` : ''}

                    <div class="btn-group">
                        <a href="tel:${encodeURIComponent(order.buyerPhone || '')}" class="call-btn">📞 Call Buyer</a>
                        <button type="button" class="dash-action-btn" style="background:#f0f2f2; color:#555;" data-buyer-uid="${order.buyerUid || ''}" data-buyer-name="${escapeHtml(order.buyerName || 'this buyer')}" data-order-id="${order.id}" onclick="window.openReportBuyerModal(this.dataset.buyerUid, this.dataset.buyerName, this.dataset.orderId)">🚩 Report Buyer</button>
                        ${currentStatusFilter === 'Pending' && canAccept ? `<button class="dash-action-btn btn-accept" onclick="updateOrderStatus('${order.id}', 'Accepted')">Accept</button>` : ''}
                        ${currentStatusFilter === 'Accepted' && !order.deliveryRequestStatus ? `<button class="dash-action-btn btn-ship" onclick="markShippedMain('${order.id}')">Mark Shipped (Self-Deliver)</button>` : ''}
                        ${currentStatusFilter === 'Accepted' && !order.deliveryRequestStatus ? `<button class="dash-action-btn" style="background:#007185; color:white;" data-order-id="${order.id}" data-buyer-city="${escapeHtml(order.buyerCity || '')}" onclick="window.openDeliveryOptions(this.dataset.orderId, this.dataset.buyerCity)">🚚 Get Delivery Help</button>` : ''}
                        ${currentStatusFilter === 'Accepted' && order.deliveryRequestStatus ? `<button class="dash-action-btn btn-cancel" onclick="window.cancelDeliveryMain('${order.id}')">Cancel Delivery Request</button>` : ''}
                        ${currentStatusFilter === 'Shipped' ? `<button class="dash-action-btn btn-delivered" onclick="confirmDeliveryMain('${order.id}')">✅ Confirm Delivery (Enter OTP)</button>` : ''}
                        ${(currentStatusFilter === 'Pending' || currentStatusFilter === 'Accepted') ? `<button class="dash-action-btn btn-cancel" onclick="updateOrderStatus('${order.id}', 'Cancelled')">Cancel</button>` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// Looks up the order from the already-loaded live list first (no extra
// Firestore read, for the common seller-dashboard case). Falls back to a
// direct read for any caller that doesn't have that list populated at all
// — e.g. delivery-dashboard.html, which manages orders from many different
// sellers and never builds this particular cache.
async function findOrderById(db, orderId) {
    const cached = allOrders.find(o => o.id === orderId);
    if (cached) return cached;
    const snap = await getDoc(doc(db, "orders", orderId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

const STATUS_MESSAGES = {
    Accepted: 'Your order has been accepted by the seller and will be shipped soon.',
    Shipped: 'Your order is on the way! 🚚',
    Delivered: 'Your order has been delivered. Enjoy! 🎉',
    Cancelled: 'Your order was cancelled by the seller.'
};

// Which status a seller-initiated action is allowed to move an order FROM,
// keyed by the new status. Anything not listed here (e.g. trying to mark an
// already-Delivered or already-Cancelled order as something else) is
// rejected — an order's lifecycle only ever moves forward, never sideways
// or backward, and never after it's already in a final state.
const SELLER_ALLOWED_FROM = {
    Accepted: ['Pending'],
    Shipped: ['Accepted'],
    Delivered: ['Shipped'],
    Cancelled: ['Pending', 'Accepted']
};

function isValidSellerTransition(currentStatus, newStatus) {
    const from = currentStatus || 'Pending';
    const allowedFrom = SELLER_ALLOWED_FROM[newStatus];
    return Array.isArray(allowedFrom) && allowedFrom.includes(from);
}

// NOTE: these action functions no longer take/call a "refetch" callback.
// The onSnapshot listener above already picks up the change automatically.
export async function updateOrderStatus(db, orderId, newStatus) {
    if (busyOrders.has(orderId)) return;
    busyOrders.add(orderId);
    try {
        const order = await findOrderById(db, orderId);

        // Guard against stale UI state (e.g. two tabs open, or the order was
        // already updated a moment ago) letting an invalid jump through —
        // "Delivered" straight to "Pending", or actioning an order twice.
        if (order && !isValidSellerTransition(order.status, newStatus)) {
            showToast(`Can't change status from "${order.status || 'Pending'}" to "${newStatus}". The order list will refresh.`, 'error');
            return;
        }

        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: newStatus, [newStatus.toLowerCase() + 'At']: new Date(), updatedAt: serverTimestamp() });
        applyLocalOrderChange(orderId, { status: newStatus, [newStatus.toLowerCase() + 'At']: Timestamp.now(), updatedAt: Timestamp.now() });

        // A cancelled order shouldn't keep its stock reserved forever.
        if (newStatus === 'Cancelled' && order) {
            await restoreStock(db, order.productId, order.quantity || 1, buildVariantKey(order.selectedSize, order.selectedColor));
        }

        if (order && order.buyerUid) {
            sendNotification(db, order.buyerUid, {
                title: `Order ${newStatus}: ${order.productName || 'Your item'}`,
                body: STATUS_MESSAGES[newStatus] || `Your order status is now ${newStatus}.`,
                type: 'order_status',
                link: 'orders.html'
            });
        }
    } catch (error) {
        console.error("Error updating status: ", error);
        showToast("Error updating order status.", 'error');
    } finally {
        busyOrders.delete(orderId);
    }
}

export async function markAsShipped(db, orderId) {
    if (busyOrders.has(orderId)) return;
    busyOrders.add(orderId);
    try {
        const order = await findOrderById(db, orderId);

        if (order && !isValidSellerTransition(order.status, 'Shipped')) {
            showToast(`Can't mark as Shipped from "${order.status || 'Pending'}". The order list will refresh.`, 'error');
            return;
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: 'Shipped', shippedAt: new Date(), deliveryOTP: otp, updatedAt: serverTimestamp() });
        applyLocalOrderChange(orderId, { status: 'Shipped', shippedAt: Timestamp.now(), deliveryOTP: otp, updatedAt: Timestamp.now() });
        showToast("Order marked as Shipped! 🚚\n\nThe buyer will now see a Delivery OTP on their Orders page. Ask them for it when you hand over the package, to confirm delivery.");

        if (order && order.buyerUid) {
            sendNotification(db, order.buyerUid, {
                title: `Order Shipped: ${order.productName || 'Your item'}`,
                body: STATUS_MESSAGES.Shipped,
                type: 'order_status',
                link: 'orders.html'
            });
        }
    } catch (error) {
        console.error("Error marking shipped:", error);
        showToast("Error updating order status.", 'error');
    } finally {
        busyOrders.delete(orderId);
    }
}

export async function confirmDelivery(db, orderId) {
    if (busyOrders.has(orderId)) return;
    busyOrders.add(orderId);
    try {
        await confirmDeliveryInner(db, orderId);
    } finally {
        busyOrders.delete(orderId);
    }
}

async function confirmDeliveryInner(db, orderId) {
    const order = await findOrderById(db, orderId);
    if (!order) {
        showToast("Order not found. Please try again.", 'error');
        return;
    }

    if (!isValidSellerTransition(order.status, 'Delivered')) {
        showToast(`Can't confirm delivery from "${order.status || 'Pending'}". The order list will refresh.`, 'error');
        return;
    }

    // Pay-at-delivery: collect the money BEFORE the OTP step.
    if (needsPaymentCollection(order)) {
        const collected = await collectPayment(db, order);
        if (!collected) return;
    }

    const enteredOtp = prompt("Enter the 4-digit Delivery OTP given by the buyer:");
    if (enteredOtp === null) return; // seller cancelled the prompt

    if (enteredOtp.trim() !== (order.deliveryOTP || '')) {
        showToast("❌ Incorrect OTP. Please ask the buyer again — the order will not be marked delivered until the correct OTP is entered.", 'error');
        return;
    }

    try {
        const orderRef = doc(db, "orders", orderId);
        await updateDoc(orderRef, { status: 'Delivered', deliveredAt: new Date(), updatedAt: serverTimestamp() });
        applyLocalOrderChange(orderId, { status: 'Delivered', deliveredAt: Timestamp.now(), updatedAt: Timestamp.now() });
        showToast("✅ Delivery confirmed! Order marked as Delivered.");

        if (order.buyerUid) {
            sendNotification(db, order.buyerUid, {
                title: `Order Delivered: ${order.productName || 'Your item'}`,
                body: STATUS_MESSAGES.Delivered,
                type: 'order_status',
                link: 'orders.html'
            });
        }
    } catch (error) {
        console.error("Error confirming delivery:", error);
        showToast("Error updating order status.", 'error');
    }
}
