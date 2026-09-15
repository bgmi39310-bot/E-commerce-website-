import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

// `reportType` is 'product' (default, reports a listing/seller), 'buyer',
// or 'delivery_partner'. Only the fields relevant to that type need to be
// filled in — e.g. reporting a buyer passes reportedUid/reportedName and
// leaves productId/sellerUid empty.
export async function submitReport(db, {
    reportType, productId, productName, sellerUid, shopName,
    reportedUid, reportedName, orderId,
    reporterUid, reason, details
}, refreshCallback) {
    if (!reason) { showToast("Please select a reason for reporting.", 'error'); return; }
    if (!reporterUid) { showToast("Please login to submit a report.", 'error'); return; }

    try {
        await addDoc(collection(db, "reports"), {
            reportType: reportType || 'product',
            productId: productId || null,
            productName: productName || null,
            sellerUid: sellerUid || null,
            shopName: shopName || null,
            reportedUid: reportedUid || null,
            reportedName: reportedName || null,
            orderId: orderId || null,
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

