import { doc, setDoc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { showToast } from './toast.js';

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAR_REGEX = /^\d{12}$/;

// PAN and Aadhar are kept in a SEPARATE, non-public collection
// (seller_private_kyc/{uid}) — not on sellers_profiles, which anyone can
// read (it's the public shop page data). Only kycStatus stays on the public
// profile, since the "Verified Seller" badge needs to be readable by buyers;
// the actual PAN/Aadhar numbers never need to be.
export async function submitKycDetails(db, uid, panNumber, aadharNumber, refreshCallback) {
    const pan = panNumber.trim().toUpperCase();
    const aadhar = aadharNumber.trim();

    if (!PAN_REGEX.test(pan)) {
        showToast("Please enter a valid PAN number (e.g. ABCDE1234F).", 'error');
        return;
    }
    if (!AADHAR_REGEX.test(aadhar)) {
        showToast("Please enter a valid 12-digit Aadhar number.", 'error');
        return;
    }

    try {
        await setDoc(doc(db, "seller_private_kyc", uid), {
            pan,
            aadharLast4: aadhar.slice(-4), // only store last 4 digits for privacy
            submittedAt: new Date()
        }, { merge: true });

        await setDoc(doc(db, "sellers_profiles", uid), {
            kycStatus: 'Pending'
        }, { merge: true });

        showToast("KYC details submitted! Our team will review them shortly.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting KYC:", error);
        showToast("Unable to submit KYC right now. Please try again.", 'error');
    }
}

export async function loadKycStatus(db, uid) {
    const container = document.getElementById('kycContainer');
    if (!container) return;

    try {
        const profileSnap = await getDoc(doc(db, "sellers_profiles", uid));
        const status = profileSnap.exists() ? (profileSnap.data().kycStatus || 'Not Submitted') : 'Not Submitted';

        if (status === 'Verified') {
            container.innerHTML = `<div class="kyc-status-box verified">✅ <strong>KYC Verified</strong> — your shop shows a trusted seller badge to buyers.</div>`;
        } else if (status === 'Pending') {
            const privateSnap = await getDoc(doc(db, "seller_private_kyc", uid));
            const priv = privateSnap.exists() ? privateSnap.data() : {};
            container.innerHTML = `<div class="kyc-status-box pending">⏳ <strong>KYC Under Review</strong> — PAN: ${escapeForDisplay(priv.pan) || 'N/A'}, Aadhar ending in ${escapeForDisplay(priv.aadharLast4) || '----'}. We'll notify you once verified.</div>`;
        } else if (status === 'Rejected') {
            container.innerHTML = `
                <div class="kyc-status-box rejected">❌ <strong>KYC Rejected</strong> — please re-check your details and submit again.</div>
                ${renderKycForm()}
            `;
            wireKycForm(db, uid);
        } else {
            container.innerHTML = `
                <p style="font-size:13px; color:#666; margin-top:0;">Get a "Verified Seller" badge on your shop by submitting your PAN and Aadhar for review.</p>
                ${renderKycForm()}
            `;
            wireKycForm(db, uid);
        }
    } catch (error) {
        console.error("Error loading KYC status:", error);
        container.innerHTML = `<p style="color:red;">Unable to load KYC status.</p>`;
    }
}

// PAN/Aadhar are seller-typed but only ever shown back to that same seller
// (never to another user), so this is a light safety net, not a defense
// against another person — still worth doing for consistency.
function escapeForDisplay(value) {
    if (!value) return '';
    return String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderKycForm() {
    return `
        <div class="form-grid">
            <input type="text" id="kycPanInput" placeholder="PAN Number (e.g. ABCDE1234F)" style="text-transform:uppercase;">
            <input type="text" id="kycAadharInput" placeholder="Aadhar Number (12 digits)" maxlength="12">
            <button id="kycSubmitBtn" class="action-btn full-width">Submit for Verification</button>
        </div>
    `;
}

function wireKycForm(db, uid) {
    const btn = document.getElementById('kycSubmitBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const pan = document.getElementById('kycPanInput').value;
        const aadhar = document.getElementById('kycAadharInput').value;
        submitKycDetails(db, uid, pan, aadhar, () => loadKycStatus(db, uid));
    });
}
