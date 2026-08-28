import { doc, setDoc, getDoc, addDoc, collection, query, where, getDocs, onSnapshot, orderBy, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';

export async function createDispute(db, { orderId, raisedByUid, raisedByName, raisedByRole, againstUid, subject, description }, refreshCallback) {
    if (!subject || !description) {
        showToast("Please fill in both subject and description.", 'error');
        return;
    }
    try {
        const docRef = await addDoc(collection(db, "disputes"), {
            orderId, raisedByUid, raisedByName, raisedByRole, againstUid,
            subject: subject.trim(),
            description: description.trim(),
            status: 'Open',
            createdAt: new Date(),
            lastUpdateAt: new Date()
        });
        showToast("Dispute submitted. Our team will review it and help resolve this.");
        if (refreshCallback) refreshCallback();
        return docRef.id;
    } catch (error) {
        console.error("Error creating dispute:", error);
        showToast("Unable to submit dispute right now.", 'error');
    }
}

export async function loadMyDisputes(db, uid) {
    const container = document.getElementById('disputesContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading disputes...</p>";

    try {
        const q1 = query(collection(db, "disputes"), where("raisedByUid", "==", uid));
        const q2 = query(collection(db, "disputes"), where("againstUid", "==", uid));
        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);

        let disputes = [];
        snap1.forEach(d => disputes.push({ id: d.id, ...d.data() }));
        snap2.forEach(d => { if (!disputes.find(x => x.id === d.id)) disputes.push({ id: d.id, ...d.data() }); });

        if (disputes.length === 0) {
            container.innerHTML = `<div class="no-disputes">You have no disputes.</div>`;
            return;
        }

        disputes.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        container.innerHTML = disputes.map(d => `
            <div class="dispute-card" onclick="window.location.href='dispute-thread.html?id=${d.id}'">
                <div class="dispute-top">
                    <strong>${escapeHtml(d.subject)}</strong>
                    <span class="dispute-status status-${d.status}">${d.status}</span>
                </div>
                <p class="dispute-preview">${escapeHtml(d.description)}</p>
            </div>
        `).join('');
    } catch (error) {
        console.error("Error loading disputes:", error);
        container.innerHTML = `<p style="color:red;">Unable to load disputes.</p>`;
    }
}

// ---------- Dispute Thread (buyer/seller/admin conversation) ----------
export async function sendDisputeMessage(db, disputeId, senderUid, senderName, text) {
    if (!text || !text.trim()) return;
    try {
        await addDoc(collection(db, "disputes", disputeId, "messages"), {
            senderUid, senderName: senderName || 'User',
            text: text.trim(),
            createdAt: serverTimestamp()
        });
        await updateDoc(doc(db, "disputes", disputeId), { lastUpdateAt: serverTimestamp() });
    } catch (error) {
        console.error("Error sending dispute message:", error);
        showToast("Unable to send message right now.", 'error');
    }
}

export function listenToDisputeMessages(db, disputeId, onUpdate) {
    const q = query(collection(db, "disputes", disputeId, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
        let messages = [];
        snap.forEach(d => messages.push({ id: d.id, ...d.data() }));
        onUpdate(messages);
    });
}

// ---------- ADMIN ----------
export async function loadAllDisputes(db) {
    const container = document.getElementById('disputesAdminContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading disputes...</p>";

    try {
        const snap = await getDocs(collection(db, "disputes"));
        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No disputes raised yet.</div>`;
            return;
        }
        let disputes = [];
        snap.forEach(d => disputes.push({ id: d.id, ...d.data() }));
        disputes.sort((a, b) => (a.status === 'Open' ? -1 : 1));

        container.innerHTML = disputes.map(d => `
            <div class="admin-row-card ${d.status === 'Closed' ? 'is-blocked' : ''}">
                <div class="arc-info">
                    <h4>${escapeHtml(d.subject)} <span class="blocked-tag" style="background:${d.status === 'Open' ? '#ff9900' : d.status === 'Resolved' ? '#28a745' : '#6c757d'};">${d.status}</span></h4>
                    <p>${escapeHtml(d.description)}</p>
                    <p class="uid-tag">Order: ${escapeHtml(d.orderId)} | Raised by: ${escapeHtml(d.raisedByName)} (${escapeHtml(d.raisedByRole)})</p>
                </div>
                <div class="arc-actions">
                    <a href="dispute-thread.html?id=${d.id}" class="admin-btn admin-btn-unblock" style="text-decoration:none;">💬 Open Thread</a>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load disputes.</p>`;
    }
}

export async function updateDisputeStatus(db, disputeId, newStatus, refreshCallback) {
    try {
        await updateDoc(doc(db, "disputes", disputeId), { status: newStatus, lastUpdateAt: new Date() });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        showToast("Error updating dispute status.", 'error');
    }
}

