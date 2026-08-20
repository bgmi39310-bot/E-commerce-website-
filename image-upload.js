import { IMGBB_API_KEY } from './imgbb-config.js';

export async function uploadToImgBB(file) {
    if (IMGBB_API_KEY === "cb22a453a079a9422c7f87e16b41c61c") {
        throw new Error("Image upload isn't set up yet. Please paste an image URL instead, or ask the site owner to add an ImgBB API key.");
    }

    const formData = new FormData();
    formData.append('image', file);

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
