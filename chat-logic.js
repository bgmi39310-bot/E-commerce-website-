import { doc, setDoc, getDoc, collection, addDoc, query, orderBy, onSnapshot, where, getDocs, serverTimestamp, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Deterministic chat ID so the same buyer+seller pair always reuses the same thread
function getChatId(uidA, uidB) {
    return [uidA, uidB].sort().join('_');
}

export async function getOrCreateChat(db, buyerUid, sellerUid, buyerName, shopName) {
    const chatId = getChatId(buyerUid, sellerUid);
    const chatRef = doc(db, "chats", chatId);
    const snap = await getDoc(chatRef);

    if (!snap.exists()) {
        await setDoc(chatRef, {
            buyerUid, sellerUid,
            buyerName: buyerName || 'DesiMarket Buyer',
            shopName: shopName || 'Local Shop',
            lastMessage: '',
            lastMessageAt: serverTimestamp(),
            unreadByBuyer: 0,
            unreadBySeller: 0,
            createdAt: serverTimestamp()
        });
    }
    return chatId;
}

export async function sendMessage(db, chatId, senderUid, senderRole, text) {
    if (!text || !text.trim()) return;
    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            senderUid,
            senderRole,
            text: text.trim(),
            createdAt: serverTimestamp()
        });

        const unreadField = senderRole === 'buyer' ? 'unreadBySeller' : 'unreadByBuyer';
        await updateDoc(doc(db, "chats", chatId), {
            lastMessage: text.trim(),
            lastMessageAt: serverTimestamp(),
            [unreadField]: increment(1)
        });
    } catch (error) {
        console.error("Error sending message:", error);
        alert("Unable to send message right now.");
    }
}

// Real-time listener for messages in a chat thread. Returns an unsubscribe function.
export function listenToMessages(db, chatId, onUpdate) {
    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
        let messages = [];
        snap.forEach(d => messages.push({ id: d.id, ...d.data() }));
        onUpdate(messages);
    });
}

export async function markChatRead(db, chatId, role) {
    try {
        const field = role === 'buyer' ? 'unreadByBuyer' : 'unreadBySeller';
        await updateDoc(doc(db, "chats", chatId), { [field]: 0 });
    } catch (error) {
        console.error("Error marking chat read:", error);
    }
}

// List chat threads where the user is the buyer or the seller
export async function loadMyChats(db, uid, role) {
    const field = role === 'buyer' ? 'buyerUid' : 'sellerUid';
    const q = query(collection(db, "chats"), where(field, "==", uid));
    const snap = await getDocs(q);
    let threads = [];
    snap.forEach(d => threads.push({ id: d.id, ...d.data() }));
    return threads;
}
