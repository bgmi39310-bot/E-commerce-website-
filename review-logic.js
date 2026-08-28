import { collection, addDoc, getDocs, query, where, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

// Very lightweight spam heuristics — catches obvious junk without blocking genuine reviews.
function looksLikeSpam(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (/https?:\/\/|www\./.test(lower)) return true;              // links
    if (/(.)\1{6,}/.test(text)) return true;                        // "aaaaaaaa" style flooding
    if (/\b(buy now|click here|whatsapp me|call \d{6,})\b/.test(lower)) return true; // spam phrases
    return false;
}

export async function submitReview(db, { orderId, productId, sellerUid, buyerUid, buyerName, rating, comment }, refreshCallback) {
    if (!rating || rating < 1 || rating > 5) {
        showToast("Please select a star rating.", 'error');
        return;
    }
    if (looksLikeSpam(comment)) {
        showToast("Your review looks like it may contain spam (links or promotional text). Please rewrite it without links.", 'error');
        return;
    }
    try {
        await addDoc(collection(db, "reviews"), {
            orderId, productId, sellerUid, buyerUid,
            buyerName: buyerName || 'DesiMarket Buyer',
            rating: Number(rating),
            comment: (comment || '').trim(),
            createdAt: new Date()
        });

        // Mark the order as reviewed so the "Write a Review" prompt doesn't show again
        await updateDoc(doc(db, "orders", orderId), { reviewed: true });

        showToast("Thank you for your review! ⭐");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting review:", error);
        showToast("Unable to submit review right now. Please try again.", 'error');
    }
}

export async function loadProductReviews(db, productId) {
    const container = document.getElementById('reviewsContainer');
    const summaryEl = document.getElementById('reviewsSummary');
    if (!container) return;

    try {
        const q = query(collection(db, "reviews"), where("productId", "==", productId));
        const snap = await getDocs(q);

        if (snap.empty) {
            summaryEl.innerHTML = `<span style="color:#767676; font-size:13px;">No reviews yet — be the first to review!</span>`;
            container.innerHTML = '';
            return;
        }

        let reviews = [];
        snap.forEach(d => reviews.push(d.data()));
        reviews.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        const avg = reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length;
        const fullStars = Math.round(avg);

        summaryEl.innerHTML = `
            <span style="color:#ff9900; font-size:16px;">${'★'.repeat(fullStars)}${'☆'.repeat(5 - fullStars)}</span>
            <span style="font-weight:bold; margin-left:6px;">${avg.toFixed(1)}</span>
            <span style="color:#767676; font-size:13px;"> (${reviews.length} review${reviews.length > 1 ? 's' : ''})</span>
        `;

        container.innerHTML = reviews.map(r => `
            <div class="review-item">
                <div class="review-top">
                    <span class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
                    <span class="review-author">${r.buyerName}</span>
                </div>
                ${r.comment ? `<p class="review-comment">${r.comment}</p>` : ''}
            </div>
        `).join('');
    } catch (error) {
        console.error("Error loading reviews:", error);
        summaryEl.innerHTML = '';
        container.innerHTML = `<p style="color:#888; font-size:13px;">Unable to load reviews right now.</p>`;
    }
}
