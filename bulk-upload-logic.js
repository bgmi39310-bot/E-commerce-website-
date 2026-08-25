import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isPremiumSeller } from './premium-logic.js';

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

    if (!currentLoggedInUser) { alert("Please login first."); return; }
    if (!shopName) { alert("Please save your Shop Profile first!"); return; }
    if (!file) { alert("Please choose a CSV file first."); return; }

    const premium = await isPremiumSeller(db, currentLoggedInUser.uid);
    if (!premium) {
        alert("Bulk CSV upload is a Premium feature. Upgrade to Premium to add many products at once!");
        return;
    }

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
        const rows = lines.slice(1);
        let successCount = 0;
        let failCount = 0;

        statusEl.innerText = `Uploading ${rows.length} products...`;

        for (const line of rows) {
            const cols = parseCsvLine(line);
            const [name, price, unit, stock, material, warranty, image, description, category] = cols;

            if (!name || !price) { failCount++; continue; }

            try {
                await addDoc(collection(db, "vendors"), {
                    name: name.trim(),
                    price: Number(price) || 0,
                    unit: (unit || 'Per Piece').trim(),
                    stock: stock ? Number(stock) : 10,
                    material: (material || '100% Original').trim(),
                    warranty: (warranty || 'Verified Quality').trim(),
                    image: (image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300').trim(),
                    images: [(image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300').trim()],
                    description: (description || `${name} available in best quality.`).trim(),
                    category: (category || 'other').trim().toLowerCase(),
                    shopName: shopName,
                    sellerUid: currentLoggedInUser.uid,
                    createdAt: new Date()
                });
                successCount++;
            } catch (err) {
                console.error('Row failed:', line, err);
                failCount++;
            }
        }

        statusEl.innerText = `✅ Uploaded ${successCount} products successfully.${failCount > 0 ? ` (${failCount} rows skipped due to errors)` : ''}`;
        statusEl.style.color = '#28a745';
        document.getElementById('csvFileInput').value = '';

        if (refreshCallback) refreshCallback(currentLoggedInUser.uid);
    } catch (error) {
        console.error(error);
        statusEl.innerText = '❌ Unable to process CSV file: ' + error.message;
        statusEl.style.color = '#dc3545';
    }
}
