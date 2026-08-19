import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

            document.getElementById('shopName').value = profile.shopName || '';
            document.getElementById('ownerName').value = profile.ownerName || '';
            document.getElementById('shopPhone').value = profile.phone || '';
            document.getElementById('shopLogoFile').value = profile.logo || '';
            document.getElementById('shopAddress').value = profile.address || '';
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
    if (!shopName || !ownerName) { alert("Please enter Shop and Owner Name!"); return; }
    
    const logoUrl = document.getElementById('shopLogoFile').value.trim();

    const profile = {
        uid: currentLoggedInUser.uid,
        shopName, 
        ownerName,
        phone: document.getElementById('shopPhone').value.trim(),
        address: document.getElementById('shopAddress').value.trim(),
        logo: logoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80"
    };

    try {
        await setDoc(doc(db, "sellers_profiles", currentLoggedInUser.uid), profile);
        loadProfileCallback(currentLoggedInUser.uid);

        const msg = document.getElementById('profileMsg');
        msg.style.display = 'block';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
        alert("Shop Profile Saved Successfully! 🎉");
    } catch (error) {
        alert("Error saving profile: " + error.message);
    }
}
