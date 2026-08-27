import { collection, addDoc, getDocs, query, where, doc, updateDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { sendNotification } from './notif-logic.js';
import { showToast } from './toast.js';

// ---------- BUYER SIDE (product.html) ----------
export async function submitQuestion(db, { productId, productName, sellerUid, askerUid, askerName, question }, refreshCallback) {
    if (!question || !question.trim()) {
        showToast('Please type your question first.', 'error');
        return;
    }
    try {
        await addDoc(collection(db, "productQuestions"), {
            productId, sellerUid, askerUid,
            askerName: askerName || 'DesiMarket Buyer',
            question: question.trim(),
            answer: '',
            answered: false,
            createdAt: new Date()
        });
        showToast('Your question has been sent to the seller!');
        if (refreshCallback) refreshCallback(); // fine here — a buyer asks at most occasionally

        if (sellerUid) {
            sendNotification(db, sellerUid, {
                title: `New question about ${productName || 'your product'}`,
                body: `"${question.trim().slice(0, 100)}${question.trim().length > 100 ? '…' : ''}" — ${askerName || 'A buyer'}`,
                type: 'new_question',
                link: 'seller-dashboard.html'
            });
        }
    } catch (error) {
        console.error("Error submitting question:", error);
        showToast('Unable to submit question right now.', 'error');
    }
}

export async function loadProductQA(db, productId) {
    const container = document.getElementById('qaContainer');
    if (!container) return;

    try {
        const q = query(collection(db, "productQuestions"), where("productId", "==", productId));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<p style="color:#888; font-size:13px;">No questions yet. Be the first to ask!</p>`;
            return;
        }

        let items = [];
        snap.forEach(d => items.push({ id: d.id, ...d.data() }));
        items.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : 0;
            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : 0;
            return tb - ta;
        });

        container.innerHTML = items.map(qa => `
            <div class="qa-item">
                <p class="qa-question">❓ ${qa.question}</p>
                ${qa.answered
                    ? `<p class="qa-answer">💬 <strong>Seller:</strong> ${qa.answer}</p>`
                    : `<p class="qa-pending">⏳ Waiting for seller's answer...</p>`
                }
            </div>
        `).join('');
    } catch (error) {
        console.error("Error loading Q&A:", error);
        container.innerHTML = `<p style="color:#888; font-size:13px;">Unable to load questions right now.</p>`;
    }
}

// ---------- SELLER SIDE (seller-dashboard.html) — local caching, no re-fetch on answer ----------
let cachedQuestions = [];

function renderSellerQuestions() {
    const container = document.getElementById('qaSellerContainer');
    if (!container) return;

    if (cachedQuestions.length === 0) {
        container.innerHTML = `<div class="no-data">No customer questions yet.</div>`;
        return;
    }

    container.innerHTML = cachedQuestions.map(qa => `
        <div class="order-card">
            <div class="order-info">
                <p><strong>${qa.askerName}</strong> asked:</p>
                <p style="font-style:italic;">"${qa.question}"</p>
                ${qa.answered
                    ? `<p style="color:#28a745;"><strong>Your answer:</strong> ${qa.answer}</p>`
                    : `
                        <textarea id="answerInput-${qa.id}" rows="2" placeholder="Type your answer..." style="width:100%; padding:8px; border:1px solid #ddd; border-radius:5px; margin-top:6px;"></textarea>
                        <button class="dash-action-btn btn-accept" style="margin-top:6px;" onclick="submitAnswerMain('${qa.id}')">Send Answer</button>
                    `
                }
            </div>
        </div>
    `).join('');
}

export async function loadSellerQuestions(db, sellerUid) {
    const container = document.getElementById('qaSellerContainer');
    if (!container) return;
    container.innerHTML = "<p>Loading questions...</p>";

    try {
        const q = query(collection(db, "productQuestions"), where("sellerUid", "==", sellerUid));
        const snap = await getDocs(q);

        cachedQuestions = [];
        snap.forEach(d => cachedQuestions.push({ id: d.id, ...d.data() }));
        cachedQuestions.sort((a, b) => (a.answered === b.answered) ? 0 : (a.answered ? 1 : -1));

        renderSellerQuestions();
    } catch (error) {
        console.error("Error loading seller questions:", error);
        container.innerHTML = `<p style="color:red;">Unable to load questions.</p>`;
    }
}

export async function submitAnswer(db, questionId, answerText) {
    if (!answerText || !answerText.trim()) {
        showToast('Please type an answer first.', 'error');
        return;
    }
    try {
        await updateDoc(doc(db, "productQuestions", questionId), {
            answer: answerText.trim(),
            answered: true,
            answeredAt: new Date()
        });

        const qa = cachedQuestions.find(x => x.id === questionId);
        if (qa) { qa.answered = true; qa.answer = answerText.trim(); }
        renderSellerQuestions();
        showToast('Answer sent to the buyer!');
    } catch (error) {
        console.error("Error submitting answer:", error);
        showToast('Unable to submit answer right now.', 'error');
    }
}
