/**
 * manager.js — LaynFleet Manager console (isolated static app).
 *
 * Responsibilities:
 *   - Gate access to the single manager account (MANAGER_EMAIL).
 *   - Live-list driver applications and approve / reject them (atomic batch:
 *     flips laynfleet/main/drivers/{uid}.approvalStatus AND
 *     users/{uid}.applications.laynFleet.isDriver, per the locked schema).
 *   - Live-list riders/members and globally suspend / reactivate them
 *     (users/{uid}.suspended + suspendedReason).
 *   - Live-list bookings (read-only for now; dispatch engine writes these later).
 *
 * SECURITY NOTE: the email gate below is CLIENT-SIDE only. Real enforcement
 * requires the Firestore security rules (currently deferred / open dev rules).
 * Until those ship, anyone who authenticates could in theory write — the gate
 * here is convenience + UX, not a security boundary. Do not treat as hardened.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Firebase init (own isolated app instance)
  // ---------------------------------------------------------------------------
  firebase.initializeApp(window.LAYNFLEET_FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;

  const driversCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.drivers);
  const ridersCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.riders);
  const bookingsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.bookings);
  const usersCol = db.collection(FS.users);

  // ---------------------------------------------------------------------------
  // Tiny DOM helpers
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove('is-hidden');
  const hide = (el) => el && el.classList.add('is-hidden');

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function formatDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : (typeof ts === 'number' ? new Date(ts) : null);
    if (!d || isNaN(d)) return '—';
    return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }

  function formatZar(amount) {
    if (amount == null || isNaN(amount)) return '—';
    return 'R' + Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function titleCase(value) {
    return String(value || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // Toast + image viewer
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el), 3200);
  }

  $('image-overlay').addEventListener('click', () => hide($('image-overlay')));
  function viewImage(url) {
    if (!url) return;
    $('image-full').src = url;
    show($('image-overlay'));
  }

  // ---------------------------------------------------------------------------
  // Modal (promise-based confirm, with optional reason field)
  // ---------------------------------------------------------------------------
  function openModal({ title, message, confirmText, confirmClass, requireReason }) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-message').textContent = message;
      const confirmBtn = $('modal-confirm');
      confirmBtn.textContent = confirmText || 'Confirm';
      confirmBtn.className = 'btn ' + (confirmClass || 'btn-primary');

      const reasonWrap = $('modal-reason-wrap');
      const reasonInput = $('modal-reason');
      reasonInput.value = '';
      if (requireReason) show(reasonWrap); else hide(reasonWrap);

      show($('modal-overlay'));
      if (requireReason) setTimeout(() => reasonInput.focus(), 50);

      function cleanup(result) {
        hide($('modal-overlay'));
        confirmBtn.removeEventListener('click', onConfirm);
        $('modal-cancel').removeEventListener('click', onCancel);
        resolve(result);
      }
      function onConfirm() {
        if (requireReason && !reasonInput.value.trim()) {
          reasonInput.focus();
          reasonInput.classList.add('field-input');
          toast('A reason is required.', 'error');
          return;
        }
        cleanup({ confirmed: true, reason: reasonInput.value.trim() });
      }
      function onCancel() { cleanup({ confirmed: false }); }

      confirmBtn.addEventListener('click', onConfirm);
      $('modal-cancel').addEventListener('click', onCancel);
    });
  }

  // ---------------------------------------------------------------------------
  // Users cache (join identity onto driver docs without repeated reads)
  // ---------------------------------------------------------------------------
  const userCache = new Map(); // uid -> user data (or null)
  async function getUser(uid) {
    if (!uid) return null;
    if (userCache.has(uid)) return userCache.get(uid);
    try {
      const snap = await usersCol.doc(uid).get();
      const data = snap.exists ? snap.data() : null;
      userCache.set(uid, data);
      return data;
    } catch (err) {
      console.error('getUser failed', uid, err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------
  const state = {
    drivers: [],       // [{ uid, ...driverDoc, user }]
    riders: [],        // [{ uid, ...userDoc }]
    bookings: [],      // [{ id, ...bookingDoc }]
    driverTab: 'PENDING',
    section: 'overview',
    search: ''
  };
  const unsub = []; // active snapshot listeners

  // ---------------------------------------------------------------------------
  // AUTH GATE
  // ---------------------------------------------------------------------------
  auth.onAuthStateChanged(async (user) => {
    hide($('boot-view'));
    if (!user) return showLogin();

    if ((user.email || '').toLowerCase() !== String(MANAGER_EMAIL).toLowerCase()) {
      // Wrong account — reject and sign out.
      await auth.signOut();
      showLogin('This account is not authorised for the manager console.');
      return;
    }
    showApp(user);
  });

  function showLogin(errorMsg) {
    detachListeners();
    hide($('app-view'));
    show($('login-view'));
    const err = $('login-error');
    if (errorMsg) { err.textContent = errorMsg; show(err); } else { hide(err); }
  }

  function showApp(user) {
    hide($('login-view'));
    show($('app-view'));
    $('sidebar-email').textContent = user.email;
    $('sidebar-avatar').textContent = initials(user.displayName || user.email);
    attachListeners();
  }

  // ---------------------------------------------------------------------------
  // LOGIN / LOGOUT
  // ---------------------------------------------------------------------------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    const btn = $('login-submit');
    hide($('login-error'));

    if (email.toLowerCase() !== String(MANAGER_EMAIL).toLowerCase()) {
      const err = $('login-error');
      err.textContent = 'This account is not authorised for the manager console.';
      show(err);
      return;
    }

    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged takes over from here.
    } catch (err) {
      console.error(err);
      const el = $('login-error');
      el.textContent = friendlyAuthError(err);
      show(el);
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  $('logout-btn').addEventListener('click', () => auth.signOut());

  function friendlyAuthError(err) {
    switch (err && err.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found': return 'Incorrect email or password.';
      case 'auth/too-many-requests': return 'Too many attempts. Try again shortly.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      default: return 'Could not sign in. Please try again.';
    }
  }

  // ---------------------------------------------------------------------------
  // LIVE LISTENERS
  // ---------------------------------------------------------------------------
  function attachListeners() {
    detachListeners();

    // Drivers (application docs = the drivers collection).
    unsub.push(driversCol.onSnapshot(async (snap) => {
      const docs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      // Join identity for each driver.
      await Promise.all(docs.map(async (d) => { d.user = await getUser(d.uid); }));
      state.drivers = docs;
      renderDrivers();
      renderOverview();
    }, (err) => {
      console.error('drivers listener', err);
      toast('Failed to load drivers (check access).', 'error');
    }));

    // Riders — ONLY those who have initiated a ride request. The rider doc at
    // laynfleet/main/riders/{uid} is created on the first request, so this list
    // stays empty until riders actually start booking (identity joined on read).
    unsub.push(ridersCol.onSnapshot(async (snap) => {
      const docs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      await Promise.all(docs.map(async (r) => { r.user = await getUser(r.uid); }));
      state.riders = docs;
      renderRiders();
      renderOverview();
    }, (err) => {
      console.warn('riders listener', err);
      state.riders = [];
      renderRiders();
    }));

    // Bookings (read-only; dispatch engine populates these later).
    unsub.push(
      bookingsCol.orderBy('createdAt', 'desc').limit(200).onSnapshot((snap) => {
        state.bookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderBookings();
        renderOverview();
      }, (err) => {
        // Likely just "no bookings / no index yet" — degrade quietly.
        console.warn('bookings listener', err);
        state.bookings = [];
        renderBookings();
      })
    );
  }

  function detachListeners() {
    while (unsub.length) { try { unsub.pop()(); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------------
  // RENDER: overview
  // ---------------------------------------------------------------------------
  function renderOverview() {
    const pending = state.drivers.filter((d) => d.approvalStatus === 'PENDING');
    const approved = state.drivers.filter((d) => d.approvalStatus === 'APPROVED');
    const onlineCount = approved.filter((d) => d.online === true).length;
    const activeBookings = state.bookings.filter((b) =>
      ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'QUOTED', 'PENDING'].includes(b.status)).length;

    $('stat-pending').textContent = pending.length;
    $('stat-approved').textContent = approved.length;
    $('stat-online-hint').textContent = onlineCount + ' online now';
    $('stat-riders').textContent = state.riders.length;
    $('stat-bookings').textContent = activeBookings;

    const badge = $('nav-badge-drivers');
    if (pending.length) { badge.textContent = pending.length; show(badge); } else { hide(badge); }

    const host = $('overview-pending');
    if (!pending.length) {
      host.innerHTML = emptyState('✅', 'No pending applications', 'New driver applications will appear here.');
      return;
    }
    host.innerHTML = pending.slice(0, 5).map(driverCardHtml).join('');
    wireDriverCardActions(host);
  }

  // ---------------------------------------------------------------------------
  // RENDER: drivers
  // ---------------------------------------------------------------------------
  function renderDrivers() {
    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    state.drivers.forEach((d) => { counts[d.approvalStatus] = (counts[d.approvalStatus] || 0) + 1; });
    $('count-pending').textContent = counts.PENDING || 0;
    $('count-approved').textContent = counts.APPROVED || 0;
    $('count-rejected').textContent = counts.REJECTED || 0;

    const term = state.search.toLowerCase();
    const list = state.drivers
      .filter((d) => d.approvalStatus === state.driverTab)
      .filter((d) => matchesDriver(d, term));

    const host = $('drivers-list');
    if (!list.length) {
      host.innerHTML = emptyState('🚗', 'Nothing here', 'No ' + state.driverTab.toLowerCase() + ' drivers' + (term ? ' matching your search.' : '.'));
      return;
    }
    host.innerHTML = list.map(driverCardHtml).join('');
    wireDriverCardActions(host);
  }

  function matchesDriver(d, term) {
    if (!term) return true;
    const v = d.vehicle || {};
    const u = d.user || {};
    return [u.displayName, u.phone, v.make, v.model, v.plate, v.colour]
      .some((x) => String(x || '').toLowerCase().includes(term));
  }

  function driverCardHtml(d) {
    const u = d.user || {};
    const v = d.vehicle || {};
    const name = u.displayName || 'Unnamed driver';
    const photo = u.photoUrl;
    const avatar = photo
      ? `<img class="avatar" src="${escapeHtml(photo)}" alt="" />`
      : `<div class="avatar">${escapeHtml(initials(name))}</div>`;

    const statusBadge = {
      PENDING: '<span class="badge badge-pending">Pending</span>',
      APPROVED: '<span class="badge badge-approved">Approved</span>',
      REJECTED: '<span class="badge badge-rejected">Rejected</span>'
    }[d.approvalStatus] || '';

    const onlineBadge = d.approvalStatus === 'APPROVED'
      ? (d.online ? '<span class="badge badge-online">Online</span>' : '<span class="badge badge-offline">Offline</span>')
      : '';
    const suspendedBadge = u.suspended ? '<span class="badge badge-suspended">Suspended</span>' : '';
    const ratingBadge = d.ratingCount
      ? `<span class="badge badge-rating">★ ${Number(d.ratingAvg || 0).toFixed(1)} · ${d.ratingCount}</span>`
      : '';

    const vehicleType = v.type ? titleCase(String(v.type).replace(/_/g, ' ')) : '—';
    const vehicleLine = [v.make, v.model].filter(Boolean).join(' ') || 'Vehicle not set';
    const licence = d.licenceUrl
      ? `<img class="doc-thumb" src="${escapeHtml(d.licenceUrl)}" alt="Licence" data-view="${escapeHtml(d.licenceUrl)}" title="View licence" />`
      : '<span class="driver-sub">No licence photo</span>';

    let actions = '';
    if (d.approvalStatus === 'PENDING') {
      actions = `
        <button class="btn btn-success btn-sm" data-approve="${escapeHtml(d.uid)}">Approve</button>
        <button class="btn btn-danger btn-sm" data-reject="${escapeHtml(d.uid)}">Reject</button>`;
    } else if (d.approvalStatus === 'APPROVED') {
      actions = u.suspended
        ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(d.uid)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(d.uid)}">Suspend</button>`;
    } else if (d.approvalStatus === 'REJECTED') {
      actions = `<span class="driver-sub">${escapeHtml(d.rejectedReason || 'Rejected — terminal')}</span>`;
    }

    return `
      <div class="driver-card">
        ${avatar}
        <div class="driver-info">
          <div class="driver-name">${escapeHtml(name)} ${statusBadge} ${onlineBadge} ${suspendedBadge} ${ratingBadge}</div>
          <div class="driver-meta">
            <span>📞 ${escapeHtml(u.phone || '—')}</span>
            <span>🚘 ${escapeHtml(vehicleType)} · ${escapeHtml(vehicleLine)}</span>
            <span>🎨 ${escapeHtml(v.colour || '—')}</span>
            <span>🔢 ${escapeHtml(v.plate || '—')}</span>
            <span>💺 ${escapeHtml(v.seats != null ? v.seats : '—')}</span>
          </div>
          <div class="driver-sub">Applied ${escapeHtml(formatDate(d.createdAt))}${d.legitAcceptedAt ? ' · accepted terms' : ''}</div>
          <span class="uid-chip" data-copy="${escapeHtml(d.uid)}" title="Copy UID">${escapeHtml(d.uid)}</span>
        </div>
        <div class="driver-actions">
          ${licence}
          ${actions}
        </div>
      </div>`;
  }

  function wireDriverCardActions(host) {
    host.querySelectorAll('[data-approve]').forEach((b) =>
      b.addEventListener('click', () => approveDriver(b.getAttribute('data-approve'))));
    host.querySelectorAll('[data-reject]').forEach((b) =>
      b.addEventListener('click', () => rejectDriver(b.getAttribute('data-reject'))));
    host.querySelectorAll('[data-suspend]').forEach((b) =>
      b.addEventListener('click', () => suspendUser(b.getAttribute('data-suspend'))));
    host.querySelectorAll('[data-reactivate]').forEach((b) =>
      b.addEventListener('click', () => reactivateUser(b.getAttribute('data-reactivate'))));
    host.querySelectorAll('[data-view]').forEach((img) =>
      img.addEventListener('click', () => viewImage(img.getAttribute('data-view'))));
  }

  // ---------------------------------------------------------------------------
  // RENDER: riders (users table)
  // ---------------------------------------------------------------------------
  function renderRiders() {
    const term = state.search.toLowerCase();
    const list = state.riders.filter((r) => {
      const u = r.user || {};
      return !term || [u.displayName, u.phone, u.email, r.uid].some((x) => String(x || '').toLowerCase().includes(term));
    });

    const host = $('riders-list');
    if (!list.length) {
      host.innerHTML = emptyState('🧑', 'No riders yet', 'A rider appears here only after they send their first ride request.');
      return;
    }

    const rows = list.map((r) => {
      const u = r.user || {};
      const isDriver = u.applications && u.applications.laynFleet && u.applications.laynFleet.isDriver;
      const avatar = u.photoUrl
        ? `<img class="row-avatar" src="${escapeHtml(u.photoUrl)}" alt="" />`
        : `<div class="row-avatar">${escapeHtml(initials(u.displayName || u.email))}</div>`;
      const statusBadge = u.suspended
        ? '<span class="badge badge-suspended">Suspended</span>'
        : '<span class="badge badge-approved">Active</span>';
      const driverBadge = isDriver ? '<span class="badge badge-driver">Driver</span>' : '';
      const rating = r.ratingCount
        ? `★ ${Number(r.ratingAvg || 0).toFixed(1)} · ${r.ratingCount}`
        : 'No ratings';
      const action = u.suspended
        ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(r.uid)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(r.uid)}">Suspend</button>`;
      return `
        <tr>
          <td>
            <div class="row-user">${avatar}
              <div>
                <div class="cell-strong">${escapeHtml(u.displayName || 'Unnamed')} ${driverBadge}</div>
                <div class="cell-dim">${escapeHtml(u.email || '—')}</div>
                <span class="uid-chip" data-copy="${escapeHtml(r.uid)}" title="Copy UID">${escapeHtml(r.uid)}</span>
              </div>
            </div>
          </td>
          <td class="cell-dim">${escapeHtml(u.phone || '—')}</td>
          <td class="cell-dim">${escapeHtml(rating)}</td>
          <td>${statusBadge}${u.suspended && u.suspendedReason ? `<div class="cell-dim">${escapeHtml(u.suspendedReason)}</div>` : ''}</td>
          <td style="text-align:right">${action}</td>
        </tr>`;
    }).join('');

    host.innerHTML = `
      <table>
        <thead><tr><th>Rider</th><th>Phone</th><th>Rating</th><th>Status</th><th style="text-align:right">Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    host.querySelectorAll('[data-suspend]').forEach((b) =>
      b.addEventListener('click', () => suspendUser(b.getAttribute('data-suspend'))));
    host.querySelectorAll('[data-reactivate]').forEach((b) =>
      b.addEventListener('click', () => reactivateUser(b.getAttribute('data-reactivate'))));
  }

  // ---------------------------------------------------------------------------
  // RENDER: bookings (read-only)
  // ---------------------------------------------------------------------------
  function renderBookings() {
    const term = state.search.toLowerCase();
    const list = state.bookings.filter((b) =>
      !term || [b.riderId, b.driverId, b.status].some((x) => String(x || '').toLowerCase().includes(term)));

    const host = $('bookings-list');
    if (!list.length) {
      host.innerHTML = emptyState('🧾', 'No bookings yet', 'Bookings appear here once the dispatch engine is live.');
      return;
    }

    const rows = list.map((b) => {
      const rider = userCache.get(b.riderId);
      const driver = userCache.get(b.driverId);
      return `
        <tr>
          <td class="cell-dim">${escapeHtml((b.id || '').slice(0, 8))}</td>
          <td class="cell-strong">${escapeHtml(rider ? rider.displayName : (b.riderId || '—'))}</td>
          <td>${escapeHtml(driver ? driver.displayName : (b.driverId || '—'))}</td>
          <td>${escapeHtml(b.type || '—')}</td>
          <td>${statusBadgeHtml(b.status)}</td>
          <td>${escapeHtml(formatZar(b.quotedPrice))}</td>
          <td class="cell-dim">${escapeHtml(formatDate(b.createdAt))}</td>
        </tr>`;
    }).join('');

    host.innerHTML = `
      <table>
        <thead><tr><th>ID</th><th>Rider</th><th>Driver</th><th>Type</th><th>Status</th><th>Price</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function statusBadgeHtml(status) {
    const map = {
      PENDING: 'badge-pending', QUOTED: 'badge-pending',
      ACCEPTED: 'badge-driver', EN_ROUTE: 'badge-driver', ARRIVED: 'badge-driver', IN_TRIP: 'badge-driver',
      COMPLETED: 'badge-approved',
      CANCELLED: 'badge-rejected', CANCELLED_NO_DRIVER: 'badge-rejected'
    };
    const cls = map[status] || 'badge-offline';
    return `<span class="badge ${cls}">${escapeHtml(titleCase(String(status || 'unknown').replace(/_/g, ' ')))}</span>`;
  }

  function emptyState(glyph, title, hint) {
    return `<div class="empty"><span class="empty-glyph">${glyph}</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></div>`;
  }

  // ---------------------------------------------------------------------------
  // ACTIONS (writes)
  // ---------------------------------------------------------------------------
  async function approveDriver(uid) {
    const d = state.drivers.find((x) => x.uid === uid);
    const name = (d && d.user && d.user.displayName) || 'this driver';
    const res = await openModal({
      title: 'Approve driver',
      message: `Approve ${name}? They will be able to go online and receive ride requests.`,
      confirmText: 'Approve', confirmClass: 'btn-success'
    });
    if (!res.confirmed) return;

    try {
      const batch = db.batch();
      batch.update(driversCol.doc(uid), {
        approvalStatus: 'APPROVED',
        approvedBy: MANAGER_EMAIL,
        approvedAt: serverTimestamp(),
        rejectedReason: firebase.firestore.FieldValue.delete()
      });
      batch.set(usersCol.doc(uid), {
        applications: { laynFleet: { isDriver: true } }
      }, { merge: true });
      await batch.commit();
      userCache.delete(uid); // force fresh identity join
      await logAdminAction('approveDriver', uid, name);
      toast(`Approved ${name}.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Approval failed. ' + (err.code || ''), 'error');
    }
  }

  async function rejectDriver(uid) {
    const d = state.drivers.find((x) => x.uid === uid);
    const name = (d && d.user && d.user.displayName) || 'this driver';
    const res = await openModal({
      title: 'Reject application',
      message: `Reject ${name}? This is final — a rejected driver cannot re-apply and must contact support.`,
      confirmText: 'Reject', confirmClass: 'btn-danger', requireReason: true
    });
    if (!res.confirmed) return;

    try {
      const batch = db.batch();
      batch.update(driversCol.doc(uid), {
        approvalStatus: 'REJECTED',
        rejectedReason: res.reason,
        approvedBy: MANAGER_EMAIL,
        approvedAt: serverTimestamp()
      });
      batch.set(usersCol.doc(uid), {
        applications: { laynFleet: { isDriver: false } }
      }, { merge: true });
      await batch.commit();
      await logAdminAction('rejectDriver', uid, name, res.reason);
      toast(`Rejected ${name}.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Rejection failed. ' + (err.code || ''), 'error');
    }
  }

  async function suspendUser(uid) {
    const u = userCache.get(uid) || {};
    const name = u.displayName || 'this member';
    const res = await openModal({
      title: 'Suspend account',
      message: `Suspend ${name}? This is a GLOBAL block across all Digilayn apps — they cannot log in or book until reactivated.`,
      confirmText: 'Suspend', confirmClass: 'btn-danger', requireReason: true
    });
    if (!res.confirmed) return;

    try {
      await usersCol.doc(uid).set({ suspended: true, suspendedReason: res.reason }, { merge: true });
      userCache.delete(uid);
      await logAdminAction('suspendUser', uid, name, res.reason);
      toast(`Suspended ${name}.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Suspend failed. ' + (err.code || ''), 'error');
    }
  }

  async function reactivateUser(uid) {
    const u = userCache.get(uid) || {};
    const name = u.displayName || 'this member';
    const res = await openModal({
      title: 'Reactivate account',
      message: `Reactivate ${name}? They will regain access immediately.`,
      confirmText: 'Reactivate', confirmClass: 'btn-primary'
    });
    if (!res.confirmed) return;

    try {
      await usersCol.doc(uid).set({ suspended: false, suspendedReason: '' }, { merge: true });
      userCache.delete(uid);
      await logAdminAction('reactivateUser', uid, name);
      toast(`Reactivated ${name}.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Reactivate failed. ' + (err.code || ''), 'error');
    }
  }

  /** Best-effort audit trail (non-blocking — never fails the primary action). */
  async function logAdminAction(action, targetUid, targetName, reason) {
    try {
      await db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.adminActions).add({
        adminEmail: MANAGER_EMAIL,
        action,
        targetUid,
        targetName: targetName || '',
        reason: reason || '',
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.warn('audit log failed (non-fatal)', err);
    }
  }

  // ---------------------------------------------------------------------------
  // NAVIGATION + SEARCH
  // ---------------------------------------------------------------------------
  const sectionMeta = {
    overview: ['Overview', 'Live operations across LaynFleet'],
    drivers: ['Drivers', 'Approve applications and manage the fleet'],
    riders: ['Riders', 'Registered members and account status'],
    bookings: ['Bookings', 'Live and historical rides']
  };

  function goToSection(name) {
    state.section = name;
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('is-active', b.getAttribute('data-section') === name));
    document.querySelectorAll('.section').forEach((s) =>
      s.classList.toggle('is-active', s.id === 'section-' + name));
    const [title, sub] = sectionMeta[name] || ['', ''];
    $('section-title').textContent = title;
    $('section-subtitle').textContent = sub;
  }

  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => goToSection(b.getAttribute('data-section'))));
  document.querySelectorAll('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => goToSection(b.getAttribute('data-goto'))));

  document.querySelectorAll('[data-driver-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.driverTab = b.getAttribute('data-driver-tab');
      document.querySelectorAll('[data-driver-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === b));
      renderDrivers();
    }));

  $('search-input').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderDrivers();
    renderRiders();
    renderBookings();
  });

  // Click-to-copy UID chips (event delegation — works for re-rendered rows).
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-copy]');
    if (!chip) return;
    const value = chip.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => toast('UID copied.', 'success')).catch(() => {});
    }
  });

  // ESC closes overlays.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hide($('image-overlay'));
    if (!$('modal-overlay').classList.contains('is-hidden')) $('modal-cancel').click();
  });
})();
