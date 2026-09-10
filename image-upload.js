import { auth } from './firebase-config.js';

// Resizes and re-compresses an image in the browser BEFORE it's ever
// uploaded. A phone camera photo can easily be 3000px wide and several MB —
// nobody needs that full resolution for a product photo that's shown at a
// few hundred pixels wide. Shrinking it here, once, at upload time, means
// every single person who ever opens that product page downloads a small
// file instead of a multi-MB original.
async function compressImage(file, maxDimension = 1600, quality = 0.82) {
    // Skip anything that isn't an image, or is already small — nothing to gain.
    if (!file.type || !file.type.startsWith('image/') || file.size < 300 * 1024) return file;

    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file; // browser couldn't decode it here — upload the original rather than fail
    }

    let { width, height } = bitmap;
    if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file; // only use it if it's actually smaller

    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

// Backend URL for the Flask API — see render.yaml. Update this if you ever
// rename the vande-market-api service (its URL changes with the name) or
// move to a custom domain.
const BACKEND_BASE_URL = 'https://vande-market-api.onrender.com';

// Uploads an image via our OWN backend (/api/uploads/image), which forwards
// it to ImgBB using a server-side API key. The ImgBB key never ships to the
// browser at all anymore — previously it sat in plain JS (imgbb-config.js)
// where anyone could open dev tools, copy it, and burn through the
// account's free quota (or host unrelated content on it).
export async function uploadToImgBB(file) {
    if (!auth.currentUser) {
        throw new Error("Please log in before uploading an image.");
    }

    const uploadFile = await compressImage(file);
    const idToken = await auth.currentUser.getIdToken();

    const formData = new FormData();
    formData.append('image', uploadFile);

    const response = await fetch(`${BACKEND_BASE_URL}/api/uploads/image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}` },
        body: formData
    });
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Upload failed');
    }
    return data.url;
}

// Wires a hidden file input to automatically upload on selection and
// fill the given text/url input with the resulting hosted image link.
export function wireImageUpload(fileInputId, urlInputId, statusElId) {
    const fileInput = document.getElementById(fileInputId);
    const urlInput = document.getElementById(urlInputId);
    const statusEl = statusElId ? document.getElementById(statusElId) : null;
    if (!fileInput || !urlInput) return;

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;

        if (file.size > 8 * 1024 * 1024) {
            if (statusEl) { statusEl.innerText = '❌ Photo too large (max 8MB)'; statusEl.style.color = '#dc3545'; }
            return;
        }

        if (statusEl) { statusEl.innerText = '⏳ Uploading...'; statusEl.style.color = '#888'; }

        try {
            const url = await uploadToImgBB(file);
            urlInput.value = url;
            if (statusEl) { statusEl.innerText = '✅ Photo uploaded!'; statusEl.style.color = '#28a745'; }
        } catch (error) {
            console.error(error);
            if (statusEl) { statusEl.innerText = '❌ ' + error.message; statusEl.style.color = '#dc3545'; }
        }
    });
}
