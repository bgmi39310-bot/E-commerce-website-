// ============================================================================
// DesiMarket — lightweight toast notifications.
//
// Replaces native alert() popups (which block the whole page and force an
// "OK" click) with a small, nice-looking message that slides in from the
// bottom, stays for a couple of seconds, then fades away on its own.
//
// Usage from any page/module:
//   import { showToast } from './toast.js';
//   showToast('Your question has been sent to the seller!');
//   showToast('Please type a message first.', 'error');
// ============================================================================

let containerEl = null;

function ensureContainer() {
    if (containerEl && document.body.contains(containerEl)) return containerEl;
    containerEl = document.createElement('div');
    containerEl.id = 'dmToastContainer';
    containerEl.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        z-index: 99999; display: flex; flex-direction: column; gap: 8px;
        align-items: center; pointer-events: none; width: 100%; padding: 0 16px;
        box-sizing: border-box;
    `;
    document.body.appendChild(containerEl);
    return containerEl;
}

const TYPE_STYLE = {
    success: { bg: '#232f3e', icon: '✅' },
    error: { bg: '#c0392b', icon: '⚠️' },
    info: { bg: '#232f3e', icon: 'ℹ️' }
};

export function showToast(message, type = 'success', durationMs = 2600) {
    const container = ensureContainer();
    const style = TYPE_STYLE[type] || TYPE_STYLE.success;

    const toast = document.createElement('div');
    toast.style.cssText = `
        background: ${style.bg}; color: white; padding: 12px 18px; border-radius: 999px;
        font-size: 13.5px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,0.28);
        display: flex; align-items: center; gap: 8px; max-width: 100%;
        opacity: 0; transform: translateY(12px); transition: opacity 0.22s ease, transform 0.22s ease;
        pointer-events: auto;
    `;
    toast.innerHTML = `<span>${style.icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    const remove = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(12px)';
        setTimeout(() => toast.remove(), 220);
    };

    toast.addEventListener('click', remove); // tap to dismiss early, no forced "OK"
    setTimeout(remove, durationMs);
}
