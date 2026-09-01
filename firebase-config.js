import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyD7cgnLiY8yuc3EPiCvmDkpfwhgltR-x-g",
    authDomain: "desimarket-4b8a5.firebaseapp.com",
    projectId: "desimarket-4b8a5",
    storageBucket: "desimarket-4b8a5.firebasestorage.app",
    messagingSenderId: "761756037231",
    appId: "1:761756037231:web:f09e5b6abb55947cf85d9a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ============================================================================
// READ-COST OPTIMIZATION: on-device offline persistence.
//
// This turns on Firestore's built-in local database (IndexedDB) in the
// browser. Every document the app ever reads gets saved on the visitor's own
// device. The next time they open the site — even a new tab, even after
// closing the browser — Firestore shows that cached data INSTANTLY (zero
// network wait, zero extra read) while quietly checking the server in the
// background over the same realtime connection our onSnapshot() listeners
// already use everywhere (product lists, orders, seller dashboard, etc).
//
// The moment a seller changes a price, stock count, product name, image, or
// their shop details, that realtime connection pushes the change to every
// open device automatically — so "instant update when something changes"
// and "serve most data from the local cache" are the same feature here, not
// a trade-off. `persistentMultipleTabManager` lets several tabs of the site
// open at once share one local cache instead of each keeping a separate copy.
//
// If the browser can't support this (very old browsers, private/incognito
// mode in some browsers, or the site open in many tabs at once in a way the
// browser blocks), Firestore automatically falls back to normal in-memory
// behaviour — nothing breaks, the site just won't get the offline speed-up.
// ============================================================================
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

