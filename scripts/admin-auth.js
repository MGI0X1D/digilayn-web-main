import { auth, AUTHORIZED_EMAIL } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

/**
 * admin-auth.js — GLOBAL access gate for the entire /portfolio admin area.
 *
 * Only AUTHORIZED_EMAIL (usrmusa@gmail.com) may pass. Every portfolio page that
 * needs protection imports initAdminAuth / loginAdmin / logoutAdmin from here,
 * so the rule is enforced in exactly one place for the whole site.
 *
 * ⚠️ TODO(security): This is a CLIENT-SIDE gate ONLY. It hides the UI and signs
 * out unauthorised accounts, but it is NOT a real security boundary — a
 * determined user could still call Firestore / Cloud Functions directly with
 * any authenticated account. We MUST add Firestore Security Rules (and Cloud
 * Function auth checks) that hard-block every read/write for any account other
 * than AUTHORIZED_EMAIL before this can be considered secure. Until those rules
 * ship, treat this as dev-grade.
 */

/**
 * True only when the signed-in user is the single authorised account.
 * @param {import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js").User|null} user
 * @returns {boolean}
 */
function isAuthorized(user) {
  return !!user && (user.email || "").toLowerCase() === AUTHORIZED_EMAIL.toLowerCase();
}

/**
 * Global auth observer. Calls onAuthorized(user) only for AUTHORIZED_EMAIL.
 * Any other signed-in account is forcibly signed out and treated as
 * unauthorised. Optionally redirects unauthorised visitors.
 *
 * @param {(user: object) => void} onAuthorized
 * @param {(reason?: string) => void} onUnauthorized
 * @param {string|null} [redirectPath] - if set, unauthorised users are sent here
 */
export function initAdminAuth(onAuthorized, onUnauthorized, redirectPath = null) {
  onAuthStateChanged(auth, async (user) => {
    if (isAuthorized(user)) {
      onAuthorized(user);
      return;
    }

    let reason;
    if (user) {
      // Signed in with a NON-authorised account — reject hard.
      console.warn("admin-auth.js: unauthorised account signed in — signing out:", user.email);
      reason = "This account is not authorised to access this area.";
      try {
        await signOut(auth);
      } catch (err) {
        console.error("admin-auth.js: sign-out of unauthorised account failed", err);
      }
    }

    if (redirectPath) {
      window.location.href = redirectPath;
      return;
    }
    onUnauthorized(reason);
  });
}

/**
 * Sign in and enforce the email allowlist. Rejects (and never leaves a session
 * open) for anything other than AUTHORIZED_EMAIL.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} the authorised user
 */
export async function loginAdmin(email, password) {
  const normalized = (email || "").trim();

  // Pre-check: never even attempt a sign-in for a non-authorised address.
  if (normalized.toLowerCase() !== AUTHORIZED_EMAIL.toLowerCase()) {
    throw new Error("This account is not authorised to access this area.");
  }

  const credential = await signInWithEmailAndPassword(auth, normalized, password);

  // Defensive re-check in case the returned account differs unexpectedly.
  if (!isAuthorized(credential.user)) {
    await signOut(auth);
    throw new Error("This account is not authorised to access this area.");
  }

  return credential.user;
}

export async function logoutAdmin() {
  await signOut(auth);
}
