/**
 * manager.js — LaynFleet Manager console (isolated static app).
 *
 * Responsibilities:
 *   - Gate access to the single manager account (MANAGER_EMAIL).
 *   - Live-list driver applications and approve / reject / demote them (atomic batch:
 *     flips laynfleet/main/drivers/{uid}.approvalStatus AND
 *     users/{uid}.applications.laynFleet.isDriver, per the locked schema).
 *   - Live-list riders/members and globally suspend / reactivate them
 *     (users/{uid}.suspended + suspendedReason), and demote drivers from rider table.
 *   - Live-list bookings with rich, multi-criteria filtering, status tabs, and detail views.
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
    const d = ts.toDate ? ts.toDate() : (typeof ts === 'number' ? new Date(ts) : (ts instanceof Date ? ts : null));
    if (!d || isNaN(d.getTime())) return '—';
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

  function isBookingActive(status) {
    return ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'QUOTED', 'PENDING'].includes(status);
  }

  function getBookingDate(b) {
    const ts = b && b.createdAt;
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (typeof ts === 'number') return new Date(ts);
    if (ts instanceof Date) return ts;
    if (typeof ts === 'string') {
      const parsed = new Date(ts);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function getBookingPrice(b) {
    if (!b) return 0;
    const val = b.quotedPrice != null ? b.quotedPrice : (b.fare != null ? b.fare : (b.amount != null ? b.amount : b.price));
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }

  // ---------------------------------------------------------------------------
  // Toast + image viewer
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    if (!el) return;
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
    search: '',
    bookingFilters: {
      quickTab: 'all',          // 'all', 'active', 'COMPLETED', 'CANCELLED'
      status: 'all',            // 'all', 'active', 'PENDING', 'QUOTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'COMPLETED', 'CANCELLED'
      type: 'all',              // 'all', 'STANDARD', 'XL', ...
      driverAssigned: 'all',    // 'all', 'assigned', 'unassigned'
      datePreset: 'all',        // 'all', 'today', 'yesterday', '7days', '30days', 'custom'
      dateStart: '',            // YYYY-MM-DD
      dateEnd: '',              // YYYY-MM-DD
      priceMin: '',             // number or ''
      priceMax: '',             // number or ''
      sortBy: 'newest',         // 'newest', 'oldest', 'price-desc', 'price-asc'
      search: ''                // booking search input
    }
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

    // Riders — ONLY those who have initiated a ride request.
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

    // Bookings (read-only; dispatch engine populates these).
    unsub.push(
      bookingsCol.orderBy('createdAt', 'desc').limit(200).onSnapshot(async (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        // Preload identities for participants
        await Promise.all(docs.map(async (b) => {
          if (b.riderId && !userCache.has(b.riderId)) await getUser(b.riderId);
          if (b.driverId && !userCache.has(b.driverId)) await getUser(b.driverId);
        }));
        state.bookings = docs;
        updateBookingTypeOptions();
        renderBookings();
        renderOverview();
      }, (err) => {
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
    const activeBookings = state.bookings.filter((b) => isBookingActive(b.status)).length;

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
    const counts = { PENDING: 0, APPROVED: 0, DEMOTED: 0, REJECTED: 0 };
    state.drivers.forEach((d) => { counts[d.approvalStatus] = (counts[d.approvalStatus] || 0) + 1; });
    $('count-pending').textContent = counts.PENDING || 0;
    $('count-approved').textContent = counts.APPROVED || 0;
    if ($('count-demoted')) $('count-demoted').textContent = counts.DEMOTED || 0;
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
    return [u.displayName, u.phone, v.make, v.model, v.plate, v.colour, d.uid]
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
      DEMOTED: '<span class="badge badge-demoted">Demoted</span>',
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
      const suspendBtn = u.suspended
        ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(d.uid)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(d.uid)}">Suspend</button>`;
      actions = `
        <button class="btn btn-warn btn-sm" data-demote="${escapeHtml(d.uid)}" title="Demote driver to normal user">Demote</button>
        ${suspendBtn}`;
    } else if (d.approvalStatus === 'DEMOTED') {
      actions = `
        <button class="btn btn-success btn-sm" data-approve="${escapeHtml(d.uid)}" title="Re-approve driver">Re-approve</button>
        <button class="btn btn-danger btn-sm" data-reject="${escapeHtml(d.uid)}">Reject</button>`;
    } else if (d.approvalStatus === 'REJECTED') {
      actions = `
        <button class="btn btn-ghost btn-sm" data-approve="${escapeHtml(d.uid)}" title="Re-approve driver">Re-approve</button>
        <span class="driver-sub">${escapeHtml(d.rejectedReason || 'Rejected — terminal')}</span>`;
    }

    let subLine = `Applied ${escapeHtml(formatDate(d.createdAt))}${d.legitAcceptedAt ? ' · accepted terms' : ''}`;
    if (d.approvalStatus === 'DEMOTED') {
      subLine = `Demoted ${escapeHtml(formatDate(d.demotedAt))}${d.demoteReason ? ` · Reason: ${escapeHtml(d.demoteReason)}` : ''}`;
    } else if (d.approvalStatus === 'APPROVED' && d.approvedAt) {
      subLine = `Approved ${escapeHtml(formatDate(d.approvedAt))}${d.approvedBy ? ` by ${escapeHtml(d.approvedBy)}` : ''}`;
    } else if (d.approvalStatus === 'REJECTED') {
      subLine = `Rejected ${escapeHtml(formatDate(d.approvedAt || d.updatedAt))}${d.rejectedReason ? ` · Reason: ${escapeHtml(d.rejectedReason)}` : ''}`;
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
          <div class="driver-sub">${subLine}</div>
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
    host.querySelectorAll('[data-demote]').forEach((b) =>
      b.addEventListener('click', () => demoteDriver(b.getAttribute('data-demote'))));
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
      const suspendAction = u.suspended
        ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(r.uid)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(r.uid)}">Suspend</button>`;
      const demoteAction = isDriver
        ? `<button class="btn btn-warn btn-sm" data-demote="${escapeHtml(r.uid)}" title="Demote driver to normal user">Demote</button>`
        : '';
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
          <td style="text-align:right">
            <div style="display:flex;gap:6px;justify-content:flex-end;">
              ${demoteAction}
              ${suspendAction}
            </div>
          </td>
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
    host.querySelectorAll('[data-demote]').forEach((b) =>
      b.addEventListener('click', () => demoteDriver(b.getAttribute('data-demote'))));
  }

  // ---------------------------------------------------------------------------
  // RENDER: bookings with filters
  // ---------------------------------------------------------------------------
  function updateBookingTypeOptions() {
    const select = $('booking-filter-type');
    if (!select) return;
    const current = select.value;
    const defaultTypes = ['STANDARD', 'XL', 'PREMIUM', 'DELIVERY', 'TUKTUK'];
    const dynamicTypes = new Set(defaultTypes);
    state.bookings.forEach((b) => {
      if (b.type) dynamicTypes.add(String(b.type).toUpperCase());
    });

    const opts = ['<option value="all">All Types</option>'];
    Array.from(dynamicTypes).sort().forEach((t) => {
      opts.push(`<option value="${escapeHtml(t)}">${escapeHtml(titleCase(t.replace(/_/g, ' ')))}</option>`);
    });
    select.innerHTML = opts.join('');
    if (Array.from(dynamicTypes).includes(current) || current === 'all') {
      select.value = current;
    }
  }

  function renderBookings() {
    const bf = state.bookingFilters;

    // Quick Tab counts on entire bookings list
    const totalCount = state.bookings.length;
    const activeCount = state.bookings.filter((b) => isBookingActive(b.status)).length;
    const completedCount = state.bookings.filter((b) => b.status === 'COMPLETED').length;
    const cancelledCount = state.bookings.filter((b) => String(b.status || '').startsWith('CANCELLED')).length;

    if ($('count-booking-all')) $('count-booking-all').textContent = totalCount;
    if ($('count-booking-active')) $('count-booking-active').textContent = activeCount;
    if ($('count-booking-completed')) $('count-booking-completed').textContent = completedCount;
    if ($('count-booking-cancelled')) $('count-booking-cancelled').textContent = cancelledCount;

    // Search query (from booking-specific search or global topbar search)
    const term = (bf.search || state.search || '').trim().toLowerCase();

    // Compute Date Range Boundaries for presets
    const now = new Date();
    let startDate = null;
    let endDate = null;

    if (bf.datePreset === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    } else if (bf.datePreset === 'yesterday') {
      const y = new Date(now.getTime() - 86400000);
      startDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0, 0);
      endDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999);
    } else if (bf.datePreset === '7days') {
      startDate = new Date(now.getTime() - 7 * 86400000);
    } else if (bf.datePreset === '30days') {
      startDate = new Date(now.getTime() - 30 * 86400000);
    } else if (bf.datePreset === 'custom' || bf.dateStart || bf.dateEnd) {
      if (bf.dateStart) startDate = new Date(bf.dateStart + 'T00:00:00');
      if (bf.dateEnd) endDate = new Date(bf.dateEnd + 'T23:59:59.999');
    }

    const priceMin = bf.priceMin !== '' && !isNaN(bf.priceMin) ? parseFloat(bf.priceMin) : null;
    const priceMax = bf.priceMax !== '' && !isNaN(bf.priceMax) ? parseFloat(bf.priceMax) : null;

    // Filter pipeline
    let list = state.bookings.filter((b) => {
      // 1. Quick Tab filter
      if (bf.quickTab === 'active' && !isBookingActive(b.status)) return false;
      if (bf.quickTab === 'COMPLETED' && b.status !== 'COMPLETED') return false;
      if (bf.quickTab === 'CANCELLED' && !String(b.status || '').startsWith('CANCELLED')) return false;

      // 2. Specific Status filter
      if (bf.status !== 'all') {
        if (bf.status === 'active' && !isBookingActive(b.status)) return false;
        else if (bf.status === 'CANCELLED' && !String(b.status || '').startsWith('CANCELLED')) return false;
        else if (bf.status !== 'active' && bf.status !== 'CANCELLED' && b.status !== bf.status) return false;
      }

      // 3. Type filter
      if (bf.type !== 'all') {
        if (String(b.type || '').toUpperCase() !== bf.type.toUpperCase()) return false;
      }

      // 4. Driver Assignment filter
      if (bf.driverAssigned === 'assigned' && (!b.driverId || !b.driverId.trim())) return false;
      if (bf.driverAssigned === 'unassigned' && b.driverId && b.driverId.trim()) return false;

      // 5. Date filter
      const bDate = getBookingDate(b);
      if (startDate && (!bDate || bDate < startDate)) return false;
      if (endDate && (!bDate || bDate > endDate)) return false;

      // 6. Fare / Price filter
      const price = getBookingPrice(b);
      if (priceMin != null && price < priceMin) return false;
      if (priceMax != null && price > priceMax) return false;

      // 7. Search filter
      if (term) {
        const rider = userCache.get(b.riderId) || {};
        const driver = userCache.get(b.driverId) || {};
        const pickup = b.pickupAddress || (b.pickup && b.pickup.address) || '';
        const dest = b.dropoffAddress || (b.destination && b.destination.address) || '';
        const matches = [
          b.id,
          b.status,
          b.type,
          b.riderId,
          rider.displayName,
          rider.phone,
          rider.email,
          b.driverId,
          driver.displayName,
          driver.phone,
          pickup,
          dest
        ].some((x) => String(x || '').toLowerCase().includes(term));
        if (!matches) return false;
      }

      return true;
    });

    // Sorting
    list.sort((a, b) => {
      const dateA = (getBookingDate(a) || new Date(0)).getTime();
      const dateB = (getBookingDate(b) || new Date(0)).getTime();
      const priceA = getBookingPrice(a);
      const priceB = getBookingPrice(b);

      switch (bf.sortBy) {
        case 'oldest': return dateA - dateB;
        case 'price-desc': return priceB - priceA;
        case 'price-asc': return priceA - priceB;
        case 'newest':
        default:
          return dateB - dateA;
      }
    });

    // Summary calculation
    const totalValue = list.reduce((sum, b) => sum + getBookingPrice(b), 0);
    const summaryEl = $('booking-filter-summary');
    if (summaryEl) {
      const hasActiveFilters = bf.quickTab !== 'all' || bf.status !== 'all' || bf.type !== 'all' ||
        bf.driverAssigned !== 'all' || bf.datePreset !== 'all' || bf.dateStart || bf.dateEnd ||
        bf.priceMin !== '' || bf.priceMax !== '' || term;

      summaryEl.innerHTML = `
        <span>Showing <strong class="filter-summary-highlight">${list.length}</strong> of ${state.bookings.length} bookings</span>
        <span>·</span>
        <span>Total Value: <strong class="filter-summary-highlight">${formatZar(totalValue)}</strong></span>
        ${hasActiveFilters ? '<span class="badge badge-pending">Filtered</span>' : ''}`;
    }

    const host = $('bookings-list');
    if (!host) return;

    if (!list.length) {
      host.innerHTML = emptyState(
        '🧾',
        state.bookings.length ? 'No bookings match filters' : 'No bookings yet',
        state.bookings.length ? 'Try adjusting your search criteria or resetting filters.' : 'Bookings appear here once ride requests are placed.'
      );
      return;
    }

    const rows = list.map((b) => {
      const rider = userCache.get(b.riderId) || {};
      const driver = userCache.get(b.driverId) || {};
      const riderName = rider.displayName || (b.riderId ? `UID: ${b.riderId.slice(0, 6)}…` : '—');
      const driverName = driver.displayName || (b.driverId ? `UID: ${b.driverId.slice(0, 6)}…` : null);
      const price = getBookingPrice(b);
      const typeStr = b.type ? titleCase(String(b.type).replace(/_/g, ' ')) : 'Standard';

      const driverCell = driverName
        ? `<div class="cell-strong">${escapeHtml(driverName)}</div><div class="cell-dim">${escapeHtml(driver.phone || (b.driverId || '').slice(0, 8))}</div>`
        : '<span class="badge badge-unassigned">Unassigned</span>';

      const pickup = b.pickupAddress || (b.pickup && b.pickup.address) || '';
      const dest = b.dropoffAddress || (b.destination && b.destination.address) || '';
      const routeText = (pickup || dest)
        ? `<div class="cell-dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(pickup + ' → ' + dest)}">${escapeHtml(pickup || '—')} → ${escapeHtml(dest || '—')}</div>`
        : '';

      return `
        <tr data-booking-row="${escapeHtml(b.id)}" style="cursor:pointer;">
          <td>
            <span class="uid-chip" data-copy="${escapeHtml(b.id)}" title="Click to copy full ID">${escapeHtml((b.id || '').slice(0, 8))}</span>
          </td>
          <td>
            <div class="cell-strong">${escapeHtml(riderName)}</div>
            <div class="cell-dim">${escapeHtml(rider.phone || rider.email || '—')}</div>
          </td>
          <td>
            ${driverCell}
          </td>
          <td>
            <span class="badge badge-offline">${escapeHtml(typeStr)}</span>
            ${routeText}
          </td>
          <td>${statusBadgeHtml(b.status)}</td>
          <td class="cell-strong">${escapeHtml(formatZar(price))}</td>
          <td class="cell-dim">${escapeHtml(formatDate(b.createdAt))}</td>
          <td style="text-align:right;">
            <button class="btn btn-ghost btn-sm" data-view-booking="${escapeHtml(b.id)}" title="View complete booking details">Details</button>
          </td>
        </tr>`;
    }).join('');

    host.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Rider</th>
            <th>Driver</th>
            <th>Type / Route</th>
            <th>Status</th>
            <th>Fare</th>
            <th>Created</th>
            <th style="text-align:right;">Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    host.querySelectorAll('[data-view-booking]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBookingModal(btn.getAttribute('data-view-booking'));
      });
    });

    host.querySelectorAll('[data-booking-row]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-copy]')) return;
        openBookingModal(row.getAttribute('data-booking-row'));
      });
    });
  }

  function openBookingModal(bookingId) {
    const b = state.bookings.find((x) => x.id === bookingId);
    if (!b) return;

    const rider = userCache.get(b.riderId) || {};
    const driver = userCache.get(b.driverId) || {};

    $('booking-modal-title').textContent = 'Booking Details';
    $('booking-modal-id').textContent = 'ID: ' + b.id;

    const statusBadge = statusBadgeHtml(b.status);
    const price = getBookingPrice(b);
    const pickup = b.pickupAddress || (b.pickup && (b.pickup.address || b.pickup.name)) || 'Not specified';
    const dest = b.dropoffAddress || (b.destination && (b.destination.address || b.destination.name)) || 'Not specified';
    const typeStr = b.type ? titleCase(String(b.type).replace(/_/g, ' ')) : 'Standard';

    const modalBody = $('booking-modal-body');
    modalBody.innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">
          <span>Overview</span>
          ${statusBadge}
        </div>
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-item-label">Ride Type</span>
            <span class="detail-item-value">${escapeHtml(typeStr)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Quoted Fare</span>
            <span class="detail-item-value">${escapeHtml(formatZar(price))}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Created At</span>
            <span class="detail-item-value">${escapeHtml(formatDate(b.createdAt))}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Payment Method</span>
            <span class="detail-item-value">${escapeHtml(b.paymentMethod || 'Cash / In-app')}</span>
          </div>
          ${b.cancelReason ? `
            <div class="detail-item detail-item-full">
              <span class="detail-item-label" style="color:var(--danger);">Cancellation Reason</span>
              <span class="detail-item-value" style="color:#fca5a5;">${escapeHtml(b.cancelReason)}</span>
            </div>` : ''}
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title"><span>Passenger (Rider)</span></div>
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-item-label">Name</span>
            <span class="detail-item-value">${escapeHtml(rider.displayName || 'Unnamed rider')}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Phone</span>
            <span class="detail-item-value">${escapeHtml(rider.phone || '—')}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Email</span>
            <span class="detail-item-value">${escapeHtml(rider.email || '—')}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Rider UID</span>
            <span class="uid-chip" data-copy="${escapeHtml(b.riderId || '')}" title="Copy UID">${escapeHtml(b.riderId || '—')}</span>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title"><span>Assigned Driver</span></div>
        ${b.driverId ? `
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-item-label">Name</span>
              <span class="detail-item-value">${escapeHtml(driver.displayName || 'Unnamed driver')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Phone</span>
              <span class="detail-item-value">${escapeHtml(driver.phone || '—')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Driver UID</span>
              <span class="uid-chip" data-copy="${escapeHtml(b.driverId)}" title="Copy UID">${escapeHtml(b.driverId)}</span>
            </div>
          </div>` : `
          <div class="detail-item">
            <span class="badge badge-unassigned">No driver assigned yet</span>
          </div>`}
      </div>

      <div class="detail-section">
        <div class="detail-section-title"><span>Route & Locations</span></div>
        <div class="detail-grid">
          <div class="detail-item detail-item-full">
            <span class="detail-item-label">🟢 Pickup Location</span>
            <span class="detail-item-value">${escapeHtml(pickup)}</span>
          </div>
          <div class="detail-item detail-item-full">
            <span class="detail-item-label">🔴 Destination / Dropoff</span>
            <span class="detail-item-value">${escapeHtml(dest)}</span>
          </div>
        </div>
      </div>

      ${(b.acceptedAt || b.arrivedAt || b.startedAt || b.completedAt || b.cancelledAt) ? `
        <div class="detail-section">
          <div class="detail-section-title"><span>Trip Lifecycle Timestamps</span></div>
          <div class="detail-grid">
            ${b.acceptedAt ? `<div class="detail-item"><span class="detail-item-label">Accepted</span><span class="detail-item-value">${escapeHtml(formatDate(b.acceptedAt))}</span></div>` : ''}
            ${b.arrivedAt ? `<div class="detail-item"><span class="detail-item-label">Arrived</span><span class="detail-item-value">${escapeHtml(formatDate(b.arrivedAt))}</span></div>` : ''}
            ${b.startedAt ? `<div class="detail-item"><span class="detail-item-label">Started</span><span class="detail-item-value">${escapeHtml(formatDate(b.startedAt))}</span></div>` : ''}
            ${b.completedAt ? `<div class="detail-item"><span class="detail-item-label">Completed</span><span class="detail-item-value">${escapeHtml(formatDate(b.completedAt))}</span></div>` : ''}
            ${b.cancelledAt ? `<div class="detail-item"><span class="detail-item-label">Cancelled</span><span class="detail-item-value">${escapeHtml(formatDate(b.cancelledAt))}</span></div>` : ''}
          </div>
        </div>` : ''}
    `;

    show($('booking-detail-overlay'));
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
    const u = userCache.get(uid) || (d && d.user) || {};
    const name = u.displayName || (d && d.user && d.user.displayName) || 'this driver';
    const isReapproval = d && (d.approvalStatus === 'DEMOTED' || d.approvalStatus === 'REJECTED');

    const res = await openModal({
      title: isReapproval ? 'Re-approve driver' : 'Approve driver',
      message: `${isReapproval ? 'Re-approve' : 'Approve'} ${name}? They will gain driver privileges and be able to go online to receive ride requests.`,
      confirmText: isReapproval ? 'Re-approve' : 'Approve',
      confirmClass: 'btn-success'
    });
    if (!res.confirmed) return;

    try {
      const batch = db.batch();
      batch.update(driversCol.doc(uid), {
        approvalStatus: 'APPROVED',
        approvedBy: MANAGER_EMAIL,
        approvedAt: serverTimestamp(),
        rejectedReason: firebase.firestore.FieldValue.delete(),
        demoteReason: firebase.firestore.FieldValue.delete(),
        demotedAt: firebase.firestore.FieldValue.delete(),
        demotedBy: firebase.firestore.FieldValue.delete()
      });
      batch.set(usersCol.doc(uid), {
        applications: { laynFleet: { isDriver: true } }
      }, { merge: true });
      await batch.commit();
      userCache.delete(uid); // force fresh identity join
      await logAdminAction(isReapproval ? 'reapproveDriver' : 'approveDriver', uid, name);
      toast(`${isReapproval ? 'Re-approved' : 'Approved'} ${name}.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Approval failed. ' + (err.code || ''), 'error');
    }
  }

  async function demoteDriver(uid) {
    const d = state.drivers.find((x) => x.uid === uid);
    const u = userCache.get(uid) || (d && d.user) || {};
    const name = u.displayName || (d && d.user && d.user.displayName) || 'this driver';

    const res = await openModal({
      title: 'Demote driver to normal user',
      message: `Demote ${name} to a normal user? They will lose driver privileges and cannot go online or accept ride requests. Their member/rider account remains active.`,
      confirmText: 'Demote',
      confirmClass: 'btn-warn',
      requireReason: true
    });
    if (!res.confirmed) return;

    try {
      const batch = db.batch();
      batch.update(driversCol.doc(uid), {
        approvalStatus: 'DEMOTED',
        online: false,
        demotedBy: MANAGER_EMAIL,
        demotedAt: serverTimestamp(),
        demoteReason: res.reason || ''
      });
      batch.set(usersCol.doc(uid), {
        applications: { laynFleet: { isDriver: false } }
      }, { merge: true });
      await batch.commit();
      userCache.delete(uid); // force fresh identity join
      await logAdminAction('demoteDriver', uid, name, res.reason);
      toast(`Demoted ${name} to a normal user.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Demote failed. ' + (err.code || ''), 'error');
    }
  }

  async function rejectDriver(uid) {
    const d = state.drivers.find((x) => x.uid === uid);
    const name = (d && d.user && d.user.displayName) || 'this driver';
    const res = await openModal({
      title: 'Reject application',
      message: `Reject ${name}? This driver application will be marked as rejected.`,
      confirmText: 'Reject',
      confirmClass: 'btn-danger',
      requireReason: true
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
      userCache.delete(uid);
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
  // NAVIGATION + FILTERS EVENT HANDLERS
  // ---------------------------------------------------------------------------
  const sectionMeta = {
    overview: ['Overview', 'Live operations across LaynFleet'],
    drivers: ['Drivers', 'Approve applications, demote, and manage the fleet'],
    riders: ['Riders', 'Registered members and account status'],
    bookings: ['Bookings', 'Live and historical rides with detailed filters']
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

  // Driver Tabs
  document.querySelectorAll('[data-driver-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.driverTab = b.getAttribute('data-driver-tab');
      document.querySelectorAll('[data-driver-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === b));
      renderDrivers();
    }));

  // Topbar Global Search
  $('search-input').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderDrivers();
    renderRiders();
    renderBookings();
  });

  // Booking Quick Tabs
  document.querySelectorAll('#booking-quick-tabs [data-booking-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      state.bookingFilters.quickTab = b.getAttribute('data-booking-tab');
      document.querySelectorAll('#booking-quick-tabs [data-booking-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === b));
      renderBookings();
    });
  });

  // Booking Specific Search
  const bSearch = $('booking-filter-search');
  if (bSearch) {
    bSearch.addEventListener('input', (e) => {
      state.bookingFilters.search = e.target.value.trim();
      renderBookings();
    });
  }

  // Booking Status Select
  const bStatus = $('booking-filter-status');
  if (bStatus) {
    bStatus.addEventListener('change', (e) => {
      state.bookingFilters.status = e.target.value;
      renderBookings();
    });
  }

  // Booking Type Select
  const bType = $('booking-filter-type');
  if (bType) {
    bType.addEventListener('change', (e) => {
      state.bookingFilters.type = e.target.value;
      renderBookings();
    });
  }

  // Booking Driver Assignment Select
  const bDriver = $('booking-filter-driver');
  if (bDriver) {
    bDriver.addEventListener('change', (e) => {
      state.bookingFilters.driverAssigned = e.target.value;
      renderBookings();
    });
  }

  // Booking Date Preset Select
  const bDatePreset = $('booking-filter-date-preset');
  const bCustomDates = $('booking-custom-dates');
  if (bDatePreset) {
    bDatePreset.addEventListener('change', (e) => {
      state.bookingFilters.datePreset = e.target.value;
      if (e.target.value === 'custom') {
        show(bCustomDates);
      } else {
        hide(bCustomDates);
      }
      renderBookings();
    });
  }

  // Booking Date Inputs
  const bDateStart = $('booking-filter-date-start');
  if (bDateStart) {
    bDateStart.addEventListener('change', (e) => {
      state.bookingFilters.dateStart = e.target.value;
      renderBookings();
    });
  }
  const bDateEnd = $('booking-filter-date-end');
  if (bDateEnd) {
    bDateEnd.addEventListener('change', (e) => {
      state.bookingFilters.dateEnd = e.target.value;
      renderBookings();
    });
  }

  // Booking Price Min / Max Inputs
  const bPriceMin = $('booking-filter-price-min');
  if (bPriceMin) {
    bPriceMin.addEventListener('input', (e) => {
      state.bookingFilters.priceMin = e.target.value.trim();
      renderBookings();
    });
  }
  const bPriceMax = $('booking-filter-price-max');
  if (bPriceMax) {
    bPriceMax.addEventListener('input', (e) => {
      state.bookingFilters.priceMax = e.target.value.trim();
      renderBookings();
    });
  }

  // Booking Sort Select
  const bSort = $('booking-filter-sort');
  if (bSort) {
    bSort.addEventListener('change', (e) => {
      state.bookingFilters.sortBy = e.target.value;
      renderBookings();
    });
  }

  // Booking Reset Filters Button
  const bReset = $('booking-filter-reset');
  if (bReset) {
    bReset.addEventListener('click', () => {
      state.bookingFilters = {
        quickTab: 'all',
        status: 'all',
        type: 'all',
        driverAssigned: 'all',
        datePreset: 'all',
        dateStart: '',
        dateEnd: '',
        priceMin: '',
        priceMax: '',
        sortBy: 'newest',
        search: ''
      };

      // Reset form controls
      if (bSearch) bSearch.value = '';
      if (bStatus) bStatus.value = 'all';
      if (bType) bType.value = 'all';
      if (bDriver) bDriver.value = 'all';
      if (bDatePreset) bDatePreset.value = 'all';
      if (bDateStart) bDateStart.value = '';
      if (bDateEnd) bDateEnd.value = '';
      if (bPriceMin) bPriceMin.value = '';
      if (bPriceMax) bPriceMax.value = '';
      if (bSort) bSort.value = 'newest';
      hide(bCustomDates);

      // Reset quick tabs UI
      document.querySelectorAll('#booking-quick-tabs [data-booking-tab]').forEach((t) =>
        t.classList.toggle('is-active', t.getAttribute('data-booking-tab') === 'all'));

      renderBookings();
      toast('Booking filters reset.', 'success');
    });
  }

  // Booking Modal Close Handlers
  const bModalClose = $('booking-modal-close');
  if (bModalClose) bModalClose.addEventListener('click', () => hide($('booking-detail-overlay')));
  const bModalDone = $('booking-modal-done');
  if (bModalDone) bModalDone.addEventListener('click', () => hide($('booking-detail-overlay')));

  const bDetailOverlay = $('booking-detail-overlay');
  if (bDetailOverlay) {
    bDetailOverlay.addEventListener('click', (e) => {
      if (e.target === bDetailOverlay) hide(bDetailOverlay);
    });
  }

  // Click-to-copy UID chips (event delegation — works for re-rendered rows).
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-copy]');
    if (!chip) return;
    const value = chip.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => toast('Copied to clipboard.', 'success')).catch(() => {});
    }
  });

  // ESC closes overlays.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hide($('image-overlay'));
    if ($('booking-detail-overlay') && !$('booking-detail-overlay').classList.contains('is-hidden')) {
      hide($('booking-detail-overlay'));
    }
    if (!$('modal-overlay').classList.contains('is-hidden')) $('modal-cancel').click();
  });
})();
