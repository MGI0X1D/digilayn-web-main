/**
 * tracking.js — Live Driver Location Monitoring Operations Center
 * Digilayn / LaynFleet Fleet Telemetry & Live Map System
 * 
 * 100% REAL DATA ONLY:
 * - Realtime Database: `driverLocations/{uid}` (live GPS coordinates, heading, speed, online presence)
 * - Firestore: `laynfleet/main/drivers/{uid}` (driver application & vehicle details)
 * - Firestore: `users/{uid}` (driver identity: name, phone, photo)
 * - Firestore: `laynfleet/main/bookings/{id}` (active trip details, routes, status)
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration & Defaults
  // ---------------------------------------------------------------------------
  const firebaseConfig = global.LAYNFLEET_FIREBASE_CONFIG;

  // Default initial camera center (South Africa / Gauteng / Poortjie region)
  const DEFAULT_MAP_CENTER = [-26.4385, 27.8542];
  const DEFAULT_MAP_ZOOM = 13;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    drivers: new Map(), // uid -> unified real driver object
    rawFirestoreDrivers: [],
    rawRtdbLocations: {},
    rawActiveBookings: [],
    userCache: new Map(),
    
    // UI Filters
    search: '',
    statusFilter: 'all', // 'all', 'online', 'intrip', 'idle', 'offline'
    vehicleFilter: 'all',

    // Selection & Tracking
    selectedDriverId: null,
    isFollowMode: false,
    soundEnabled: true,
    activeMapStyle: 'dark'
  };

  // Map & Layers State
  let map = null;
  let infoWindow = null;
  const markerLayers = new Map(); // uid -> google.maps.Marker
  const routeLayers = new Map(); // uid -> Google Maps overlays
  const breadcrumbHistory = new Map(); // uid -> recent Google Maps positions

  // Firebase instances
  let db = null;
  let rtdb = null;
  let unsubFirestore = [];

  // ---------------------------------------------------------------------------
  // Google Maps styles
  // ---------------------------------------------------------------------------
  const DARK_MAP_STYLES = [
    { elementType: 'geometry', stylers: [{ color: '#17202d' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#a8b5c5' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#17202d' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#34455a' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0c1522' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] }
  ];

  // ---------------------------------------------------------------------------
  // Helper Utilities
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'D';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function formatTimeAgo(ts) {
    if (!ts) return 'No signal';
    const timeMs = ts.toDate ? ts.toDate().getTime() : (typeof ts === 'number' ? ts : (ts instanceof Date ? ts.getTime() : Date.now()));
    const elapsedSec = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
    if (elapsedSec < 5) return 'Just now';
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
    return `${Math.floor(elapsedSec / 3600)}h ago`;
  }

  function cleanPhone(phone) {
    let clean = String(phone || '').replace(/[^\d+]/g, '');
    if (clean.startsWith('0') && clean.length === 10) clean = '27' + clean.slice(1);
    return clean.replace(/^\+/, '');
  }

  function cardinalDirection(heading) {
    if (heading == null || isNaN(heading)) return 'N';
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(heading / 45) % 8;
    return directions[idx];
  }

  function showToast(message, type = 'info') {
    const existing = document.querySelector('.tracker-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `tracker-toast toast-${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'}</span> <span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // Google Maps initialization
  // ---------------------------------------------------------------------------
  function initMap() {
    const isDark = document.documentElement.classList.contains('dark');
    state.activeMapStyle = isDark ? 'dark' : 'light';

    map = new google.maps.Map($('map'), {
      center: { lat: DEFAULT_MAP_CENTER[0], lng: DEFAULT_MAP_CENTER[1] },
      zoom: DEFAULT_MAP_ZOOM,
      zoomControl: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      gestureHandling: 'greedy'
    });
    infoWindow = new google.maps.InfoWindow();
    setMapStyle(state.activeMapStyle);
    map.addListener('click', deselectDriver);
    syncMapLayers();

    window.addEventListener('themeChanged', () => {
      const darkNow = document.documentElement.classList.contains('dark');
      if (state.activeMapStyle === 'dark' || state.activeMapStyle === 'light') {
        setMapStyle(darkNow ? 'dark' : 'light');
      }
    });
  }

  function setMapStyle(styleKey) {
    if (!['dark', 'light', 'voyager', 'satellite'].includes(styleKey)) styleKey = 'dark';
    state.activeMapStyle = styleKey;
    if (map) {
      map.setOptions({
        mapTypeId: styleKey === 'voyager' ? 'terrain' : styleKey === 'satellite' ? 'hybrid' : 'roadmap',
        styles: styleKey === 'dark' ? DARK_MAP_STYLES : []
      });
    }

    document.querySelectorAll('[data-map-style]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mapStyle === styleKey);
    });
  }

  // ---------------------------------------------------------------------------
  // Driver markers
  // ---------------------------------------------------------------------------
  function createDriverMarker(driver) {
    const status = driver.computedStatus || 'offline';
    const name = driver.user?.displayName || driver.vehicle?.plate || 'Driver';
    const marker = new google.maps.Marker({
      map,
      position: { lat: driver.location.lat, lng: driver.location.lng },
      title: name,
      label: { text: initials(name), color: '#fff', fontWeight: '700' },
      icon: markerIcon(status),
      zIndex: status === 'intrip' ? 1000 : status === 'online' ? 500 : 100
    });

    marker.addListener('click', () => {
      selectDriver(driver.uid, true);
      infoWindow.setContent(getDriverPopupHtml(state.drivers.get(driver.uid) || driver));
      infoWindow.open({ map, anchor: marker });
    });
    return marker;
  }

  function markerIcon(status) {
    const colors = { intrip: '#3b82f6', online: '#22c55e', idle: '#f59e0b', offline: '#64748b' };
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 19,
      fillColor: colors[status] || colors.offline,
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2
    };
  }

  function getDriverPopupHtml(driver) {
    const name = driver.user?.displayName || 'Driver';
    const plate = driver.vehicle?.plate || 'No Plate';
    const model = [driver.vehicle?.make, driver.vehicle?.model].filter(Boolean).join(' ') || 'Vehicle';
    const speed = Math.round(driver.location.speed || 0);
    const status = driver.computedStatus;

    return `
      <div class="map-popup-card">
        <div class="popup-driver-name">
          <span>${escapeHtml(name)}</span>
          <span class="driver-status-tag ${status}">${status}</span>
        </div>
        <div class="popup-meta-line">🚘 ${escapeHtml(model)} (${escapeHtml(plate)})</div>
        <div class="popup-meta-line">⚡ ${speed} km/h · Heading ${cardinalDirection(driver.location.heading)} (${Math.round(driver.location.heading || 0)}°)</div>
        ${driver.activeBooking ? `
          <div class="popup-meta-line" style="color:var(--intrip); font-weight:700;">
            📍 On Trip #${escapeHtml(driver.activeBooking.id.slice(-6))} · ${escapeHtml(driver.activeBooking.destinationAddress || 'Active Route')}
          </div>
        ` : ''}
        <button class="popup-btn-action" onclick="window.LaynFleetTracker.selectDriver('${escapeHtml(driver.uid)}', true)">
          Open Telemetry &amp; Controls
        </button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Data Ingestion: Pure Real Data (Firestore + RTDB)
  // ---------------------------------------------------------------------------
  function consolidateFleet() {
    const driversMap = new Map();

    state.rawFirestoreDrivers.forEach((fDoc) => {
      const uid = fDoc.uid || fDoc.id;
      const rtdbEntry = state.rawRtdbLocations[uid] || {};
      const user = state.userCache.get(uid) || fDoc.user || {};

      // Find active booking for this driver
      const activeBk = state.rawActiveBookings.find((b) => b.driverId === uid);

      // RTDB is the only verified source of driver coordinates and presence.
      const lat = rtdbEntry.lat;
      const lng = rtdbEntry.lng;
      const heading = rtdbEntry.heading != null ? rtdbEntry.heading : 0;
      const speed = rtdbEntry.speed != null ? rtdbEntry.speed : 0;
      const updatedAt = rtdbEntry.locationUpdatedAt || rtdbEntry.updatedAt || null;

      // Real status calculation
      const ageMs = typeof updatedAt === 'number' ? Date.now() - updatedAt : Infinity;
      const isFresh = ageMs >= 0 && ageMs <= 60000;
      const isOnline = fDoc.approvalStatus === 'APPROVED' && fDoc.online === true &&
        rtdbEntry.online === true && isFresh;

      let computedStatus = 'offline';
      if (activeBk && isOnline) {
        computedStatus = 'intrip';
      } else if (isOnline && speed > 2) {
        computedStatus = 'online';
      } else if (isOnline) {
        computedStatus = 'idle';
      }

      driversMap.set(uid, {
        uid,
        user,
        photoUrl: fDoc.photoUrl || user.photoUrl || '',
        phone: fDoc.phone || user.phone || '',
        vehicle: fDoc.vehicle || {},
        approvalStatus: fDoc.approvalStatus || 'UNKNOWN',
        ratingAvg: fDoc.ratingAvg || 0,
        ratingCount: fDoc.ratingCount || 0,
        location: {
          lat: lat != null ? Number(lat) : null,
          lng: lng != null ? Number(lng) : null,
          heading: Number(heading),
          speed: Number(speed),
          accuracy: rtdbEntry.accuracy ?? null,
          updatedAt: updatedAt
        },
        hasGpsLock: Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
          lat != null && lng != null,
        computedStatus,
        activeBooking: activeBk || null
      });
    });

    state.drivers = driversMap;
    renderUI();
  }

  // ---------------------------------------------------------------------------
  // Render: Map, Sidebar, KPIs, Inspector
  // ---------------------------------------------------------------------------
  function renderUI() {
    renderKPIs();
    renderSidebarList();
    syncMapLayers();
    if (state.selectedDriverId) {
      renderInspector(state.drivers.get(state.selectedDriverId));
    }
  }

  function renderKPIs() {
    const list = Array.from(state.drivers.values());
    const total = list.length;
    const online = list.filter((d) => d.computedStatus === 'online').length;
    const intrip = list.filter((d) => d.computedStatus === 'intrip').length;
    const idle = list.filter((d) => d.computedStatus === 'idle').length;
    const offline = list.filter((d) => d.computedStatus === 'offline').length;

    if ($('kpi-total-val')) $('kpi-total-val').textContent = total;
    if ($('kpi-online-val')) $('kpi-online-val').textContent = online;
    if ($('kpi-intrip-val')) $('kpi-intrip-val').textContent = intrip;
    if ($('kpi-idle-val')) $('kpi-idle-val').textContent = idle;
    if ($('kpi-offline-val')) $('kpi-offline-val').textContent = offline;

    if ($('badge-tab-all')) $('badge-tab-all').textContent = total;
    if ($('badge-tab-online')) $('badge-tab-online').textContent = online;
    if ($('badge-tab-intrip')) $('badge-tab-intrip').textContent = intrip;
    if ($('badge-tab-idle')) $('badge-tab-idle').textContent = idle;
    if ($('badge-tab-offline')) $('badge-tab-offline').textContent = offline;

    const movingDrivers = list.filter((d) => d.hasGpsLock && (d.location.speed || 0) > 0);
    const avgSpeed = movingDrivers.length
      ? Math.round(movingDrivers.reduce((acc, d) => acc + (d.location.speed || 0), 0) / movingDrivers.length)
      : 0;
    if ($('hud-avg-speed')) $('hud-avg-speed').textContent = `${avgSpeed} km/h`;
  }

  function renderSidebarList() {
    const host = $('drivers-list-container');
    if (!host) return;

    const term = state.search.toLowerCase();
    const list = Array.from(state.drivers.values()).filter((d) => {
      if (state.statusFilter !== 'all' && d.computedStatus !== state.statusFilter) return false;

      if (state.vehicleFilter !== 'all') {
        const vType = String(d.vehicle?.type || '').toLowerCase();
        if (!vType.includes(state.vehicleFilter.toLowerCase())) return false;
      }

      if (term) {
        const name = String(d.user?.displayName || '').toLowerCase();
        const phone = String(d.phone || d.user?.phone || '').toLowerCase();
        const plate = String(d.vehicle?.plate || '').toLowerCase();
        const make = String(d.vehicle?.make || '').toLowerCase();
        const model = String(d.vehicle?.model || '').toLowerCase();
        return name.includes(term) || phone.includes(term) || plate.includes(term) || make.includes(term) || model.includes(term);
      }

      return true;
    });

    if (!list.length) {
      host.innerHTML = `
        <div class="empty-drivers">
          <span class="empty-icon">🛰️</span>
          <p style="font-weight:700;">No drivers found</p>
          <p style="font-size:12px; opacity:0.7;">No registered drivers match the selected filter.</p>
        </div>
      `;
      return;
    }

    host.innerHTML = list.map((d) => {
      const isSelected = d.uid === state.selectedDriverId;
      const name = d.user?.displayName || 'Driver';
      const photo = d.photoUrl || d.user?.photoUrl;
      const vLine = [d.vehicle?.make, d.vehicle?.model].filter(Boolean).join(' ') || 'Vehicle not set';
      const plate = d.vehicle?.plate || '—';
      const speed = Math.round(d.location?.speed || 0);
      const status = d.computedStatus;
      const statusLabel = status === 'intrip' ? 'In Trip' : status === 'online' ? 'Online' : status === 'idle' ? 'Idle' : 'Offline';

      const avatarHtml = photo
        ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}" />`
        : `<span>${escapeHtml(initials(name))}</span>`;

      return `
        <div class="driver-card-item status-${status} ${isSelected ? 'is-selected' : ''}" data-driver-uid="${escapeHtml(d.uid)}">
          <div class="driver-item-header">
            <div class="driver-avatar-row">
              <div class="driver-avatar">
                ${avatarHtml}
                <span class="driver-status-badge-dot ${status}"></span>
              </div>
              <div class="driver-name-block">
                <div class="driver-name-text">
                  <span>${escapeHtml(name)}</span>
                  ${d.ratingAvg ? `<span class="driver-rating-badge">★ ${Number(d.ratingAvg).toFixed(1)}</span>` : ''}
                </div>
                <div class="driver-vehicle-text">🚘 ${escapeHtml(vLine)} · <strong style="color:var(--text);">${escapeHtml(plate)}</strong></div>
              </div>
            </div>
            <div class="driver-metric-pill">
              <span class="driver-status-tag ${status}">${statusLabel}</span>
              ${d.hasGpsLock ? `<span class="driver-speed-val">${speed} km/h</span>` : '<span class="driver-speed-val" style="color:var(--text-faint);">No GPS</span>'}
            </div>
          </div>

          ${d.activeBooking ? `
            <div class="driver-trip-snippet">
              <div class="trip-snippet-route">
                <span class="trip-dot pickup"></span>
                <span>${escapeHtml(d.activeBooking.pickupAddress || 'Pickup')}</span>
                <span style="color:var(--text-faint);">➔</span>
                <span class="trip-dot dropoff"></span>
                <span>${escapeHtml(d.activeBooking.destinationAddress || 'Dropoff')}</span>
              </div>
              <div class="trip-snippet-meta">
                <span>Trip #${escapeHtml(d.activeBooking.id.slice(-6))}</span>
                <span style="font-weight:700; color:var(--text);">${d.activeBooking.fare ? 'R' + d.activeBooking.fare : 'Active'}</span>
              </div>
            </div>
          ` : ''}

          <div class="driver-card-footer">
            <div class="driver-ping-time">
              <span>⏱️</span> <span>${d.hasGpsLock ? formatTimeAgo(d.location.updatedAt) : 'No GPS broadcast'}</span>
            </div>
            <div class="driver-quick-actions" onclick="event.stopPropagation();">
              ${d.hasGpsLock ? `
                <button class="btn-card-action" onclick="window.LaynFleetTracker.selectDriver('${escapeHtml(d.uid)}', true)">
                  📍 Focus
                </button>
              ` : `
                <button class="btn-card-action" onclick="window.LaynFleetTracker.selectDriver('${escapeHtml(d.uid)}', false)">
                  ℹ️ Details
                </button>
              `}
              ${(d.phone || d.user?.phone) ? `
                <a class="btn-card-action" href="https://wa.me/${cleanPhone(d.phone || d.user.phone)}" target="_blank" title="WhatsApp Driver">
                  💬 WhatsApp
                </a>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    host.querySelectorAll('.driver-card-item').forEach((item) => {
      item.addEventListener('click', () => {
        const uid = item.dataset.driverUid;
        const d = state.drivers.get(uid);
        selectDriver(uid, d && d.hasGpsLock);
      });
    });
  }

  function syncMapLayers() {
    if (!map) return;

    const currentUids = new Set();

    state.drivers.forEach((driver, uid) => {
      if (!driver.hasGpsLock) {
        clearDriverMapLayers(uid);
        return;
      }

      currentUids.add(uid);
      const position = { lat: driver.location.lat, lng: driver.location.lng };

      let marker = markerLayers.get(uid);
      if (!marker) {
        marker = createDriverMarker(driver);
        markerLayers.set(uid, marker);
      } else {
        const name = driver.user?.displayName || driver.vehicle?.plate || 'Driver';
        marker.setPosition(position);
        marker.setTitle(name);
        marker.setLabel({ text: initials(name), color: '#fff', fontWeight: '700' });
        marker.setIcon(markerIcon(driver.computedStatus));
        marker.setZIndex(driver.computedStatus === 'intrip' ? 1000 : driver.computedStatus === 'online' ? 500 : 100);
      }

      if (!breadcrumbHistory.has(uid)) breadcrumbHistory.set(uid, []);
      const history = breadcrumbHistory.get(uid);
      if (!history.length || history[history.length - 1].lat !== position.lat || history[history.length - 1].lng !== position.lng) {
        history.push(position);
        if (history.length > 25) history.shift();
      }

      syncRouteLayer(driver);
    });

    markerLayers.forEach((marker, uid) => {
      if (!currentUids.has(uid)) clearDriverMapLayers(uid);
    });

    if (state.isFollowMode && state.selectedDriverId) {
      const selDriver = state.drivers.get(state.selectedDriverId);
      if (selDriver && selDriver.hasGpsLock) {
        map.panTo({ lat: selDriver.location.lat, lng: selDriver.location.lng });
      }
    }
  }

  function clearDriverMapLayers(uid) {
    markerLayers.get(uid)?.setMap(null);
    markerLayers.delete(uid);
    (routeLayers.get(uid) || []).forEach((overlay) => overlay.setMap(null));
    routeLayers.delete(uid);
    breadcrumbHistory.delete(uid);
  }

  function syncRouteLayer(driver) {
    const uid = driver.uid;
    (routeLayers.get(uid) || []).forEach((overlay) => overlay.setMap(null));
    const overlays = [];

    if (driver.activeBooking) {
      const b = driver.activeBooking;
      const destination = b.dropoffLocation;
      const lat = Number(destination?.latitude ?? destination?.lat);
      const lng = Number(destination?.longitude ?? destination?.lng);
      if (destination && Number.isFinite(lat) && Number.isFinite(lng)) {
        const end = { lat, lng };
        overlays.push(new google.maps.Polyline({
          map,
          path: [{ lat: driver.location.lat, lng: driver.location.lng }, end],
          strokeColor: '#3b82f6', strokeWeight: 4, strokeOpacity: 0.85
        }));
        overlays.push(new google.maps.Circle({
          map, center: end, radius: 18,
          fillColor: '#ef4444', fillOpacity: 1,
          strokeColor: '#fff', strokeWeight: 2
        }));
      }
    }

    if (uid === state.selectedDriverId && driver.hasGpsLock) {
      const history = breadcrumbHistory.get(uid) || [];
      if (history.length > 1) {
        overlays.push(new google.maps.Polyline({
          map, path: history,
          strokeColor: '#22c55e', strokeWeight: 3, strokeOpacity: 0.5
        }));
      }
    }
    routeLayers.set(uid, overlays);
  }

  // ---------------------------------------------------------------------------
  // Driver Inspector
  // ---------------------------------------------------------------------------
  function selectDriver(uid, focusOnMap = false) {
    const previousDriverId = state.selectedDriverId;
    state.selectedDriverId = uid;
    const driver = state.drivers.get(uid);

    document.querySelectorAll('.driver-card-item').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.driverUid === uid);
    });

    if (!driver) {
      deselectDriver();
      return;
    }

    renderInspector(driver);

    if (focusOnMap && driver.hasGpsLock && map) {
      map.panTo({ lat: driver.location.lat, lng: driver.location.lng });
      map.setZoom(15);
    }

    const inspectorEl = $('driver-inspector');
    if (inspectorEl) inspectorEl.classList.remove('is-hidden');
    if (map && previousDriverId && previousDriverId !== uid) {
      const previousDriver = state.drivers.get(previousDriverId);
      if (previousDriver?.hasGpsLock) syncRouteLayer(previousDriver);
    }
    if (map && driver.hasGpsLock) syncRouteLayer(driver);
  }

  function deselectDriver() {
    state.selectedDriverId = null;
    state.isFollowMode = false;
    updateFollowModeUI();

    document.querySelectorAll('.driver-card-item').forEach((el) => {
      el.classList.remove('is-selected');
    });

    const inspectorEl = $('driver-inspector');
    if (inspectorEl) inspectorEl.classList.add('is-hidden');
    infoWindow?.close();
    if (map) state.drivers.forEach((driver) => {
      if (driver.hasGpsLock) syncRouteLayer(driver);
    });
  }

  function renderInspector(driver) {
    const el = $('driver-inspector');
    if (!el || !driver) return;

    const name = driver.user?.displayName || 'Driver';
    const photo = driver.photoUrl || driver.user?.photoUrl;
    const phone = driver.phone || driver.user?.phone || 'Not recorded';
    const plate = driver.vehicle?.plate || '—';
    const model = [driver.vehicle?.make, driver.vehicle?.model].filter(Boolean).join(' ') || 'Vehicle not set';
    const speed = Math.round(driver.location?.speed || 0);
    const heading = Math.round(driver.location?.heading || 0);
    const lat = driver.hasGpsLock ? driver.location.lat.toFixed(5) : '—';
    const lng = driver.hasGpsLock ? driver.location.lng.toFixed(5) : '—';
    const status = driver.computedStatus;

    const avatarHtml = photo
      ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}" />`
      : `<span>${escapeHtml(initials(name))}</span>`;

    $('inspector-avatar').innerHTML = avatarHtml;
    $('inspector-name').textContent = name;
    $('inspector-rating').textContent = driver.ratingCount > 0 && driver.ratingAvg
      ? `★ ${Number(driver.ratingAvg).toFixed(1)} (${driver.ratingCount} rides)` : 'No rating yet';
    $('inspector-status-badge').className = `driver-status-tag ${status}`;
    $('inspector-status-badge').textContent = status.toUpperCase();

    $('inspector-speed').textContent = driver.hasGpsLock ? `${speed} km/h` : 'No GPS';
    $('inspector-heading').textContent = driver.hasGpsLock ? `${cardinalDirection(heading)} (${heading}°)` : '—';
    $('inspector-coords').textContent = driver.hasGpsLock ? `${lat}, ${lng}` : 'No GPS broadcast';
    $('inspector-plate').textContent = plate;
    $('inspector-model').textContent = model;
    $('inspector-phone').textContent = phone;

    const tripCard = $('inspector-trip-card');
    if (driver.activeBooking) {
      tripCard.classList.remove('is-hidden');
      $('inspector-trip-id').textContent = `Trip #${driver.activeBooking.id.slice(-6)}`;
      $('inspector-pickup-addr').textContent = driver.activeBooking.pickupAddress || 'Pickup address';
      $('inspector-dest-addr').textContent = driver.activeBooking.destinationAddress || driver.activeBooking.dropoffAddress || 'Destination address';
      $('inspector-trip-fare').textContent = driver.activeBooking.fare ? `R${driver.activeBooking.fare}` : '—';
    } else {
      tripCard.classList.add('is-hidden');
    }

    const cleanP = cleanPhone(phone);
    const waBtn = $('inspector-wa-btn');
    if (waBtn) {
      const waMsg = encodeURIComponent(`Hi ${name}, LaynFleet Dispatch here. Checking in on your current location.`);
      waBtn.href = cleanP ? `https://wa.me/${cleanP}?text=${waMsg}` : '#';
      waBtn.style.opacity = cleanP ? '1' : '0.5';
    }

    const callBtn = $('inspector-call-btn');
    if (callBtn) {
      callBtn.href = phone ? `tel:${phone}` : '#';
      callBtn.style.opacity = phone ? '1' : '0.5';
    }

    const mapsBtn = $('inspector-maps-btn');
    if (mapsBtn) {
      if (driver.hasGpsLock) {
        mapsBtn.href = `https://www.google.com/maps/search/?api=1&query=${driver.location.lat},${driver.location.lng}`;
        mapsBtn.style.display = 'flex';
      } else {
        mapsBtn.style.display = 'none';
      }
    }
  }

  function toggleFollowMode() {
    state.isFollowMode = !state.isFollowMode;
    updateFollowModeUI();
    if (state.isFollowMode && state.selectedDriverId) {
      const driver = state.drivers.get(state.selectedDriverId);
      if (driver && driver.hasGpsLock) map.panTo({ lat: driver.location.lat, lng: driver.location.lng });
    }
  }

  function updateFollowModeUI() {
    const badge = $('hud-follow-badge');
    const btn = $('btn-follow-toggle');
    if (badge) badge.classList.toggle('is-hidden', !state.isFollowMode);
    if (btn) btn.classList.toggle('is-active', state.isFollowMode);
  }

  function fitAllDrivers() {
    if (!map) return;
    const validDrivers = Array.from(state.drivers.values()).filter((d) => d.hasGpsLock);
    if (!validDrivers.length) {
      map.setCenter({ lat: DEFAULT_MAP_CENTER[0], lng: DEFAULT_MAP_CENTER[1] });
      map.setZoom(DEFAULT_MAP_ZOOM);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    validDrivers.forEach((driver) => bounds.extend({ lat: driver.location.lat, lng: driver.location.lng }));
    map.fitBounds(bounds, 60);
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > 15) map.setZoom(15);
    });
  }

  // ---------------------------------------------------------------------------
  // Live Firebase Listeners (Real Data)
  // ---------------------------------------------------------------------------
  function attachFirebaseListeners() {
    if (typeof firebase === 'undefined' || !firebaseConfig?.apiKey || !firebaseConfig?.databaseURL) {
      console.error('Firebase SDK or shared Firebase configuration not loaded.');
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      db = firebase.firestore();
      rtdb = typeof firebase.database === 'function' ? firebase.database() : null;

      // 1. RTDB Driver Locations Listener
      if (rtdb) {
        const locRef = rtdb.ref('driverLocations');
        locRef.on('value', (snap) => {
          state.rawRtdbLocations = snap.val() || {};
          consolidateFleet();
        });
      }

      // 2. Firestore Drivers Collection
      const driversCol = db.collection('laynfleet').doc('main').collection('drivers');
      const unsubDrivers = driversCol.onSnapshot(async (snap) => {
        const docs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        await Promise.all(docs.map(async (d) => {
          if (!state.userCache.has(d.uid)) {
            try {
              const uSnap = await db.collection('users').doc(d.uid).get();
              if (uSnap.exists) state.userCache.set(d.uid, uSnap.data());
            } catch (e) { /* ignore */ }
          }
          d.user = state.userCache.get(d.uid) || {};
        }));

        state.rawFirestoreDrivers = docs;
        consolidateFleet();
      }, (err) => {
        console.warn('Firestore drivers listener error', err);
      });
      unsubFirestore.push(unsubDrivers);

      // 3. Firestore Active Bookings Collection
      const bookingsCol = db.collection('laynfleet').doc('main').collection('bookings');
      const unsubBookings = bookingsCol.where('status', 'in', ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'AT_DESTINATION', 'RETURN_TRIP'])
        .onSnapshot((snap) => {
          state.rawActiveBookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          consolidateFleet();
        }, (err) => {
          console.warn('Firestore bookings listener error', err);
        });
      unsubFirestore.push(unsubBookings);

    } catch (err) {
      console.error('Firebase initialization failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM Wiring & Event Listeners
  // ---------------------------------------------------------------------------
  function initDOM() {
    const searchInput = $('search-drivers');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.search = e.target.value;
        renderSidebarList();
      });
    }

    document.querySelectorAll('.filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        state.statusFilter = tab.dataset.filterStatus || 'all';
        renderSidebarList();
      });
    });

    const vehicleSelect = $('filter-vehicle-type');
    if (vehicleSelect) {
      vehicleSelect.addEventListener('change', (e) => {
        state.vehicleFilter = e.target.value;
        renderSidebarList();
      });
    }

    document.querySelectorAll('[data-map-style]').forEach((btn) => {
      btn.addEventListener('click', () => setMapStyle(btn.dataset.mapStyle));
    });

    const fitBtn = $('btn-fit-fleet');
    if (fitBtn) fitBtn.addEventListener('click', fitAllDrivers);

    const followBtn = $('btn-follow-toggle');
    if (followBtn) followBtn.addEventListener('click', toggleFollowMode);

    const sidebarToggle = $('sidebar-collapse-toggle');
    const sidebar = $('tracker-sidebar');
    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('is-collapsed');
        sidebarToggle.innerHTML = sidebar.classList.contains('is-collapsed') ? '➔' : '◀';
        setTimeout(() => map && google.maps.event.trigger(map, 'resize'), 300);
      });
    }

    const closeInspector = $('btn-close-inspector');
    if (closeInspector) closeInspector.addEventListener('click', deselectDriver);
  }

  // ---------------------------------------------------------------------------
  // App Bootstrapper
  // ---------------------------------------------------------------------------
  function loadGoogleMaps() {
    if (!firebaseConfig?.apiKey) {
      showToast('Google Maps API key is unavailable.', 'error');
      return;
    }
    global.initLaynFleetTrackingMap = () => {
      initMap();
      setTimeout(fitAllDrivers, 1500);
    };
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(firebaseConfig.apiKey)}&loading=async&callback=initLaynFleetTrackingMap`;
    script.onerror = () => showToast('Google Maps could not load. Check the browser key and connection.', 'error');
    document.head.appendChild(script);
  }

  function boot() {
    initDOM();
    if (typeof firebase === 'undefined' || !firebaseConfig?.apiKey) {
      console.error('Firebase configuration is unavailable.');
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    loadGoogleMaps();
    firebase.auth().onAuthStateChanged((user) => {
      if (!user || user.email?.toLowerCase() !== global.MANAGER_EMAIL?.toLowerCase()) {
        unsubFirestore.forEach((unsubscribe) => unsubscribe());
        unsubFirestore = [];
        window.location.replace('index.html');
        return;
      }
      if (unsubFirestore.length === 0) {
        attachFirebaseListeners();
        setInterval(consolidateFleet, 15000);
      }
    });

  }

  global.LaynFleetTracker = {
    selectDriver,
    deselectDriver,
    fitAllDrivers
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
