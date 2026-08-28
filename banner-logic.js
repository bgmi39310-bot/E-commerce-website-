import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

// ---------- HOMEPAGE (public) ----------
export async function loadActiveBanners(db) {
    try {
        const q = query(collection(db, "banners"), where("active", "==", true));
        const snap = await getDocs(q);
        let banners = [];
        snap.forEach(d => banners.push({ id: d.id, ...d.data() }));
        banners.sort((a, b) => (a.order || 0) - (b.order || 0));
        return banners;
    } catch (error) {
        console.error("Error loading banners:", error);
        return [];
    }
}

// ---------- ADMIN ----------
export async function loadAllBanners(db) {
    const container = document.getElementById('bannersContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading banners...</p>";

    try {
        const snap = await getDocs(collection(db, "banners"));
        if (snap.empty) {
            container.innerHTML = `<div class="admin-no-data">No banners created yet.</div>`;
            return;
        }

        let banners = [];
        snap.forEach(d => banners.push({ id: d.id, ...d.data() }));
        banners.sort((a, b) => (a.order || 0) - (b.order || 0));

        container.innerHTML = banners.map(b => `
            <div class="admin-row-card ${!b.active ? 'is-blocked' : ''}">
                <img class="arc-thumb" src="${b.imageUrl || 'https://via.placeholder.com/80x50'}" alt="" style="width:80px; height:50px; border-radius:6px; object-fit:cover;">
                <div class="arc-info">
                    <h4>${b.title || 'Untitled Banner'} ${!b.active ? '<span class="blocked-tag">INACTIVE</span>' : ''}</h4>
                    <p>${b.subtitle || ''}</p>
                    <p class="uid-tag">Link: ${b.linkUrl || 'N/A'}</p>
                </div>
                <div class="arc-actions">
                    <button class="admin-btn ${b.active ? 'admin-btn-block' : 'admin-btn-unblock'}" onclick="toggleBannerMain('${b.id}', ${!b.active})">${b.active ? '🚫 Deactivate' : '✅ Activate'}</button>
                    <button class="admin-btn admin-btn-delete" onclick="deleteBannerMain('${b.id}')">🗑️ Delete</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error(error);
        container.innerHTML = `<p style="color:red;">Unable to load banners.</p>`;
    }
}

export async function createBanner(db, bannerData, refreshCallback) {
    if (!bannerData.imageUrl || !bannerData.title) {
        showToast("Please provide at least an image URL and title.", 'error');
        return;
    }
    try {
        await addDoc(collection(db, "banners"), {
            ...bannerData,
            active: true,
            order: Date.now(),
            createdAt: new Date()
        });
        showToast("Banner created!");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        showToast("Error creating banner: " + error.message, 'error');
    }
}

export async function toggleBannerActive(db, bannerId, active, refreshCallback) {
    try {
        await updateDoc(doc(db, "banners", bannerId), { active });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        showToast("Error updating banner.", 'error');
    }
}

export async function deleteBanner(db, bannerId, refreshCallback) {
    if (!confirm("Delete this banner?")) return;
    try {
        await deleteDoc(doc(db, "banners", bannerId));
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error(error);
        showToast("Error deleting banner.", 'error');
    }
}

