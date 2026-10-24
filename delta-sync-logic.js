import { collection, query, where, orderBy, limit, getDocs, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ============================================================================
// Shared delta-sync for "my own growing history" screens — buyer's My
// Orders, seller dashboard orders, and a seller's own product list. All
// three used to hold a LIVE Firestore listener on the visitor's entire
// history with no limit, which re-read every order/product they'd EVER
// had every single time the page loaded (and again on every change while
// the tab stayed open) — for an active seller with hundreds of past
// orders, that's hundreds of reads just to open the dashboard.
//
// This fetches the FULL list once (capped, newest-first), caches it in
// localStorage, and on every later visit only asks Firestore for
// documents with `updatedAt` newer than the last sync — which is cheap
// regardless of how much history has piled up, since it only touches
// what actually changed. The old live-update feel (seeing a status change
// appear without refreshing) is gone; a page reload is what triggers a
// resync now, same trade-off made for the notification bell and
// reviews/Q&A lazy-loading earlier.
//
// WHY THIS WORKS: every write that touches an order or product now also
// sets `updatedAt: serverTimestamp()` (see order-logic.js, delivery-logic.js,
// return-logic.js, product-logic.js, bulk-upload-logic.js, stock-logic.js,
// review-logic.js, and the backend's payments.py) — without that on EVERY
// write, a changed document just wouldn't show up in the next delta fetch.
// ============================================================================

const FIRST_SYNC_LIMIT = 300; // generous cap for the one-time first full fetch

// IMPORTANT CAVEAT this TTL exists for: a delta fetch only ever learns about
// documents that CHANGED since the last sync — a DELETED document doesn't
// show up as a "change", it just silently stops appearing in query results.
// So a deleted order/product would keep appearing in the cached list
// forever, through delta syncs alone. Orders are never actually deleted
// (see firestore.rules: `allow delete: if false`), so this only matters for
// products — deleteProduct() in product-logic.js calls removeFromCache()
// below for the immediate/common case (a seller deleting their own
// listing), but a product could also be removed by an admin from a
// DIFFERENT session, which that seller's own cache wouldn't know about.
// This TTL is the backstop for that: once a cache is older than this, it's
// treated as gone and a full resync happens, which can only ever return
// documents that genuinely still exist — quietly correcting any drift.
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// "v2": bumping this version throws away every old saved list once. Older
// versions used the phone's clock as the sync watermark, which could make a
// document created by the server (e.g. a new product) look "older" than the
// watermark and be skipped forever — so lists could be missing items. A
// fresh full sync fixes any list that was already affected.
function cacheKeyFor(storageKey) {
    return `deltaSync:v2:${storageKey}`;
}

// The cache is saved as JSON, and JSON.stringify turns a Firestore Timestamp
// into a plain { seconds, nanoseconds } object — which has NO .toDate() or
// .toMillis() any more. Pages like My Orders call order.deliveredAt.toDate()
// (to decide if the return window is still open) and createdAt.toDate()
// (to show the order date), so on every visit after the first, those values
// silently stopped working: no return button, no date. This turns the plain
// objects back into real Timestamps when the cache is read.
function reviveTimestamps(value) {
    if (Array.isArray(value)) return value.map(reviveTimestamps);
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number' &&
            keys.every(k => k === 'seconds' || k === 'nanoseconds' || k === 'type')) {
            return new Timestamp(value.seconds, value.nanoseconds);
        }
        const out = {};
        for (const k of keys) out[k] = reviveTimestamps(value[k]);
        return out;
    }
    return value;
}

function loadCache(storageKey) {
    try {
        const raw = localStorage.getItem(cacheKeyFor(storageKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.items) || !parsed.lastSync) return null;
        parsed.items = reviveTimestamps(parsed.items);
        return parsed;
    } catch {
        return null; // corrupt/unreadable cache — treat as no cache, just resync fully
    }
}

function saveCache(storageKey, items, lastSync) {
    try {
        localStorage.setItem(cacheKeyFor(storageKey), JSON.stringify({ items, lastSync }));
    } catch (e) {
        // Storage full/unavailable (e.g. private browsing) — not fatal, the
        // next call just falls back to a full resync instead of a delta one.
        console.error('delta-sync: could not write cache', e);
    }
}

/**
 * @param db            Firestore instance
 * @param collectionPath  e.g. "orders" or "vendors"
 * @param whereField      the ownership field, e.g. "sellerUid" or "buyerUid"
 * @param whereValue      the current user's uid
 * @param storageKey      a name unique to this screen+user, e.g. `orders:seller:${uid}`
 * @returns the full merged list (existing cached items + whatever changed), newest-updated first
 */
export async function deltaSync(db, { collectionPath, whereField, whereValue, storageKey }) {
    if (!whereValue) return [];

    let cached = loadCache(storageKey);
    if (cached && (Date.now() - new Date(cached.lastSync).getTime()) > MAX_CACHE_AGE_MS) {
        cached = null; // stale beyond the deletion-safety window — do a full resync instead of a delta one
    }
    const itemsById = new Map((cached ? cached.items : []).map(item => [item.id, item]));
    const base = collection(db, collectionPath);
    const syncStartedAt = new Date();

    let snap;
    if (cached) {
        // Delta fetch: only documents touched since the last sync.
        // Look back 5 minutes before the watermark as a safety margin: the
        // watermark is the phone's clock, while updatedAt is the server's. If
        // the phone's clock runs ahead, a change made just now could look
        // "older" than the watermark and be missed. Re-fetching a few extra
        // recent documents is cheap, and they just overwrite by id.
        const lastSyncDate = new Date(new Date(cached.lastSync).getTime() - 5 * 60 * 1000);
        snap = await getDocs(query(
            base,
            where(whereField, '==', whereValue),
            where('updatedAt', '>', lastSyncDate),
            orderBy('updatedAt', 'asc')
        ));
    } else {
        // First-ever sync for this screen+user: one bounded full fetch to seed the cache.
        snap = await getDocs(query(
            base,
            where(whereField, '==', whereValue),
            orderBy('updatedAt', 'desc'),
            limit(FIRST_SYNC_LIMIT)
        ));
    }

    snap.forEach(d => {
        itemsById.set(d.id, { id: d.id, ...d.data() });
    });

    const items = Array.from(itemsById.values()).sort((a, b) => {
        const aTime = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0;
        const bTime = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0;
        return bTime - aTime; // newest-updated first
    });

    // Using the time the sync STARTED (not finished) as the new watermark is
    // deliberate: it means a document written mid-fetch is simply picked up
    // again on the NEXT sync rather than possibly being missed — a little
    // redundancy is fine, missing an update silently is not.
    // The watermark comes from the documents' OWN server timestamps (the
    // newest updatedAt we've seen), not from the phone's clock — so a phone
    // whose clock is a few minutes off can never cause changes to be missed.
    let maxMs = 0;
    for (const item of items) {
        const ms = item.updatedAt && item.updatedAt.toMillis ? item.updatedAt.toMillis() : 0;
        if (ms > maxMs) maxMs = ms;
    }
    const watermark = maxMs > 0
        ? new Date(maxMs)
        : (cached ? new Date(cached.lastSync) : new Date(0));
    saveCache(storageKey, items, watermark.toISOString());

    return items;
}

/** Clears a screen's cached delta-sync state — call this if data ever looks
 *  wrong/stuck and a full resync is wanted (e.g. a "Refresh" button). */
export function clearDeltaSyncCache(storageKey) {
    try {
        localStorage.removeItem(cacheKeyFor(storageKey));
    } catch { /* ignore */ }
}

/** Merges changes into ONE cached item right after a successful write, so
 *  the next page load shows the new state straight away. */
export function updateInDeltaSyncCache(storageKey, id, changes) {
    const cached = loadCache(storageKey);
    if (!cached) return;
    saveCache(storageKey, cached.items.map(item => item.id === id ? { ...item, ...changes } : item), cached.lastSync);
}

/** Removes ONE item from a screen's cached list immediately — call this
 *  right after successfully deleting something, since delta-sync alone has
 *  no way to learn about a deletion until the TTL eventually forces a full
 *  resync (see MAX_CACHE_AGE_MS above). */
export function removeFromDeltaSyncCache(storageKey, id) {
    const cached = loadCache(storageKey);
    if (!cached) return;
    saveCache(storageKey, cached.items.filter(item => item.id !== id), cached.lastSync);
}
