import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

export async function loadSellerProfileFromFirestore(db, uid) {
    try {
        const docRef = doc(db, "sellers_profiles", uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const profile = docSnap.data();
            document.getElementById('profileDisplay').style.display = 'block';
            document.getElementById('profileForm').style.display = 'none';

            document.getElementById('dispShopName').innerText = profile.shopName;
            document.getElementById('dispOwnerName').innerText = profile.ownerName || 'N/A';
            document.getElementById('dispPhone').innerText = profile.phone || 'N/A';
            document.getElementById('dispAddress').innerText = profile.address || 'N/A';
            document.getElementById('dispLogo').src = profile.logo || 'https://via.placeholder.com/80';
            const dispCityEl = document.getElementById('dispCity');
            if (dispCityEl) dispCityEl.innerText = profile.city || 'N/A';
            const dispVillagesEl = document.getElementById('dispVillages');
            if (dispVillagesEl) dispVillagesEl.innerText = (profile.deliveryVillages && profile.deliveryVillages.length) ? profile.deliveryVillages.join(', ') : 'N/A';

            document.getElementById('shopName').value = profile.shopName || '';
            document.getElementById('ownerName').value = profile.ownerName || '';
            document.getElementById('shopPhone').value = profile.phone || '';
            document.getElementById('shopLogoFile').value = profile.logo || '';
            document.getElementById('shopAddress').value = profile.address || '';
            const cityField = document.getElementById('shopCity');
            if (cityField) cityField.value = profile.city || '';
            const villagesField = document.getElementById('shopVillages');
            if (villagesField) villagesField.value = (profile.deliveryVillages || []).join(', ');
            const upiField = document.getElementById('shopUpiId');
            if (upiField) upiField.value = profile.upiId || '';
        } else {
            document.getElementById('profileDisplay').style.display = 'none';
            document.getElementById('profileForm').style.display = 'grid';
        }
    } catch (error) {
        console.error("Error loading profile:", error);
    }
}

export async function saveSellerProfile(db, currentLoggedInUser, loadProfileCallback) {
    if (!currentLoggedInUser) return;
    const shopName = document.getElementById('shopName').value.trim();
    const ownerName = document.getElementById('ownerName').value.trim();
    if (!shopName || !ownerName) { showToast("Please enter Shop and Owner Name!", 'error'); return; }

    const logoUrl = document.getElementById('shopLogoFile').value.trim();
    const upiField = document.getElementById('shopUpiId');
    const villagesField = document.getElementById('shopVillages');
    const deliveryVillages = villagesField
        ? villagesField.value.split(',').map(v => v.trim()).filter(v => v)
        : [];

    const profile = {
        uid: currentLoggedInUser.uid,
        shopName,
        ownerName,
        phone: document.getElementById('shopPhone').value.trim(),
        address: document.getElementById('shopAddress').value.trim(),
        city: document.getElementById('shopCity') ? document.getElementById('shopCity').value.trim() : '',
        deliveryVillages,
        upiId: upiField ? upiField.value.trim() : '',
        logo: logoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80"
    };

    try {
        // merge: true is important — without it, saving the basic profile form
        // would silently wipe out fields that live on this same document but
        // are set elsewhere (followerCount from follow-logic.js, isPremium
        // from premium-logic.js, KYC status from kyc-logic.js, etc).
        await setDoc(doc(db, "sellers_profiles", currentLoggedInUser.uid), profile, { merge: true });
        loadProfileCallback(currentLoggedInUser.uid);

        const msg = document.getElementById('profileMsg');
        msg.style.display = 'block';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
        showToast("Shop Profile Saved Successfully! 🎉");
    } catch (error) {
        showToast("Error saving profile: " + error.message, 'error');
    }
}
