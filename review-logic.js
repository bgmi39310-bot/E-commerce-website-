import { collection, getDocs, query, where, doc, writeBatch, orderBy, limit, getAggregateFromServer, average, count } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';
import { escapeHtml } from './sanitize.js';

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
        // Creating the review and marking the order as reviewed used to be
        // two separate writes — if the second one failed after the first
        // succeeded (network blip, etc.), the order would never show as
        // reviewed, and the "Write a Review" prompt would keep appearing,
        // letting the same buyer submit a second review for the same order
        // (the Firestore rule that blocks that only checks orders.reviewed,
        // which would have been stuck at false). A batch commits both
        // writes together, or neither.
        const batch = writeBatch(db);
        const reviewRef = doc(collection(db, "reviews"));
        batch.set(reviewRef, {
            orderId, productId, sellerUid, buyerUid,
            buyerName: buyerName || 'DesiMarket Buyer',
            rating: Number(rating),
            comment: (comment || '').trim(),
            createdAt: new Date()
        });
        batch.update(doc(db, "orders", orderId), { reviewed: true });
        await batch.commit();

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
        const reviewsQuery = query(collection(db, "reviews"), where("productId", "==", productId));

        // The star average and "X reviews" count must reflect EVERY review,
        // not just the ones we bother to display — so those come from a
        // Firestore aggregation (average()/count()), which is priced as a
        // small number of index-entries-scanned rather than one full
        // document read per review. Only the review LIST below is capped
        // with limit() — showing the most recent 20 is what actually needs
        // full documents (comments, reviewer names, etc).
        const [aggSnap, listSnap] = await Promise.all([
            getAggregateFromServer(reviewsQuery, { avgRating: average("rating"), total: count() }),
            getDocs(query(reviewsQuery, orderBy("createdAt", "desc"), limit(20)))
        ]);

        const total = aggSnap.data().total;
        if (total === 0) {
            summaryEl.innerHTML = `<span style="color:#767676; font-size:13px;">No reviews yet — be the first to review!</span>`;
            container.innerHTML = '';
            return;
        }

        const avg = aggSnap.data().avgRating || 0;
        const fullStars = Math.round(avg);

        let reviews = [];
        listSnap.forEach(d => reviews.push(d.data()));
        // Already newest-first from the query's orderBy — no client-side sort needed.

        summaryEl.innerHTML = `
            <span style="color:#ff9900; font-size:16px;">${'★'.repeat(fullStars)}${'☆'.repeat(5 - fullStars)}</span>
            <span style="font-weight:bold; margin-left:6px;">${avg.toFixed(1)}</span>
            <span style="color:#767676; font-size:13px;"> (${total} review${total > 1 ? 's' : ''}${total > reviews.length ? `, showing ${reviews.length} most recent` : ''})</span>
        `;

        container.innerHTML = reviews.map(r => `
            <div class="review-item">
                <div class="review-top">
                    <span class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
                    <span class="review-author">${escapeHtml(r.buyerName)}</span>
                </div>
                ${r.comment ? `<p class="review-comment">${escapeHtml(r.comment)}</p>` : ''}
            </div>
        `).join('');
    } catch (error) {
        console.error("Error loading reviews:", error);
        summaryEl.innerHTML = '';
        container.innerHTML = `<p style="color:#888; font-size:13px;">Unable to load reviews right now.</p>`;
    }
}
