// ============================================================================
// DesiMarket — Khata (roz ka hisab) shared helpers.
// Used by khata-seller.html (dukandaar) and khata.html (grahak).
// Backend: backend/routes/khata.py. All money arrives as integer PAISE.
// ============================================================================
import { BACKEND_BASE_URL } from './order-api.js';
import { escapeHtml } from './sanitize.js';

export async function khataApi(user, path, method = 'GET', body = null) {
    const idToken = await user.getIdToken();
    const res = await fetch(`${BACKEND_BASE_URL}/api/khata${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kuch gadbad ho gayi. Dobara try kijiye.');
    return data;
}

export function rupees(paise) {
    const v = (paise || 0) / 100;
    return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}

const MONTHS = ['Janvari', 'Farvari', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
}
export function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function currentMonthIST() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 7);
}
export function todayIST() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function dayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = ['Ravi', 'Som', 'Mangal', 'Budh', 'Guru', 'Shukra', 'Shani'][new Date(y, m - 1, d).getDay()];
    return `${d}/${m} · ${wd}`;
}

// A one-line summary: "Baaki ₹420" / "Advance ₹100" / "Hisab barabar"
export function balanceLabel(paise) {
    if (paise > 0) return { text: `Baaki ${rupees(paise)}`, cls: 'owe' };
    if (paise < 0) return { text: `Advance ${rupees(-paise)}`, cls: 'adv' };
    return { text: 'Hisab barabar ✓', cls: 'zero' };
}

// mode: 'seller' | 'buyer'. Cancelled entries stay visible (struck through) on purpose.
export function entryHtml(e, mode) {
    const id = escapeHtml(e.id);
    let main, amt = '', cls = e.type;
    if (e.type === 'charge') {
        main = `${escapeHtml(e.itemName || 'Saaman')} × ${e.quantity} <span class="sub">@ ${rupees(e.rate)}</span>`;
        amt = '+' + rupees(e.amount);
    } else if (e.type === 'payment') {
        main = '💰 Paise mile';
        amt = '−' + rupees(e.amount);
    } else if (e.type === 'claim') {
        main = '💸 UPI se bheje (grahak ka dawa)';
        amt = rupees(e.amount);
        cls = 'claim ' + (e.claimStatus || 'pending');
    } else {
        main = `🚫 Nahi diya${e.itemName ? ' <span class="sub">(' + escapeHtml(e.itemName) + ')</span>' : ''}`;
    }
    if (e.voided) cls += ' voided';

    let extra = '';
    if (e.note && e.type !== 'skip') extra += `<div class="note">📝 ${escapeHtml(e.note)}</div>`;
    if (e.voided) extra += `<div class="note void">✕ Cancel: ${escapeHtml(e.voidReason || '')}</div>`;
    if (e.edited && !e.voided) extra += `<div class="note">✏️ Sudhari hui entry</div>`;
    if (e.type === 'claim') {
        const lbl = { pending: '⏳ Dukandaar ke confirm karne ka intezaar', confirmed: '✅ Confirm hua — payment khate me likh di gayi', rejected: '❌ Reject hua' }[e.claimStatus] || '';
        extra += `<div class="note ${e.claimStatus === 'rejected' ? 'void' : ''}">${lbl}${e.claimReason ? ': ' + escapeHtml(e.claimReason) : ''}</div>`;
    }

    const d = e.dispute;
    if (d) {
        extra += `<div class="dispute ${d.status}">❓ Grahak: ${escapeHtml(d.message || '')}`;
        if (d.reply) extra += `<br>↳ Dukaan: ${escapeHtml(d.reply)}`;
        else if (d.status === 'open') extra += `<br><em>Jawab ka intezaar hai</em>`;
        extra += `</div>`;
    }

    let actions = '';
    if (e.type === 'claim') {
        if (mode === 'seller' && e.claimStatus === 'pending') {
            actions += `<button class="mini ok" onclick="resolveClaim('${id}', 'confirm', ${e.amount})">✅ Confirm</button>`;
            actions += `<button class="mini danger" onclick="resolveClaim('${id}', 'reject', ${e.amount})">❌ Reject</button>`;
        }
    } else if (!e.voided) {
        if (mode === 'seller') {
            if (e.type !== 'skip') actions += `<button class="mini" onclick="editEntry('${id}')">✏️ Sudharo</button>`;
            if (d && d.status === 'open') actions += `<button class="mini" onclick="replyDispute('${id}')">💬 Jawab do</button>`;
            actions += `<button class="mini danger" onclick="voidEntry('${id}')">✕ Cancel</button>`;
        } else if (mode === 'buyer' && (!d || d.status !== 'open')) {
            actions += `<button class="mini" onclick="askDoubt('${id}')">❓ Sawal</button>`;
        }
    }

    return `<div class="entry ${cls}">
        <div class="e-top"><span class="e-date">${escapeHtml(dayLabel(e.date))}</span><span class="e-amt">${amt}</span></div>
        <div class="e-main">${main}</div>${extra}
        ${actions ? `<div class="e-actions">${actions}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- extras
export function upiLink(upiId, shopName, paise, note) {
    const p = new URLSearchParams({ pa: upiId, pn: shopName || 'Dukaan', cu: 'INR', tn: note || 'Khata' });
    if (paise > 0) p.set('am', (paise / 100).toFixed(2));
    return 'upi://pay?' + p.toString();
}

// Download rows (array of arrays) as a CSV file that opens correctly in Excel/Sheets (UTF-8 BOM).
export function downloadCsv(filename, rows) {
    const esc = (v) => {
        let t = String(v ?? '');
        if (/^[=+\-@]/.test(t)) t = "'" + t;                // stop spreadsheet formula injection
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const csv = '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ledgerCsvRows(detail) {
    const rows = [['Tareekh', 'Type', 'Saaman', 'Matra', 'Rate', 'Amount (Rs)', 'Note', 'Sthiti']];
    for (const e of detail.entries) {
        const type = { charge: 'Maal diya', payment: 'Paise mile', skip: 'Nahi diya', claim: 'UPI dawa' }[e.type] || e.type;
        const status = e.voided ? 'Cancel: ' + (e.voidReason || '') : (e.claimStatus || '');
        rows.push([e.date, type, e.itemName || '', e.quantity ?? '', e.rate != null ? e.rate / 100 : '',
                   (e.amount || 0) / 100, e.note || '', status]);
    }
    return rows;
}

export function itemLine(it) {
    return `${it.name} ${it.quantity} ${it.unit} = ${rupees(Math.round(it.quantity * it.rate))}`;
}
