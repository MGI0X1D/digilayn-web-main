import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js";

/**
 * Shared Firebase config for the whole Digilayn web (the /portfolio admin area
 * in particular). Uses the SAME working credentials as the LaynFleet manager
 * console (see portfolio/projects/laynfleet/admin/firebase-config.js) so every
 * page authenticates against one project: `digilayn-projects`.
 *
 * Web API keys are PUBLIC identifiers — safe to expose. Real access control
 * lives in Firebase/Firestore security rules.
 *
 * TODO(security): access is currently gated CLIENT-SIDE only (see
 * admin-auth.js). We MUST add Firestore Security Rules + Cloud Function auth
 * checks that hard-block every read/write for any account other than
 * AUTHORIZED_EMAIL. Until those ship, treat this as dev-grade, not hardened.
 */
const firebaseConfig = {
  apiKey: "AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA",
  authDomain: "digilayn-projects.firebaseapp.com",
  projectId: "digilayn-projects",
  storageBucket: "digilayn-projects.firebasestorage.app",
  messagingSenderId: "95485356681",
  appId: "1:95485356681:web:3cf619a266961009e17458",
  measurementId: "G-27H9WZSCGQ"
};

/**
 * The ONLY account permitted to access the /portfolio admin area.
 * Keep this in sync with MANAGER_EMAIL in the LaynFleet admin config.
 */
export const AUTHORIZED_EMAIL = "usrmusa@gmail.com";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const storage = getStorage(app);

// Analytics is optional and must never break auth/data if it is unsupported
// (e.g. blocked, or served from a non-https / file:// context).
let analytics = null;
isSupported()
  .then((supported) => {
    if (supported) analytics = getAnalytics(app);
  })
  .catch((err) => console.warn("Firebase Analytics unavailable:", err));

export { app, analytics, auth, db, functions, storage };
