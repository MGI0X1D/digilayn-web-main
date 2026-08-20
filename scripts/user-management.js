import { auth, functions, db } from "./firebase-config.js";
import {
  collection,
  query,
  onSnapshot,
  Timestamp,
  doc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js";

/** Safely extracts millisecond epoch from various timestamp formats. */
export function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (ts._seconds !== undefined) {
    return ts._seconds * 1000 + (ts._nanoseconds ? Math.floor(ts._nanoseconds / 1e6) : 0);
  }
  if (typeof ts === "number") return ts;
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

class UserManagement {
  constructor() {
    this.users = [];
    this.unsubscribe = null;
    this.filters = {
      search: "",
      deletePending: "all",
      suspended: "all",
      hasUsername: "all",
      laynFleetDriver: "all",
      poortjieAdmin: "all",
      poortjieTaxiAdmin: "all",
      poortjieSupport: "all",
      tuktukDriver: "all",
      tuktukOwner: "all",
      dateStart: null,
      dateEnd: null,
      sortBy: "newest"
    };
    this.deleteUserFully = httpsCallable(functions, "deleteUserFully");
  }

  init(onUpdate, onError) {
    console.log("Initializing UserManagement Firestore listener...");
    const usersRef = collection(db, "users");
    const q = query(usersRef);

    try {
      this.unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          console.log(`Firestore snapshot received: ${snapshot.size} documents.`);
          this.users = snapshot.docs.map((d) => {
            const data = d.data() || {};
            return {
              userId: d.id,
              uid: d.id,
              displayName: data.displayName || "",
              username: data.username || "",
              email: data.email || "",
              phone: data.phone || "",
              photoUrl: data.photoUrl || "",
              suspended: !!data.suspended,
              suspendedReason: data.suspendedReason || "",
              deletePending: !!data.deletePending,
              applications: data.applications || {},
              roles: data.roles || {},
              devices: data.devices || {},
              registeredWith: data.registeredWith || "",
              createdAt: data.createdAt || null,
              updatedAt: data.updatedAt || null,
              lastActive: data.lastActive || null
            };
          });
          onUpdate(this.applyFilters(this.users));
        },
        (error) => {
          console.error("UserManagement: onSnapshot error:", error);
          if (onError) onError(error);
        }
      );
    } catch (error) {
      console.error("UserManagement: Error setting up onSnapshot:", error);
      if (onError) onError(error);
    }
  }

  applyFilters(users) {
    let filtered = [...users];

    // Search query
    if (this.filters.search) {
      const s = this.filters.search.toLowerCase().trim();
      filtered = filtered.filter(
        (u) =>
          u.displayName.toLowerCase().includes(s) ||
          u.username.toLowerCase().includes(s) ||
          u.email.toLowerCase().includes(s) ||
          u.phone.toLowerCase().includes(s) ||
          u.userId.toLowerCase().includes(s)
      );
    }

    // Delete Pending
    if (this.filters.deletePending !== "all") {
      const isPending = this.filters.deletePending === "true";
      filtered = filtered.filter((u) => !!u.deletePending === isPending);
    }

    // Suspended
    if (this.filters.suspended !== "all") {
      const isSuspended = this.filters.suspended === "true";
      filtered = filtered.filter((u) => !!u.suspended === isSuspended);
    }

    // Has Username
    if (this.filters.hasUsername !== "all") {
      const has = this.filters.hasUsername === "true";
      filtered = filtered.filter((u) => (!!u.username && u.username.length > 0) === has);
    }

    // LaynFleet Driver Application
    if (this.filters.laynFleetDriver !== "all") {
      const isDriver = this.filters.laynFleetDriver === "true";
      filtered = filtered.filter((u) => !!u.applications?.laynFleet?.isDriver === isDriver);
    }

    // Poortjie Roles
    if (this.filters.poortjieAdmin !== "all") {
      const val = this.filters.poortjieAdmin === "true";
      filtered = filtered.filter((u) => !!u.roles?.poortjie?.isAdmin === val);
    }
    if (this.filters.poortjieTaxiAdmin !== "all") {
      const val = this.filters.poortjieTaxiAdmin === "true";
      filtered = filtered.filter((u) => !!u.roles?.poortjie?.isTaxiRankAdmin === val);
    }
    if (this.filters.poortjieSupport !== "all") {
      const val = this.filters.poortjieSupport === "true";
      filtered = filtered.filter((u) => !!u.roles?.poortjie?.listForSupport === val);
    }

    // Tuktuk Roles
    if (this.filters.tuktukDriver !== "all") {
      const val = this.filters.tuktukDriver === "true";
      filtered = filtered.filter((u) => !!u.roles?.tuktuk?.isDriver === val);
    }
    if (this.filters.tuktukOwner !== "all") {
      const val = this.filters.tuktukOwner === "true";
      filtered = filtered.filter((u) => !!u.roles?.tuktuk?.isOwner === val);
    }

    // Date Range
    if (this.filters.dateStart) {
      const start = new Date(this.filters.dateStart).getTime();
      filtered = filtered.filter((u) => getTimestampMs(u.createdAt) >= start);
    }
    if (this.filters.dateEnd) {
      const end = new Date(this.filters.dateEnd).getTime();
      filtered = filtered.filter((u) => getTimestampMs(u.createdAt) <= end + 86400000);
    }

    // Sorting
    filtered.sort((a, b) => {
      switch (this.filters.sortBy) {
        case "newest":
          return getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt);
        case "oldest":
          return getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt);
        case "lastActive":
          return getTimestampMs(b.lastActive || b.updatedAt) - getTimestampMs(a.lastActive || a.updatedAt);
        case "nameAZ":
          return (a.displayName || "").localeCompare(b.displayName || "");
        case "usernameAZ":
          return (a.username || "").localeCompare(b.username || "");
        default:
          return 0;
      }
    });

    return filtered;
  }

  setFilter(key, value) {
    this.filters[key] = value;
  }

  async deleteUser(uid, username) {
    if (auth.currentUser && auth.currentUser.uid === uid) {
      console.warn("User tried to delete themselves. Operation blocked.");
      throw new Error("You cannot delete yourself.");
    }
    console.log(`Deleting user UID: ${uid} (${username})`);
    try {
      const result = await this.deleteUserFully({ uid, username });
      return result.data || { success: true };
    } catch (cfError) {
      console.warn("Cloud function deleteUserFully error, falling back to direct Firestore removal:", cfError);
      const userRef = doc(db, "users", uid);
      await deleteDoc(userRef);
      if (username) {
        const usernameRef = doc(db, "usernames", username);
        await deleteDoc(usernameRef);
      }
      return { success: true, method: "firestore-direct" };
    }
  }

  async toggleUserSuspension(uid, isSuspended) {
    console.log(`Toggling suspension for UID: ${uid} to ${!isSuspended}`);
    const userRef = doc(db, "users", uid);
    await updateDoc(userRef, {
      suspended: !isSuspended,
      updatedAt: Timestamp.now()
    });
    return { success: true, suspended: !isSuspended };
  }

  async toggleUserRole(uid, rolePath, currentStatus) {
    console.log(`Toggling role ${rolePath} for UID: ${uid} to ${!currentStatus}`);
    const userRef = doc(db, "users", uid);
    const updateData = {
      [`roles.${rolePath}`]: !currentStatus,
      updatedAt: Timestamp.now()
    };
    await updateDoc(userRef, updateData);
    return { success: true };
  }

  async toggleLaynFleetDriver(uid, currentStatus) {
    console.log(`Toggling LaynFleet driver for UID: ${uid} to ${!currentStatus}`);
    const userRef = doc(db, "users", uid);
    const updateData = {
      "applications.laynFleet.isDriver": !currentStatus,
      updatedAt: Timestamp.now()
    };
    await updateDoc(userRef, updateData);
    return { success: true };
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
  }
}

export const userManager = new UserManagement();
