// ============================================================================
// DesiMarket — Gaon Bazaar shared helpers (backend: backend/routes/bazaar.py).
// Prices arrive as integer PAISE.
// ============================================================================
import { BACKEND_BASE_URL } from './order-api.js';
import { rupees } from './khata-api.js';

export { rupees };

// user === null => public (no token). Writes always need a signed-in user.
export async function bazaarApi(user, path, method = 'GET', body = null) {
    const headers = {};
    if (user) headers['Authorization'] = `Bearer ${await user.getIdToken()}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BACKEND_BASE_URL}/api/bazaar${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kuch gadbad ho gayi. Dobara try kijiye.');
    return data;
}

export const KINDS = {
    sell:   { label: 'Mandi',  icon: '🛒', postLabel: 'Kuch bechna hai' },
    rent:   { label: 'Kiraya', icon: '🚜', postLabel: 'Vahan / machine kiraye par dena hai' },
    job:    { label: 'Kaam',   icon: '📋', postLabel: 'Majdoor chahiye (kaam dena hai)' },
    worker: { label: 'Majdoor', icon: '👷', postLabel: 'Main kaam dhoondh raha/rahi hoon' },
};

export const CAT = {
    sell: [['pashu', '🐄', 'Pashu'], ['fasal', '🌾', 'Fasal'], ['beej-khad', '🌱', 'Beej / khad'], ['chara', '🌿', 'Chara / bhusa'],
           ['saman', '🏺', 'Purana saman'], ['mahila-utpad', '🧵', 'Mahila utpad'], ['hastshilp', '🧺', 'Hastshilp'],
           ['vahan', '🛵', 'Vahan'], ['khet-theka', '📐', 'Khet bataai']],
    rent: [['tractor', '🚜', 'Tractor'], ['jcb', '🏗️', 'JCB'], ['tempo', '🚚', 'Tempo'], ['thresher', '🌾', 'Thresher'],
           ['pump-machine', '⚙️', 'Pump / machine'], ['bhaada-sharing', '📦', 'Bhaada sharing'], ['anya', '➕', 'Anya']],
    job: [['khet-kaam', '🌾', 'Khet'], ['nirman', '🧱', 'Nirman'], ['driver', '🚛', 'Driver'], ['ghar-kaam', '🏠', 'Ghar / pashu'],
          ['silai-ghar', '🧵', 'Ghar baithe'], ['anya', '➕', 'Anya']],
    worker: [['khet-majdoor', '🌾', 'Khet majdoor'], ['mistri', '🧱', 'Mistri'], ['plumber', '🔧', 'Plumber'], ['electrician', '💡', 'Electrician'],
             ['driver', '🚛', 'Driver'], ['karigar', '🛠️', 'Karigar'], ['silai-kadhai', '🧵', 'Silai-kadhai'], ['toli', '👥', 'Toli'], ['anya', '➕', 'Anya']],
};
export const catLabel = (kind, key) => {
    const c = (CAT[kind] || []).find(x => x[0] === key);
    return c ? `${c[1]} ${c[2]}` : key;
};
export const ANIMALS = [['gaay', 'Gaay'], ['bhains', 'Bhains'], ['bakri', 'Bakri'], ['bail', 'Bail'], ['bhed', 'Bhed'], ['murgi', 'Murgi / batakh'], ['ghoda', 'Ghoda'], ['anya', 'Anya']];

const UNIT = { total: '', per_din: '/din', per_ghanta: '/ghanta', per_kilo: '/kilo', per_quintal: '/quintal', per_acre: '/acre', per_nag: '/nag' };
export const UNIT_NAME = { total: 'Kul keemat', per_din: 'Prati din', per_ghanta: 'Prati ghanta', per_kilo: 'Prati kilo', per_quintal: 'Prati quintal', per_acre: 'Prati acre', per_nag: 'Prati nag (ek)' };
export function priceText(p) {
    if (!p.price) return p.kind === 'sell' ? 'Mol-bhav' : 'Baat karke';
    return rupees(p.price) + (UNIT[p.priceUnit] || '');
}

export function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return `${mins || 1} min pehle`;
    if (mins < 1440) return `${Math.round(mins / 60)} ghante pehle`;
    return `${Math.round(mins / 1440)} din pehle`;
}

// ---- voice: read a hint aloud / dictate into a field (browser support varies) ----
export function speak(text) {
    try {
        if (!('speechSynthesis' in window)) return false;
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'hi-IN';
        speechSynthesis.speak(u);
        return true;
    } catch { return false; }
}
export function listen(onText, onError) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { onError && onError(new Error('Is browser me bolkar search nahi chalta.')); return; }
    const r = new SR();
    r.lang = 'hi-IN';
    r.interimResults = false;
    r.onresult = (e) => onText(e.results[0][0].transcript);
    r.onerror = () => onError && onError(new Error('Awaaz samajh nahi aayi, dobara bolkar dekhiye.'));
    r.start();
}

export function waLink(phone, text) {
    return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}
export function shareLink(postId) {
    return new URL('bazaar.html?post=' + encodeURIComponent(postId), location.href).href;
}
