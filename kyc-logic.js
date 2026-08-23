import { doc, setDoc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAR_REGEX = /^\d{12}$/;

export async function submitKycDetails(db, uid, panNumber, aadharNumber, refreshCallback) {
    const pan = panNumber.trim().toUpperCase();
    const aadhar = aadharNumber.trim();

    if (!PAN_REGEX.test(pan)) {
        alert("Please enter a valid PAN number (e.g. ABCDE1234F).");
        return;
    }
    if (!AADHAR_REGEX.test(aadhar)) {
        alert("Please enter a valid 12-digit Aadhar number.");
        return;
    }

    try {
        await setDoc(doc(db, "sellers_profiles", uid), {
            kycPan: pan,
            kycAadharLast4: aadhar.slice(-4), // only store last 4 digits for privacy
            kycStatus: 'Pending',
            kycSubmittedAt: new Date()
        }, { merge: true });

        alert("KYC details submitted! Our team will review them shortly.");
        if (refreshCallback) refreshCallback();
    } catch (error) {
        console.error("Error submitting KYC:", error);
        alert("Unable to submit KYC right now. Please try again.");
    }
}

export async function loadKycStatus(db, uid) {
    const container = document.getElementById('kycContainer');
    if (!container) return;

    try {
        const snap = await getDoc(doc(db, "sellers_profiles", uid));
        const data = snap.exists() ? snap.data() : {};
        const status = data.kycStatus || 'Not Submitted';

        if (status === 'Verified') {
            container.innerHTML = `<div class="kyc-status-box verified">✅ <strong>KYC Verified</strong> — your shop shows a trusted seller badge to buyers.</div>`;
        } else if (status === 'Pending') {
            container.innerHTML = `<div class="kyc-status-box pending">⏳ <strong>KYC Under Review</strong> — PAN: ${data.kycPan || 'N/A'}, Aadhar ending in ${data.kycAadharLast4 || '----'}. We'll notify you once verified.</div>`;
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
