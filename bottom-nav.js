// DesiMarket bottom navigation (mobile). One consistent 5-tab bar on the main pages so the
// big features are always one tap away:  Home · Bazaar · Khata · Orders · Sab (all services).
// Self-contained: injects its own CSS + markup, highlights the current tab, hides on desktop.
// Add to a page with:  <script src="bottom-nav.js" defer></script>
(function () {
    if (window.__dmBottomNav) return;
    window.__dmBottomNav = true;
    var path = location.pathname.substring(location.pathname.lastIndexOf('/') + 1) || 'index.html';
    var TABS = [
        { href: 'index.html',   icon: '🏠', label: 'Home',   match: ['index.html', 'product.html', 'shop.html', 'cart.html', 'checkout.html', 'wishlist.html'] },
        { href: 'bazaar.html',  icon: '🌾', label: 'Bazaar', match: ['bazaar.html'] },
        { href: 'khata.html',   icon: '📒', label: 'Khata',  match: ['khata.html', 'khata-view.html'] },
        { href: 'orders.html',  icon: '📦', label: 'Orders', match: ['orders.html', 'subscriptions.html', 'messages.html', 'chat.html'] },
        { href: 'suvidha.html', icon: '⠿',  label: 'Sab',    match: ['suvidha.html', 'account.html', 'addresses.html'] },
    ];
    var css = '#dmNav{position:fixed;left:0;right:0;bottom:0;z-index:400;display:flex;background:#fff;border-top:1px solid #e3e9ed;box-shadow:0 -4px 18px rgba(23,33,43,.10);padding-bottom:env(safe-area-inset-bottom,0px);font-family:inherit}' +
        '#dmNav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 2px 6px;text-decoration:none;color:#7a8791;font-size:11px;font-weight:700;-webkit-tap-highlight-color:transparent;position:relative}' +
        '#dmNav a .i{font-size:21px;line-height:1;filter:grayscale(.9);opacity:.75;transition:transform .15s}' +
        '#dmNav a.on{color:#0e6f7a}#dmNav a.on .i{filter:none;opacity:1;transform:translateY(-2px) scale(1.12)}' +
        '#dmNav a.on::before{content:"";position:absolute;top:0;left:30%;right:30%;height:3px;border-radius:0 0 4px 4px;background:#ff9900}' +
        '@media (min-width:900px){#dmNav{display:none}}';
    function mount() {
        if (document.getElementById('dmNav')) return;
        var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
        var nav = document.createElement('nav'); nav.id = 'dmNav'; nav.setAttribute('aria-label', 'Main');
        nav.innerHTML = TABS.map(function (t) {
            var on = t.match.indexOf(path) !== -1;
            return '<a href="' + t.href + '"' + (on ? ' class="on" aria-current="page"' : '') + '><span class="i">' + t.icon + '</span>' + t.label + '</a>';
        }).join('');
        document.body.appendChild(nav);
        if (window.innerWidth < 900) document.body.style.paddingBottom = '72px';
    }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
