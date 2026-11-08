// ============================================================================
// PIN-code-first place picker (backend: backend/routes/geo.py), used by Gaon Bazaar.
//   1. person types a 6-digit PIN  -> Rajya / Zila / Tehsil fill themselves
//   2. person writes their GAON (village) — free text, because a village can have a
//      different name from its post office
//   3. person picks their POST OFFICE from the PIN's list (a tick box copies the post
//      office name into the village box for people whose two names are the same)
//   4. optional mohalla / landmark, optional "📍 meri location" (GPS)
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
        <input id="${p}Pin" type="tel" inputmode="numeric" maxlength="6" placeholder="jaise: 472118" autocomplete="postal-code">
        <div class="pininfo" id="${p}Info"></div>
        <div id="${p}Fallback" style="display:none;">
            <div class="hint">PIN abhi jaanch nahi ho paya. Rajya aur zila khud likhiye:</div>
            <div class="two"><input id="${p}Fs" maxlength="40" placeholder="Rajya"><input id="${p}Fd" maxlength="60" placeholder="Zila"></div>
        </div>
        <div id="${p}VillWrap" style="display:none;">
            <label>🏘️ Aapka gaon (khud likhiye)</label>
            <input id="${p}Village" maxlength="60" placeholder="Apne gaon ka naam">
            <div id="${p}PoWrap" style="display:none;">
                <label>📮 Post Office chuniye (jahan se aapki daak aati hai)</label>
                <select id="${p}Po"></select>
                <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin-top:6px;"><input id="${p}Same" type="checkbox" style="width:auto;min-height:auto;"> Mera gaon bhi yahi hai (post office wale naam ka)</label>
            </div>
            <div class="hint">Gaon aur post office alag ho sakte hain — dono alag se save hote hain.</div>
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
        $('Fallback').style.display = 'none';
        S.geo = null; S.failed = false;
        $('VillWrap').style.display = 'block';          // the village can always be typed
        $('PoWrap').style.display = 'none';
        try {
            const g = await fetchPin(pin);
            S.geo = g;
            if (!S.gps) { S.lat = g.lat; S.lng = g.lng; }
            $('Info').innerHTML = `<div class="pin-ok">✅ ${esc(g.state)} › ${esc(g.district)}${g.block ? ' › ' + esc(g.block) : ''}</div>`;
            if (g.offices.length) {
                $('Po').innerHTML = '<option value="">— Post office chuniye —</option>'
                    + g.offices.map(o => `<option value="${esc(o.name)}">${esc(o.name)}${o.type ? ' (' + esc(o.type) + ')' : ''}</option>`).join('');
                $('PoWrap').style.display = 'block';
                if (init.postOffice && g.offices.some(o => o.name === init.postOffice)) $('Po').value = init.postOffice;
                $('Same').checked = !!($('Po').value && $('Village').value.trim().toLowerCase() === $('Po').value.toLowerCase());
            } else {
                $('Info').innerHTML += '<div class="pin-bad">Post office ki list abhi nahi mili — apna gaon khud likhiye.</div>';
            }
        } catch (e) {
            S.failed = true;
            $('Info').innerHTML = `<div class="pin-bad">⚠️ ${esc(e.message)}</div>`;
            $('Fallback').style.display = 'block';
            if (init.state) $('Fs').value = init.state;
            if (init.district) $('Fd').value = init.district;
        }
        onChange(read(p));
    }

    $('Pin').addEventListener('input', () => {
        const v = $('Pin').value.replace(/\D/g, '').slice(0, 6);
        $('Pin').value = v;
        if (v.length === 6) lookup(v);
        else { S.geo = null; $('Info').innerHTML = ''; $('VillWrap').style.display = 'none'; $('Fallback').style.display = 'none'; }
    });
    $('Po').addEventListener('change', () => { if ($('Same').checked && $('Po').value) $('Village').value = $('Po').value; onChange(read(p)); });
    $('Same').addEventListener('change', () => {
        if ($('Same').checked && $('Po').value) $('Village').value = $('Po').value;
        else if ($('Same').checked) { $('Same').checked = false; $('Info').innerHTML += '<div class="pin-bad">Pehle post office chuniye.</div>'; }
    });
    $('Village').addEventListener('input', () => { if ($('Same').checked && $('Village').value.trim().toLowerCase() !== $('Po').value.toLowerCase()) $('Same').checked = false; });
    const gpsBtn = $('Gps');
    if (gpsBtn) gpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) { $('GpsSt').textContent = 'Is phone me location nahi mil sakti.'; return; }
        $('GpsSt').textContent = '⏳ Location dhoondh rahe hain...';
        navigator.geolocation.getCurrentPosition(
            (pos) => { S.lat = pos.coords.latitude; S.lng = pos.coords.longitude; S.gps = true; $('GpsSt').textContent = '✅ Location mil gayi (sirf lagbhag 1 km tak ki jagah save hoti hai, ghar ka sahi pata nahi)'; onChange(read(p)); },
            () => { $('GpsSt').textContent = 'Location nahi mili. Location allow karke dobara dabaiye.'; },
            { enableHighAccuracy: false, timeout: 10000 });
    });
    if (init.village) $('Village').value = init.village;
    if (init.pincode) { $('Pin').value = init.pincode; lookup(init.pincode); }
    if (init.landmark && $('Land')) $('Land').value = init.landmark;
}

// Current value of the picker: { pincode, state, district, block, village, postOffice, landmark, lat, lng, ready }
export function read(p) {
    const $ = (s) => document.getElementById(p + s);
    const S = STATE[p] || {};
    const pin = ($('Pin')?.value || '').trim();
    const g = S.geo;
    const out = {
        pincode: pin,
        state: g ? g.state : ($('Fs')?.value || '').trim(),
        district: g ? g.district : ($('Fd')?.value || '').trim(),
        block: g ? g.block : '',
        village: ($('Village')?.value || '').trim(),
        postOffice: ($('Po')?.value || '').trim(),
        landmark: ($('Land')?.value || '').trim(),
        lat: S.lat ?? null, lng: S.lng ?? null,
    };
    out.ready = /^\d{6}$/.test(pin) && !!out.district;
    return out;
}
export const readPin = read;
