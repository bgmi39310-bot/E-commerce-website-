import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

export async function submitReport(db, { productId, productName, sellerUid, shopName, reporterUid, reason, details }, refreshCallback) {
    if (!reason) { showToast("Please select a reason for reporting.", 'error'); return; }
    if (!reporterUid) { showToast("Please login to report a listing.", 'error'); return; }

    try {
        await addDoc(collection(db, "reports"), {
            productId: productId || null,
            productName: productName || 'Unknown product',
            sellerUid: sellerUid || null,
            shopName: shopName || 'Unknown shop',
            reporterUid,
            reason,
            details: (details || '').trim(),
            status: 'Pending',
            createdAt: new Date()
        });
        showToast("Thank you. Your report has been submitted for review. 🙏");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting report:", error);
        showToast("Unable to submit report right now. Please try again.", 'error');
    }
}

