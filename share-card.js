// Seller "Share my shop" card.
//
// Draws a good-looking picture card of the shop (logo, name, area, villages
// it delivers to, followers) and lets the seller send it on WhatsApp or any
// other app. The card and the message contain ONLY information that is
// already public on the shop page — shop name, logo, city/area, the villages
// it delivers to and the follower count. It NEVER includes the owner's
// phone number, address, email, UPI details, map location or KYC data.
//
// Two ways to send:
//  1. "WhatsApp par bhejo" — sends a link. WhatsApp turns it into a preview
//     card (logo + shop name + area) and tapping that card opens the shop
//     page. (The preview comes from the backend: backend/routes/share.py.)
//  2. "Card ki photo share karo" — shares the picture itself, with the shop
//     link in the caption.
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { BACKEND_BASE_URL } from './order-api.js';
import { showToast } from './toast.js';

const W = 1080;
const H = 1350;
const FONT = '"Segoe UI", Roboto, "Noto Sans Devanagari", "Noto Sans", Arial, sans-serif';

// ---------------------------------------------------------------- links
function frontendBase() {
    return location.origin + location.pathname.replace(/[^/]*$/, '');
}
export function directShopLink(uid) {
    return `${frontendBase()}shop.html?id=${encodeURIComponent(uid)}`;
}
export function richShopLink(uid) {
    return `${BACKEND_BASE_URL}/share/shop/${encodeURIComponent(uid)}?b=${encodeURIComponent(frontendBase())}`;
}

// ---------------------------------------------------------------- canvas helpers
function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width <= maxWidth || !line) {
            line = test;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
        lines.length = maxLines;
        let last = lines[maxLines - 1];
        while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last + '…';
    }
    return lines;
}

function loadImage(url) {
    return new Promise(resolve => {
        if (!url) return resolve(null);
        const img = new Image();
        img.crossOrigin = 'anonymous'; // needed so the finished card can be saved/shared
        const timer = setTimeout(() => resolve(null), 8000);
        img.onload = () => { clearTimeout(timer); resolve(img); };
        img.onerror = () => { clearTimeout(timer); resolve(null); };
        img.src = url;
    });
}

function pillHeight(fontPx) { return fontPx + 34; }

function drawPill(ctx, text, centerX, y, fontPx) {
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const w = Math.min(ctx.measureText(text).width + 72, 820);
    const h = pillHeight(fontPx);
    roundRectPath(ctx, centerX - w / 2, y, w, h, h / 2);
    ctx.fillStyle = '#f3f5f7';
    ctx.fill();
    ctx.fillStyle = '#2b3a4a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let t = text;
    while (t.length > 3 && ctx.measureText(t).width > w - 60) t = t.slice(0, -2) + '…';
    ctx.fillText(t, centerX, y + h / 2 + 2);
    return h;
}

/**
 * Draws the card. `info` = { shopName, city, villages: [], followers }.
 * Everything in `info` is already public on the shop page.
 */
export function drawShopCard(info, logoImg) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // --- background
    const bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, '#2f4157');
    bg.addColorStop(0.5, '#232f3e');
    bg.addColorStop(1, '#121a24');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // soft glows + dots for a festive feel
    const glow = (x, y, r, a) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,153,0,${a})`);
        g.addColorStop(1, 'rgba(255,153,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    glow(110, 120, 380, 0.35);
    glow(W - 80, H - 140, 420, 0.28);
    ctx.fillStyle = 'rgba(255,210,122,0.35)';
    [[70, 560, 7], [1010, 420, 9], [950, 860, 6], [120, 980, 8], [880, 150, 6], [200, 300, 5], [1000, 1180, 7], [60, 1240, 6]].forEach(([x, y, r]) => {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    });

    // --- brand
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 62px ${FONT}`;
    const desi = 'Desi', market = 'Market';
    const bw = ctx.measureText(desi).width + ctx.measureText(market).width;
    let bx = (W - bw) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(desi, bx, 118);
    bx += ctx.measureText(desi).width;
    ctx.fillStyle = '#ff9900';
    ctx.fillText(market, bx, 118);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `600 26px ${FONT}`;
    try { ctx.letterSpacing = '7px'; } catch (e) { /* older browsers: no spacing */ }
    ctx.fillText('VOCAL FOR LOCAL', W / 2, 168);
    try { ctx.letterSpacing = '0px'; } catch (e) { /* ignore */ }

    // --- main white card
    const cx = 80, cy = 200, cw = W - 160, ch = 1010;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 24;
    roundRectPath(ctx, cx, cy, cw, ch, 56);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // orange header band (clipped to the card's rounded top)
    ctx.save();
    roundRectPath(ctx, cx, cy, cw, ch, 56);
    ctx.clip();
    const band = ctx.createLinearGradient(cx, cy, cx + cw, cy + 260);
    band.addColorStop(0, '#ff9900');
    band.addColorStop(1, '#ffc65c');
    ctx.fillStyle = band;
    ctx.fillRect(cx, cy, cw, 225);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(cx + cw - 90, cy + 40, 150, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 60, cy + 210, 90, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // --- logo
    const lx = W / 2, ly = cy + 215, lr = 118;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.beginPath(); ctx.arc(lx, ly, lr + 16, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.clip();
    if (logoImg) {
        const s = Math.max((lr * 2) / logoImg.naturalWidth, (lr * 2) / logoImg.naturalHeight);
        const dw = logoImg.naturalWidth * s, dh = logoImg.naturalHeight * s;
        ctx.drawImage(logoImg, lx - dw / 2, ly - dh / 2, dw, dh);
    } else {
        const g = ctx.createLinearGradient(lx - lr, ly - lr, lx + lr, ly + lr);
        g.addColorStop(0, '#2f4157');
        g.addColorStop(1, '#232f3e');
        ctx.fillStyle = g;
        ctx.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
        ctx.fillStyle = '#ff9900';
        ctx.font = `800 130px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((info.shopName || 'D').trim().charAt(0).toUpperCase(), lx, ly + 8);
    }
    ctx.restore();

    // --- shop name
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#232f3e';
    ctx.font = `800 70px ${FONT}`;
    const nameLines = wrapText(ctx, info.shopName || 'Local Shop', cw - 110, 2);
    let y = ly + lr + 100;
    nameLines.forEach(line => { ctx.fillText(line, W / 2, y); y += 80; });

    ctx.fillStyle = '#2e9e5b';
    ctx.font = `700 27px ${FONT}`;
    try { ctx.letterSpacing = '3px'; } catch (e) { /* ignore */ }
    ctx.fillText('LOCAL SHOP ON DESIMARKET', W / 2, y - 12);
    try { ctx.letterSpacing = '0px'; } catch (e) { /* ignore */ }
    y += 14;

    // --- info pills (only public details)
    const yAfterName = y;
    // Chips are only drawn if they fit above the button, so a long shop name
    // can never make them run over it.
    const by = cy + ch - 128, bh = 96, bwid = cw - 140;
    const limit = by - 20;
    const tryPill = (text, fontPx) => {
        if (y + pillHeight(fontPx) > limit) return;
        y += drawPill(ctx, text, W / 2, y, fontPx) + 16;
    };
    if (info.city) tryPill(`📍 ${info.city}`, 36);
    const villages = (info.villages || []).filter(Boolean);
    if (villages.length) {
        const shown = villages.slice(0, 3).join(', ');
        const more = villages.length > 3 ? `  +${villages.length - 3} aur` : '';
        tryPill(`🚚 Delivery: ${shown}${more}`, 32);
    }
    if ((info.followers || 0) > 0) {
        tryPill(`👥 ${info.followers} ${info.followers === 1 ? 'Follower' : 'Followers'}`, 32);
    }

    if (y === yAfterName) {
        // Nothing to show (no area / villages / followers yet): fill the space nicely.
        ctx.fillStyle = '#5b6875';
        ctx.font = `600 36px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Ghar baithe apni pasand ka', W / 2, y + 70);
        ctx.fillText('saaman mangaiye 🛍️', W / 2, y + 122);
    }

    // --- call to action
    ctx.save();
    ctx.shadowColor = 'rgba(255,153,0,0.55)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    roundRectPath(ctx, W / 2 - bwid / 2, by, bwid, bh, bh / 2);
    const cta = ctx.createLinearGradient(0, by, 0, by + bh);
    cta.addColorStop(0, '#ffd45e');
    cta.addColorStop(1, '#ff9900');
    ctx.fillStyle = cta;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#1b2430';
    ctx.font = `800 42px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('👉 Dukaan dekhne ke liye tap karo', W / 2, by + bh / 2 + 3);

    // --- footer
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText('Gaon ki dukaan, ab online 🛒', W / 2, 1268);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText('Pasand aaye to apne doston ko bhi bhejiye', W / 2, 1312);

    return canvas;
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        try {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png');
        } catch (e) {
            reject(e); // e.g. SecurityError if the logo's server did not allow it
        }
    });
}

// ---------------------------------------------------------------- modal
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function openShopShareCard(db, uid) {
    showToast('Card ban raha hai...');

    let profile = {};
    try {
        const snap = await getDoc(doc(db, 'sellers_profiles', uid));
        if (snap.exists()) profile = snap.data();
    } catch (e) {
        console.error(e);
        showToast('Shop ki jaankari nahi mili. Dobara try karo.', 'error');
        return;
    }
    if (!profile.shopName) {
        showToast('Pehle apna Shop Profile bharke save karo.', 'error');
        return;
    }

    // ONLY these public fields are used for the card and the message.
    const info = {
        shopName: String(profile.shopName).slice(0, 80),
        city: String(profile.city || '').slice(0, 60),
        villages: Array.isArray(profile.deliveryVillages) ? profile.deliveryVillages.map(v => String(v).slice(0, 40)) : [],
        followers: Math.max(0, parseInt(profile.followerCount) || 0)
    };

    const logo = await loadImage(profile.logo);
    let canvas = drawShopCard(info, logo);
    let blob;
    try {
        blob = await canvasToBlob(canvas);
    } catch (e) {
        // The logo's host didn't allow the picture to be saved — draw the card
        // with the shop's first letter instead of the logo.
        canvas = drawShopCard(info, null);
        blob = await canvasToBlob(canvas);
    }
    const imgUrl = URL.createObjectURL(blob);
    const fileName = `${info.shopName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'dukaan'}-desimarket.png`;
    const file = new File([blob], fileName, { type: 'image/png' });

    const direct = directShopLink(uid);
    const rich = richShopLink(uid);
    const headline = `🏪 *${info.shopName}*${info.city ? ' — ' + info.city : ''}`;
    const textRich = `${headline}\nDesiMarket par hamari dukaan dekhiye 👇\n${rich}`;
    const textDirect = `${headline}\nDesiMarket par hamari dukaan dekhiye 👇\n${direct}`;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed; inset:0; z-index:100000; background:rgba(10,16,24,.78); display:flex; align-items:center; justify-content:center; padding:14px; font-family:inherit;';
    wrap.innerHTML = `
        <div style="background:#fff; border-radius:18px; width:100%; max-width:420px; max-height:96vh; overflow:auto; padding:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <strong style="font-size:17px;">📤 Apni dukaan share karo</strong>
                <button id="scClose" style="border:none; background:#eef0f2; width:34px; height:34px; border-radius:50%; font-size:16px; cursor:pointer;">✕</button>
            </div>
            <img src="${imgUrl}" alt="Shop card" style="width:100%; border-radius:12px; display:block; box-shadow:0 6px 22px rgba(0,0,0,.25);">
            <p style="font-size:12px; color:#666; margin:10px 2px 12px; line-height:1.5;">✅ Card me sirf wahi jaankari hai jo aapke shop page par sabko dikhti hai. Aapka phone number, address aur UPI isme <strong>nahi</strong> hai.</p>
            <button id="scWa" style="width:100%; padding:13px; border:none; border-radius:12px; background:#25d366; color:#fff; font-size:15px; font-weight:700; cursor:pointer; margin-bottom:8px;">🟢 WhatsApp par bhejo (tap karte hi dukaan khulegi)</button>
            <button id="scShare" style="width:100%; padding:13px; border:none; border-radius:12px; background:#232f3e; color:#fff; font-size:15px; font-weight:700; cursor:pointer; margin-bottom:8px;">🖼️ Card ki photo share karo</button>
            <div style="display:flex; gap:8px;">
                <a id="scDl" href="${imgUrl}" download="${esc(fileName)}" style="flex:1; text-align:center; padding:11px 6px; border:1.5px solid #232f3e; border-radius:12px; color:#232f3e; font-size:13.5px; font-weight:700; text-decoration:none;">⬇️ Download</a>
                <button id="scCopy" style="flex:1; padding:11px 6px; border:1.5px solid #232f3e; border-radius:12px; background:#fff; color:#232f3e; font-size:13.5px; font-weight:700; cursor:pointer;">🔗 Link copy</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);

    const close = () => { wrap.remove(); URL.revokeObjectURL(imgUrl); };
    wrap.querySelector('#scClose').onclick = close;
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    wrap.querySelector('#scWa').onclick = () => {
        window.open('https://wa.me/?text=' + encodeURIComponent(textRich), '_blank');
    };

    wrap.querySelector('#scShare').onclick = async () => {
        try {
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], text: textDirect, title: info.shopName });
            } else if (navigator.share) {
                await navigator.share({ text: textDirect, title: info.shopName });
                showToast('Is phone se photo seedhe share nahi ho sakti — pehle Download karo.');
            } else {
                showToast('Is browser me share nahi hota. Download karke bhejo.', 'error');
            }
        } catch (e) {
            if (e && e.name !== 'AbortError') showToast('Share nahi ho paya. Download karke bhejo.', 'error');
        }
    };

    wrap.querySelector('#scCopy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(direct);
            showToast('Link copy ho gaya 📋');
        } catch (e) {
            showToast(direct);
        }
    };
}
