// ============================================================================
// DesiMarket — global double-click / double-tap guard.
//
// Problem this solves: on a slow connection (or just an eager tap), buttons
// like "Buy Now", "Ask Seller", "Follow", "Send", "Submit Review" etc. could
// be pressed several times before the first click's request finished,
// firing multiple duplicate orders/messages/follows.
//
// Fix: this script runs in the CAPTURE phase (before any button's own
// onclick handler fires) and briefly "locks" whichever element was just
// clicked. Any further click on that *same* element within the lock window
// is silently swallowed. Other buttons on the page are unaffected, so this
// never blocks normal navigation — only rapid repeat-clicks on one button.
//
// Drop this one script tag into every page (already done across the site)
// and every button/onclick element on that page is automatically protected
// — no per-button code changes needed.
// ============================================================================
(function () {
    const LOCK_MS = 1200; // long enough to cover a typical Firestore round-trip

    document.addEventListener('click', function (e) {
        const target = e.target.closest('button, [onclick], .dash-action-btn, .follow-btn, .s-follow-btn');
        if (!target) return;

        if (target.dataset.dmLocked === '1') {
            e.stopImmediatePropagation();
            e.preventDefault();
            return;
        }

        target.dataset.dmLocked = '1';
        // Visual feedback that the tap registered, without a jarring popup.
        const originalOpacity = target.style.opacity;
        target.style.opacity = '0.6';

        setTimeout(function () {
            target.dataset.dmLocked = '0';
            target.style.opacity = originalOpacity || '';
        }, LOCK_MS);
    }, true); // capture: runs before the element's own onclick
})();
