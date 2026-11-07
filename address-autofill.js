// ============================================================================
// DesiMarket — PIN-code-first address autofill (backend: backend/routes/geo.py)
//
// Drop-in for the EXISTING address forms: pages keep their own input ids and
// their own save code. This module only
//   1. watches the PIN input; at 6 digits it asks the backend who that PIN is,
//   2. fills State (and District / Block if the page has those inputs),
//   3. shows a "Gaon / Post Office" dropdown whose pick fills the City/Village input.
// Nothing long has to be typed, so spellings stay clean (and sellers' delivery
// villages match buyers' villages exactly).
//
//   attachAddressAutofill({ pin, state, city, district?, block? })   single address
//   attachVillagePicker({ input, pinsInput?, label? })               many villages
//   pickVillageForHome({ ... })                                      see index.html
// ============================================================================
import { fetchPin } from './pin-picker.js';

// ---- tiny shared styles (injected once so no page needs CSS edits) ----
function ensureStyles() {
    if (document.getElementById('pa-styles')) return;
    const s = document.createElement('style');
    s.id = 'pa-styles';
    s.textContent = `
        .pa-box { background:#f4f8ff; border:1px solid #d3def5; border-radius:8px; padding:8px 10px; margin:6px 0 10px; font-size:13px; }
        .pa-ok { color:#1a7f4b; font-weight:700; } .pa-bad { color:#8a5a00; }
        .pa-box select { width:100%; padding:9px; margin-top:6px; border:1px solid #ccc; border-radius:6px; font-size:14px; box-sizing:border-box; }
        .pa-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
        .pa-chip { padding:5px 10px; border-radius:14px; border:1.5px solid #232f3e; background:#fff; font-size:12.5px; font-weight:600; cursor:pointer; color:#232f3e; }
        .pa-chip.on { background:#232f3e; color:#fff; }
        .pa-pin { width:100%; padding:9px; border:1px solid #ccc; border-radius:6px; font-size:16px; letter-spacing:3px; box-sizing:border-box; }
        .pa-all { margin-top:6px; background:none; border:0; color:#2456b3; font-weight:700; font-size:12.5px; cursor:pointer; padding:2px 0; }
    `;
    document.head.appendChild(s);
}

const $ = (id) => (typeof id === 'string' ? document.getElementById(id) : id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- pure helpers (unit-tested)
export const splitList = (text) => String(text || '').split(',').map(v => v.trim()).filter(Boolean);
export const hasName = (list, name) => list.some(v => v.toLowerCase() === String(name).toLowerCase());
export function toggleName(text, name) {
    const list = splitList(text);
    return (hasName(list, name) ? list.filter(v => v.toLowerCase() !== name.toLowerCase()) : [...list, name]).join(', ');
}
export function addNames(text, names) {
    const list = splitList(text);
    for (const n of names) if (!hasName(list, n)) list.push(n);
    return list.join(', ');
}
export function findOffice(offices, wanted) {
    const w = String(wanted || '').trim().toLowerCase();
    return w ? (offices || []).find(o => o.name.toLowerCase() === w) || null : null;
}

// ---------------------------------------------------------------- single address
export function attachAddressAutofill(cfg) {
    ensureStyles();
    const pinEl = $(cfg.pin), stateEl = $(cfg.state), cityEl = $(cfg.city);
    const districtEl = cfg.district ? $(cfg.district) : null;
    const blockEl = cfg.block ? $(cfg.block) : null;
    if (!pinEl || !stateEl || !cityEl) return null;

    pinEl.setAttribute('inputmode', 'numeric');
    pinEl.setAttribute('autocomplete', 'postal-code');
    if (!pinEl.getAttribute('maxlength')) pinEl.setAttribute('maxlength', '6');

    const box = document.createElement('div');
    box.className = 'pa-box';
    box.style.display = 'none';
    box.innerHTML = '<div class="pa-info"></div><select class="pa-vill" style="display:none;"></select>';
    const anchor = pinEl.closest('.form-row') || pinEl.closest('.form-group') || pinEl;   // seller/delivery forms keep inputs directly in a grid
    box.style.gridColumn = '1 / -1';
    box.style.flex = '1 1 100%';
    anchor.insertAdjacentElement('afterend', box);
    const info = box.querySelector('.pa-info'), sel = box.querySelector('.pa-vill');

    let geo = null, seq = 0;

    async function lookup(pin, wantedCity) {
        const mine = ++seq;
        box.style.display = 'block';
        sel.style.display = 'none';
        info.innerHTML = '⏳ PIN jaanch ho rahi hai...';
        try {
            const g = await fetchPin(pin);
            if (mine !== seq) return;                         // a newer PIN was typed meanwhile
            geo = g;
            stateEl.value = g.state;
            if (districtEl) districtEl.value = g.district;
            if (blockEl) blockEl.value = g.block || '';
            info.innerHTML = `<span class="pa-ok">✅ ${esc(g.state)} › ${esc(g.district)}${g.block ? ' › ' + esc(g.block) : ''}</span>`;
            sel.innerHTML = '<option value="">— Apna gaon / post office chuniye —</option>'
                + g.offices.map(o => `<option value="${esc(o.name)}">${esc(o.name)}${o.type ? ' (' + esc(o.type) + ')' : ''}</option>`).join('')
                + '<option value="__other">Anya — khud likhiye</option>';
            sel.style.display = g.offices.length ? 'block' : 'none';
            if (!g.offices.length) info.innerHTML += '<div class="pa-bad">Gaon ki list abhi nahi mili — apna gaon/shehar neeche khud likhiye.</div>';
            const hit = findOffice(g.offices, wantedCity !== undefined ? wantedCity : cityEl.value);
            if (hit) { sel.value = hit.name; cityEl.value = hit.name; }
            if (cfg.onGeo) cfg.onGeo(g);
        } catch (e) {
            if (mine !== seq) return;
            geo = null;
            info.innerHTML = `<span class="pa-bad">⚠️ ${esc(e.message)} Rajya aur shehar/gaon khud likh sakte hain.</span>`;
        }
    }

    pinEl.addEventListener('input', () => {
        const v = pinEl.value.replace(/\D/g, '').slice(0, 6);
        if (v !== pinEl.value) pinEl.value = v;
        if (v.length === 6) lookup(v);
        else { geo = null; seq++; box.style.display = 'none'; }
    });
    sel.addEventListener('change', () => {
        if (sel.value === '__other') { cityEl.value = ''; cityEl.focus(); }
        else if (sel.value) cityEl.value = sel.value;
    });

    return {
        // call after you set pinEl.value programmatically (e.g. editing a saved address / tapping a saved one)
        refresh(city) { const v = pinEl.value.trim(); if (/^\d{6}$/.test(v)) lookup(v, city); else { box.style.display = 'none'; } },
        geo: () => (geo ? { pincode: pinEl.value.trim(), state: geo.state, district: geo.district, block: geo.block || '', lat: geo.lat ?? null, lng: geo.lng ?? null } : null),
    };
}

// ---------------------------------------------------------------- many villages (seller / delivery partner)
// `input` is the page's existing comma-separated villages text input — it stays the source
// of truth, so the page's save code needs no change except (optionally) reading getPins().
export function attachVillagePicker({ input, label = '📮 PIN code daaliye — us PIN ke gaon niche aa jayenge, chhoone se chuniye', initialPins = [] }) {
    ensureStyles();
    const inputEl = $(input);
    if (!inputEl) return null;
    const host = document.createElement('div');
    host.className = 'pa-box';
    host.style.margin = '0 0 8px';
    host.style.gridColumn = '1 / -1';
    host.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">${esc(label)}</div>
        <input class="pa-pin" type="tel" inputmode="numeric" maxlength="6" placeholder="PIN code">
        <div class="pa-info" style="margin-top:6px;"></div><div class="pa-chips"></div>`;
    inputEl.insertAdjacentElement('beforebegin', host);
    const pinIn = host.querySelector('.pa-pin'), info = host.querySelector('.pa-info'), chips = host.querySelector('.pa-chips');

    const pins = new Set((initialPins || []).filter(Boolean));
    const looked = new Map();      // pin -> offices (this session)
    let current = null, seq = 0;

    function syncPins() {
        const list = splitList(inputEl.value);
        for (const [pin, offices] of looked) {
            const any = offices.some(o => hasName(list, o.name));
            if (any) pins.add(pin); else pins.delete(pin);
        }
    }
    function paint() {
        const list = splitList(inputEl.value);
        chips.innerHTML = (current ? current.offices : []).map(o =>
            `<span class="pa-chip ${hasName(list, o.name) ? 'on' : ''}" data-n="${esc(o.name)}">${esc(o.name)}</span>`).join('')
            + (current && current.offices.length > 1 ? '<button type="button" class="pa-all">＋ Sab chuniye</button>' : '');
    }
    chips.addEventListener('click', (e) => {
        const chip = e.target.closest('.pa-chip'), all = e.target.closest('.pa-all');
        if (chip) inputEl.value = toggleName(inputEl.value, chip.dataset.n);
        else if (all && current) inputEl.value = addNames(inputEl.value, current.offices.map(o => o.name));
        else return;
        syncPins(); paint();
    });
    inputEl.addEventListener('input', () => { syncPins(); paint(); });
    pinIn.addEventListener('input', async () => {
        const v = pinIn.value.replace(/\D/g, '').slice(0, 6);
        if (v !== pinIn.value) pinIn.value = v;
        if (v.length < 6) { info.textContent = ''; chips.innerHTML = ''; current = null; return; }
        const mine = ++seq;
        info.textContent = '⏳ Jaanch ho rahi hai...';
        try {
            const g = await fetchPin(v);
            if (mine !== seq) return;
            current = g; looked.set(v, g.offices);
            info.innerHTML = `<span class="pa-ok">✅ ${esc(g.state)} › ${esc(g.district)}${g.block ? ' › ' + esc(g.block) : ''}</span>`;
            paint();
        } catch (e) {
            if (mine !== seq) return;
            current = null; chips.innerHTML = '';
            info.innerHTML = `<span class="pa-bad">⚠️ ${esc(e.message)} Aap gaon ke naam niche khud bhi likh sakte hain.</span>`;
        }
    });
    return { getPins: () => { syncPins(); return [...pins]; } };
}
