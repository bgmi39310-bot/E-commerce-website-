// Serves every product/shop image at roughly the size it's actually going
// to be displayed at, instead of the browser downloading a full original
// (which could be several MB straight off someone's phone camera) just to
// shrink it down to a 130px thumbnail with CSS.
//
// Routes the image through images.weserv.nl, a free, no-API-key image
// resizing proxy: it fetches the original once, caches a resized/re-encoded
// (WebP) copy on its own CDN, and serves that from then on. This helps
// EVERY image already sitting in Firestore today too — sellers never need
// to re-upload anything for existing product photos to load faster.
//
// `width` should be roughly 2x the CSS display width, so the image still
// looks sharp on high-density (retina) phone screens.
export function resizedImageUrl(url, width) {
    if (!url || typeof url !== 'string') return url;
    // Already a local/placeholder image, or a data URL — nothing to proxy.
    if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('./')) return url;

    try {
        const bare = url.replace(/^https?:\/\//, '');
        return `https://images.weserv.nl/?url=${encodeURIComponent(bare)}&w=${width}&q=75&output=webp`;
    } catch {
        return url; // if anything about the URL is unexpected, just use it as-is
    }
}

