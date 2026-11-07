// ============================================================================
// PIN-code-first place picker (backend: backend/routes/geo.py).
//   1. person types a 6-digit PIN  -> Rajya / Zila / Tehsil fill themselves
//   2. person taps their Gaon / Post Office from a list (or "Anya" to type it)
//   3. optional mohalla / landmark, optional "📍 meri location" (GPS)
// No long names are ever typed, so spelling mistakes cannot happen.
// ============================================================================
import { BACKEND_BASE_URL } from './order-api.js';
import { escapeHtml as esc } from './sanitize.js';

const STATE = {};     // per picker prefix: { geo, lat, lng, gps, failed }

export async function fetchPin(pin) {
    const res = await fetch(`${BACKEND_BASE_URL}/api/geo/pincode/${encodeURIComponent(pin)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'PIN jaanch nahi ho paya.');
    return d;
}

export function pinPickerHtml(p, { landmark = true, gps = true } = {}) {
    return `<div class="pinbox" id="${p}Box">
        <label>📮 Apna PIN code (6 ank)</label>
        <input id="${p}Pin" type="tel" inputmode="numeric" maxlength="6" placeholder="jaise: 250001" autocomplete="postal-code">
        <div class="pininfo" id="${p}Info"></div>
        <div id="${p}Fallback" style="display:none;">
            <div class="hint">PIN abhi jaanch nahi ho paya. Rajya aur zila khud likhiye:</div>
            <div class="two"><input id="${p}Fs" maxlength="40" placeholder="Rajya"><input id="${p}Fd" maxlength="60" placeholder="Zila"></div>
        </div>
        <div id="${p}VillWrap" style="display:none;">
            <label>🏘️ Apna gaon / post office chuniye</label>
            <select id="${p}Vill"></select>
            <input id="${p}VillOther" maxlength="60" placeholder="Apne gaon ka naam likhiye" style="display:none;margin-top:6px;">
        </div>
        ${landmark ? `<input id="${p}Land" maxlength="80" placeholder="Mohalla / gali / landmark (optional)" style="margin-top:8px;">` : ''}
        ${gps ? `<div style="margin-top:8px;"><button type="button" class="mini" id="${p}Gps">📍 Meri location lagao</button> <span class="hint" id="${p}GpsSt"></span></div>` : ''}
    </div>`;
}

export function wirePinPicker(p, init = {}, onChange = () => {}) {
    const S = STATE[p] = { geo: null, lat: null, lng: null, gps: false, failed: false };
    const $ = (s) => document.getElementById(p + s);

    async function lookup(pin) {
        $('Info').innerHTML = '<span class="hint">⏳ Jaanch ho rahi hai...</span>';
        $('VillWrap').style.display = 'none';
        $('Fallback').style.display = 'none';
        S.geo = null; S.failed = false;
        try {
            const g = await fetchPin(pin);
            S.geo = g;
            if (!S.gps) { S.lat = g.lat; S.lng = g.lng; }
            $('Info').innerHTML = `<div class="pin-ok">✅ ${esc(g.state)} › ${esc(g.district)}${g.block ? ' › ' + esc(g.block) : ''}</div>`;
            const opts = g.offices.map(o => `<option value="${esc(o.name)}">${esc(o.name)}${o.type ? ' (' + esc(o.type) + ')' : ''}</option>`);
            opts.push('<option value="__other">Anya — apna gaon khud likhiye</option>');
            $('Vill').innerHTML = opts.join('');
            $('VillWrap').style.display = 'block';
            if (!g.offices.length) {      // list unavailable (fallback data source): type the village directly
                $('Vill').value = '__other';
                $('VillOther').style.display = 'block';
                $('Info').innerHTML += '<div class="pin-bad">Gaon ki list abhi nahi mili — apna gaon khud likhiye.</div>';
            }
            if (init.village && g.offices.some(o => o.name === init.village)) $('Vill').value = init.village;
            else if (init.village && init.pincode === pin) { $('Vill').value = '__other'; $('VillOther').value = init.village; $('VillOther').style.display = 'block'; }
        } catch (e) {
            S.failed = true;
            $('Info').innerHTML = `<div class="pin-bad">⚠️ ${esc(e.message)}</div>`;
            $('Fallback').style.display = 'block';
            if (init.state) $('Fs').value = init.state;
            if (init.district) $('Fd').value = init.district;
            $('VillWrap').style.display = 'block';
            $('Vill').innerHTML = '<option value="__other">Apna gaon likhiye</option>';
            $('VillOther').style.display = 'block';
        }
        onChange(read(p));
    }

    $('Pin').addEventListener('input', () => {
        const v = $('Pin').value.replace(/\D/g, '').slice(0, 6);
        $('Pin').value = v;
        if (v.length === 6) lookup(v);
        else { S.geo = null; $('Info').innerHTML = ''; $('VillWrap').style.display = 'none'; $('Fallback').style.display = 'none'; }
    });
    $('Vill').addEventListener('change', () => { $('VillOther').style.display = $('Vill').value === '__other' ? 'block' : 'none'; onChange(read(p)); });
    const gpsBtn = $('Gps');
    if (gpsBtn) gpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) { $('GpsSt').textContent = 'Is phone me location nahi mil sakti.'; return; }
        $('GpsSt').textContent = '⏳ Location dhoondh rahe hain...';
        navigator.geolocation.getCurrentPosition(
            (pos) => { S.lat = pos.coords.latitude; S.lng = pos.coords.longitude; S.gps = true; $('GpsSt').textContent = '✅ Location mil gayi (sirf lagbhag 1 km tak ki jagah save hoti hai, ghar ka sahi pata nahi)'; onChange(read(p)); },
            () => { $('GpsSt').textContent = 'Location nahi mili. Location allow karke dobara dabaiye.'; },
            { enableHighAccuracy: false, timeout: 10000 });
    });
    if (init.pincode) { $('Pin').value = init.pincode; lookup(init.pincode); }
    if (init.landmark && $('Land')) $('Land').value = init.landmark;
}

// Current value of the picker: { pincode, state, district, block, village, landmark, lat, lng, ready }
export function read(p) {
    const $ = (s) => document.getElementById(p + s);
    const S = STATE[p] || {};
    const pin = ($('Pin')?.value || '').trim();
    const g = S.geo;
    let village = '';
    if ($('Vill')) village = $('Vill').value === '__other' ? ($('VillOther').value || '').trim() : $('Vill').value;
    const out = {
        pincode: pin,
        state: g ? g.state : ($('Fs')?.value || '').trim(),
        district: g ? g.district : ($('Fd')?.value || '').trim(),
        block: g ? g.block : '',
        village,
        landmark: ($('Land')?.value || '').trim(),
        lat: S.lat ?? null, lng: S.lng ?? null,
    };
    out.ready = /^\d{6}$/.test(pin) && !!out.district;
    return out;
}
export const readPin = read;
