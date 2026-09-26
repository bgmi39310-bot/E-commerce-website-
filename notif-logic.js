import { collection, addDoc, doc, updateDoc, getDocs, getCountFromServer, onSnapshot, query, where, orderBy, limit, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { escapeHtml } from './sanitize.js';

// ============================================================================
// DesiMarket unified notification system.
// Firestore shape:  users/{uid}/notifications/{notifId}
//   { title, body, type, link, read: boolean, createdAt: serverTimestamp }
//
// Any part of the app (buyer or seller side) can call sendNotification() to
// notify a user. Any page can call mountNotificationBell() once to get a
// working bell icon + unread badge + dropdown panel.
//
// READ COST — this used to keep ONE live Firestore listener open reading
// the most recent 30 notifications, on EVERY page, for every signed-in
// visitor — re-paid in full on every page load/refresh site-wide, which
// made it the single biggest source of Firestore reads in the app. It's
// now split into three pieces, each doing only the minimum it needs to:
//
//   1. On mount: one cheap aggregate COUNT query (unread notifications
//      only) for the badge number — billed as ~1 read no matter how many
//      match, instead of reading up to 30 full documents just for a count.
//   2. A SECOND, genuinely live listener — but scoped to
//      `where('createdAt', '>', mountTime)`, i.e. "only notifications
//      created after this page opened". At the moment it attaches, NOTHING
//      matches that filter yet, so its first snapshot is empty (0 reads).
//      From then on it costs exactly 1 read each time a new notification
//      actually arrives — which is what you WANT to pay for (a real
//      event), not for re-reading 30 already-seen ones on every page load.
//      This is what makes new notifications still show up instantly with
//      a chime, same as before.
//   3. The full 30-item history is only fetched (one-time, not live) the
//      first time the visitor actually opens the panel.
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

    // Ask for OS notification permission once, quietly — only meaningful
    // now that new notifications are live-pushed again (see below).
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
    let listLoaded = false;
    let unreadCount = 0;

    function setUnreadCount(n) {
        unreadCount = n;
        if (unreadCount > 0) {
            badgeEl.style.display = 'flex';
            badgeEl.innerText = unreadCount > 99 ? '99+' : unreadCount;
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
            const when = n.createdAt && n.createdAt.toDate ? timeAgo(n.createdAt.toDate()) : (n.createdAt instanceof Date ? timeAgo(n.createdAt) : '');
            return `
                <div data-notif-id="${escapeHtml(n.id)}" data-notif-link="${escapeHtml(n.link || '')}"
                     onclick="window.__dmNotifClick_${containerId}(this.dataset.notifId, this.dataset.notifLink)"
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
            n.read = true; // optimistic — updates the badge instantly rather than waiting on the write
            setUnreadCount(Math.max(0, unreadCount - 1));
            try {
                await updateDoc(doc(db, "users", uid, "notifications", notifId), { read: true });
            } catch (e) { console.error(e); }
        }
        if (link) window.location.href = link;
    };

    async function loadList() {
        if (listLoaded) return; // fetched once per page visit — reopening the panel just reuses it
        listEl.innerHTML = `<p style="text-align:center; color:#888; font-size:12.5px; padding:24px 10px;">Loading...</p>`;
        try {
            const q = query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"), limit(30));
            const snap = await getDocs(q);
            const fetched = [];
            snap.forEach(d => fetched.push({ id: d.id, ...d.data() }));
            // Merge in anything the live "new notifications" listener already
            // added since page load, so a notification that arrived live
            // doesn't get duplicated once the full history loads too.
            const seenIds = new Set(fetched.map(n => n.id));
            const liveOnly = notifications.filter(n => !seenIds.has(n.id));
            notifications = [...liveOnly, ...fetched];
            listLoaded = true;
            renderList();
        } catch (e) {
            console.error("Notification list error:", e);
            listEl.innerHTML = `<p style="text-align:center; color:#c00; font-size:12px; padding:20px 10px;">Unable to load notifications.</p>`;
        }
    }

    bellEl.addEventListener('click', () => {
        const isOpen = panelEl.style.display === 'block';
        panelEl.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) loadList(); // the full 30-item history is only ever fetched once someone actually opens the panel
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
            unread.forEach(n => {
                batch.update(doc(db, "users", uid, "notifications", n.id), { read: true });
                n.read = true;
            });
            await batch.commit();
            setUnreadCount(0);
            renderList();
        } catch (err) {
            console.error("markAllRead error:", err);
        }
    });

    // Piece 1: cheap unread COUNT for the badge's starting number — covers
    // everything unread from BEFORE this page opened.
    (async () => {
        try {
            const unreadQuery = query(collection(db, "users", uid, "notifications"), where("read", "==", false));
            const countSnap = await getCountFromServer(unreadQuery);
            setUnreadCount(countSnap.data().count);
        } catch (e) {
            console.error("Notification count error:", e);
        }
    })();

    // Piece 2: a genuinely LIVE listener for anything created from this
    // moment forward. Its first snapshot matches nothing (0 reads) since
    // nothing has createdAt > mountedAt yet — after that it costs exactly
    // 1 read per real new notification, which is when a chime + browser
    // notification should fire, same as before this change.
    const mountedAt = new Date();
    const liveQuery = query(
        collection(db, "users", uid, "notifications"),
        where("createdAt", ">", mountedAt)
    );
    const unsubscribeLive = onSnapshot(liveQuery, (snap) => {
        snap.docChanges().forEach(change => {
            if (change.type !== 'added') return;
            const n = { id: change.doc.id, ...change.doc.data() };
            if (notifications.some(existing => existing.id === n.id)) return; // already have it (e.g. list was opened after it arrived)
            notifications.unshift(n);
            if (!n.read) setUnreadCount(unreadCount + 1);
            if (listLoaded) renderList();
            playChime();
            showBrowserNotification(n);
        });
    }, (error) => {
        console.error("Live notification listener error:", error);
    });

    return unsubscribeLive;
}
