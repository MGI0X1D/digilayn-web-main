import { auth, functions, db } from "./firebase-config.js";
import { doc, Timestamp, updateDoc } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js";

export function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (ts._seconds !== undefined) return ts._seconds * 1000 + Math.floor((ts._nanoseconds || 0) / 1e6);
  if (typeof ts === "number") return ts;
  const parsed = new Date(ts).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

class UserManagement {
  constructor() {
    this.users = [];
    this.orphanStorage = [];
    this.orphanUsernames = [];
    this.onUpdate = null;
    this.onError = null;
    this.filters = {
      search: "", deletePending: "all", suspended: "all", hasUsername: "all",
      laynFleetDriver: "all", poortjieAdmin: "all", poortjieTaxiAdmin: "all",
      poortjieSupport: "all", tuktukDriver: "all", tuktukOwner: "all",
      dateStart: null, dateEnd: null, sortBy: "newest"
    };
    this.getInventory = httpsCallable(functions, "getGlobalUserInventoryCallable");
    this.previewDelete = httpsCallable(functions, "previewGlobalUserDeleteCallable");
    this.deleteUserFully = httpsCallable(functions, "deleteGlobalUserCallable");
    this.deleteStorageObjectFully = httpsCallable(functions, "deleteGlobalStorageObjectCallable");
    this.deleteUsernameReservationFully = httpsCallable(functions, "deleteGlobalUsernameReservationCallable");
  }

  async init(onUpdate, onError) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    try {
      await this.refresh();
    } catch (_) {
      // refresh already reported the exact callable error through onError.
    }
  }

  async refresh() {
    try {
      const response = await this.getInventory({});
      const inventory = response.data || {};
      this.users = (inventory.accounts || []).map((account) => this.normalizeAccount(account));
      this.orphanStorage = inventory.orphanStorage || [];
      this.orphanUsernames = inventory.orphanUsernames || [];
      this.onUpdate?.(this.applyFilters(this.users), {
        orphanStorage: this.orphanStorage,
        orphanUsernames: this.orphanUsernames,
        excludedPrefixes: inventory.excludedPrefixes || []
      });
    } catch (error) {
      console.error("UserManagement inventory failed:", error);
      this.onError?.(error);
      throw error;
    }
  }

  normalizeAccount(account) {
    const authData = account.auth || null;
    const firestore = account.firestore || null;
    const source = firestore || {};
    const storageObjects = account.storage || [];
    const usernameReservations = account.usernames || [];
    let integrity = "complete";
    if (authData && !firestore) integrity = "auth-only";
    else if (!authData && firestore) integrity = "firestore-only";
    else if (!authData && !firestore) integrity = "linked-orphans-only";
    return {
      userId: account.uid,
      uid: account.uid,
      displayName: authData?.displayName || source.displayName || "",
      username: source.username || usernameReservations[0]?.username || "",
      email: authData?.email || source.email || "",
      phone: authData?.phone || source.phone || "",
      photoUrl: authData?.photoUrl || source.photoUrl || storageObjects.find((item) => String(item.contentType).startsWith("image/"))?.downloadUrl || "",
      suspended: !!source.suspended,
      suspendedReason: source.suspendedReason || "",
      deletePending: !!source.deletePending,
      applications: source.applications || {}, roles: source.roles || {}, devices: source.devices || {},
      registeredWith: source.registeredWith || "",
      createdAt: authData?.createdAt || source.createdAt || null,
      updatedAt: source.updatedAt || null,
      lastActive: authData?.lastSignInAt || source.lastActive || null,
      hasAuth: !!authData,
      hasFirestore: !!firestore,
      authDisabled: !!authData?.disabled,
      emailVerified: !!authData?.emailVerified,
      providers: authData?.providers || [],
      integrity,
      storageObjects,
      usernameReservations
    };
  }

  applyFilters(users) {
    let filtered = [...users];
    if (this.filters.search) {
      const search = this.filters.search.toLowerCase().trim();
      filtered = filtered.filter((user) => [user.displayName, user.username, user.email, user.phone, user.userId, user.integrity]
        .some((value) => String(value || "").toLowerCase().includes(search)));
    }
    const booleanFilter = (key, getter) => {
      if (this.filters[key] !== "all") {
        const expected = this.filters[key] === "true";
        filtered = filtered.filter((user) => !!getter(user) === expected);
      }
    };
    booleanFilter("deletePending", (user) => user.deletePending);
    booleanFilter("suspended", (user) => user.suspended);
    booleanFilter("hasUsername", (user) => user.username);
    booleanFilter("laynFleetDriver", (user) => user.applications?.laynFleet?.isDriver);
    booleanFilter("poortjieAdmin", (user) => user.roles?.poortjie?.isAdmin);
    booleanFilter("poortjieTaxiAdmin", (user) => user.roles?.poortjie?.isTaxiRankAdmin);
    booleanFilter("poortjieSupport", (user) => user.roles?.poortjie?.listForSupport);
    booleanFilter("tuktukDriver", (user) => user.roles?.tuktuk?.isDriver);
    booleanFilter("tuktukOwner", (user) => user.roles?.tuktuk?.isOwner);
    if (this.filters.dateStart) {
      const start = new Date(this.filters.dateStart).getTime();
      filtered = filtered.filter((user) => getTimestampMs(user.createdAt) >= start);
    }
    if (this.filters.dateEnd) {
      const end = new Date(this.filters.dateEnd).getTime() + 86400000;
      filtered = filtered.filter((user) => getTimestampMs(user.createdAt) <= end);
    }
    filtered.sort((a, b) => {
      switch (this.filters.sortBy) {
        case "oldest": return getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt);
        case "lastActive": return getTimestampMs(b.lastActive || b.updatedAt) - getTimestampMs(a.lastActive || a.updatedAt);
        case "nameAZ": return (a.displayName || "").localeCompare(b.displayName || "");
        case "usernameAZ": return (a.username || "").localeCompare(b.username || "");
        default: return getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt);
      }
    });
    return filtered;
  }

  setFilter(key, value) { this.filters[key] = value; }

  async getDeletePreview(uid) {
    return (await this.previewDelete({ uid })).data;
  }

  async deleteUser(uid, confirmation) {
    if (auth.currentUser?.uid === uid) throw new Error("You cannot delete yourself.");
    const result = await this.deleteUserFully({ uid, confirmation });
    await this.refresh();
    return result.data;
  }

  async deleteStorageObject(path, confirmation) {
    const result = await this.deleteStorageObjectFully({ path, confirmation });
    await this.refresh();
    return result.data;
  }

  async deleteUsernameReservation(username, confirmation) {
    const result = await this.deleteUsernameReservationFully({ username, confirmation });
    await this.refresh();
    return result.data;
  }

  async toggleUserSuspension(uid, isSuspended) {
    await updateDoc(doc(db, "users", uid), { suspended: !isSuspended, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true, suspended: !isSuspended };
  }

  async toggleUserRole(uid, rolePath, currentStatus) {
    await updateDoc(doc(db, "users", uid), { [`roles.${rolePath}`]: !currentStatus, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true };
  }

  async toggleLaynFleetDriver(uid, currentStatus) {
    await updateDoc(doc(db, "users", uid), { "applications.laynFleet.isDriver": !currentStatus, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true };
  }

  destroy() { this.onUpdate = null; this.onError = null; }
}

export const userManager = new UserManagement();
