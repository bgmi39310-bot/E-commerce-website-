import { IMGBB_API_KEY } from './imgbb-config.js';

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

export async function uploadToImgBB(file) {
    if (IMGBB_API_KEY === "PASTE_YOUR_IMGBB_API_KEY_HERE") {
        throw new Error("Image upload isn't set up yet. Please paste an image URL instead, or ask the site owner to add an ImgBB API key.");
    }

    const uploadFile = await compressImage(file);

    const formData = new FormData();
    formData.append('image', uploadFile);

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
        method: 'POST',
        body: formData
    });
    const data = await response.json();

    if (!data.success) {
        throw new Error((data.error && data.error.message) || 'Upload failed');
    }
    return data.data.url;
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
