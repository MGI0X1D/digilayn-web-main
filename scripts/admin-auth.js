import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

/**
 * Checks if a user has superuser privileges.
 * @param {string} uid 
 * @returns {Promise<boolean>}
 */
async function checkSuperUser(uid) {
  try {
    console.log("Checking superuser status for UID:", uid);
    const userDoc = await getDoc(doc(db, "users", uid));
    if (userDoc.exists()) {
      const userData = userDoc.data();
      const isSuper = userData.roles?.digilayn?.isSuperUser === true;
      console.log("Superuser status for", uid, ":", isSuper);
      return isSuper;
    } else {
      console.warn("User document not found for UID:", uid);
    }
  } catch (error) {
    console.error("Error checking superuser status:", error);
  }
  return false;
}

/**
 * Global Admin Auth Observer
 * @param {Function} onAuthorized - Callback when user is authorized as superuser
 * @param {Function} onUnauthorized - Callback when user is not logged in or not superuser
 */
export function initAdminAuth(onAuthorized, onUnauthorized) {
  console.log("admin-auth.js: initAdminAuth called");
  onAuthStateChanged(auth, async (user) => {
    console.log("admin-auth.js: onAuthStateChanged", user ? user.email : "no user");
    if (user) {
      const isSuper = await checkSuperUser(user.uid);
      if (isSuper) {
        onAuthorized(user);
      } else {
        console.warn("User is logged in but not a superuser. Redirecting...");
        // Logged in but not superuser - redirect to home page
        window.location.href = "../../index.html";
        onUnauthorized();
      }
    } else {
      onUnauthorized();
    }
  });
}

export async function loginAdmin(email, password) {
  try {
    console.log("admin-auth.js: Attempting login for", email);
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const isSuper = await checkSuperUser(userCredential.user.uid);
    if (!isSuper) {
      console.warn("Login successful but not a superuser. Signing out.");
      await signOut(auth);
      window.location.href = "../../index.html";
      return;
    }
    return userCredential.user;
  } catch (error) {
    console.error("admin-auth.js: Login error", error);
    throw error;
  }
}

export async function logoutAdmin() {
  await signOut(auth);
}
