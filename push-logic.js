// Phone/browser push notifications.
//
// When a buyer or seller turns this on, their device gets a notification
// (new order, order accepted, low stock...) even when the website is closed.
//
// ONE-TIME SETUP (the site owner does this once, see the instructions):
//   Firebase console -> Project settings -> Cloud Messaging -> "Web Push
//   certificates" -> Generate key pair -> paste the PUBLIC key below.
// While VAPID_PUBLIC_KEY is empty the feature stays switched off and the
// "Notification chalu karo" buttons are hidden.
import { firebaseApp, auth } from './firebase-config.js';
import { BACKEND_BASE_URL } from './order-api.js';
import { showToast } from './toast.js';

export const VAPID_PUBLIC_KEY = '';

export function isPushConfigured() {
    return !!VAPID_PUBLIC_KEY;
}

export function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushAlreadyOn() {
    return isPushSupported() && Notification.permission === 'granted' && localStorage.getItem('dm_push_on') === '1';
}

export async function enablePush() {
    if (!isPushConfigured()) {
        showToast('Notification abhi set nahi hue. Site ke admin ko ek baar setup karna hoga.', 'error');
        return false;
    }
    if (!isPushSupported()) {
        showToast('Is browser me notification nahi chalte. Chrome use karke dekhiye.', 'error');
        return false;
    }
    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
        showToast('Notification ke liye pehle login kijiye.', 'error');
        return false;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast('Notification ki ijazat nahi mili. Browser settings me allow kijiye.', 'error');
            return false;
        }

        const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js");
        const registration = await navigator.serviceWorker.ready;
        const token = await getToken(getMessaging(firebaseApp), {
            vapidKey: VAPID_PUBLIC_KEY,
            serviceWorkerRegistration: registration
        });
        if (!token) throw new Error('No token received');

        const idToken = await user.getIdToken();
        const res = await fetch(`${BACKEND_BASE_URL}/api/push/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ token })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Could not save the notification setting.');
        }
        localStorage.setItem('dm_push_on', '1');
        showToast('🔔 Notification chalu ho gaye!');
        return true;
    } catch (e) {
        console.error('Enable push failed:', e);
        showToast('Notification chalu nahi ho paye. Dobara try kijiye.', 'error');
        return false;
    }
}

// Shows/hides a "Notification chalu karo" menu item depending on whether the
// feature is set up, supported and not already on.
export function setupPushMenuItem(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (!isPushConfigured() || !isPushSupported() || pushAlreadyOn()) {
        el.style.display = 'none';
        return;
    }
    el.style.display = '';
    el.addEventListener('click', async () => {
        const ok = await enablePush();
        if (ok) el.style.display = 'none';
    });
}
