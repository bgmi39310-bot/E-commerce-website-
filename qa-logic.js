import { collection, addDoc, getDocs, query, where, doc, updateDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function submitQuestion(db, { productId, sellerUid, askerUid, askerName, question }, refreshCallback) {
    if (!question || !question.trim()) {
        alert("Please type your question first.");
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
        alert("Your question has been sent to the seller!");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting question:", error);
        alert("Unable to submit question right now.");
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

// ---------- SELLER SIDE ----------
export async function loadSellerQuestions(db, sellerUid) {
    const container = document.getElementById('qaSellerContainer');
    if (!container) return;

    try {
        const q = query(collection(db, "productQuestions"), where("sellerUid", "==", sellerUid));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `<div class="no-data">No customer questions yet.</div>`;
            return;
        }

        let items = [];
        snap.forEach(d => items.push({ id: d.id, ...d.data() }));
        items.sort((a, b) => (a.answered === b.answered) ? 0 : (a.answered ? 1 : -1));

        container.innerHTML = items.map(qa => `
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
    } catch (error) {
        console.error("Error loading seller questions:", error);
        container.innerHTML = `<p style="color:red;">Unable to load questions.</p>`;
    }
}

export async function submitAnswer(db, questionId, answerText, refreshCallback) {
    if (!answerText || !answerText.trim()) {
        alert("Please type an answer first.");
        return;
    }
    try {
        await updateDoc(doc(db, "productQuestions", questionId), {
            answer: answerText.trim(),
            answered: true,
            answeredAt: new Date()
        });
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting answer:", error);
        alert("Unable to submit answer right now.");
    }
}

