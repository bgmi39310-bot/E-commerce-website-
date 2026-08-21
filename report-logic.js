import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function submitReport(db, { productId, productName, sellerUid, shopName, reporterUid, reason, details }, refreshCallback) {
    if (!reason) { alert("Please select a reason for reporting."); return; }
    if (!reporterUid) { alert("Please login to report a listing."); return; }

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
        alert("Thank you. Your report has been submitted for review. 🙏");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting report:", error);
        alert("Unable to submit report right now. Please try again.");
    }
}

