// Registers the DesiMarket service worker so the site becomes installable
// and gets basic offline app-shell support. Include this on any page with:
// <script src="pwa-init.js" defer></script>
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.log('Service worker registration failed:', err);
        });
    });
}

