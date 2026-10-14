import { showToast } from './toast.js';
import { BACKEND_BASE_URL } from './order-api.js';

// Simple CSV line parser that respects quoted fields containing commas.
function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

export async function bulkUploadProducts(db, currentLoggedInUser, shopName, file, refreshCallback) {
    const statusEl = document.getElementById('bulkUploadStatus');

    if (!currentLoggedInUser) { showToast("Please login first.", 'error'); return; }
    if (!shopName) { showToast("Please save your Shop Profile first!", 'error'); return; }
    if (!file) { showToast("Please choose a CSV file first.", 'error'); return; }

    statusEl.innerText = 'Reading file...';
    statusEl.style.color = '#888';

    try {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');

        if (lines.length < 2) {
            statusEl.innerText = '❌ CSV file appears to be empty.';
            statusEl.style.color = '#dc3545';
            return;
        }

        // Skip header row (line 0), expect: name,price,unit,stock,material,warranty,image,description,category
        const rows = lines.slice(1).map(line => {
            const [name, price, unit, stock, material, warranty, image, description, category] = parseCsvLine(line);
            return { name, price, unit, stock, material, warranty, image, description, category };
        });

        statusEl.innerText = `Uploading ${rows.length} products...`;

        // The Premium-only gate and the actual writes both happen
        // server-side now (see backend/routes/products.py) — that gate used
        // to be a client-side isPremiumSeller() check only, bypassable by
        // calling the Firestore SDK directly regardless of plan.
        const idToken = await currentLoggedInUser.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/products/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ shopName, products: rows })
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.error || 'Could not upload products.');

        statusEl.innerText = `✅ Uploaded ${result.created} products successfully.${result.failed > 0 ? ` (${result.failed} rows skipped due to errors)` : ''}`;
        statusEl.style.color = '#28a745';
        document.getElementById('csvFileInput').value = '';

        if (refreshCallback) refreshCallback(currentLoggedInUser.uid);
    } catch (error) {
        console.error(error);
        statusEl.innerText = '❌ Unable to process CSV file: ' + error.message;
        statusEl.style.color = '#dc3545';
    }
}
