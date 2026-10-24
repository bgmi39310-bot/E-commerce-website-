// DesiMarket welcome splash - a short greeting-card animation shown ONLY when
// the site is opened (or the homepage is reloaded). It covers the screen while
// the homepage loads its shops and products in the background, so by the time
// the animation finishes the site is already filled in and ready.
//
// - Runs only on the homepage (index.html). On every other page this file does
//   nothing, so the other pages open exactly as before.
// - Not shown again when you come BACK to the homepage from another page of
//   the site, or with the browser's back button - only on opening the site
//   or reloading the homepage.
// - Stays for at least ~2.6 seconds so the animation plays properly, then
//   leaves as soon as the homepage products have appeared. A safety timer
//   (8 seconds) guarantees it can never get stuck. Tapping "Skip" closes it
//   early.
// Loaded as a plain (non-module) script at the very top of <head>.
(function () {
    if (window.__dmWelcomeInit) return;
    window.__dmWelcomeInit = true;

    // ---- only on the homepage ------------------------------------------
    var last = location.pathname.substring(location.pathname.lastIndexOf('/') + 1);
    if (last !== '' && last !== 'index.html') return;

    // ---- only when the site is opened / the homepage is reloaded --------
    var navType = 'navigate';
    try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.type) navType = nav.type;
    } catch (e) { /* older browsers: treat as a fresh open */ }
    if (navType === 'back_forward') return;
    var cameFromInside = false;
    try {
        cameFromInside = !!document.referrer && new URL(document.referrer).origin === location.origin;
    } catch (e) { /* ignore */ }
    if (navType === 'navigate' && cameFromInside) return;

    var reduceMotion = false;
    try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }

    var MIN_MS = reduceMotion ? 1200 : 2600;
    var MAX_MS = 8000;

    // ---- greeting by time of day ---------------------------------------
    var h = new Date().getHours();
    var greet = h >= 5 && h < 12 ? 'Suprabhat' : h >= 12 && h < 17 ? 'Namaste' : h >= 17 && h < 21 ? 'Shubh Sandhya' : 'Shubh Ratri';
    var greetIcon = h >= 5 && h < 12 ? '\u2600\ufe0f' : h >= 12 && h < 17 ? '\ud83d\ude4f' : h >= 17 && h < 21 ? '\ud83c\udf07' : '\ud83c\udf19';

    // ---- styles ---------------------------------------------------------
    var css =
        '#dmw{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:hidden;' +
        'background:radial-gradient(circle at 50% 30%,#2f4157 0%,#232f3e 45%,#141c26 100%);' +
        'display:flex;align-items:center;justify-content:center;flex-direction:column;' +
        'font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;touch-action:none;' +
        '-webkit-tap-highlight-color:transparent;opacity:1;transition:opacity .55s ease,transform .55s ease}' +
        '#dmw.dmw-out{opacity:0;transform:scale(1.06);pointer-events:none}' +
        '#dmw .dmw-glow{position:absolute;width:420px;height:420px;border-radius:50%;top:50%;left:50%;' +
        'margin:-250px 0 0 -210px;background:radial-gradient(circle,rgba(255,153,0,.28),rgba(255,153,0,0) 65%);' +
        'animation:dmwBreath 3.2s ease-in-out infinite}' +
        '#dmw .dmw-dot{position:absolute;bottom:-14px;border-radius:50%;background:rgba(255,200,120,.55);' +
        'animation:dmwRise linear infinite}' +
        '#dmw .dmw-conf{position:absolute;top:-16px;width:8px;height:12px;border-radius:2px;opacity:0;' +
        'animation:dmwFall ease-in forwards}' +
        '#dmw .dmw-skip{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:14px;z-index:5;' +
        'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);color:#fff;border-radius:20px;' +
        'padding:6px 14px;font-size:13px;opacity:0;animation:dmwFade .4s ease 1s forwards;cursor:pointer}' +
        '#dmw .dmw-stack{position:relative;width:min(78vw,300px);height:290px;margin-bottom:18px}' +
        '#dmw *{box-sizing:border-box}' +
        '#dmw .dmw-card{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:24px;' +
        'box-shadow:0 20px 50px rgba(0,0,0,.45);opacity:0}' +
        '#dmw .dmw-c1{background:linear-gradient(145deg,#ff9900,#ffb84d);animation:dmwCardA .9s cubic-bezier(.2,1.3,.4,1) .15s forwards}' +
        '#dmw .dmw-c2{background:linear-gradient(145deg,#2e9e5b,#5cc487);animation:dmwCardB .9s cubic-bezier(.2,1.3,.4,1) .3s forwards}' +
        '#dmw .dmw-main{background:#fff;color:#232f3e;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;text-align:center;padding:18px;animation:dmwMain 1s cubic-bezier(.2,1.25,.4,1) .45s forwards}' +
        '#dmw .dmw-hand{font-size:58px;line-height:1;display:inline-block;transform-origin:70% 80%;animation:dmwWave 1.6s ease-in-out 1.2s 2}' +
        '#dmw .dmw-greet{font-size:30px;font-weight:800;margin:10px 0 2px;letter-spacing:-.5px;opacity:0;animation:dmwUp .6s ease .9s forwards}' +
        '#dmw .dmw-wel{font-size:15px;color:#555;opacity:0;animation:dmwUp .6s ease 1.05s forwards}' +
        '#dmw .dmw-brand{font-size:30px;font-weight:800;letter-spacing:-.5px;margin-top:6px;opacity:0;animation:dmwUp .6s ease 1.2s forwards}' +
        '#dmw .dmw-brand span{color:#ff9900}' +
        '#dmw .dmw-tag{margin-top:8px;font-size:12.5px;font-weight:600;color:#2e9e5b;letter-spacing:.4px;opacity:0;animation:dmwUp .6s ease 1.4s forwards}' +
        '#dmw .dmw-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:340px;padding:0 14px}' +
        '#dmw .dmw-chip{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);border-radius:20px;' +
        'padding:7px 12px;font-size:12.5px;opacity:0;transform:translateY(14px) scale(.9);animation:dmwChip .5s ease forwards,dmwFloat 3s ease-in-out infinite}' +
        '#dmw .dmw-load{position:relative;width:min(70vw,230px);height:4px;margin-top:22px;border-radius:4px;background:rgba(255,255,255,.16);overflow:hidden}' +
        '#dmw .dmw-load i{position:absolute;left:0;top:0;height:100%;width:0;border-radius:4px;' +
        'background:linear-gradient(90deg,#ff9900,#ffd27a);transition:width .5s ease}' +
        '#dmw .dmw-msg{margin-top:9px;font-size:12px;color:rgba(255,255,255,.7);min-height:16px}' +
        '@keyframes dmwCardA{0%{opacity:0;transform:translateY(60px) rotate(0) scale(.7)}100%{opacity:1;transform:translateY(0) rotate(-7deg) scale(1)}}' +
        '@keyframes dmwCardB{0%{opacity:0;transform:translateY(60px) rotate(0) scale(.7)}100%{opacity:1;transform:translateY(0) rotate(6deg) scale(1)}}' +
        '@keyframes dmwMain{0%{opacity:0;transform:translateY(70px) scale(.7) rotate(4deg)}100%{opacity:1;transform:translateY(0) scale(1) rotate(0)}}' +
        '@keyframes dmwUp{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}}' +
        '@keyframes dmwWave{0%,100%{transform:rotate(0)}15%{transform:rotate(16deg)}30%{transform:rotate(-10deg)}45%{transform:rotate(14deg)}60%{transform:rotate(-6deg)}75%{transform:rotate(0)}}' +
        '@keyframes dmwChip{0%{opacity:0;transform:translateY(14px) scale(.9)}100%{opacity:1;transform:translateY(0) scale(1)}}' +
        '@keyframes dmwFloat{0%,100%{margin-top:0}50%{margin-top:-4px}}' +
        '@keyframes dmwBreath{0%,100%{transform:scale(.92);opacity:.8}50%{transform:scale(1.08);opacity:1}}' +
        '@keyframes dmwRise{0%{transform:translateY(0);opacity:0}15%{opacity:.9}100%{transform:translateY(-105vh);opacity:0}}' +
        '@keyframes dmwFall{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(105vh) rotate(540deg)}}' +
        '@keyframes dmwFade{to{opacity:1}}' +
        '@media (prefers-reduced-motion:reduce){#dmw *{animation-duration:.01s!important;animation-delay:0s!important;animation-iteration-count:1!important}}' +
        '@media (max-height:640px){#dmw .dmw-stack{height:230px}#dmw .dmw-hand{font-size:44px}#dmw .dmw-greet,#dmw .dmw-brand{font-size:24px}}';

    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    // ---- markup ---------------------------------------------------------
    var el = document.createElement('div');
    el.id = 'dmw';
    el.setAttribute('role', 'presentation');
    var chips = ['\ud83d\udecd\ufe0f Local Shops', '\ud83d\ude9a Doorstep Delivery', '\ud83d\udcb8 UPI & COD', '\u2b50 Trusted Sellers'];
    var chipHtml = '';
    for (var c = 0; c < chips.length; c++) {
        chipHtml += '<div class="dmw-chip" style="animation-delay:' + (1.5 + c * 0.18) + 's,' + (2.2 + c * 0.3) + 's">' + chips[c] + '</div>';
    }
    el.innerHTML =
        '<div class="dmw-glow"></div>' +
        '<button class="dmw-skip" type="button">Skip \u203a</button>' +
        '<div class="dmw-stack">' +
            '<div class="dmw-card dmw-c1"></div>' +
            '<div class="dmw-card dmw-c2"></div>' +
            '<div class="dmw-card dmw-main">' +
                '<div class="dmw-hand">' + greetIcon + '</div>' +
                '<div class="dmw-greet">' + greet + '!</div>' +
                '<div class="dmw-wel">Aapka swagat hai</div>' +
                '<div class="dmw-brand">Desi<span>Market</span></div>' +
                '<div class="dmw-tag">VOCAL FOR LOCAL \ud83c\uddee\ud83c\uddf3</div>' +
            '</div>' +
        '</div>' +
        '<div class="dmw-chips">' + chipHtml + '</div>' +
        '<div class="dmw-load"><i></i></div>' +
        '<div class="dmw-msg">Aapki dukaan taiyar ho rahi hai...</div>';

    // floating dots + a one-time confetti burst
    var colors = ['#ff9900', '#ffd27a', '#2e9e5b', '#ffffff', '#e8505b'];
    if (!reduceMotion) {
        for (var d = 0; d < 14; d++) {
            var dot = document.createElement('i');
            dot.className = 'dmw-dot';
            var sz = 4 + Math.random() * 7;
            dot.style.cssText = 'left:' + (Math.random() * 100) + '%;width:' + sz + 'px;height:' + sz + 'px;' +
                'animation-duration:' + (4 + Math.random() * 4) + 's;animation-delay:' + (Math.random() * 3) + 's';
            el.appendChild(dot);
        }
        for (var k = 0; k < 26; k++) {
            var cf = document.createElement('i');
            cf.className = 'dmw-conf';
            cf.style.cssText = 'left:' + (Math.random() * 100) + '%;background:' + colors[k % colors.length] + ';' +
                'animation-duration:' + (1.8 + Math.random() * 1.6) + 's;animation-delay:' + (0.5 + Math.random() * 1.2) + 's';
            el.appendChild(cf);
        }
    }
    // <body> doesn't exist yet this early, so attach to <html>; position:fixed makes that fine.
    document.documentElement.appendChild(el);

    var bar = el.querySelector('.dmw-load i');
    var msg = el.querySelector('.dmw-msg');
    var startedAt = Date.now();
    var closed = false;

    // Progress bar: creeps forward while loading, jumps to 100% when ready.
    var pct = 8;
    bar.style.width = pct + '%';
    var creep = setInterval(function () {
        pct = Math.min(90, pct + (90 - pct) * 0.12);
        bar.style.width = pct + '%';
    }, 350);

    function close() {
        if (closed) return;
        closed = true;
        clearInterval(creep);
        clearInterval(poll);
        clearTimeout(maxTimer);
        bar.style.width = '100%';
        msg.textContent = 'Taiyar hai! \ud83c\udf89';
        setTimeout(function () {
            el.classList.add('dmw-out');
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 650);
        }, 250);
    }

    // The homepage is "ready" once the page has loaded and the product grid
    // no longer shows its grey skeleton placeholders (real products, or the
    // "no products" / error message, have replaced them).
    function homeReady() {
        if (document.readyState !== 'complete') return false;
        var grid = document.getElementById('productGrid');
        if (!grid) return true;
        return !grid.querySelector('.skel-card');
    }

    var poll = setInterval(function () {
        if (Date.now() - startedAt >= MIN_MS && homeReady()) close();
    }, 150);
    var maxTimer = setTimeout(close, MAX_MS);

    el.querySelector('.dmw-skip').addEventListener('click', close);
    // Never leave it stuck if the user comes back from another app/tab.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && Date.now() - startedAt > MAX_MS) close();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) close(); });
})();
