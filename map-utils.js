// Free map helpers built on Leaflet.js + OpenStreetMap tiles — deliberately
// NOT Google Maps. Google Maps Platform now requires a credit card on file
// and bills per-request past small monthly free limits (the old universal
// $200/month credit was retired in March 2025). OpenStreetMap tiles and
// Leaflet need no API key, no billing account, and no card — the only
// requirement is showing the standard attribution, which every map below
// already includes.
//
// This module is loaded as a plain <script> (not an ES module) via
// loadMapLibrary(), because Leaflet itself is a classic (non-module)
// script that attaches a global `L`.

let _leafletLoadPromise = null;

// Injects Leaflet's CSS + JS from cdnjs once per page, and resolves once
// the global `L` is ready to use. Safe to call multiple times — later
// calls just reuse the same in-flight/completed load.
export function loadMapLibrary() {
    if (_leafletLoadPromise) return _leafletLoadPromise;

    _leafletLoadPromise = new Promise((resolve, reject) => {
        if (window.L) { resolve(window.L); return; }

        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
        document.head.appendChild(cssLink);

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
        script.onload = () => resolve(window.L);
        script.onerror = () => reject(new Error('Could not load the map library. Please check your connection and try again.'));
        document.head.appendChild(script);
    });

    return _leafletLoadPromise;
}

const DEFAULT_CENTER = [22.9734, 78.6569]; // roughly the geographic centre of India
const DEFAULT_ZOOM = 5;

function addBaseLayers(L, map) {
    const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });
    // Free, no API key needed — Esri's World Imagery satellite basemap.
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics'
    });

    // Satellite is the DEFAULT view: in villages and rural areas,
    // OpenStreetMap's street map is often sparse (few roads or buildings
    // actually mapped by anyone yet), which makes it hard to tell where
    // your own house actually is. An aerial photo shows the real rooftop
    // regardless of how well-mapped an area is on OSM — a much clearer
    // starting point for pinning "this is my house". Street Map is one tap
    // away via the layer switcher (top-right) if that's more useful for a
    // given area.
    satelliteLayer.addTo(map);
    L.control.layers(
        { '🛰️ Satellite': satelliteLayer, '🗺️ Street Map': streetLayer },
        null,
        { position: 'topright', collapsed: true }
    ).addTo(map);
}

// Interactive picker: shows a map the person can click/drag a pin on to
// choose a location. Calls onPick({lat, lng}) every time the pin moves.
// If initialLat/initialLng are given, starts zoomed in there with a pin
// already placed; otherwise starts zoomed out on India with no pin until
// the person clicks (or uses "Use my current location").
export async function initPickerMap(containerId, onPick, initialLat, initialLng) {
    const L = await loadMapLibrary();
    const hasInitial = typeof initialLat === 'number' && typeof initialLng === 'number';
    const center = hasInitial ? [initialLat, initialLng] : DEFAULT_CENTER;
    // Zoomed in close (18) whenever there's an actual point to show, so
    // individual rooftops are distinguishable on the satellite layer —
    // rather than a wide view where every house in the village looks the same.
    const zoom = hasInitial ? 18 : DEFAULT_ZOOM;

    const map = L.map(containerId).setView(center, zoom);
    addBaseLayers(L, map);

    let marker = hasInitial ? L.marker(center, { draggable: true }).addTo(map) : null;

    function placeMarker(latlng) {
        if (marker) {
            marker.setLatLng(latlng);
        } else {
            marker = L.marker(latlng, { draggable: true }).addTo(map);
            marker.on('dragend', () => onPick(marker.getLatLng()));
        }
        onPick(latlng);
    }

    map.on('click', (e) => placeMarker(e.latlng));
    if (marker) marker.on('dragend', () => onPick(marker.getLatLng()));

    return {
        map,
        useCurrentLocation() {
            if (!navigator.geolocation) return Promise.reject(new Error('Geolocation is not available on this device/browser.'));
            return new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                        map.setView(latlng, 18);
                        placeMarker(latlng);
                        resolve(latlng);
                    },
                    (err) => reject(err),
                    { enableHighAccuracy: true, timeout: 10000 }
                );
            });
        },
        // Moves the view + pin to a new spot without recreating the map —
        // used when the SAME picker (e.g. one modal reused for every
        // address) is opened again for a different existing address, or
        // reset for "Add New".
        setPosition(lat, lng) {
            if (typeof lat !== 'number' || typeof lng !== 'number') return;
            map.setView([lat, lng], 18);
            placeMarker({ lat, lng });
        },
        // Removes the pin and re-centers on India — used when reopening a
        // reused picker for "Add New" (no location picked yet).
        clear() {
            if (marker) { map.removeLayer(marker); marker = null; }
            map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        },
        // Needed because Leaflet sizes its canvas based on the container's
        // size AT CREATION TIME — if the map starts inside a hidden/collapsed
        // section (a modal, a details toggle, etc.) it renders broken until
        // told to recalculate once it's actually visible.
        invalidateSize() { map.invalidateSize(); }
    };
}

// Static, non-interactive map with a single pin — for showing a shop's or
// address's location without letting it be moved.
export async function initViewMap(containerId, lat, lng, popupText) {
    const L = await loadMapLibrary();
    const map = L.map(containerId, { zoomControl: true, dragging: true, scrollWheelZoom: false }).setView([lat, lng], 17);
    addBaseLayers(L, map);
    const marker = L.marker([lat, lng]).addTo(map);
    if (popupText) marker.bindPopup(popupText).openPopup();
    return { map, invalidateSize() { map.invalidateSize(); } };
}

// Turns {lat, lng} into a human-readable address string, via OpenStreetMap's
// free Nominatim service. No API key, but please respect its usage policy
// (max ~1 request/second) — fine for "buyer taps a pin" style usage, NOT
// for bulk/automated lookups.
export async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
            headers: { 'Accept-Language': 'en' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.display_name || null;
    } catch (error) {
        console.error('Reverse geocoding failed:', error);
        return null;
    }
}

// Straight-line ("as the crow flies") distance in km between two
// lat/lng points. Pure maths, works completely offline — no API needed
// for this part at all.
export function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
