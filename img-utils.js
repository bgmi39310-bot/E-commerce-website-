// Serves every product/shop image at roughly the size it's actually going
// to be displayed at, instead of the browser downloading a full original
// (which could be several MB straight off someone's phone camera) just to
// shrink it down to a 130px thumbnail with CSS.
//
// Routes the image through wsrv.nl, a free, no-API-key image resizing
// proxy: it fetches the original once, caches a resized/re-encoded
// (WebP) copy on its own CDN, and serves that from then on. This helps
// EVERY image already sitting in Firestore today too — sellers never need
// to re-upload anything for existing product photos to load faster.
//
// NOTE: this used to point at images.weserv.nl (the same open-source
// project, same API — wsrv.nl is just its newer/shorter domain). Cloudflare
// changed its free-plan terms in November 2022 to disallow using it to
// serve mostly images/video, and images.weserv.nl got caught by that —
// since then it's been badly rate-limited industry-wide, which looked
// exactly like "the product photo just never loads". wsrv.nl is the same
// service and isn't affected, so this is a drop-in fix — nothing else about
// how this function is called needs to change.
//
// `width` should be roughly 2x the CSS display width, so the image still
// looks sharp on high-density (retina) phone screens.
export function resizedImageUrl(url, width) {
    if (!url || typeof url !== 'string') return url;
    // Already a local/placeholder image, or a data URL — nothing to proxy.
    if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('./')) return url;

    try {
        const bare = url.replace(/^https?:\/\//, '');
        return `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=${width}&q=75&output=webp`;
    } catch {
        return url; // if anything about the URL is unexpected, just use it as-is
    }
}

