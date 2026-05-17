import { auth, functions, db } from "./firebase-config.js";
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  where,
  limit,
  Timestamp,
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js";

class UserManagement {
  constructor() {
    this.users = [];
    this.unsubscribe = null;
    this.filters = {
      search: "",
      deletePending: "all",
      suspended: "all",
      hasUsername: "all",
      dateStart: null,
      dateEnd: null,
      sortBy: "newest"
    };
    this.deleteUserFully = httpsCallable(functions, 'deleteUserFully');
  }

  init(onUpdate, onError) {
    console.log("Initializing UserManagement Firestore listener...");
    const usersRef = collection(db, "users");
    let q = query(usersRef);

    // Initial listener for live data with error handling
    try {
      this.unsubscribe = onSnapshot(q, (snapshot) => {
        console.log(`Firestore snapshot received: ${snapshot.size} documents.`);
        this.users = snapshot.docs.map(doc => {
          const data = doc.data();
          return {
            user_id: doc.id,
            ...data,
            // Handle cases where timestamps might be null or missing
            created_at: data.created_at || null,
            updated_at: data.updated_at || null
          };
        });
        onUpdate(this.applyFilters(this.users));
      }, (error) => {
        console.error("UserManagement: onSnapshot error:", error);
        if (onError) onError(error);
      });
    } catch (error) {
      console.error("UserManagement: Error setting up onSnapshot:", error);
      if (onError) onError(error);
    }
  }

  applyFilters(users) {
    console.log("Applying filters to users list...");
    let filtered = [...users];

    // Search
    if (this.filters.search) {
      const s = this.filters.search.toLowerCase();
      filtered = filtered.filter(u => 
        (u.display_name?.toLowerCase().includes(s)) ||
        (u.username?.toLowerCase().includes(s)) ||
        (u.email?.toLowerCase().includes(s)) ||
        (u.phone?.toLowerCase().includes(s)) ||
        (u.user_id?.toLowerCase().includes(s))
      );
    }

    // Delete Pending
    if (this.filters.deletePending !== "all") {
      const isPending = this.filters.deletePending === "true";
      filtered = filtered.filter(u => !!u.delete_pending === isPending);
    }

    // Suspended
    if (this.filters.suspended !== "all") {
      const isSuspended = this.filters.suspended === "true";
      filtered = filtered.filter(u => !!u.is_suspended === isSuspended);
    }

    // Has Username
    if (this.filters.hasUsername !== "all") {
      const has = this.filters.hasUsername === "true";
      filtered = filtered.filter(u => !!u.username === has);
    }

    // Date Range
    if (this.filters.dateStart) {
      const start = new Date(this.filters.dateStart).getTime();
      filtered = filtered.filter(u => u.created_at?.toMillis() >= start);
    }
    if (this.filters.dateEnd) {
      const end = new Date(this.filters.dateEnd).getTime();
      // Add one day to end date to include the whole day
      filtered = filtered.filter(u => u.created_at?.toMillis() <= (end + 86400000));
    }

    // Sorting
    filtered.sort((a, b) => {
      switch (this.filters.sortBy) {
        case "newest":
          return (b.created_at?.toMillis() || 0) - (a.created_at?.toMillis() || 0);
        case "oldest":
          return (a.created_at?.toMillis() || 0) - (b.created_at?.toMillis() || 0);
        case "lastActive":
          return (b.updated_at?.toMillis() || 0) - (a.updated_at?.toMillis() || 0);
        case "nameAZ":
          return (a.display_name || "").localeCompare(b.display_name || "");
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
    if (auth.currentUser.uid === uid) {
      console.warn("User tried to delete themselves. Operation blocked.");
      throw new Error("You cannot delete yourself.");
    }
    console.log(`Calling deleteUserFully Cloud Function for UID: ${uid}`);
    const result = await this.deleteUserFully({ uid, username });
    return result.data;
  }

  async toggleUserSuspension(uid, isSuspended) {
    console.log(`Toggling suspension for UID: ${uid} to ${!isSuspended}`);
    const userRef = doc(db, "users", uid);
    await updateDoc(userRef, {
      is_suspended: !isSuspended,
      updated_at: Timestamp.now()
    });
    return { success: true, is_suspended: !isSuspended };
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
  }
}

export const userManager = new UserManagement();
