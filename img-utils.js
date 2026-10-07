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
    if (!url || typeof url !== 'string') return NO_IMAGE_PLACEHOLDER;
    // Already a local/placeholder image, or a data URL — nothing to proxy.
    if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('./')) return url;

    try {
        const bare = url.replace(/^https?:\/\//, '');
        return `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=${width}&q=75&output=webp`;
    } catch {
        return url; // if anything about the URL is unexpected, just use it as-is
    }
}

// A plain "no image" box, as a data: URI — this loads with ZERO network
// requests, so it can never be the slow/rate-limited/down third party that
// images.weserv.nl turned out to be (see the note above). Used everywhere
// an <img> needs a fallback: as the initial src when there's no image URL
// at all (see above), and as the onerror target when a real image URL
// fails to load. No single or double quotes inside it on purpose, so it's
// safe to drop into either onerror="this.src='...'" or src="...".
export const NO_IMAGE_PLACEHOLDER =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"%3E' +
    '%3Crect width="200" height="200" fill="%23f0f0f0"/%3E' +
    '%3Ctext x="50%25" y="50%25" font-family="sans-serif" font-size="16" fill="%23999" text-anchor="middle" dy=".3em"%3ENo Image%3C/text%3E' +
    '%3C/svg%3E';

