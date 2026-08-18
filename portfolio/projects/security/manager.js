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
  const rtdb = typeof firebase.database === 'function' ? firebase.database() : null;
  const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;

  const driversCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.drivers);
  const ridersCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.riders);
  const bookingsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.bookings);
  const reviewsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.reviews);
  const pricingCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection('pricing');
  const pricingProposalsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection('pricingProposals');
  const pricingHistoryCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection('pricingHistory');
  const appConfigCol = db.collection('appConfig');
  const adminActionsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.adminActions);
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

  function cleanPhoneNumber(phone) {
    let cleaned = String(phone || '').replace(/[^\d+]/g, '');
    if (cleaned.startsWith('0') && cleaned.length === 10) {
      cleaned = '27' + cleaned.slice(1);
    }
    return cleaned.replace(/^\+/, '');
  }

  function renderStarsHtml(rating, showScore = true) {
    const num = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    const exact = Number(rating || 0).toFixed(1);
    let starClass = 'star';
    if (num <= 2) starClass += ' star-danger';
    else if (num === 3) starClass += ' star-warn';
    else starClass += ' star-success';

    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
      if (i <= num) {
        starsHtml += `<span class="${starClass}">★</span>`;
      } else {
        starsHtml += `<span class="star star-empty">★</span>`;
      }
    }
    return `<span class="stars-row" title="${escapeHtml(exact)} out of 5 stars">${starsHtml}${showScore ? ` <span class="rating-pill">${escapeHtml(exact)}</span>` : ''}</span>`;
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
    reviews: [],       // [{ id, bookingId, rating, comment, reviewerId, targetId, hidden, flagged, ... }]
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
    },
    reviewFilters: {
      quickTab: 'all',          // 'all', 'scrutiny', '5star', '4star', '3star', 'low', 'hidden'
      stars: 'all',             // 'all', '5', '4', '3', '2', '1', 'low'
      type: 'all',              // 'all', 'driver', 'rider'
      status: 'all',            // 'all', 'visible', 'hidden', 'flagged', 'responded'
      datePreset: 'all',        // 'all', 'today', 'yesterday', '7days', '30days', 'custom'
      dateStart: '',            // YYYY-MM-DD
      dateEnd: '',              // YYYY-MM-DD
      sortBy: 'newest',         // 'newest', 'oldest', 'rating-asc', 'rating-desc'
      search: ''                // review search input
    },
    pricingRates: [],
    pricingProposals: [],
    pricingHistory: [],
    appConfig: {},
    appConfigTab: 'com.digilayn.laynrider',
    appConfigAudit: [],
    driverLocations: {}
  };
  let rawReviewsDocs = []; // Standalone review docs from reviewsCol
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
        await consolidateAndHydrateReviews();
      }, (err) => {
        console.warn('bookings listener', err);
        state.bookings = [];
        renderBookings();
      })
    );

    // Reviews (standalone reviews collection)
    unsub.push(
      reviewsCol.orderBy('createdAt', 'desc').limit(300).onSnapshot(async (snap) => {
        rawReviewsDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        await consolidateAndHydrateReviews();
      }, (err) => {
        console.warn('reviews listener', err);
        rawReviewsDocs = [];
        consolidateAndHydrateReviews();
      })
    );

    // Pricing Rates
    unsub.push(
      pricingCol.onSnapshot((snap) => {
        state.pricingRates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderPricing();
      }, (err) => {
        console.warn('pricing listener', err);
      })
    );

    // Active Proposals (Live Democratic Votes)
    unsub.push(
      pricingProposalsCol.onSnapshot((snap) => {
        state.pricingProposals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const badge = $('nav-badge-pricing');
        if (badge) {
          badge.textContent = state.pricingProposals.length;
          badge.classList.toggle('is-hidden', state.pricingProposals.length === 0);
        }
        renderPricing();
      }, (err) => {
        console.warn('pricing proposals listener', err);
      })
    );

    // Pricing History & Audit Log
    unsub.push(
      pricingHistoryCol.orderBy('createdAt', 'desc').limit(100).onSnapshot((snap) => {
        state.pricingHistory = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderPricing();
      }, (err) => {
        console.warn('pricing history listener', err);
      })
    );

    // App Config & System Gates
    unsub.push(
      appConfigCol.onSnapshot((snap) => {
        const configs = {};
        snap.docs.forEach((doc) => {
          configs[doc.id] = { id: doc.id, ...doc.data() };
        });
        state.appConfig = configs;
        renderAppControl();
      }, (err) => {
        console.warn('appConfig listener', err);
      })
    );

    // Audit log for app control actions
    unsub.push(
      adminActionsCol.orderBy('createdAt', 'desc').limit(50).onSnapshot((snap) => {
        state.appConfigAudit = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((a) => a.action && a.action.startsWith('appConfig'));
        renderAppControlAudit();
      }, (err) => {
        console.warn('adminActions appConfig listener', err);
      })
    );

    // RTDB Presence & Location listener
    if (rtdb) {
      try {
        const locRef = rtdb.ref('driverLocations');
        const onLocValue = (snap) => {
          state.driverLocations = snap.val() || {};
          renderDrivers();
          renderOverview();
        };
        locRef.on('value', onLocValue);
        unsub.push(() => locRef.off('value', onLocValue));
      } catch (err) {
        console.warn('RTDB driverLocations listener failed', err);
      }
    }
  }

  function detachListeners() {
    while (unsub.length) { try { unsub.pop()(); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------------
  // CONSOLIDATION: Reviews & Feedback
  // ---------------------------------------------------------------------------
  function consolidateReviews() {
    const list = [];
    const seenBookingIds = new Set();
    const seenReviewIds = new Set();

    // 1. Standalone docs from reviewsCol
    rawReviewsDocs.forEach((d) => {
      const id = d.id;
      const bId = d.bookingId || d.tripId || '';
      if (id) seenReviewIds.add(id);
      if (bId) seenBookingIds.add(bId);

      const ratingVal = Number(d.rating != null ? d.rating : (d.stars != null ? d.stars : 5));
      list.push({
        id,
        bookingId: bId,
        rating: isNaN(ratingVal) ? 5 : ratingVal,
        comment: d.comment || d.review || d.text || d.feedback || '',
        reviewerId: d.reviewerId || d.authorId || d.riderId || d.userId || '',
        reviewerRole: String(d.reviewerRole || d.authorRole || 'RIDER').toUpperCase(),
        reviewerName: d.reviewerName || '',
        reviewerPhone: d.reviewerPhone || '',
        reviewerEmail: d.reviewerEmail || '',
        targetId: d.targetId || d.driverId || d.targetUid || '',
        targetRole: String(d.targetRole || (d.reviewerRole === 'RIDER' ? 'DRIVER' : 'RIDER')).toUpperCase(),
        targetName: d.targetName || '',
        tags: Array.isArray(d.tags) ? d.tags : (Array.isArray(d.categories) ? d.categories : []),
        createdAt: d.createdAt || d.timestamp || d.date || null,
        hidden: !!d.hidden || d.status === 'HIDDEN',
        hiddenReason: d.hiddenReason || '',
        hiddenBy: d.hiddenBy || '',
        hiddenAt: d.hiddenAt || null,
        flagged: !!d.flagged || d.status === 'FLAGGED',
        flaggedReason: d.flaggedReason || '',
        managerResponse: d.managerResponse || d.response || '',
        managerRespondedAt: d.managerRespondedAt || d.respondedAt || null,
        managerRespondedBy: d.managerRespondedBy || '',
        contactHistory: Array.isArray(d.contactHistory) ? d.contactHistory : [],
        isBookingEmbedded: false,
        raw: d
      });
    });

    // 2. Embedded booking reviews
    state.bookings.forEach((b) => {
      if (b.reviewDeleted) return;
      const hasRating = b.rating != null || b.driverRating != null || b.riderRating != null;
      const hasReviewText = !!(b.review || b.feedback || b.reviewComment || b.driverReview || b.riderReview);

      if ((hasRating || hasReviewText) && !seenBookingIds.has(b.id) && !seenReviewIds.has(b.reviewId)) {
        const ratingVal = Number(b.rating != null ? b.rating : (b.driverRating != null ? b.driverRating : (b.riderRating != null ? b.riderRating : 5)));
        const commentVal = b.review || b.feedback || b.reviewComment || b.driverReview || b.riderReview || '';

        list.push({
          id: b.reviewId || ('booking_' + b.id),
          bookingId: b.id,
          rating: isNaN(ratingVal) ? 5 : ratingVal,
          comment: String(commentVal),
          reviewerId: b.riderId || '',
          reviewerRole: 'RIDER',
          reviewerName: '',
          reviewerPhone: '',
          reviewerEmail: '',
          targetId: b.driverId || '',
          targetRole: 'DRIVER',
          targetName: '',
          tags: Array.isArray(b.reviewTags) ? b.reviewTags : (Array.isArray(b.ratingTags) ? b.ratingTags : []),
          createdAt: b.reviewedAt || b.completedAt || b.createdAt || null,
          hidden: !!b.reviewHidden || !!b.hidden,
          hiddenReason: b.reviewHiddenReason || b.hiddenReason || '',
          hiddenBy: b.reviewHiddenBy || '',
          hiddenAt: b.reviewHiddenAt || null,
          flagged: !!b.reviewFlagged,
          flaggedReason: b.reviewFlaggedReason || '',
          managerResponse: b.managerResponse || '',
          managerRespondedAt: b.managerRespondedAt || null,
          managerRespondedBy: b.managerRespondedBy || '',
          contactHistory: Array.isArray(b.contactHistory) ? b.contactHistory : [],
          isBookingEmbedded: true,
          raw: b
        });
      }
    });

    state.reviews = list;
  }

  async function consolidateAndHydrateReviews() {
    consolidateReviews();
    await Promise.all(state.reviews.map(async (r) => {
      if (r.reviewerId && !userCache.has(r.reviewerId)) await getUser(r.reviewerId);
      if (r.targetId && !userCache.has(r.targetId)) await getUser(r.targetId);
    }));
    renderReviews();
    renderOverview();
  }

  function isDriverOnlineAndActive(d) {
    if (!d || d.online !== true || d.approvalStatus !== 'APPROVED') return false;
    const rtdbEntry = state.driverLocations && state.driverLocations[d.uid];
    if (!rtdbEntry) return false;
    if (rtdbEntry.online !== true) return false;
    const age = rtdbEntry.updatedAt ? (Date.now() - rtdbEntry.updatedAt) : Infinity;
    return age < 65000;
  }

  // ---------------------------------------------------------------------------
  // RENDER: overview
  // ---------------------------------------------------------------------------
  function renderOverview() {
    const pending = state.drivers.filter((d) => d.approvalStatus === 'PENDING');
    const approved = state.drivers.filter((d) => d.approvalStatus === 'APPROVED');
    const onlineCount = approved.filter(isDriverOnlineAndActive).length;
    const activeBookings = state.bookings.filter((b) => isBookingActive(b.status)).length;

    $('stat-pending').textContent = pending.length;
    $('stat-approved').textContent = approved.length;
    $('stat-online-hint').textContent = onlineCount + ' online now';
    $('stat-riders').textContent = state.riders.length;
    $('stat-bookings').textContent = activeBookings;

    // Review metrics for overview
    const totalReviews = state.reviews.length;
    const scrutinyReviews = state.reviews.filter((r) => r.rating <= 2 || r.flagged);
    const avgRating = totalReviews > 0
      ? (state.reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1)
      : '5.0';

    if ($('stat-fleet-rating')) $('stat-fleet-rating').textContent = totalReviews > 0 ? `★ ${avgRating}` : '★ 5.0';
    if ($('stat-fleet-reviews-hint')) {
      $('stat-fleet-reviews-hint').textContent = totalReviews > 0
        ? `${totalReviews} total reviews · ${scrutinyReviews.length} need scrutiny`
        : 'No customer reviews yet';
    }

    const badge = $('nav-badge-drivers');
    if (pending.length) { badge.textContent = pending.length; show(badge); } else { hide(badge); }

    const badgeReviews = $('nav-badge-reviews');
    if (badgeReviews) {
      if (scrutinyReviews.length) { badgeReviews.textContent = scrutinyReviews.length; show(badgeReviews); }
      else { hide(badgeReviews); }
    }

    const host = $('overview-pending');
    if (!pending.length) {
      host.innerHTML = emptyState('✅', 'No pending applications', 'New driver applications will appear here.');
    } else {
      host.innerHTML = pending.slice(0, 5).map(driverCardHtml).join('');
      wireDriverCardActions(host);
    }

    const scrutinyHost = $('overview-scrutiny-reviews');
    if (scrutinyHost) {
      if (!scrutinyReviews.length) {
        scrutinyHost.innerHTML = emptyState('⭐', 'All reviews look healthy', 'No low ratings (≤ 2 stars) or flagged feedback requiring scrutiny.');
      } else {
        scrutinyHost.innerHTML = scrutinyReviews.slice(0, 5).map(reviewCardHtml).join('');
        wireReviewCardActions(scrutinyHost);
      }
    }
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

    let onlineBadge = '';
    if (d.approvalStatus === 'APPROVED') {
      const rtdbEntry = state.driverLocations && state.driverLocations[d.uid];
      const isRtdbOnline = rtdbEntry && rtdbEntry.online === true;
      const rtdbAge = (rtdbEntry && rtdbEntry.updatedAt) ? (Date.now() - rtdbEntry.updatedAt) : Infinity;
      const isFresh = isRtdbOnline && rtdbAge < 65000;

      if (d.online && isFresh) {
        onlineBadge = '<span class="badge badge-online">Online</span>';
      } else if (d.online && !isFresh) {
        onlineBadge = '<span class="badge badge-offline" title="App closed or connection lost (Stale heartbeat)">Offline</span>';
      } else {
        onlineBadge = '<span class="badge badge-offline">Offline</span>';
      }
    }
    const suspendedBadge = u.suspended ? '<span class="badge badge-suspended">Suspended</span>' : '';
    const ratingBadge = d.ratingCount
      ? `<span class="badge badge-rating" style="cursor:pointer;" data-filter-driver-reviews="${escapeHtml(u.displayName || d.uid)}" title="Click to view all reviews for this driver">★ ${Number(d.ratingAvg || 0).toFixed(1)} · ${d.ratingCount}</span>`
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
    host.querySelectorAll('[data-filter-driver-reviews]').forEach((b) =>
      b.addEventListener('click', () => filterReviewsBySubject(b.getAttribute('data-filter-driver-reviews'))));
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
        ? `<span class="badge badge-rating" style="cursor:pointer;" data-filter-rider-reviews="${escapeHtml(u.displayName || r.uid)}" title="Click to view all reviews for this rider">★ ${Number(r.ratingAvg || 0).toFixed(1)} · ${r.ratingCount}</span>`
        : '<span class="cell-dim">No ratings</span>';
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
          <td>${rating}</td>
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
    host.querySelectorAll('[data-filter-rider-reviews]').forEach((b) =>
      b.addEventListener('click', () => filterReviewsBySubject(b.getAttribute('data-filter-rider-reviews'))));
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

      ${(() => {
        const rev = state.reviews.find((x) => x.bookingId === b.id);
        if (!rev && b.rating == null && !b.review && !b.feedback) return '';
        const ratingScore = rev ? rev.rating : (b.rating || 5);
        const comment = rev ? rev.comment : (b.review || b.feedback || '');
        const revId = rev ? rev.id : (b.reviewId || ('booking_' + b.id));
        return `
          <div class="detail-section">
            <div class="detail-section-title">
              <span>Trip Rating &amp; Passenger Review</span>
              <div>${renderStarsHtml(ratingScore, true)}</div>
            </div>
            <div class="detail-grid">
              <div class="detail-item detail-item-full">
                <span class="detail-item-label">Feedback Comment</span>
                <div class="review-body-text ${comment ? '' : 'is-empty-comment'}">${escapeHtml(comment || 'No written feedback provided (rating only).')}</div>
              </div>
              <div class="detail-item">
                <button class="btn btn-ghost btn-sm" id="booking-inspect-rev-btn" data-inspect-rev="${escapeHtml(revId)}" type="button">
                  🔍 Scrutinize &amp; Moderate Review
                </button>
              </div>
            </div>
          </div>`;
      })()}
    `;

    const inspectRevBtn = $('booking-inspect-rev-btn');
    if (inspectRevBtn) {
      inspectRevBtn.addEventListener('click', () => {
        const rId = inspectRevBtn.getAttribute('data-inspect-rev');
        hide($('booking-detail-overlay'));
        openReviewModal(rId);
      });
    }

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
  // RENDER: reviews with filters & scrutiny
  // ---------------------------------------------------------------------------
  function renderReviews() {
    const rf = state.reviewFilters;
    const term = (rf.search || state.search || '').trim().toLowerCase();

    // Calculate quick tab counts on whole review list
    const totalCount = state.reviews.length;
    const scrutinyCount = state.reviews.filter((r) => r.rating <= 2 || r.flagged).length;
    const count5 = state.reviews.filter((r) => r.rating === 5).length;
    const count4 = state.reviews.filter((r) => r.rating === 4).length;
    const count3 = state.reviews.filter((r) => r.rating === 3).length;
    const countLow = state.reviews.filter((r) => r.rating <= 2).length;
    const countHidden = state.reviews.filter((r) => r.hidden).length;

    if ($('count-rev-all')) $('count-rev-all').textContent = totalCount;
    if ($('count-rev-scrutiny')) $('count-rev-scrutiny').textContent = scrutinyCount;
    if ($('count-rev-5star')) $('count-rev-5star').textContent = count5;
    if ($('count-rev-4star')) $('count-rev-4star').textContent = count4;
    if ($('count-rev-3star')) $('count-rev-3star').textContent = count3;
    if ($('count-rev-low')) $('count-rev-low').textContent = countLow;
    if ($('count-rev-hidden')) $('count-rev-hidden').textContent = countHidden;

    // Review KPI cards
    const avgScore = totalCount > 0 ? (state.reviews.reduce((s, r) => s + r.rating, 0) / totalCount).toFixed(1) : '5.0';
    const fiveStarPct = totalCount > 0 ? Math.round((count5 / totalCount) * 100) : 100;

    if ($('stat-rev-avg')) $('stat-rev-avg').textContent = `★ ${avgScore} / 5.0`;
    if ($('stat-rev-breakdown')) $('stat-rev-breakdown').textContent = `${totalCount} reviews recorded`;
    if ($('stat-rev-scrutiny')) $('stat-rev-scrutiny').textContent = scrutinyCount;
    if ($('stat-rev-5star-rate')) $('stat-rev-5star-rate').textContent = `${fiveStarPct}%`;
    if ($('stat-rev-5star-count')) $('stat-rev-5star-count').textContent = `${count5} top ratings`;
    if ($('stat-rev-hidden')) $('stat-rev-hidden').textContent = countHidden;

    // Compute Date Range Boundaries for presets
    const now = new Date();
    let startDate = null;
    let endDate = null;

    if (rf.datePreset === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    } else if (rf.datePreset === 'yesterday') {
      const y = new Date(now.getTime() - 86400000);
      startDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0, 0);
      endDate = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999);
    } else if (rf.datePreset === '7days') {
      startDate = new Date(now.getTime() - 7 * 86400000);
    } else if (rf.datePreset === '30days') {
      startDate = new Date(now.getTime() - 30 * 86400000);
    } else if (rf.datePreset === 'custom' || rf.dateStart || rf.dateEnd) {
      if (rf.dateStart) startDate = new Date(rf.dateStart + 'T00:00:00');
      if (rf.dateEnd) endDate = new Date(rf.dateEnd + 'T23:59:59.999');
    }

    // Filter pipeline
    let list = state.reviews.filter((r) => {
      // 1. Quick Tabs
      if (rf.quickTab === 'scrutiny' && !(r.rating <= 2 || r.flagged)) return false;
      if (rf.quickTab === '5star' && r.rating !== 5) return false;
      if (rf.quickTab === '4star' && r.rating !== 4) return false;
      if (rf.quickTab === '3star' && r.rating !== 3) return false;
      if (rf.quickTab === 'low' && r.rating > 2) return false;
      if (rf.quickTab === 'hidden' && !r.hidden) return false;

      // 2. Rating select
      if (rf.stars !== 'all') {
        if (rf.stars === 'low' && r.rating > 2) return false;
        else if (rf.stars !== 'low' && r.rating !== Number(rf.stars)) return false;
      }

      // 3. Type select
      if (rf.type !== 'all') {
        if (rf.type === 'driver' && r.targetRole !== 'DRIVER') return false;
        if (rf.type === 'rider' && r.targetRole !== 'RIDER') return false;
      }

      // 4. Status select
      if (rf.status !== 'all') {
        if (rf.status === 'visible' && r.hidden) return false;
        if (rf.status === 'hidden' && !r.hidden) return false;
        if (rf.status === 'flagged' && !r.flagged) return false;
        if (rf.status === 'responded' && !r.managerResponse) return false;
      }

      // 5. Date filter
      const rDate = getBookingDate(r);
      if (startDate && (!rDate || rDate < startDate)) return false;
      if (endDate && (!rDate || rDate > endDate)) return false;

      // 6. Search filter
      if (term) {
        const uRev = userCache.get(r.reviewerId) || {};
        const uTarget = userCache.get(r.targetId) || {};
        const matches = [
          r.id,
          r.bookingId,
          r.comment,
          r.reviewerName,
          r.targetName,
          uRev.displayName,
          uRev.phone,
          uRev.email,
          r.reviewerId,
          uTarget.displayName,
          uTarget.phone,
          r.targetId,
          ...(r.tags || [])
        ].some((x) => String(x || '').toLowerCase().includes(term));
        if (!matches) return false;
      }

      return true;
    });

    // Sorting
    list.sort((a, b) => {
      const dateA = (getBookingDate(a) || new Date(0)).getTime();
      const dateB = (getBookingDate(b) || new Date(0)).getTime();
      switch (rf.sortBy) {
        case 'oldest': return dateA - dateB;
        case 'rating-asc': return a.rating - b.rating;
        case 'rating-desc': return b.rating - a.rating;
        case 'newest':
        default:
          return dateB - dateA;
      }
    });

    // Summary calculation
    const summaryEl = $('review-filter-summary');
    if (summaryEl) {
      const hasActiveFilters = rf.quickTab !== 'all' || rf.stars !== 'all' || rf.type !== 'all' ||
        rf.status !== 'all' || rf.datePreset !== 'all' || rf.dateStart || rf.dateEnd || term;
      const listAvg = list.length > 0 ? (list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(1) : '5.0';
      summaryEl.innerHTML = `
        <span>Showing <strong class="filter-summary-highlight">${list.length}</strong> of ${state.reviews.length} reviews</span>
        <span>·</span>
        <span>Average in View: <strong class="filter-summary-highlight">★ ${listAvg}</strong></span>
        ${hasActiveFilters ? '<span class="badge badge-pending">Filtered</span>' : ''}`;
    }

    const host = $('reviews-list');
    if (!host) return;

    if (!list.length) {
      host.innerHTML = emptyState(
        '⭐',
        state.reviews.length ? 'No reviews match filters' : 'No reviews recorded yet',
        state.reviews.length ? 'Try adjusting your search criteria or resetting filters.' : 'Reviews appear here when riders or drivers submit post-trip ratings.'
      );
      return;
    }

    host.innerHTML = list.map(reviewCardHtml).join('');
    wireReviewCardActions(host);
  }

  function reviewCardHtml(r) {
    const uRev = userCache.get(r.reviewerId) || {};
    const uTarget = userCache.get(r.targetId) || {};
    const revName = uRev.displayName || r.reviewerName || (r.reviewerRole === 'RIDER' ? 'Rider' : 'Driver');
    const targetName = uTarget.displayName || r.targetName || (r.targetRole === 'DRIVER' ? 'Driver' : 'Rider');

    const revPhoto = uRev.photoUrl
      ? `<img class="review-party-avatar" src="${escapeHtml(uRev.photoUrl)}" alt="" />`
      : `<div class="review-party-avatar">${escapeHtml(initials(revName))}</div>`;

    const targetPhoto = uTarget.photoUrl
      ? `<img class="review-party-avatar" src="${escapeHtml(uTarget.photoUrl)}" alt="" />`
      : `<div class="review-party-avatar">${escapeHtml(initials(targetName))}</div>`;

    const isFlagged = r.flagged || r.rating <= 2;
    const isHidden = r.hidden;

    const visibleBadge = r.hidden
      ? '<span class="badge badge-hidden">Hidden</span>'
      : '<span class="badge badge-visible">Visible</span>';

    const flaggedBadge = r.flagged ? '<span class="badge badge-flagged">Flagged</span>' : '';
    const respondedBadge = r.managerResponse ? '<span class="badge badge-responded">Responded</span>' : '';
    const contactBadge = (r.contactHistory && r.contactHistory.length)
      ? `<span class="badge badge-approved" title="Contacted ${r.contactHistory.length} times">Contacted (${r.contactHistory.length})</span>`
      : '';

    const tagsHtml = (r.tags && r.tags.length)
      ? `<div class="review-tags">${r.tags.map(t => `<span class="review-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const commentHtml = r.comment && r.comment.trim()
      ? `<div class="review-body-text">"${escapeHtml(r.comment)}"</div>`
      : `<div class="review-body-text is-empty-comment">No written feedback provided (rating only).</div>`;

    const hiddenBanner = r.hidden
      ? `<div class="review-banner-hidden">
          <span>👁️ <strong>Hidden from App:</strong> ${escapeHtml(r.hiddenReason || 'Moderated by management')}</span>
          <span>${r.hiddenBy ? `by ${escapeHtml(r.hiddenBy)}` : ''}</span>
         </div>`
      : '';

    const responsePreview = r.managerResponse
      ? `<div class="review-response-preview">
          <div class="review-response-preview-head">
            <span>Manager Response</span>
            <span>${escapeHtml(formatDate(r.managerRespondedAt))}</span>
          </div>
          <div>${escapeHtml(r.managerResponse)}</div>
         </div>`
      : '';

    const hideBtn = r.hidden
      ? `<button class="btn btn-ghost btn-sm" data-unhide-review="${escapeHtml(r.id)}" title="Restore review to public view">Unhide</button>`
      : `<button class="btn btn-warn btn-sm" data-hide-review="${escapeHtml(r.id)}" title="Hide review from public view">Hide</button>`;

    return `
      <div class="review-card ${isFlagged ? 'is-flagged-card' : ''} ${isHidden ? 'is-hidden-card' : ''}">
        <div class="review-card-top">
          <div class="review-participants">
            <div class="review-party">
              ${revPhoto}
              <div class="review-party-meta">
                <div class="review-party-name">
                  <span>${escapeHtml(revName)}</span>
                  <span class="badge ${r.reviewerRole === 'DRIVER' ? 'badge-driver' : 'badge-pending'}">${escapeHtml(r.reviewerRole)}</span>
                </div>
                <div class="review-party-role">${escapeHtml(uRev.phone || uRev.email || (r.reviewerId ? `UID: ${r.reviewerId.slice(0, 6)}…` : '—'))}</div>
              </div>
            </div>

            <span class="review-arrow">➔</span>

            <div class="review-party">
              ${targetPhoto}
              <div class="review-party-meta">
                <div class="review-party-name">
                  <span>${escapeHtml(targetName)}</span>
                  <span class="badge ${r.targetRole === 'DRIVER' ? 'badge-driver' : 'badge-pending'}">${escapeHtml(r.targetRole)}</span>
                </div>
                <div class="review-party-role">${escapeHtml(uTarget.phone || (r.targetId ? `UID: ${r.targetId.slice(0, 6)}…` : '—'))}</div>
              </div>
            </div>
          </div>

          <div class="review-score-area">
            <div>${renderStarsHtml(r.rating, true)}</div>
            <div class="review-date">${escapeHtml(formatDate(r.createdAt))}</div>
          </div>
        </div>

        <div class="review-badges-row">
          ${visibleBadge}
          ${flaggedBadge}
          ${respondedBadge}
          ${contactBadge}
        </div>

        ${commentHtml}
        ${tagsHtml}
        ${hiddenBanner}
        ${responsePreview}

        <div class="review-card-footer">
          <div class="review-meta-left">
            ${r.bookingId ? `<span class="uid-chip" data-view-booking="${escapeHtml(r.bookingId)}" title="Click to view trip details">Trip: ${escapeHtml(r.bookingId.slice(0, 8))}</span>` : ''}
            <span class="uid-chip" data-copy="${escapeHtml(r.id)}" title="Click to copy Review ID">ID: ${escapeHtml(r.id.slice(0, 8))}</span>
          </div>

          <div class="review-actions-group">
            <button class="btn btn-ghost btn-sm" data-scrutinize-review="${escapeHtml(r.id)}" title="Inspect all details and moderate">Scrutinize</button>
            <button class="btn btn-whatsapp btn-sm" data-contact-reviewer="${escapeHtml(r.id)}" title="Contact reviewer via WhatsApp, Phone, or Email">Contact</button>
            ${hideBtn}
            <button class="btn btn-danger btn-sm" data-delete-review="${escapeHtml(r.id)}" title="Permanently delete review">Delete</button>
          </div>
        </div>
      </div>`;
  }

  function wireReviewCardActions(host) {
    host.querySelectorAll('[data-scrutinize-review]').forEach((b) =>
      b.addEventListener('click', () => openReviewModal(b.getAttribute('data-scrutinize-review'))));
    host.querySelectorAll('[data-contact-reviewer]').forEach((b) =>
      b.addEventListener('click', () => openContactReviewerModal(b.getAttribute('data-contact-reviewer'))));
    host.querySelectorAll('[data-hide-review]').forEach((b) =>
      b.addEventListener('click', () => hideReview(b.getAttribute('data-hide-review'))));
    host.querySelectorAll('[data-unhide-review]').forEach((b) =>
      b.addEventListener('click', () => unhideReview(b.getAttribute('data-unhide-review'))));
    host.querySelectorAll('[data-delete-review]').forEach((b) =>
      b.addEventListener('click', () => deleteReview(b.getAttribute('data-delete-review'))));
    host.querySelectorAll('[data-view-booking]').forEach((b) =>
      b.addEventListener('click', () => openBookingModal(b.getAttribute('data-view-booking'))));
  }

  function openReviewModal(reviewId) {
    const r = state.reviews.find((x) => x.id === reviewId);
    if (!r) return;

    const uRev = userCache.get(r.reviewerId) || {};
    const uTarget = userCache.get(r.targetId) || {};
    const b = r.bookingId ? state.bookings.find((x) => x.id === r.bookingId) : null;
    const targetDriver = state.drivers.find((d) => d.uid === r.targetId);

    $('review-modal-title').textContent = 'Review Scrutiny & Moderation';
    $('review-modal-id').textContent = 'Review ID: ' + r.id;

    // Sentiment alert banner
    let alertBanner = '';
    if (r.rating <= 2) {
      alertBanner = `
        <div class="scrutiny-alert scrutiny-alert-danger">
          <span style="font-size:18px;">⚠️</span>
          <div>
            <strong>Low Rating / Grievance Alert</strong><br/>
            This review scored ${r.rating} star(s). Review trip route, examine driver notes, and contact reviewer directly to resolve any dispute.
          </div>
        </div>`;
    } else if (r.rating === 3) {
      alertBanner = `
        <div class="scrutiny-alert scrutiny-alert-warn">
          <span style="font-size:18px;">ℹ️</span>
          <div>
            <strong>Neutral Feedback</strong><br/>
            Customer gave a 3-star rating. Follow up if feedback indicates room for service improvement.
          </div>
        </div>`;
    } else {
      alertBanner = `
        <div class="scrutiny-alert scrutiny-alert-success">
          <span style="font-size:18px;">⭐</span>
          <div>
            <strong>Positive Satisfaction</strong><br/>
            Customer gave a high ${r.rating}-star rating.
          </div>
        </div>`;
    }

    const revName = uRev.displayName || r.reviewerName || 'Unnamed user';
    const targetName = uTarget.displayName || r.targetName || 'Assigned user';
    const vehicle = (targetDriver && targetDriver.vehicle) || {};
    const vehicleLine = [vehicle.make, vehicle.model, vehicle.plate ? `(${vehicle.plate})` : ''].filter(Boolean).join(' ') || 'Not recorded';

    const tagsHtml = (r.tags && r.tags.length)
      ? `<div class="review-tags">${r.tags.map(t => `<span class="review-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '<span class="cell-dim">No specific categories tagged</span>';

    const outreachHistoryHtml = (r.contactHistory && r.contactHistory.length)
      ? `<div class="outreach-history-wrap">
          ${r.contactHistory.map(entry => `
            <div class="outreach-item">
              <div class="outreach-item-head">
                <span>${escapeHtml(entry.method || 'Outreach')} — ${escapeHtml(entry.outcome || 'Logged')}</span>
                <span class="cell-dim">${escapeHtml(formatDate(entry.createdAt || entry.date))}</span>
              </div>
              ${entry.note ? `<div class="outreach-item-note">${escapeHtml(entry.note)}</div>` : ''}
              <div class="cell-dim" style="font-size:10px;">By: ${escapeHtml(entry.adminEmail || MANAGER_EMAIL)}</div>
            </div>
          `).join('')}
         </div>`
      : '<p class="cell-dim">No customer contact recorded yet.</p>';

    const modalBody = $('review-modal-body');
    modalBody.innerHTML = `
      ${alertBanner}

      <!-- RATING & COMMENT SUMMARY -->
      <div class="detail-section">
        <div class="detail-section-title">
          <span>Feedback &amp; Rating</span>
          <div>${renderStarsHtml(r.rating, true)}</div>
        </div>
        <div class="detail-grid">
          <div class="detail-item detail-item-full">
            <span class="detail-item-label">Customer Comment</span>
            <div class="review-body-text ${r.comment ? '' : 'is-empty-comment'}">${escapeHtml(r.comment || 'No written text provided (star rating only).')}</div>
          </div>
          <div class="detail-item detail-item-full">
            <span class="detail-item-label">Tags &amp; Feedback Flags</span>
            ${tagsHtml}
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Created At</span>
            <span class="detail-item-value">${escapeHtml(formatDate(r.createdAt))}</span>
          </div>
          <div class="detail-item">
            <span class="detail-item-label">Moderation Status</span>
            <div style="margin-top:2px;">
              ${r.hidden ? `<span class="badge badge-hidden">Hidden: ${escapeHtml(r.hiddenReason || 'Suppressed')}</span>` : '<span class="badge badge-visible">Visible (Public)</span>'}
              ${r.flagged ? '<span class="badge badge-flagged" style="margin-left:4px;">Flagged for Scrutiny</span>' : ''}
            </div>
          </div>
        </div>
      </div>

      <!-- INVOLVED PARTIES -->
      <div class="scrutiny-parties-grid">
        <!-- REVIEWER -->
        <div class="detail-section">
          <div class="detail-section-title">
            <span>Reviewer (${escapeHtml(r.reviewerRole)})</span>
            ${uRev.suspended ? '<span class="badge badge-suspended">Suspended</span>' : '<span class="badge badge-approved">Active</span>'}
          </div>
          <div class="detail-grid" style="grid-template-columns:1fr;">
            <div class="detail-item">
              <span class="detail-item-label">Name</span>
              <span class="detail-item-value">${escapeHtml(revName)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Phone</span>
              <span class="detail-item-value">📞 ${escapeHtml(uRev.phone || '—')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Email</span>
              <span class="detail-item-value">✉️ ${escapeHtml(uRev.email || '—')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Reviewer UID</span>
              <span class="uid-chip" data-copy="${escapeHtml(r.reviewerId)}" title="Copy UID">${escapeHtml(r.reviewerId || '—')}</span>
            </div>
          </div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-whatsapp btn-sm" id="modal-btn-contact-reviewer" type="button">Contact Reviewer</button>
            ${uRev.suspended
              ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(r.reviewerId)}" type="button">Reactivate</button>`
              : `<button class="btn btn-danger btn-sm" data-suspend="${escapeHtml(r.reviewerId)}" type="button">Suspend</button>`}
          </div>
        </div>

        <!-- SUBJECT UNDER REVIEW -->
        <div class="detail-section">
          <div class="detail-section-title">
            <span>Reviewed (${escapeHtml(r.targetRole)})</span>
            ${targetDriver ? `<span class="badge badge-approved">${escapeHtml(targetDriver.approvalStatus)}</span>` : ''}
          </div>
          <div class="detail-grid" style="grid-template-columns:1fr;">
            <div class="detail-item">
              <span class="detail-item-label">Name</span>
              <span class="detail-item-value">${escapeHtml(targetName)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Phone</span>
              <span class="detail-item-value">📞 ${escapeHtml(uTarget.phone || '—')}</span>
            </div>
            ${r.targetRole === 'DRIVER' ? `
              <div class="detail-item">
                <span class="detail-item-label">Vehicle</span>
                <span class="detail-item-value">🚘 ${escapeHtml(vehicleLine)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-item-label">Driver Overall Rating</span>
                <span class="detail-item-value">★ ${Number(targetDriver && targetDriver.ratingAvg || 5).toFixed(1)} (${(targetDriver && targetDriver.ratingCount) || 0} reviews)</span>
              </div>
            ` : ''}
            <div class="detail-item">
              <span class="detail-item-label">Subject UID</span>
              <span class="uid-chip" data-copy="${escapeHtml(r.targetId)}" title="Copy UID">${escapeHtml(r.targetId || '—')}</span>
            </div>
          </div>
          ${(targetDriver && targetDriver.approvalStatus === 'APPROVED') ? `
            <div style="margin-top:8px;">
              <button class="btn btn-warn btn-sm" data-demote="${escapeHtml(r.targetId)}" type="button">Demote Driver</button>
            </div>` : ''}
        </div>
      </div>

      <!-- ASSOCIATED BOOKING -->
      ${b ? `
        <div class="detail-section">
          <div class="detail-section-title">
            <span>Trip &amp; Route Details</span>
            ${statusBadgeHtml(b.status)}
          </div>
          <div class="detail-grid">
            <div class="detail-item detail-item-full">
              <span class="detail-item-label">Route</span>
              <span class="detail-item-value">${escapeHtml(b.pickupAddress || (b.pickup && b.pickup.address) || '—')} → ${escapeHtml(b.dropoffAddress || (b.destination && b.destination.address) || '—')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Fare</span>
              <span class="detail-item-value">${escapeHtml(formatZar(getBookingPrice(b)))}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Ride Type</span>
              <span class="detail-item-value">${escapeHtml(b.type ? titleCase(String(b.type).replace(/_/g, ' ')) : 'Standard')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item-label">Booking ID</span>
              <span class="uid-chip" data-copy="${escapeHtml(b.id)}" title="Copy ID">${escapeHtml(b.id)}</span>
            </div>
            <div class="detail-item">
              <button class="btn btn-ghost btn-sm" id="modal-btn-view-booking" type="button">Open Full Booking Details</button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- OFFICIAL MANAGER RESPONSE -->
      <div class="detail-section">
        <div class="detail-section-title">
          <span>Official Manager Response</span>
          ${r.managerRespondedAt ? `<span class="cell-dim">Saved ${escapeHtml(formatDate(r.managerRespondedAt))}</span>` : ''}
        </div>
        <label class="field">
          <textarea id="modal-manager-response-input" class="field-input" rows="2" placeholder="Type an official response or resolution note to this review…">${escapeHtml(r.managerResponse || '')}</textarea>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          ${r.managerResponse ? '<button class="btn btn-ghost btn-sm" id="modal-btn-clear-response" type="button">Remove Response</button>' : ''}
          <button class="btn btn-primary btn-sm" id="modal-btn-save-response" type="button">Save Manager Response</button>
        </div>
      </div>

      <!-- OUTREACH & CONTACT HISTORY -->
      <div class="detail-section">
        <div class="detail-section-title">
          <span>Outreach &amp; Resolution History</span>
          <button class="btn btn-link btn-sm" id="modal-btn-log-outreach" type="button">+ Log Outreach Attempt</button>
        </div>
        ${outreachHistoryHtml}
      </div>

      <!-- MODERATION CONTROLS -->
      <div class="detail-section" style="background:var(--bg-elevated);">
        <div class="detail-section-title"><span>Moderation Actions</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button class="btn btn-ghost btn-sm" id="modal-btn-toggle-flag" type="button">
            ${r.flagged ? '🏳️ Unflag Scrutiny' : '🚩 Flag for Scrutiny'}
          </button>
          ${r.hidden
            ? '<button class="btn btn-ghost btn-sm" id="modal-btn-unhide" type="button">👁️ Restore to Public View</button>'
            : '<button class="btn btn-warn btn-sm" id="modal-btn-hide" type="button">👁️ Hide from Public View</button>'}
          <button class="btn btn-danger btn-sm" id="modal-btn-delete" type="button">🗑️ Delete Review</button>
        </div>
      </div>
    `;

    // Wire buttons in modal
    $('modal-btn-contact-reviewer').addEventListener('click', () => {
      hide($('review-detail-overlay'));
      openContactReviewerModal(reviewId);
    });

    if ($('modal-btn-log-outreach')) {
      $('modal-btn-log-outreach').addEventListener('click', () => {
        hide($('review-detail-overlay'));
        openContactReviewerModal(reviewId);
      });
    }

    if ($('modal-btn-view-booking') && b) {
      $('modal-btn-view-booking').addEventListener('click', () => {
        hide($('review-detail-overlay'));
        openBookingModal(b.id);
      });
    }

    $('modal-btn-toggle-flag').addEventListener('click', async () => {
      await toggleFlagReview(reviewId);
      openReviewModal(reviewId);
    });

    if ($('modal-btn-hide')) {
      $('modal-btn-hide').addEventListener('click', async () => {
        await hideReview(reviewId);
        openReviewModal(reviewId);
      });
    }
    if ($('modal-btn-unhide')) {
      $('modal-btn-unhide').addEventListener('click', async () => {
        await unhideReview(reviewId);
        openReviewModal(reviewId);
      });
    }

    $('modal-btn-delete').addEventListener('click', async () => {
      hide($('review-detail-overlay'));
      await deleteReview(reviewId);
    });

    $('modal-btn-save-response').addEventListener('click', async () => {
      const txt = $('modal-manager-response-input').value.trim();
      await saveManagerResponse(reviewId, txt);
      openReviewModal(reviewId);
    });

    if ($('modal-btn-clear-response')) {
      $('modal-btn-clear-response').addEventListener('click', async () => {
        await saveManagerResponse(reviewId, '');
        openReviewModal(reviewId);
      });
    }

    // User suspend/demote triggers inside modal
    modalBody.querySelectorAll('[data-suspend]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await suspendUser(btn.getAttribute('data-suspend'));
        openReviewModal(reviewId);
      });
    });
    modalBody.querySelectorAll('[data-reactivate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await reactivateUser(btn.getAttribute('data-reactivate'));
        openReviewModal(reviewId);
      });
    });
    modalBody.querySelectorAll('[data-demote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await demoteDriver(btn.getAttribute('data-demote'));
        openReviewModal(reviewId);
      });
    });

    show($('review-detail-overlay'));
  }

  function openContactReviewerModal(reviewId) {
    const r = state.reviews.find((x) => x.id === reviewId);
    if (!r) return;

    const uRev = userCache.get(r.reviewerId) || {};
    const revName = uRev.displayName || r.reviewerName || 'Customer';
    const rawPhone = uRev.phone || r.reviewerPhone || '';
    const cleanPhone = cleanPhoneNumber(rawPhone);
    const email = uRev.email || r.reviewerEmail || '';
    const bookingId = r.bookingId || '—';

    $('contact-modal-title').textContent = 'Contact Reviewer — ' + revName;
    $('contact-modal-subtitle').textContent = `📞 ${rawPhone || 'No phone'} · ✉️ ${email || 'No email'}`;

    // Message templates
    const templates = {
      low_rating: `Hello ${revName}, this is LaynFleet Management regarding your recent ride (Booking Ref: ${bookingId}). We noticed your ${r.rating}-star review and want to make sure your concerns are addressed. Could you please share more details with us so we can assist you and ensure this doesn't happen again?`,
      general_feedback: `Hi ${revName}, thank you for using LaynFleet. Management is following up on your recent feedback for trip ${bookingId}. We appreciate your support and wanted to check if there's anything else we can assist you with.`,
      fare_dispute: `Hello ${revName}, LaynFleet Support is reaching out regarding your review on trip ${bookingId}. If you experienced an issue with the fare or route, our management team is ready to review and resolve it for you.`
    };

    const modalBody = $('contact-modal-body');
    modalBody.innerHTML = `
      <!-- REVIEW CONTEXT SNIPPET -->
      <div class="contact-context-box">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <strong>Review Reference</strong>
          <div>${renderStarsHtml(r.rating, true)}</div>
        </div>
        <div class="review-body-text ${r.comment ? '' : 'is-empty-comment'}" style="margin:0;font-size:12.5px;">
          ${escapeHtml(r.comment ? `"${r.comment}"` : 'No written feedback (star rating only)')}
        </div>
        <div class="cell-dim" style="font-size:11px;">
          <span>Trip: ${escapeHtml(bookingId)}</span> · <span>Date: ${escapeHtml(formatDate(r.createdAt))}</span>
        </div>
      </div>

      <!-- CHANNELS GRID -->
      <div class="contact-channels-grid">
        <!-- WHATSAPP -->
        <div class="contact-channel-card">
          <div class="contact-channel-header">
            <span>WhatsApp Direct</span>
            <span class="badge badge-online">Fastest</span>
          </div>
          <label class="field" style="margin-top:4px;">
            <span class="field-label" style="font-size:11px;">Message Template</span>
            <select id="wa-template-select" class="field-input filter-select" style="height:32px;padding:4px 8px;font-size:12px;">
              <option value="low_rating">Low Rating Follow-Up</option>
              <option value="general_feedback">General Feedback</option>
              <option value="fare_dispute">Fare / Route Issue</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label" style="font-size:11px;">WhatsApp Message Preview</span>
            <textarea id="wa-message-input" class="field-input" rows="4" style="font-size:12px;">${escapeHtml(templates.low_rating)}</textarea>
          </label>
          <button class="btn btn-whatsapp btn-block" id="btn-launch-whatsapp" type="button" ${cleanPhone ? '' : 'disabled'}>
            📱 Open WhatsApp Chat (${escapeHtml(rawPhone || 'No Phone')})
          </button>
        </div>

        <!-- PHONE & EMAIL -->
        <div class="contact-channel-card">
          <div class="contact-channel-header"><span>Direct Phone &amp; Email</span></div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
            <a class="btn btn-call btn-block" href="tel:${escapeHtml(cleanPhone)}" style="text-align:center;text-decoration:none;display:block;" ${cleanPhone ? '' : 'disabled'}>
              📞 Call ${escapeHtml(rawPhone || 'No Phone')}
            </a>
            <button class="btn btn-ghost btn-sm btn-block" id="btn-copy-phone" type="button" ${rawPhone ? '' : 'disabled'}>
              📋 Copy Phone Number
            </button>
            <hr style="border:0;border-top:1px solid var(--border);margin:4px 0;" />
            <a class="btn btn-ghost btn-block" href="mailto:${escapeHtml(email)}?subject=${encodeURIComponent(`LaynFleet Support: Feedback regarding your ride (${bookingId})`)}&body=${encodeURIComponent(templates.low_rating)}" style="text-align:center;text-decoration:none;display:block;" ${email ? '' : 'disabled'}>
              ✉️ Send Email (${escapeHtml(email || 'No Email')})
            </a>
            <button class="btn btn-ghost btn-sm btn-block" id="btn-copy-email" type="button" ${email ? '' : 'disabled'}>
              📋 Copy Email Address
            </button>
          </div>
        </div>
      </div>

      <!-- LOG OUTREACH ATTEMPT FORM -->
      <div class="detail-section">
        <div class="detail-section-title"><span>Record Outreach Attempt / Resolution</span></div>
        <div class="detail-grid">
          <div class="detail-item">
            <label class="field-label" for="outreach-method">Contact Method</label>
            <select id="outreach-method" class="field-input filter-select">
              <option value="WhatsApp">WhatsApp</option>
              <option value="Phone Call">Phone Call</option>
              <option value="SMS">SMS</option>
              <option value="Email">Email</option>
              <option value="In-Person">In-Person</option>
            </select>
          </div>
          <div class="detail-item">
            <label class="field-label" for="outreach-outcome">Outcome</label>
            <select id="outreach-outcome" class="field-input filter-select">
              <option value="Resolved — Customer Satisfied">Resolved — Customer Satisfied</option>
              <option value="Explanation &amp; Apology Accepted">Explanation &amp; Apology Accepted</option>
              <option value="Driver Counseled / Warned">Driver Counseled / Warned</option>
              <option value="Refund / Fare Credit Issued">Refund / Fare Credit Issued</option>
              <option value="Pending Further Investigation">Pending Further Investigation</option>
              <option value="No Answer / Left Voicemail">No Answer / Left Voicemail</option>
              <option value="Customer Unreachable">Customer Unreachable</option>
            </select>
          </div>
          <div class="detail-item detail-item-full">
            <label class="field-label" for="outreach-note">Manager Investigation Notes</label>
            <textarea id="outreach-note" class="field-input" rows="2" placeholder="e.g. Spoke to reviewer, clarified traffic situation, issued credit / driver warned."></textarea>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:6px;">
          <button class="btn btn-primary btn-sm" id="btn-save-outreach" type="button">Save Outreach Record</button>
        </div>
      </div>
    `;

    // Template change handler
    const tSelect = $('wa-template-select');
    const waInput = $('wa-message-input');
    tSelect.addEventListener('change', () => {
      waInput.value = templates[tSelect.value] || '';
    });

    // Launch WhatsApp
    $('btn-launch-whatsapp').addEventListener('click', () => {
      const msg = encodeURIComponent(waInput.value.trim());
      const url = `https://wa.me/${cleanPhone}?text=${msg}`;
      window.open(url, '_blank');
      toast('Opening WhatsApp chat…', 'success');
    });

    // Copy Phone / Email
    $('btn-copy-phone').addEventListener('click', () => {
      if (rawPhone && navigator.clipboard) {
        navigator.clipboard.writeText(rawPhone).then(() => toast('Phone number copied.', 'success')).catch(() => {});
      }
    });
    $('btn-copy-email').addEventListener('click', () => {
      if (email && navigator.clipboard) {
        navigator.clipboard.writeText(email).then(() => toast('Email address copied.', 'success')).catch(() => {});
      }
    });

    // Save Outreach Record
    $('btn-save-outreach').addEventListener('click', async () => {
      const method = $('outreach-method').value;
      const outcome = $('outreach-outcome').value;
      const note = $('outreach-note').value.trim();

      await logOutreachAttempt(reviewId, method, outcome, note);
      hide($('contact-reviewer-overlay'));
      openReviewModal(reviewId);
    });

    show($('contact-reviewer-overlay'));
  }

  async function updateReviewData(reviewId, data) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    const docRef = reviewsCol.doc(reviewId);
    const snap = await docRef.get();
    if (snap.exists) {
      await docRef.update(data);
    } else {
      await docRef.set({
        ...data,
        rating: rev ? rev.rating : 5,
        comment: rev ? rev.comment : '',
        reviewerId: rev ? rev.reviewerId : '',
        reviewerRole: rev ? rev.reviewerRole : 'RIDER',
        targetId: rev ? rev.targetId : '',
        targetRole: rev ? rev.targetRole : 'DRIVER',
        bookingId: rev ? rev.bookingId : '',
        createdAt: (rev && rev.createdAt) || serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
    }
  }

  async function hideReview(reviewId) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    const res = await openModal({
      title: 'Hide review from public view',
      message: `Hide this review from public display? It will remain stored for management records and internal scrutiny.`,
      confirmText: 'Hide Review',
      confirmClass: 'btn-warn',
      requireReason: true
    });
    if (!res.confirmed) return;

    try {
      await updateReviewData(reviewId, {
        hidden: true,
        hiddenReason: res.reason,
        hiddenBy: MANAGER_EMAIL,
        hiddenAt: serverTimestamp(),
        status: 'HIDDEN'
      });
      await logAdminAction('hideReview', reviewId, rev ? rev.reviewerName : '', res.reason);
      toast('Review hidden from public view.', 'success');
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to hide review: ' + (err.message || ''), 'error');
    }
  }

  async function unhideReview(reviewId) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    const res = await openModal({
      title: 'Restore review to public view',
      message: `Make this review visible again on public LaynFleet apps?`,
      confirmText: 'Unhide Review',
      confirmClass: 'btn-primary'
    });
    if (!res.confirmed) return;

    try {
      await updateReviewData(reviewId, {
        hidden: false,
        hiddenReason: firebase.firestore.FieldValue.delete(),
        hiddenBy: firebase.firestore.FieldValue.delete(),
        hiddenAt: firebase.firestore.FieldValue.delete(),
        status: 'ACTIVE'
      });
      await logAdminAction('unhideReview', reviewId, rev ? rev.reviewerName : '', 'Restored to public');
      toast('Review restored to public view.', 'success');
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to unhide review: ' + (err.message || ''), 'error');
    }
  }

  async function deleteReview(reviewId) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    const res = await openModal({
      title: 'Delete review',
      message: `Permanently delete this review? This action cannot be undone.`,
      confirmText: 'Delete Review',
      confirmClass: 'btn-danger',
      requireReason: true
    });
    if (!res.confirmed) return;

    try {
      await reviewsCol.doc(reviewId).delete();
      if (rev && rev.bookingId) {
        try {
          await bookingsCol.doc(rev.bookingId).update({
            rating: firebase.firestore.FieldValue.delete(),
            review: firebase.firestore.FieldValue.delete(),
            feedback: firebase.firestore.FieldValue.delete(),
            reviewDeleted: true,
            reviewDeletedAt: serverTimestamp(),
            reviewDeletedBy: MANAGER_EMAIL,
            reviewDeletedReason: res.reason
          });
        } catch (e) { /* non-fatal */ }
      }
      await logAdminAction('deleteReview', reviewId, rev ? rev.reviewerName : '', res.reason);
      toast('Review deleted permanently.', 'success');
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to delete review: ' + (err.message || ''), 'error');
    }
  }

  async function toggleFlagReview(reviewId) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    if (!rev) return;
    const newFlag = !rev.flagged;
    try {
      await updateReviewData(reviewId, {
        flagged: newFlag,
        flaggedAt: newFlag ? serverTimestamp() : firebase.firestore.FieldValue.delete(),
        flaggedBy: newFlag ? MANAGER_EMAIL : firebase.firestore.FieldValue.delete()
      });
      await logAdminAction(newFlag ? 'flagReview' : 'unflagReview', reviewId, rev.reviewerName || '', newFlag ? 'Flagged for manager investigation' : 'Resolved scrutiny');
      toast(newFlag ? 'Review flagged for scrutiny.' : 'Review scrutiny flag cleared.', 'success');
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to update flag: ' + (err.message || ''), 'error');
    }
  }

  async function saveManagerResponse(reviewId, responseText) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    try {
      if (responseText) {
        await updateReviewData(reviewId, {
          managerResponse: responseText,
          managerRespondedAt: serverTimestamp(),
          managerRespondedBy: MANAGER_EMAIL
        });
        await logAdminAction('respondToReview', reviewId, rev ? rev.reviewerName : '', responseText);
        toast('Manager response saved.', 'success');
      } else {
        await updateReviewData(reviewId, {
          managerResponse: firebase.firestore.FieldValue.delete(),
          managerRespondedAt: firebase.firestore.FieldValue.delete(),
          managerRespondedBy: firebase.firestore.FieldValue.delete()
        });
        await logAdminAction('clearReviewResponse', reviewId, rev ? rev.reviewerName : '');
        toast('Manager response removed.', 'success');
      }
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to save response: ' + (err.message || ''), 'error');
    }
  }

  async function logOutreachAttempt(reviewId, method, outcome, note) {
    const rev = state.reviews.find((x) => x.id === reviewId);
    const newEntry = {
      date: new Date().toISOString(),
      method: method || 'Outreach',
      outcome: outcome || 'Logged',
      note: note || '',
      adminEmail: MANAGER_EMAIL
    };

    try {
      const currentHistory = (rev && rev.contactHistory) ? [...rev.contactHistory] : [];
      currentHistory.unshift(newEntry);

      await updateReviewData(reviewId, {
        contactHistory: currentHistory,
        lastContactedAt: serverTimestamp(),
        lastContactedBy: MANAGER_EMAIL,
        lastOutcome: outcome
      });

      await logAdminAction('contactReviewer', reviewId, rev ? rev.reviewerName : '', `${method}: ${outcome} — ${note}`);
      toast('Outreach attempt recorded successfully.', 'success');
      await consolidateAndHydrateReviews();
    } catch (err) {
      console.error(err);
      toast('Failed to record outreach: ' + (err.message || ''), 'error');
    }
  }

  function filterReviewsBySubject(searchTerm) {
    goToSection('reviews');
    state.reviewFilters.search = searchTerm || '';
    const input = $('review-filter-search');
    if (input) input.value = searchTerm || '';
    renderReviews();
  }

  // ---------------------------------------------------------------------------
  // PRICING & DEMOCRATIC GOVERNANCE
  // ---------------------------------------------------------------------------
  const DEFAULT_VEHICLE_PRICING = [
    { type: 'PRIVATE_CAR', label: 'Private Car', defaultRate: 10.0, defaultMin: 25.0 },
    { type: 'MINI_BUS', label: 'Mini Bus', defaultRate: 12.0, defaultMin: 30.0 },
    { type: 'BAKKIE', label: 'Bakkie', defaultRate: 12.0, defaultMin: 30.0 },
    { type: 'MOTORBIKE', label: 'Motorbike', defaultRate: 7.0, defaultMin: 18.0 },
    { type: 'TUK_TUK', label: 'Tuk Tuk', defaultRate: 6.0, defaultMin: 15.0 }
  ];

  function renderPricing() {
    const ratesTableEl = $('pricing-rates-table');
    const proposalsListEl = $('pricing-proposals-list');
    const historyTableEl = $('pricing-history-table');

    // Build rate mapping
    const ratesMap = new Map();
    state.pricingRates.forEach((r) => {
      const key = (r.vehicleType || r.id).toUpperCase();
      ratesMap.set(key, r);
    });

    // 1. Stats Summary
    const privateRate = ratesMap.get('PRIVATE_CAR') || { ratePerKm: 10.0, minimumFare: 25.0 };
    if ($('stat-pricing-private-rate')) $('stat-pricing-private-rate').textContent = `R${privateRate.ratePerKm.toFixed(2)}/km`;
    if ($('stat-pricing-private-min')) $('stat-pricing-private-min').textContent = `Min Fare: R${privateRate.minimumFare.toFixed(2)}`;
    if ($('stat-pricing-active-proposals')) $('stat-pricing-active-proposals').textContent = state.pricingProposals.length;
    if ($('stat-pricing-history-count')) $('stat-pricing-history-count').textContent = state.pricingHistory.length;

    // 2. Rates Table
    if (ratesTableEl) {
      const rowsHtml = DEFAULT_VEHICLE_PRICING.map((vp) => {
        const doc = ratesMap.get(vp.type);
        const ratePerKm = (doc && typeof doc.ratePerKm === 'number') ? doc.ratePerKm : vp.defaultRate;
        const minFare = (doc && typeof doc.minimumFare === 'number') ? doc.minimumFare : vp.defaultMin;
        const hasActiveProposal = doc && Boolean(doc.activeProposalId);
        const updatedAtStr = doc && doc.updatedAt ? formatDate(doc.updatedAt) : 'Seed Baseline';

        return `
          <tr>
            <td><strong>${escapeHtml(vp.label)}</strong></td>
            <td><strong>R${ratePerKm.toFixed(2)}</strong> / km</td>
            <td>R${minFare.toFixed(2)}</td>
            <td>
              ${hasActiveProposal
                ? '<span class="status-badge status-badge-pending">🗳️ Voting in Progress</span>'
                : '<span class="status-badge status-badge-approved">✓ Active Rate</span>'}
            </td>
            <td>${escapeHtml(updatedAtStr)}</td>
          </tr>
        `;
      }).join('');

      ratesTableEl.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Vehicle Type</th>
              <th>Rate / km</th>
              <th>Minimum Fare</th>
              <th>Governance Status</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }

    // 3. Active Proposals (Live Democratic Votes)
    if (proposalsListEl) {
      if (state.pricingProposals.length === 0) {
        proposalsListEl.innerHTML = '<p class="empty">No active pricing proposals under vote.</p>';
      } else {
        proposalsListEl.innerHTML = state.pricingProposals.map((prop) => {
          const vTypeObj = DEFAULT_VEHICLE_PRICING.find((x) => x.type === prop.vehicleType) || { label: prop.vehicleType };
          const yesVotes = Number(prop.yesVoteCount || 0);
          const noVotes = Number(prop.noVoteCount || 0);
          const requiredYes = Number(prop.requiredYesVotes || 1);
          const totalDrivers = Number(prop.totalEligibleDrivers || 1);
          const progressPct = Math.min(100, Math.round((yesVotes / requiredYes) * 100));

          return `
            <div class="card card-proposal" style="padding: 16px; border-left: 4px solid var(--brand);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div>
                  <h4 style="margin: 0; font-size: 16px;">${escapeHtml(vTypeObj.label)} Pricing Proposal</h4>
                  <span class="muted" style="font-size: 12px;">Proposed by ${escapeHtml(prop.proposerName || 'Driver')} · ${formatDate(prop.createdAt)}</span>
                </div>
                <span class="status-badge status-badge-pending">ACTIVE VOTING</span>
              </div>

              <div style="display: flex; gap: 24px; margin: 12px 0; background: var(--panel-2); padding: 12px; border-radius: var(--radius-sm);">
                <div>
                  <span class="muted" style="font-size: 11px; text-transform: uppercase;">Proposed Rate</span>
                  <div style="font-size: 16px; font-weight: 800; color: var(--brand);">R${Number(prop.proposedRatePerKm).toFixed(2)}/km · Min R${Number(prop.proposedMinimumFare).toFixed(2)}</div>
                </div>
                <div>
                  <span class="muted" style="font-size: 11px; text-transform: uppercase;">Current Rate</span>
                  <div style="font-size: 14px; color: var(--text-dim);">R${Number(prop.currentRatePerKm).toFixed(2)}/km · Min R${Number(prop.currentMinimumFare).toFixed(2)}</div>
                </div>
              </div>

              ${prop.reason ? `<p style="font-size: 13px; font-style: italic; margin: 8px 0; color: var(--text-dim);">"${escapeHtml(prop.reason)}"</p>` : ''}

              <div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px;">
                  <span><strong>${yesVotes} YES</strong> · ${noVotes} NO</span>
                  <span class="muted">${requiredYes} YES votes needed for 60% Quorum (${totalDrivers} eligible drivers)</span>
                </div>
                <div style="height: 8px; background: var(--border); border-radius: 4px; overflow: hidden;">
                  <div style="height: 100%; width: ${progressPct}%; background: var(--brand); border-radius: 4px;"></div>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 4. Pricing History Audit Table
    if (historyTableEl) {
      if (state.pricingHistory.length === 0) {
        historyTableEl.innerHTML = '<p class="empty">No historical pricing proposal records found.</p>';
      } else {
        const rowsHtml = state.pricingHistory.map((h) => {
          const vTypeObj = DEFAULT_VEHICLE_PRICING.find((x) => x.type === h.vehicleType) || { label: h.vehicleType };
          const statusBadge = h.status === 'APPROVED'
            ? '<span class="status-badge status-badge-approved">APPROVED</span>'
            : '<span class="status-badge status-badge-rejected">REJECTED</span>';

          return `
            <tr>
              <td>${formatDate(h.resolvedAt || h.createdAt)}</td>
              <td><strong>${escapeHtml(vTypeObj.label)}</strong></td>
              <td><strong>R${Number(h.proposedRatePerKm).toFixed(2)}/km</strong> (Min R${Number(h.proposedMinimumFare).toFixed(2)})</td>
              <td>R${Number(h.currentRatePerKm).toFixed(2)}/km</td>
              <td>${statusBadge}</td>
              <td>${Number(h.yesVoteCount || 0)} YES / ${Number(h.noVoteCount || 0)} NO</td>
              <td>${escapeHtml(h.proposerName || 'Driver')}</td>
            </tr>
          `;
        }).join('');

        historyTableEl.innerHTML = `
          <table class="data-table">
            <thead>
              <tr>
                <th>Date Resolved</th>
                <th>Vehicle Type</th>
                <th>Proposed Rate</th>
                <th>Previous Rate</th>
                <th>Outcome</th>
                <th>Final Vote</th>
                <th>Proposer</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        `;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // APP CONTROL & SYSTEM GATES
  // ---------------------------------------------------------------------------
  const APP_NAMES = {
    'com.digilayn.laynrider': 'LaynRider (Rider App)',
    'com.digilayn.layndriver': 'LaynDriver (Driver App)'
  };

  function renderAppControl() {
    const riderConfig = state.appConfig['com.digilayn.laynrider'] || {};
    const driverConfig = state.appConfig['com.digilayn.layndriver'] || {};

    // 1. Update KPI overview cards
    const riderMaint = riderConfig.maintenanceMode === true;
    const riderMinVer = Number(riderConfig.minVersionCode || 1);
    const statRiderEl = $('stat-app-rider-status');
    const statRiderDetailsEl = $('stat-app-rider-details');
    if (statRiderEl && statRiderDetailsEl) {
      if (riderMaint) {
        statRiderEl.innerHTML = '<span class="status-pill status-demoted" style="font-size: 14px;">🚧 Maintenance Active</span>';
        statRiderDetailsEl.textContent = riderConfig.maintenanceMessage || 'App entrance blocked';
      } else if (riderMinVer > 1) {
        statRiderEl.innerHTML = `<span class="status-pill status-approved" style="font-size: 14px;">Operational (Min v${riderMinVer})</span>`;
        statRiderDetailsEl.textContent = 'Force upgrade policy active';
      } else {
        statRiderEl.innerHTML = '<span class="status-pill status-approved" style="font-size: 14px;">🟢 Operational</span>';
        statRiderDetailsEl.textContent = 'Min v1 · Open for riders';
      }
    }

    const driverMaint = driverConfig.maintenanceMode === true;
    const driverMinVer = Number(driverConfig.minVersionCode || 1);
    const statDriverEl = $('stat-app-driver-status');
    const statDriverDetailsEl = $('stat-app-driver-details');
    if (statDriverEl && statDriverDetailsEl) {
      if (driverMaint) {
        statDriverEl.innerHTML = '<span class="status-pill status-demoted" style="font-size: 14px;">🚧 Maintenance Active</span>';
        statDriverDetailsEl.textContent = driverConfig.maintenanceMessage || 'App entrance blocked';
      } else if (driverMinVer > 1) {
        statDriverEl.innerHTML = `<span class="status-pill status-approved" style="font-size: 14px;">Operational (Min v${driverMinVer})</span>`;
        statDriverDetailsEl.textContent = 'Force upgrade policy active';
      } else {
        statDriverEl.innerHTML = '<span class="status-pill status-approved" style="font-size: 14px;">🟢 Operational</span>';
        statDriverDetailsEl.textContent = 'Min v1 · Open for drivers';
      }
    }

    const statGlobalEl = $('stat-app-global-status');
    const statLastUpdatedEl = $('stat-app-last-updated');
    if (statGlobalEl && statLastUpdatedEl) {
      if (riderMaint && driverMaint) {
        statGlobalEl.innerHTML = '<span style="color: var(--danger, #ef4444);">Full Fleet Locked</span>';
        statLastUpdatedEl.textContent = 'All apps in maintenance';
      } else if (riderMaint || driverMaint) {
        statGlobalEl.innerHTML = '<span style="color: var(--warn, #f59e0b);">Partial Maintenance</span>';
        statLastUpdatedEl.textContent = riderMaint ? 'Rider app locked' : 'Driver app locked';
      } else {
        statGlobalEl.innerHTML = '<span style="color: var(--success, #22c55e);">All Systems Live</span>';
        statLastUpdatedEl.textContent = 'Ready for bookings';
      }
    }

    // Update tab badges
    const riderBadge = $('badge-tab-rider');
    if (riderBadge) {
      riderBadge.textContent = riderMaint ? 'MAINTENANCE' : `v${riderMinVer}`;
      riderBadge.className = 'tab-badge-pill ' + (riderMaint ? 'pill-danger' : 'pill-success');
    }
    const driverBadge = $('badge-tab-driver');
    if (driverBadge) {
      driverBadge.textContent = driverMaint ? 'MAINTENANCE' : `v${driverMinVer}`;
      driverBadge.className = 'tab-badge-pill ' + (driverMaint ? 'pill-danger' : 'pill-success');
    }

    // Sidebar badge
    const navBadge = $('nav-badge-appcontrol');
    if (navBadge) {
      const hasActiveAlert = riderMaint || driverMaint;
      navBadge.classList.toggle('is-hidden', !hasActiveAlert);
      if (hasActiveAlert) {
        navBadge.textContent = '!';
        navBadge.style.background = 'var(--danger, #ef4444)';
        navBadge.style.color = '#fff';
      }
    }

    // Render active tab config form
    updateAppConfigFormFromState();
  }

  function updateAppConfigFormFromState() {
    const pkg = state.appConfigTab;
    const formPanel = $('appcontrol-form-panel');
    const emergencyPanel = $('appcontrol-emergency-panel');

    if (pkg === 'emergency') {
      hide(formPanel);
      show(emergencyPanel);
      return;
    }

    show(formPanel);
    hide(emergencyPanel);

    const config = state.appConfig[pkg] || {};
    const isRider = pkg === 'com.digilayn.laynrider';
    if ($('app-config-title')) $('app-config-title').textContent = isRider ? 'LaynRider Configuration' : 'LaynDriver Configuration';
    if ($('app-config-pkg')) $('app-config-pkg').textContent = pkg;

    const maintChecked = config.maintenanceMode === true;
    if ($('input-app-maintenance')) $('input-app-maintenance').checked = maintChecked;
    if ($('input-app-maintenance-msg')) $('input-app-maintenance-msg').value = config.maintenanceMessage || '';
    if ($('input-app-min-version')) $('input-app-min-version').value = Number(config.minVersionCode || 1);
    if ($('input-app-store-url')) $('input-app-store-url').value = config.storeUrl || '';

    const badgeEl = $('app-config-state-badge');
    if (badgeEl) {
      if (maintChecked) {
        badgeEl.textContent = 'Maintenance Mode Active';
        badgeEl.className = 'badge badge-demoted';
      } else {
        badgeEl.textContent = 'Operational';
        badgeEl.className = 'badge badge-approved';
      }
    }

    updateSimulatorPreview();
  }

  function updateSimulatorPreview() {
    const maintInput = $('input-app-maintenance');
    const msgInput = $('input-app-maintenance-msg');
    const minVerInput = $('input-app-min-version');
    const storeUrlInput = $('input-app-store-url');

    if (!maintInput || !msgInput || !minVerInput) return;

    const maint = maintInput.checked;
    const msg = (msgInput.value || '').trim();
    const minVer = parseInt(minVerInput.value, 10) || 1;
    const storeUrl = storeUrlInput ? (storeUrlInput.value || '').trim() : '';

    const resultEl = $('preview-sim-result');
    const textEl = $('preview-sim-text');
    if (!resultEl || !textEl) return;

    if (maint) {
      resultEl.textContent = 'Blocked by Maintenance Gate';
      resultEl.className = 'preview-result-pill pill-danger';
      textEl.innerHTML = `<strong>Blocking Screen:</strong> "${escapeHtml(msg || 'LaynFleet is undergoing maintenance. Please check back shortly.')}" — users cannot proceed.`;
    } else if (minVer > 1) {
      resultEl.textContent = `Force Upgrade Gate (v < ${minVer})`;
      resultEl.className = 'preview-result-pill pill-warn';
      textEl.innerHTML = `<strong>Version Policy:</strong> Devices on version code &lt; <strong>${minVer}</strong> will be halted with an 'Update Required' button linking to <code>${escapeHtml(storeUrl || 'Store URL')}</code>.`;
    } else {
      resultEl.textContent = 'Passes Launch Gate (Operational)';
      resultEl.className = 'preview-result-pill pill-success';
      textEl.textContent = 'Users running any build will smoothly enter the app and reach the dashboard.';
    }
  }

  function renderAppControlAudit() {
    const container = $('appcontrol-audit-table');
    if (!container) return;

    const list = state.appConfigAudit || [];
    if (!list.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p class="empty-title">No config changes recorded yet</p>
          <p class="empty-subtitle">State updates will appear in this audit log.</p>
        </div>
      `;
      return;
    }

    const rowsHtml = list.map((item) => {
      let detail = escapeHtml(item.reason || '');
      try {
        const parsed = JSON.parse(item.reason);
        if (parsed && typeof parsed === 'object') {
          detail = `Maint: <strong>${parsed.maintenanceMode ? 'ON' : 'OFF'}</strong> · MinVer: <strong>v${parsed.minVersionCode || 1}</strong>`;
        }
      } catch (e) { /* use raw string */ }

      return `
        <tr>
          <td>${escapeHtml(formatDate(item.createdAt))}</td>
          <td><code>${escapeHtml(item.targetUid || 'Fleet')}</code></td>
          <td><span class="badge badge-pending">${escapeHtml(item.action || 'update')}</span></td>
          <td>${detail}</td>
          <td>${escapeHtml(item.adminEmail || MANAGER_EMAIL)}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Package</th>
            <th>Action</th>
            <th>Applied State</th>
            <th>Admin</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  async function saveCurrentAppConfig() {
    const pkg = state.appConfigTab;
    if (pkg === 'emergency') return;

    const maintenanceMode = $('input-app-maintenance').checked;
    const maintenanceMessage = ($('input-app-maintenance-msg').value || '').trim();
    const minVersionCode = Math.max(1, parseInt($('input-app-min-version').value, 10) || 1);
    const storeUrl = ($('input-app-store-url').value || '').trim();

    const appTitle = APP_NAMES[pkg] || pkg;
    const confirm = await openModal({
      title: `Update ${appTitle} State?`,
      message: `You are about to update live launch gate rules for ${appTitle}:
• Maintenance Mode: ${maintenanceMode ? 'ENABLED (BLOCKING)' : 'Disabled (Operational)'}
• Min Version Code: ${minVersionCode}
• Store URL: ${storeUrl || 'None'}

This applies immediately to all connected devices.`,
      confirmText: 'Broadcast State',
      confirmClass: maintenanceMode ? 'btn-danger' : 'btn-primary'
    });

    if (!confirm) return;

    try {
      const payload = {
        maintenanceMode,
        maintenanceMessage: maintenanceMessage || 'LaynFleet is undergoing scheduled system maintenance. Please check back shortly.',
        minVersionCode,
        minSupportedAndroidVersion: minVersionCode,
        minSupportedWebVersion: minVersionCode,
        storeUrl,
        storeUrlPlay: storeUrl,
        storeUrlAppGallery: storeUrl,
        storeUrlWeb: storeUrl,
        updatedAt: serverTimestamp(),
        updatedBy: MANAGER_EMAIL
      };

      await appConfigCol.doc(pkg).set(payload, { merge: true });

      // If LaynDriver is put in maintenance or force-upgrade, immediately force all drivers offline
      if (pkg === 'com.digilayn.layndriver' && (maintenanceMode || minVersionCode > 1)) {
        try {
          const onlineDrivers = await driversCol.where('online', '==', true).get();
          if (!onlineDrivers.empty) {
            const driverBatch = db.batch();
            onlineDrivers.docs.forEach((doc) => {
              driverBatch.update(doc.ref, {
                online: false,
                forcedOfflineReason: maintenanceMode ? 'Maintenance Mode' : 'Force Upgrade',
                updatedAt: serverTimestamp()
              });
            });
            await driverBatch.commit();
          }
        } catch (err) {
          console.warn('Driver offline batch failed (non-fatal)', err);
        }
      }

      await logAdminAction('appConfigUpdate', pkg, appTitle, JSON.stringify({
        maintenanceMode,
        minVersionCode,
        storeUrl
      }));

      toast(`${appTitle} state updated successfully.`, 'success');
    } catch (err) {
      console.error('saveAppConfig failed', err);
      toast('Failed to update app state: ' + (err.message || ''), 'error');
    }
  }

  async function setEmergencyMaintenance(enable) {
    const confirm = await openModal({
      title: enable ? 'EMERGENCY: Lock Entire Fleet?' : 'Restore Entire Fleet to Operational?',
      message: enable
        ? 'WARNING: This will immediately enable Maintenance Mode on BOTH LaynRider and LaynDriver, blocking all user logins and ride requests.'
        : 'This will clear Maintenance Mode across all LaynFleet applications and resume normal operations.',
      confirmText: enable ? 'LOCK ALL APPS' : 'RESTORE ALL APPS',
      confirmClass: enable ? 'btn-danger' : 'btn-primary'
    });

    if (!confirm) return;

    try {
      const batch = db.batch();
      const packages = ['com.digilayn.laynrider', 'com.digilayn.layndriver'];

      packages.forEach((pkg) => {
        const ref = appConfigCol.doc(pkg);
        batch.set(ref, {
          maintenanceMode: enable,
          maintenanceMessage: enable
            ? 'Emergency maintenance in progress. Please check back shortly.'
            : 'LaynFleet is operational.',
          updatedAt: serverTimestamp(),
          updatedBy: MANAGER_EMAIL
        }, { merge: true });
      });

      if (enable) {
        try {
          const onlineDrivers = await driversCol.where('online', '==', true).get();
          onlineDrivers.docs.forEach((doc) => {
            batch.update(doc.ref, {
              online: false,
              forcedOfflineReason: 'Emergency Fleet Maintenance',
              updatedAt: serverTimestamp()
            });
          });
        } catch (err) {
          console.warn('Emergency driver offline batch failed (non-fatal)', err);
        }
      }

      await batch.commit();
      await logAdminAction('appConfigEmergency', 'all_apps', 'Full Fleet', `Emergency maintenance ${enable ? 'ENABLED' : 'DISABLED'}`);

      toast(enable ? 'Emergency maintenance enabled across all apps.' : 'All apps restored to operational.', 'success');
    } catch (err) {
      console.error('setEmergencyMaintenance failed', err);
      toast('Emergency action failed: ' + (err.message || ''), 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // NAVIGATION + FILTERS EVENT HANDLERS
  // ---------------------------------------------------------------------------
  const sectionMeta = {
    overview: ['Overview', 'Live operations across LaynFleet'],
    drivers: ['Drivers', 'Approve applications, demote, and manage the fleet'],
    riders: ['Riders', 'Registered members and account status'],
    bookings: ['Bookings', 'Live and historical rides with detailed filters'],
    reviews: ['Reviews & Moderation', 'Scrutinize feedback, moderate ratings, and contact reviewers'],
    pricing: ['Pricing & Governance', 'Democratic driver-determined fleet rates, live voting progress, and audit history'],
    appcontrol: ['App Control & System State', 'Manage maintenance kill switches, version requirements, and live launch gates']
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
    renderReviews();
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

  // Review Quick Tabs
  document.querySelectorAll('#review-quick-tabs [data-review-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      state.reviewFilters.quickTab = b.getAttribute('data-review-tab');
      document.querySelectorAll('#review-quick-tabs [data-review-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === b));
      renderReviews();
    });
  });

  // Review Search Input
  const rSearch = $('review-filter-search');
  if (rSearch) {
    rSearch.addEventListener('input', (e) => {
      state.reviewFilters.search = e.target.value.trim();
      renderReviews();
    });
  }

  // Review Stars Select
  const rStars = $('review-filter-stars');
  if (rStars) {
    rStars.addEventListener('change', (e) => {
      state.reviewFilters.stars = e.target.value;
      renderReviews();
    });
  }

  // Review Type Select
  const rType = $('review-filter-type');
  if (rType) {
    rType.addEventListener('change', (e) => {
      state.reviewFilters.type = e.target.value;
      renderReviews();
    });
  }

  // Review Status Select
  const rStatus = $('review-filter-status');
  if (rStatus) {
    rStatus.addEventListener('change', (e) => {
      state.reviewFilters.status = e.target.value;
      renderReviews();
    });
  }

  // Review Date Preset Select
  const rDatePreset = $('review-filter-date-preset');
  const rCustomDates = $('review-custom-dates');
  if (rDatePreset) {
    rDatePreset.addEventListener('change', (e) => {
      state.reviewFilters.datePreset = e.target.value;
      if (e.target.value === 'custom') {
        show(rCustomDates);
      } else {
        hide(rCustomDates);
      }
      renderReviews();
    });
  }

  // Review Date Start / End Inputs
  const rDateStart = $('review-filter-date-start');
  if (rDateStart) {
    rDateStart.addEventListener('change', (e) => {
      state.reviewFilters.dateStart = e.target.value;
      renderReviews();
    });
  }
  const rDateEnd = $('review-filter-date-end');
  if (rDateEnd) {
    rDateEnd.addEventListener('change', (e) => {
      state.reviewFilters.dateEnd = e.target.value;
      renderReviews();
    });
  }

  // Review Sort Select
  const rSort = $('review-filter-sort');
  if (rSort) {
    rSort.addEventListener('change', (e) => {
      state.reviewFilters.sortBy = e.target.value;
      renderReviews();
    });
  }

  // Review Reset Filters Button
  const rReset = $('review-filter-reset');
  if (rReset) {
    rReset.addEventListener('click', () => {
      state.reviewFilters = {
        quickTab: 'all',
        stars: 'all',
        type: 'all',
        status: 'all',
        datePreset: 'all',
        dateStart: '',
        dateEnd: '',
        sortBy: 'newest',
        search: ''
      };

      if (rSearch) rSearch.value = '';
      if (rStars) rStars.value = 'all';
      if (rType) rType.value = 'all';
      if (rStatus) rStatus.value = 'all';
      if (rDatePreset) rDatePreset.value = 'all';
      if (rDateStart) rDateStart.value = '';
      if (rDateEnd) rDateEnd.value = '';
      if (rSort) rSort.value = 'newest';
      hide(rCustomDates);

      document.querySelectorAll('#review-quick-tabs [data-review-tab]').forEach((t) =>
        t.classList.toggle('is-active', t.getAttribute('data-review-tab') === 'all'));

      renderReviews();
      toast('Review filters reset.', 'success');
    });
  }

  // Review Scrutiny Modal Close Handlers
  const rModalClose = $('review-modal-close');
  if (rModalClose) rModalClose.addEventListener('click', () => hide($('review-detail-overlay')));
  const rModalDone = $('review-modal-done');
  if (rModalDone) rModalDone.addEventListener('click', () => hide($('review-detail-overlay')));

  const rDetailOverlay = $('review-detail-overlay');
  if (rDetailOverlay) {
    rDetailOverlay.addEventListener('click', (e) => {
      if (e.target === rDetailOverlay) hide(rDetailOverlay);
    });
  }

  // Contact Reviewer Modal Close Handlers
  const cModalClose = $('contact-modal-close');
  if (cModalClose) cModalClose.addEventListener('click', () => hide($('contact-reviewer-overlay')));
  const cModalDone = $('contact-modal-done');
  if (cModalDone) cModalDone.addEventListener('click', () => hide($('contact-reviewer-overlay')));

  const cDetailOverlay = $('contact-reviewer-overlay');
  if (cDetailOverlay) {
    cDetailOverlay.addEventListener('click', (e) => {
      if (e.target === cDetailOverlay) hide(cDetailOverlay);
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

  // App Control Tab Switcher
  document.querySelectorAll('#appcontrol-tabs [data-app-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.appConfigTab = btn.getAttribute('data-app-tab');
      document.querySelectorAll('#appcontrol-tabs [data-app-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === btn));
      updateAppConfigFormFromState();
    });
  });

  // App Control Preset Chips
  document.querySelectorAll('.btn-preset-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      const input = $('input-app-maintenance-msg');
      if (input) {
        input.value = preset;
        updateSimulatorPreview();
      }
    });
  });

  // App Control Dynamic Preview updates on input
  const maintSwitch = $('input-app-maintenance');
  if (maintSwitch) maintSwitch.addEventListener('change', updateSimulatorPreview);
  const maintMsgInput = $('input-app-maintenance-msg');
  if (maintMsgInput) maintMsgInput.addEventListener('input', updateSimulatorPreview);
  const minVerInput = $('input-app-min-version');
  if (minVerInput) minVerInput.addEventListener('input', updateSimulatorPreview);
  const storeUrlInput = $('input-app-store-url');
  if (storeUrlInput) storeUrlInput.addEventListener('input', updateSimulatorPreview);

  // App Control Form Actions
  const btnSaveConfig = $('btn-save-app-config');
  if (btnSaveConfig) btnSaveConfig.addEventListener('click', saveCurrentAppConfig);
  const btnRevertConfig = $('btn-revert-app-config');
  if (btnRevertConfig) btnRevertConfig.addEventListener('click', updateAppConfigFormFromState);

  // Emergency Actions
  const btnEmergMaint = $('btn-emergency-all-maintenance');
  if (btnEmergMaint) btnEmergMaint.addEventListener('click', () => setEmergencyMaintenance(true));
  const btnEmergRestore = $('btn-emergency-all-restore');
  if (btnEmergRestore) btnEmergRestore.addEventListener('click', () => setEmergencyMaintenance(false));

  // ESC closes overlays.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hide($('image-overlay'));
    if ($('booking-detail-overlay') && !$('booking-detail-overlay').classList.contains('is-hidden')) {
      hide($('booking-detail-overlay'));
    }
    if ($('review-detail-overlay') && !$('review-detail-overlay').classList.contains('is-hidden')) {
      hide($('review-detail-overlay'));
    }
    if ($('contact-reviewer-overlay') && !$('contact-reviewer-overlay').classList.contains('is-hidden')) {
      hide($('contact-reviewer-overlay'));
    }
    if (!$('modal-overlay').classList.contains('is-hidden')) $('modal-cancel').click();
  });
})();
