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
export async function uploadToImgBB(file, { skipCompress = false } = {}) {
    if (!auth.currentUser) {
        throw new Error("Please log in before uploading an image.");
    }

    // Photos coming out of the editor are already cropped + shrunk; only
    // un-edited files go through the generic compressor.
    const uploadFile = skipCompress ? file : await compressImage(file);
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

// ---------------------------------------------------------------------------
// Photo editor: opens right after a photo is picked from the phone. The user
// can crop (square / 4:3 / 3:4 / 16:9 / original), drag + pinch-zoom, rotate
// and adjust brightness. On "Save" the photo is cropped, shrunk and
// compressed to a small JPEG — only then is it uploaded to ImgBB.
// ---------------------------------------------------------------------------
const ASPECTS = { 'orig': null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9 };

function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => resolve({ img, url });
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
        img.src = url;
    });
}

function canvasToBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Resolves with the edited, compressed File — or null if the user cancelled.
export async function openImageEditor(file, options = {}) {
    const {
        aspect: initialAspect = 'orig',
        maxDimension = 900,
        quality = 0.8,
        targetKB = 150
    } = options;

    let loaded;
    try {
        loaded = await loadImageFromFile(file);
    } catch (e) {
        return file; // can't decode it here (e.g. HEIC) — upload the original rather than fail
    }
    const { img, url } = loaded;

    return new Promise(resolve => {
        let aspectKey = ASPECTS[initialAspect] !== undefined ? initialAspect : 'orig';
        let rot = 0, zoom = 1, offX = 0, offY = 0, bright = 100;
        let W = 300, H = 300;

        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed; inset:0; z-index:100000; background:#111; color:#fff; display:flex; flex-direction:column; font-family:inherit; touch-action:none; user-select:none; -webkit-user-select:none;';
        const btn = 'border:1px solid #555; background:#2a2a2a; color:#fff; border-radius:8px; padding:8px 12px; font-size:14px; cursor:pointer;';
        ov.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px;">
                <strong style="font-size:16px;">✂️ Photo edit karo</strong>
                <button id="ieCancel" style="${btn}">✕ Cancel</button>
            </div>
            <div id="ieStage" style="flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:6px 10px;">
                <canvas id="ieCanvas" style="border-radius:6px; background:#000; touch-action:none; max-width:100%; max-height:100%;"></canvas>
            </div>
            <div style="background:#1c1c1c; padding:10px 14px 16px;">
                <div id="ieAspects" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;"></div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                    <button id="ieRotL" style="${btn}">⟲</button>
                    <button id="ieRotR" style="${btn}">⟳</button>
                    <span style="font-size:12px; color:#aaa;">Ungli se hilao, do ungli se zoom karo</span>
                </div>
                <label style="font-size:12px; color:#aaa;">🔍 Zoom</label>
                <input id="ieZoom" type="range" min="100" max="400" value="100" style="width:100%; margin:2px 0 8px;">
                <label style="font-size:12px; color:#aaa;">☀️ Brightness</label>
                <input id="ieBright" type="range" min="60" max="140" value="100" style="width:100%; margin:2px 0 12px;">
                <button id="ieSave" style="width:100%; padding:13px; border:none; border-radius:10px; background:linear-gradient(180deg,#f7dfa5,#f0c14b); color:#111; font-weight:700; font-size:15px; cursor:pointer;">✅ Save karo & upload karo</button>
            </div>`;
        document.body.appendChild(ov);

        const stage = ov.querySelector('#ieStage');
        const canvas = ov.querySelector('#ieCanvas');
        const ctx = canvas.getContext('2d');
        const zoomEl = ov.querySelector('#ieZoom');
        const brightEl = ov.querySelector('#ieBright');
        const saveBtn = ov.querySelector('#ieSave');

        const rotDims = () => (rot % 2 === 0)
            ? { rw: img.naturalWidth, rh: img.naturalHeight }
            : { rw: img.naturalHeight, rh: img.naturalWidth };

        function draw(c, f, w, h) {
            const { rw, rh } = rotDims();
            const base = Math.max(w / rw, h / rh);
            const sc = base * zoom * f;
            c.save();
            c.fillStyle = '#fff';
            c.fillRect(0, 0, w * f, h * f);
            c.translate(w * f / 2 + offX * f, h * f / 2 + offY * f);
            c.rotate(rot * Math.PI / 2);
            c.scale(sc, sc);
            if ('filter' in c) c.filter = `brightness(${bright}%)`;
            c.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
            c.restore();
        }

        function clampOffsets() {
            const { rw, rh } = rotDims();
            const base = Math.max(W / rw, H / rh);
            const maxX = Math.max(0, (rw * base * zoom - W) / 2);
            const maxY = Math.max(0, (rh * base * zoom - H) / 2);
            offX = Math.min(maxX, Math.max(-maxX, offX));
            offY = Math.min(maxY, Math.max(-maxY, offY));
        }

        function render() {
            clampOffsets();
            ctx.clearRect(0, 0, W, H);
            draw(ctx, 1, W, H);
        }

        function layout() {
            const r = stage.getBoundingClientRect();
            const availW = Math.max(120, r.width - 20);
            const availH = Math.max(120, r.height - 12);
            const { rw, rh } = rotDims();
            const ar = ASPECTS[aspectKey] || (rw / rh);
            if (availW / ar <= availH) { W = Math.round(availW); H = Math.round(availW / ar); }
            else { H = Math.round(availH); W = Math.round(availH * ar); }
            canvas.width = W;
            canvas.height = H;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            offX = 0; offY = 0; zoom = 1; zoomEl.value = 100;
            render();
        }

        // ---- aspect buttons ----
        const aspectsBox = ov.querySelector('#ieAspects');
        const labels = { 'orig': 'Original', '1:1': '1:1 ▢', '4:3': '4:3', '3:4': '3:4', '16:9': '16:9' };
        function paintAspectButtons() {
            aspectsBox.innerHTML = '';
            Object.keys(labels).forEach(k => {
                const b = document.createElement('button');
                b.textContent = labels[k];
                b.style.cssText = btn + (k === aspectKey ? 'background:#f0c14b; color:#111; border-color:#f0c14b; font-weight:700;' : '');
                b.onclick = () => { aspectKey = k; paintAspectButtons(); layout(); };
                aspectsBox.appendChild(b);
            });
        }
        paintAspectButtons();

        ov.querySelector('#ieRotL').onclick = () => { rot = (rot + 3) % 4; layout(); };
        ov.querySelector('#ieRotR').onclick = () => { rot = (rot + 1) % 4; layout(); };
        zoomEl.oninput = () => { zoom = zoomEl.value / 100; render(); };
        brightEl.oninput = () => { bright = Number(brightEl.value); render(); };

        // ---- drag to pan, pinch to zoom, wheel to zoom ----
        const pointers = new Map();
        let lastDist = 0;
        canvas.addEventListener('pointerdown', e => {
            canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                lastDist = Math.hypot(a.x - b.x, a.y - b.y);
            }
        });
        canvas.addEventListener('pointermove', e => {
            if (!pointers.has(e.pointerId)) return;
            const prev = pointers.get(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 1) {
                offX += e.clientX - prev.x;
                offY += e.clientY - prev.y;
            } else if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                if (lastDist > 0) {
                    zoom = Math.min(4, Math.max(1, zoom * dist / lastDist));
                    zoomEl.value = Math.round(zoom * 100);
                }
                lastDist = dist;
            }
            render();
        });
        const endPointer = e => { pointers.delete(e.pointerId); lastDist = 0; };
        canvas.addEventListener('pointerup', endPointer);
        canvas.addEventListener('pointercancel', endPointer);
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            zoom = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 0.92)));
            zoomEl.value = Math.round(zoom * 100);
            render();
        }, { passive: false });

        function close(result) {
            window.removeEventListener('resize', layout);
            ov.remove();
            URL.revokeObjectURL(url);
            resolve(result);
        }

        ov.querySelector('#ieCancel').onclick = () => close(null);

        // ---- Save: crop + shrink + compress to a small JPEG ----
        saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Chhota kar rahe hain...';
            try {
                const { rw, rh } = rotDims();
                const base = Math.max(W / rw, H / rh);
                // Never output more pixels than the crop actually contains.
                const srcLong = Math.max(W, H) / (base * zoom);
                let long = Math.max(200, Math.min(maxDimension, Math.round(srcLong)));
                let best = null;
                for (let attempt = 0; attempt < 6 && !(best && best.size <= targetKB * 1024); attempt++) {
                    const f = long / Math.max(W, H);
                    const out = document.createElement('canvas');
                    out.width = Math.max(1, Math.round(W * f));
                    out.height = Math.max(1, Math.round(H * f));
                    draw(out.getContext('2d'), f, W, H);
                    for (const q of [quality, quality - 0.1, quality - 0.2, 0.5]) {
                        const blob = await canvasToBlob(out, Math.max(0.4, q));
                        if (blob && (!best || blob.size < best.size)) best = blob;
                        if (blob && blob.size <= targetKB * 1024) break;
                    }
                    long = Math.round(long * 0.8);
                    if (long < 300) break;
                }
                if (!best) throw new Error('Could not process the photo.');
                const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
                close(new File([best], name, { type: 'image/jpeg' }));
            } catch (err) {
                console.error(err);
                saveBtn.disabled = false;
                saveBtn.textContent = '✅ Save karo & upload karo';
                alert('Photo save nahi ho payi. Dobara try karo.');
            }
        };

        window.addEventListener('resize', layout);
        // Wait a frame so the stage has its real size before we lay out the canvas.
        requestAnimationFrame(layout);
    });
}

function formatKB(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

// Wires a hidden file input: when a photo is picked it opens the editor,
// then (after Save) uploads the small edited photo and fills the given
// url input with the hosted link.
// options: { aspect: 'orig'|'1:1'|'4:3'|'3:4'|'16:9', maxDimension, quality, targetKB }
export function wireImageUpload(fileInputId, urlInputId, statusElId, options = {}) {
    const fileInput = document.getElementById(fileInputId);
    const urlInput = document.getElementById(urlInputId);
    const statusEl = statusElId ? document.getElementById(statusElId) : null;
    if (!fileInput || !urlInput) return;

    const setStatus = (text, color) => { if (statusEl) { statusEl.innerText = text; statusEl.style.color = color || '#888'; } };

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        fileInput.value = ''; // lets the same photo be picked again later

        if (!file.type || !file.type.startsWith('image/')) {
            setStatus('❌ Please choose a photo', '#dc3545');
            return;
        }
        if (file.size > 25 * 1024 * 1024) {
            setStatus('❌ Photo too large (max 25MB)', '#dc3545');
            return;
        }

        const edited = await openImageEditor(file, options);
        if (!edited) { setStatus(''); return; } // user cancelled

        setStatus('⏳ Uploading...');
        try {
            const url = await uploadToImgBB(edited, { skipCompress: true });
            urlInput.value = url;
            setStatus(`✅ Photo uploaded! (${formatKB(file.size)} → ${formatKB(edited.size)})`, '#28a745');
        } catch (error) {
            console.error(error);
            setStatus('❌ ' + error.message, '#dc3545');
        }
    });
}
