import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
export const db = getFirestore(app);
