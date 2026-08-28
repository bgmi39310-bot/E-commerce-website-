import { collection, addDoc, doc, updateDoc, onSnapshot, query, orderBy, limit, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { escapeHtml } from './sanitize.js';

// ============================================================================
// DesiMarket unified notification system.
// Firestore shape:  users/{uid}/notifications/{notifId}
//   { title, body, type, link, read: boolean, createdAt: serverTimestamp }
//
// Any part of the app (buyer or seller side) can call sendNotification() to
// notify a user. Any page can call mountNotificationBell() once to get a
// fully working bell icon + unread badge + dropdown panel, wired to a live
// Firestore listener — no per-page boilerplate needed.
// ============================================================================

const TYPE_ICON = {
    order_status: '📦',
    return_status: '↩️',
    new_question: '❓',
    new_order: '🛍️',
    default: '🔔'
};

const TYPE_COLOR = {
    order_status: '#007bff',
    return_status: '#6f42c1',
    new_question: '#ff9900',
    new_order: '#28a745',
    default: '#232f3e'
};

// ---------- Writing notifications (call this from anywhere) ----------
export async function sendNotification(db, toUid, { title, body, type, link }) {
    if (!toUid || !title) return;
    try {
        await addDoc(collection(db, "users", toUid, "notifications"), {
            title,
            body: body || '',
            type: type || 'default',
            link: link || '',
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {
        // Never let a notification failure break the calling flow (order update, etc.)
        console.error("sendNotification error:", e);
    }
}

// ---------- Chime + native browser notification (both completely free, no service needed) ----------
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(740, ctx.currentTime);
        osc.frequency.setValueAtTime(988, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.16, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
    } catch (e) { /* audio not available, ignore */ }
}

function showBrowserNotification(n) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
        const notif = new Notification(n.title || "DesiMarket", {
            body: n.body || '',
            icon: "icon-192.png",
            badge: "icon-192.png",
            tag: n.id // replaces older OS notifications instead of stacking endlessly
        });
        notif.onclick = () => {
            window.focus();
            if (n.link) window.location.href = n.link;
            notif.close();
        };
    } catch (e) { /* some browsers restrict this, fail silently */ }
}

function timeAgo(date) {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ---------- The reusable bell component ----------
// Call once per page: mountNotificationBell(db, uid, 'someContainerId')
// The container element just needs to exist in the DOM; this function injects
// everything else (bell, badge, dropdown) into it.
export function mountNotificationBell(db, uid, containerId) {
    const container = document.getElementById(containerId);
    if (!container || !uid) return;

    // Ask for OS notification permission once, quietly (matches the existing
    // seller-dashboard pattern already used elsewhere in this app).
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }

    container.innerHTML = `
        <div style="position:relative;">
            <div id="${containerId}_bell" style="cursor:pointer; font-size:19px; position:relative; line-height:1;">
                🔔
                <span id="${containerId}_badge" style="display:none; position:absolute; top:-7px; right:-9px; background:#ff4d4d; color:white; font-size:10px; font-weight:bold; border-radius:50%; min-width:16px; height:16px; padding:0 3px; align-items:center; justify-content:center; box-shadow:0 0 0 2px #232f3e;">0</span>
            </div>
            <div id="${containerId}_panel" style="display:none; position:absolute; right:0; top:30px; width:310px; max-width:88vw; max-height:400px; overflow-y:auto; background:white; border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,0.22); z-index:5000; text-align:left;">
                <div style="padding:13px 16px; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; background:white; border-radius:12px 12px 0 0;">
                    <strong style="font-size:14.5px; color:#232f3e;">🔔 Notifications</strong>
                    <span id="${containerId}_markread" style="font-size:11.5px; color:#007185; cursor:pointer; font-weight:600;">Mark all read</span>
                </div>
                <div id="${containerId}_list" style="padding:6px;">
                    <p style="text-align:center; color:#888; font-size:12.5px; padding:24px 10px;">Loading...</p>
                </div>
            </div>
        </div>
    `;

    const bellEl = document.getElementById(`${containerId}_bell`);
    const panelEl = document.getElementById(`${containerId}_panel`);
    const badgeEl = document.getElementById(`${containerId}_badge`);
    const listEl = document.getElementById(`${containerId}_list`);
    const markReadEl = document.getElementById(`${containerId}_markread`);

    let notifications = [];
    let isFirstSnapshot = true;

    function updateBadge() {
        const unread = notifications.filter(n => !n.read).length;
        if (unread > 0) {
            badgeEl.style.display = 'flex';
            badgeEl.innerText = unread > 99 ? '99+' : unread;
        } else {
            badgeEl.style.display = 'none';
        }
    }

    function renderList() {
        if (notifications.length === 0) {
            listEl.innerHTML = `<p style="text-align:center; color:#888; font-size:12.5px; padding:24px 10px;">No notifications yet.</p>`;
            return;
        }
        listEl.innerHTML = notifications.map(n => {
            const icon = TYPE_ICON[n.type] || TYPE_ICON.default;
            const color = TYPE_COLOR[n.type] || TYPE_COLOR.default;
            const when = n.createdAt && n.createdAt.toDate ? timeAgo(n.createdAt.toDate()) : '';
            return `
                <div onclick="window.__dmNotifClick_${containerId}('${n.id}', '${(n.link || '').replace(/'/g, "\\'")}')"
                     style="display:flex; gap:10px; padding:10px 10px; border-radius:8px; cursor:pointer; margin-bottom:2px; background:${n.read ? 'transparent' : '#f5faff'};">
                    <div style="flex-shrink:0; width:34px; height:34px; border-radius:50%; background:${color}1a; display:flex; align-items:center; justify-content:center; font-size:16px;">${icon}</div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:12.8px; font-weight:${n.read ? '600' : '700'}; color:#232f3e; line-height:1.35;">${escapeHtml(n.title)}</div>
                        ${n.body ? `<div style="font-size:11.8px; color:#666; margin-top:2px; line-height:1.35;">${escapeHtml(n.body)}</div>` : ''}
                        <div style="font-size:10.5px; color:#999; margin-top:4px;">${when}</div>
                    </div>
                    ${!n.read ? `<span style="flex-shrink:0; width:8px; height:8px; border-radius:50%; background:${color}; margin-top:5px;"></span>` : ''}
                </div>
            `;
        }).join('');
    }

    window[`__dmNotifClick_${containerId}`] = async function(notifId, link) {
        const n = notifications.find(x => x.id === notifId);
        if (n && !n.read) {
            try {
                await updateDoc(doc(db, "users", uid, "notifications", notifId), { read: true });
            } catch (e) { console.error(e); }
        }
        if (link) window.location.href = link;
    };

    bellEl.addEventListener('click', () => {
        const isOpen = panelEl.style.display === 'block';
        panelEl.style.display = isOpen ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) panelEl.style.display = 'none';
    });

    markReadEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const unread = notifications.filter(n => !n.read);
        if (unread.length === 0) return;
        try {
            const batch = writeBatch(db);
            unread.forEach(n => batch.update(doc(db, "users", uid, "notifications", n.id), { read: true }));
            await batch.commit();
        } catch (err) {
            console.error("markAllRead error:", err);
        }
    });

    const q = query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"), limit(30));
    const unsubscribe = onSnapshot(q, (snap) => {
        notifications = [];
        const freshlyAdded = [];
        snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            notifications.push(data);
        });
        snap.docChanges().forEach(change => {
            if (change.type === 'added' && !isFirstSnapshot) {
                freshlyAdded.push({ id: change.doc.id, ...change.doc.data() });
            }
        });

        updateBadge();
        renderList();

        if (!isFirstSnapshot && freshlyAdded.length > 0) {
            playChime();
            freshlyAdded.forEach(showBrowserNotification);
        }
        isFirstSnapshot = false;
    }, (error) => {
        console.error("Notification listener error:", error);
        listEl.innerHTML = `<p style="text-align:center; color:#c00; font-size:12px; padding:20px 10px;">Unable to load notifications.</p>`;
    });

    return unsubscribe;
}
