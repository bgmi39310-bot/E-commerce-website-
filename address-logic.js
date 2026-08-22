import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function addressesRef(db, uid) {
    return collection(db, "users", uid, "addresses");
}

export async function loadAddresses(db, uid) {
    const snap = await getDocs(addressesRef(db, uid));
    let addresses = [];
    snap.forEach(d => addresses.push({ id: d.id, ...d.data() }));
    // Default address first, then most recently added
    addresses.sort((a, b) => (b.isDefault === true) - (a.isDefault === true));
    return addresses;
}

export async function saveAddress(db, uid, addressData, addressId) {
    if (addressId) {
        await updateDoc(doc(db, "users", uid, "addresses", addressId), addressData);
        return addressId;
    } else {
        const docRef = await addDoc(addressesRef(db, uid), addressData);
        return docRef.id;
    }
}

export async function deleteAddress(db, uid, addressId) {
    await deleteDoc(doc(db, "users", uid, "addresses", addressId));
}

export async function setDefaultAddress(db, uid, addressId) {
    const snap = await getDocs(addressesRef(db, uid));
    const batch = writeBatch(db);
    snap.forEach(d => {
        batch.update(doc(db, "users", uid, "addresses", d.id), { isDefault: d.id === addressId });
    });
    await batch.commit();
}

