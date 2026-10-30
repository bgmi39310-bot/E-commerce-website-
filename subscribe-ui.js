// "Roz ke liye lagao" — the subscribe popup on the product page.
// Creates a subscription through the backend (POST /api/subscriptions).
import { auth } from './firebase-config.js';
import { loadAddresses } from './address-logic.js';
import { BACKEND_BASE_URL } from './order-api.js';
import { showToast } from './toast.js';

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function openSubscribeModal({ db, product, productId, selectedVariants }) {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
        showToast('Subscription ke liye pehle login kijiye.', 'error');
        setTimeout(() => { window.location.href = 'login.html'; }, 1200);
        return;
    }

    // Prefill from the buyer's default saved address (they can still edit it).
    let addr = {};
    try {
        const list = await loadAddresses(db, user.uid);
        if (list.length) addr = list[0];
    } catch (e) { /* the buyer can type the address instead */ }

    const price = parseFloat(product.price) || 0;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed; inset:0; z-index:100000; background:rgba(10,16,24,.7); display:flex; align-items:flex-end; justify-content:center; font-family:inherit;';
    const field = 'width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:8px; font-size:14px; margin:3px 0 10px;';
    const radio = (name, value, label, checked) => `<label style="display:flex; align-items:center; gap:8px; padding:9px 10px; border:1.5px solid #ddd; border-radius:8px; margin-bottom:6px; font-size:14px; cursor:pointer;"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}> ${label}</label>`;
    wrap.innerHTML = `
        <div style="background:#fff; width:100%; max-width:480px; max-height:94vh; overflow:auto; border-radius:18px 18px 0 0; padding:18px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <strong style="font-size:17px;">🔁 Roz ke liye lagao</strong>
                <button id="subClose" style="border:none; background:#eef0f2; width:34px; height:34px; border-radius:50%; font-size:16px; cursor:pointer;">✕</button>
            </div>
            <p style="margin:0 0 12px; font-size:13.5px; color:#555;"><strong>${esc(product.name)}</strong> — ₹${price.toFixed(0)} ${esc(product.unit || '')}<br>
               <span style="font-size:12px;">🏪 ${esc(product.shopName || 'Local Seller')}</span></p>

            <label style="font-size:13px; font-weight:700;">Kitna chahiye (har baar)</label>
            <div style="display:flex; align-items:center; gap:12px; margin:4px 0 12px;">
                <button type="button" id="subMinus" style="width:38px; height:38px; border:1.5px solid #232f3e; background:#fff; border-radius:8px; font-size:20px; cursor:pointer;">−</button>
                <strong id="subQty" style="font-size:18px; min-width:24px; text-align:center;">1</strong>
                <button type="button" id="subPlus" style="width:38px; height:38px; border:1.5px solid #232f3e; background:#fff; border-radius:8px; font-size:20px; cursor:pointer;">+</button>
            </div>

            <label style="font-size:13px; font-weight:700;">Kitni baar</label>
            <div style="margin:4px 0 10px;">
                ${radio('subFreq', 'daily', '📅 Roz', true)}
                ${radio('subFreq', 'alternate', '↔️ Ek din chhod kar', false)}
                ${radio('subFreq', 'weekly', '🗓️ Hafte me ek baar', false)}
            </div>

            <label style="font-size:13px; font-weight:700;">Delivery ka samay</label>
            <select id="subSlot" style="${field}">
                <option value="morning">Subah (8 se 12)</option>
                <option value="anytime">Kabhi bhi</option>
                <option value="afternoon">Dopahar (12 se 4)</option>
                <option value="evening">Shaam (4 se 8)</option>
            </select>

            <label style="font-size:13px; font-weight:700;">Paisa kaise doge (delivery par)</label>
            <div style="margin:4px 0 10px;">
                ${radio('subPay', 'COD', '💵 Cash on Delivery', true)}
                ${radio('subPay', 'UPI', '📱 UPI se, delivery par', false)}
            </div>

            <label style="font-size:13px; font-weight:700;">Naam</label>
            <input id="subName" style="${field}" value="${esc(addr.name || '')}" placeholder="Aapka naam">
            <label style="font-size:13px; font-weight:700;">Phone (10 digit)</label>
            <input id="subPhone" inputmode="numeric" maxlength="10" style="${field}" value="${esc(addr.phone || '')}" placeholder="10 digit mobile number">
            <label style="font-size:13px; font-weight:700;">Pura pata</label>
            <textarea id="subAddress" rows="2" style="${field}" placeholder="Ghar / gali / landmark">${esc([addr.addressLine, addr.state].filter(Boolean).join(', '))}</textarea>
            <label style="font-size:13px; font-weight:700;">Shehar / Gaon</label>
            <input id="subCity" style="${field}" value="${esc(addr.city || '')}" placeholder="Shehar ya gaon">

            <div style="background:#f1f8f2; border:1px solid #bfe0c4; border-radius:10px; padding:10px 12px; font-size:12.5px; color:#1b5e20; line-height:1.55; margin-bottom:12px;">
                ✅ <strong>Kal subah se</strong> shuru hoga. Paisa sirf delivery par dena hai, kuch apne aap nahi katega. Kabhi bhi <strong>Pause ya Cancel</strong> kar sakte ho.
            </div>
            <button id="subGo" style="width:100%; padding:14px; border:none; border-radius:12px; background:linear-gradient(180deg,#ffd45e,#ff9900); color:#1b2430; font-size:16px; font-weight:800; cursor:pointer;">✅ Subscription shuru karo</button>
        </div>`;
    document.body.appendChild(wrap);

    let qty = 1;
    const qtyEl = wrap.querySelector('#subQty');
    wrap.querySelector('#subMinus').onclick = () => { qty = Math.max(1, qty - 1); qtyEl.textContent = qty; };
    wrap.querySelector('#subPlus').onclick = () => { qty = Math.min(10, qty + 1); qtyEl.textContent = qty; };
    const close = () => wrap.remove();
    wrap.querySelector('#subClose').onclick = close;
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    const val = (id) => wrap.querySelector('#' + id).value.trim();
    const pick = (name) => wrap.querySelector(`input[name="${name}"]:checked`).value;

    wrap.querySelector('#subGo').onclick = async (ev) => {
        const btn = ev.currentTarget;
        const phone = val('subPhone');
        if (!val('subName') || !val('subAddress')) { showToast('Naam aur pata bharein.', 'error'); return; }
        if (!/^\d{10}$/.test(phone)) { showToast('10 digit ka sahi phone number daalein.', 'error'); return; }
        btn.disabled = true;
        btn.textContent = 'Ho raha hai...';
        try {
            const idToken = await user.getIdToken();
            const res = await fetch(`${BACKEND_BASE_URL}/api/subscriptions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                body: JSON.stringify({
                    productId,
                    quantity: qty,
                    frequency: pick('subFreq'),
                    paymentMethod: pick('subPay'),
                    selectedSize: selectedVariants ? selectedVariants.size : null,
                    selectedColor: selectedVariants ? selectedVariants.color : null,
                    delivery: { name: val('subName'), phone, address: val('subAddress'), city: val('subCity'), slot: val('subSlot') }
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Subscription nahi ban paya.');
            close();
            showToast('🔁 Subscription shuru! Pehla order ' + data.firstOrderDate + ' ki subah.');
            setTimeout(() => { window.location.href = 'subscriptions.html'; }, 1800);
        } catch (e) {
            showToast(e.message, 'error');
            btn.disabled = false;
            btn.textContent = '✅ Subscription shuru karo';
        }
    };
}
