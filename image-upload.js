import { IMGBB_API_KEY } from './imgbb-config.js';

export async function uploadToImgBB(file) {
    const formData = new FormData();
    formData.append('image', file);

    try {
        const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();

        if (!data.success) {
            throw new Error((data.error && data.error.message) || 'Upload failed');
        }
        return data.data.url;
    } catch (error) {
        console.error("ImgBB Error:", error);
        throw new Error("Photo upload nahi ho payi. Kripya dobara koshish karein.");
    }
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

        // 30 MB ki limit yahan set kar di gayi hai (30 MB = 30 * 1024 * 1024 bytes)
        if (file.size > 30 * 1024 * 1024) {
            if (statusEl) { statusEl.innerText = '❌ Photo bohot badi hai (max 30MB allowed)'; statusEl.style.color = '#dc3545'; }
            return;
        }

        if (statusEl) { statusEl.innerText = '⏳ Upload ho rahi hai...'; statusEl.style.color = '#888'; }

        try {
            const url = await uploadToImgBB(file);
            urlInput.value = url;
            if (statusEl) { statusEl.innerText = '✅ Photo upload ho gayi!'; statusEl.style.color = '#28a745'; }
        } catch (error) {
            console.error(error);
            if (statusEl) { statusEl.innerText = '❌ Upload fail ho gayi'; statusEl.style.color = '#dc3545'; }
        }
    });
}
