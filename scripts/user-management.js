import { auth, functions, db } from "./firebase-config.js";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, Timestamp, writeBatch } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
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
      search: "", suspensionReason: "all", suspended: "all", hasUsername: "all",
      laynFleetDriver: "all", poortjieAdmin: "all", poortjieTaxiAdmin: "all",
      poortjieSupport: "all", tuktukDriver: "all", tuktukOwner: "all",
      emailDomain: "all", integrity: "all",
      dateStart: null, dateEnd: null, sortBy: "newest"
    };
    this.getInventory = httpsCallable(functions, "getGlobalUserInventoryCallable");
    this.previewDelete = httpsCallable(functions, "previewGlobalUserDeleteCallable");
    this.deleteUserFully = httpsCallable(functions, "deleteGlobalUserCallable");
    this.deleteStorageObjectFully = httpsCallable(functions, "deleteGlobalStorageObjectCallable");
    this.deleteUsernameReservationFully = httpsCallable(functions, "deleteGlobalUsernameReservationCallable");
    this.deleteOrphanDocumentFully = httpsCallable(functions, "deleteGlobalOrphanDocumentCallable");
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
      this.orphanDocuments = inventory.orphanDocuments || [];
      this.onUpdate?.(this.applyFilters(this.users), {
        orphanStorage: this.orphanStorage,
        orphanUsernames: this.orphanUsernames,
        orphanDocuments: this.orphanDocuments,
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
      filtered = filtered.filter((user) => [user.displayName, user.username, user.email, user.phone, user.userId, user.integrity, user.suspendedReason]
        .some((value) => String(value || "").toLowerCase().includes(search)));
    }
    const booleanFilter = (key, getter) => {
      if (this.filters[key] !== "all") {
        const expected = this.filters[key] === "true";
        filtered = filtered.filter((user) => !!getter(user) === expected);
      }
    };
    booleanFilter("suspended", (user) => user.suspended);
    if (this.filters.suspensionReason && this.filters.suspensionReason !== "all") {
      if (this.filters.suspensionReason === "pending-delete") {
        filtered = filtered.filter((user) => user.suspended && String(user.suspendedReason || "").trim().toLowerCase() === "pending delete");
      } else if (this.filters.suspensionReason === "terms-violation") {
        filtered = filtered.filter((user) => user.suspended && String(user.suspendedReason || "").toLowerCase().includes("violation"));
      } else if (this.filters.suspensionReason === "suspicious-activity") {
        filtered = filtered.filter((user) => user.suspended && (String(user.suspendedReason || "").toLowerCase().includes("suspicious") || String(user.suspendedReason || "").toLowerCase().includes("fraud")));
      } else if (this.filters.suspensionReason === "other") {
        filtered = filtered.filter((user) => {
          if (!user.suspended) return false;
          const r = String(user.suspendedReason || "").trim().toLowerCase();
          return r !== "pending delete" && !r.includes("violation") && !r.includes("suspicious") && !r.includes("fraud");
        });
      }
    }
    booleanFilter("hasUsername", (user) => user.username);
    booleanFilter("laynFleetDriver", (user) => user.applications?.laynFleet?.isDriver);
    booleanFilter("poortjieAdmin", (user) => user.roles?.poortjie?.isAdmin);
    booleanFilter("poortjieTaxiAdmin", (user) => user.roles?.poortjie?.isTaxiRankAdmin);
    booleanFilter("poortjieSupport", (user) => user.roles?.poortjie?.listForSupport);
    booleanFilter("tuktukDriver", (user) => user.roles?.tuktuk?.isDriver);
    booleanFilter("tuktukOwner", (user) => user.roles?.tuktuk?.isOwner);
    if (this.filters.emailDomain && this.filters.emailDomain !== "all") {
      if (this.filters.emailDomain === "gmail") {
        filtered = filtered.filter((user) => String(user.email || "").toLowerCase().trim().endsWith("@gmail.com"));
      } else if (this.filters.emailDomain === "non-gmail") {
        filtered = filtered.filter((user) => {
          const email = String(user.email || "").toLowerCase().trim();
          return email.length > 0 && !email.endsWith("@gmail.com");
        });
      } else if (this.filters.emailDomain === "no-email") {
        filtered = filtered.filter((user) => !user.email || String(user.email).trim().length === 0);
      }
    }
    if (this.filters.integrity && this.filters.integrity !== "all") {
      filtered = filtered.filter((user) => user.integrity === this.filters.integrity);
    }
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

  async deleteUser(uid, confirmation, onProgress) {
    if (auth.currentUser?.uid === uid) throw new Error("You cannot delete yourself.");
    onProgress?.({ step: "requesting", percent: 25, message: "Validating credentials and sending delete request..." });
    const result = await this.deleteUserFully({ uid, confirmation });
    onProgress?.({ step: "refreshing", percent: 80, message: "Refreshing user inventory..." });
    await this.refresh();
    onProgress?.({ step: "done", percent: 100, message: "User deleted successfully." });
    return result.data;
  }

  async deleteStorageObject(path, confirmation, skipRefresh = false) {
    const result = await this.deleteStorageObjectFully({ path, confirmation });
    if (!skipRefresh) await this.refresh();
    return result.data;
  }

  async deleteUsernameReservation(username, confirmation, skipRefresh = false) {
    const result = await this.deleteUsernameReservationFully({ username, confirmation });
    if (!skipRefresh) await this.refresh();
    return result.data;
  }

  async deleteOrphanDocument(path, confirmation, skipRefresh = false) {
    const result = await this.deleteOrphanDocumentFully({ path, confirmation });
    if (!skipRefresh) await this.refresh();
    return result.data;
  }

  async deleteOrphansBatch(items, onProgress, isAborted) {
    const results = { succeeded: [], failed: [] };
    const total = items.length;

    for (let i = 0; i < total; i++) {
      if (isAborted?.()) break;
      const item = items[i];
      onProgress?.({
        type: "item_start",
        index: i,
        total,
        percent: Math.round((i / total) * 90),
        item,
        results
      });

      try {
        if (item.type === "storage") {
          await this.deleteStorageObject(item.id, item.id, true);
        } else if (item.type === "username") {
          await this.deleteUsernameReservation(item.id, item.id, true);
        } else if (item.type === "document") {
          await this.deleteOrphanDocument(item.id, item.id, true);
        }
        results.succeeded.push(item);
        onProgress?.({
          type: "item_success",
          index: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 90),
          item,
          results
        });
      } catch (err) {
        console.error(`Failed to delete orphan ${item.type} ${item.id}:`, err);
        results.failed.push({ item, error: err.message || String(err) });
        onProgress?.({
          type: "item_error",
          index: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 90),
          item,
          error: err.message || String(err),
          results
        });
      }
    }

    onProgress?.({
      type: "refreshing",
      index: total,
      total,
      percent: 95,
      message: "Refreshing system inventory...",
      results
    });

    try {
      await this.refresh();
    } catch (refreshErr) {
      console.warn("Failed to refresh after orphan batch deletion:", refreshErr);
    }

    onProgress?.({
      type: "complete",
      index: total,
      total,
      percent: 100,
      results
    });

    return results;
  }

  async toggleUserSuspension(uid, isSuspended, reason = "") {
    const updateData = {
      suspended: !isSuspended,
      suspendedReason: !isSuspended ? (String(reason || "").trim() || "Suspended by manager") : "",
      updatedAt: Timestamp.now()
    };
    await updateDoc(doc(db, "users", uid), updateData);
    await this.refresh();
    return { success: true, suspended: !isSuspended, suspendedReason: updateData.suspendedReason };
  }

  async toggleUserRole(uid, rolePath, currentStatus) {
    await updateDoc(doc(db, "users", uid), { [`roles.${rolePath}`]: !currentStatus, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true };
  }

  async togglePoortjieRole(uid, roleKey, currentStatus) {
    await updateDoc(doc(db, "users", uid), { [`roles.poortjie.${roleKey}`]: !currentStatus, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true };
  }

  async toggleLaynFleetDriver(uid, currentStatus) {
    await updateDoc(doc(db, "users", uid), { "applications.laynFleet.isDriver": !currentStatus, updatedAt: Timestamp.now() });
    await this.refresh();
    return { success: true };
  }

  findUserByEmail(email) {
    const clean = String(email || "").trim().toLowerCase();
    if (!clean) return null;
    return this.users.find((u) => String(u.email || "").trim().toLowerCase() === clean) || null;
  }

  async fetchLaynFleetDrivers() {
    const snapshot = await getDocs(collection(db, "laynfleet", "main", "drivers"));
    const usersByUid = new Map(this.users.map((u) => [u.userId || u.uid, u]));

    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      const user = usersByUid.get(docSnap.id) || {};
      return {
        uid: docSnap.id,
        approvalStatus: data.approvalStatus || "PENDING",
        vehicle: data.vehicle || {},
        ratingAvg: data.ratingAvg ?? null,
        ratingCount: data.ratingCount ?? 0,
        tripsCount: data.tripsCount ?? data.completedTripsCount ?? 0,
        online: !!data.online,
        busy: !!data.busy,
        approvedAt: data.approvedAt || null,
        approvedBy: data.approvedBy || "",
        demotedAt: data.demotedAt || null,
        demotedBy: data.demotedBy || "",
        demoteReason: data.demoteReason || "",
        testAccount: !!data.testAccount,
        user: {
          displayName: user.displayName || data.displayName || "Unknown Driver",
          email: user.email || data.email || "",
          phone: user.phone || data.phone || "",
          photoUrl: user.photoUrl || data.photoUrl || "",
          username: user.username || "",
          suspended: !!user.suspended,
          suspendedReason: user.suspendedReason || data.suspendedReason || "",
          updatedAt: user.updatedAt || data.updatedAt || null,
          createdAt: user.createdAt || data.createdAt || null
        },
        raw: data
      };
    });
  }

  async fetchDogTowingDrivers() {
    const snapshot = await getDocs(collection(db, "laynfleet", "dog-towing", "drivers"));
    const usersByUid = new Map(this.users.map((u) => [u.userId || u.uid, u]));

    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      const user = usersByUid.get(docSnap.id) || {};
      const rawRole = String(data.role || "DRIVER").toUpperCase();
      const isOwner = rawRole === "OWNER";
      const approvalStatus = data.approvalStatus || (isOwner ? "APPROVED" : "PENDING");
      return {
        uid: docSnap.id,
        role: isOwner ? "OWNER" : "DRIVER",
        approvalStatus,
        isDriver: data.isDriver !== false,
        addedBy: data.addedBy || "",
        addedAt: data.addedAt || 0,
        demotedAt: data.demotedAt || null,
        demoteReason: data.demoteReason || "",
        vehicle: data.vehicle || {},
        user: {
          displayName: user.displayName || data.displayName || "Unknown User",
          email: user.email || data.email || "",
          phone: user.phone || data.phone || "",
          photoUrl: user.photoUrl || data.photoUrl || "",
          username: user.username || "",
          suspended: !!user.suspended,
          suspendedReason: user.suspendedReason || data.suspendedReason || "",
          updatedAt: user.updatedAt || data.updatedAt || null,
          createdAt: user.createdAt || data.createdAt || null
        },
        raw: data
      };
    });
  }

  async fetchLaynFleetRiders() {
    const snapshot = await getDocs(collection(db, "laynfleet", "main", "riders"));
    const usersByUid = new Map(this.users.map((u) => [u.userId || u.uid, u]));

    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      const user = usersByUid.get(docSnap.id) || {};
      return {
        uid: docSnap.id,
        tripsCount: data.tripsCount ?? data.totalTrips ?? 0,
        ratingAvg: data.ratingAvg ?? null,
        ratingCount: data.ratingCount ?? 0,
        joinedAt: data.joinedAt || user.createdAt || null,
        user: {
          displayName: user.displayName || data.displayName || "Rider",
          email: user.email || data.email || "",
          phone: user.phone || data.phone || "",
          photoUrl: user.photoUrl || data.photoUrl || "",
          username: user.username || "",
          suspended: !!user.suspended,
          suspendedReason: user.suspendedReason || data.suspendedReason || "",
          updatedAt: user.updatedAt || data.updatedAt || null,
          createdAt: user.createdAt || data.createdAt || null
        },
        raw: data
      };
    });
  }

  async promoteLaynDriver(uid, vehicleData = {}) {
    const batch = writeBatch(db);
    const driverRef = doc(db, "laynfleet", "main", "drivers", uid);
    const userRef = doc(db, "users", uid);
    const managerEmail = auth.currentUser?.email || "usrmusa@gmail.com";

    batch.set(driverRef, {
      approvalStatus: "APPROVED",
      approvedBy: managerEmail,
      approvedAt: Timestamp.now(),
      demoteReason: null,
      demotedAt: null,
      demotedBy: null,
      updatedAt: Timestamp.now(),
      vehicle: {
        make: vehicleData.make || "",
        model: vehicleData.model || "",
        colour: vehicleData.colour || "",
        plate: vehicleData.plate || "",
        seats: vehicleData.seats || 4,
        vehicleType: vehicleData.vehicleType || "standard"
      }
    }, { merge: true });

    batch.set(userRef, {
      applications: {
        laynFleet: {
          isDriver: true
        }
      },
      updatedAt: Timestamp.now()
    }, { merge: true });

    await batch.commit();
    await this.refresh();
    return { success: true };
  }

  async demoteLaynDriver(uid, reason = "") {
    const batch = writeBatch(db);
    const driverRef = doc(db, "laynfleet", "main", "drivers", uid);
    const userRef = doc(db, "users", uid);
    const managerEmail = auth.currentUser?.email || "usrmusa@gmail.com";

    batch.set(driverRef, {
      approvalStatus: "DEMOTED",
      online: false,
      demoteReason: reason || "Demoted by manager",
      demotedAt: Timestamp.now(),
      demotedBy: managerEmail,
      updatedAt: Timestamp.now()
    }, { merge: true });

    batch.set(userRef, {
      applications: {
        laynFleet: {
          isDriver: false
        }
      },
      updatedAt: Timestamp.now()
    }, { merge: true });

    await batch.commit();
    await this.refresh();
    return { success: true };
  }

  async reapproveLaynDriver(uid) {
    return this.promoteLaynDriver(uid);
  }

  async promoteDogTowingUser(uid, role = "DRIVER", vehicleData = {}) {
    const batch = writeBatch(db);
    const driverRef = doc(db, "laynfleet", "dog-towing", "drivers", uid);
    const userRef = doc(db, "users", uid);
    const managerEmail = auth.currentUser?.email || "usrmusa@gmail.com";
    const isOwner = role === "OWNER";

    batch.set(driverRef, {
      role: isOwner ? "OWNER" : "DRIVER",
      approvalStatus: "APPROVED",
      isDriver: true,
      addedBy: managerEmail,
      addedAt: Date.now(),
      updatedAt: Timestamp.now(),
      vehicle: {
        make: vehicleData.make || "",
        model: vehicleData.model || "",
        plate: vehicleData.plate || ""
      }
    }, { merge: true });

    batch.set(userRef, {
      applications: {
        laynAssist: {
          role: isOwner ? "OWNER" : "DRIVER",
          isDriver: true,
          isOwner: isOwner,
          approved: true
        }
      },
      updatedAt: Timestamp.now()
    }, { merge: true });

    await batch.commit();
    await this.refresh();
    return { success: true };
  }

  async demoteDogTowingUser(uid, newRole = "DRIVER", reason = "") {
    const batch = writeBatch(db);
    const driverRef = doc(db, "laynfleet", "dog-towing", "drivers", uid);
    const userRef = doc(db, "users", uid);
    const managerEmail = auth.currentUser?.email || "usrmusa@gmail.com";

    if (newRole === "DRIVER") {
      batch.set(driverRef, {
        role: "DRIVER",
        demoteReason: reason || "Demoted from owner to driver",
        demotedAt: Timestamp.now(),
        demotedBy: managerEmail,
        updatedAt: Timestamp.now()
      }, { merge: true });

      batch.set(userRef, {
        applications: {
          laynAssist: {
            role: "DRIVER",
            isOwner: false,
            isDriver: true
          }
        },
        updatedAt: Timestamp.now()
      }, { merge: true });
    } else {
      batch.set(driverRef, {
        approvalStatus: "REVOKED",
        isDriver: false,
        demoteReason: reason || "Access revoked by manager",
        demotedAt: Timestamp.now(),
        demotedBy: managerEmail,
        updatedAt: Timestamp.now()
      }, { merge: true });

      batch.set(userRef, {
        applications: {
          laynAssist: {
            approved: false,
            isDriver: false
          }
        },
        updatedAt: Timestamp.now()
      }, { merge: true });
    }

    await batch.commit();
    await this.refresh();
    return { success: true };
  }

  async reapproveDogTowingDriver(uid) {
    const batch = writeBatch(db);
    const driverRef = doc(db, "laynfleet", "dog-towing", "drivers", uid);
    const userRef = doc(db, "users", uid);
    const managerEmail = auth.currentUser?.email || "usrmusa@gmail.com";

    batch.set(driverRef, {
      approvalStatus: "APPROVED",
      isDriver: true,
      approvedAt: Timestamp.now(),
      approvedBy: managerEmail,
      demoteReason: null,
      demotedAt: null,
      demotedBy: null,
      updatedAt: Timestamp.now()
    }, { merge: true });

    batch.set(userRef, {
      applications: {
        laynAssist: {
          isDriver: true,
          approved: true
        }
      },
      updatedAt: Timestamp.now()
    }, { merge: true });

    await batch.commit();
    await this.refresh();
    return { success: true };
  }

  destroy() { this.onUpdate = null; this.onError = null; }
}

export const userManager = new UserManagement();
