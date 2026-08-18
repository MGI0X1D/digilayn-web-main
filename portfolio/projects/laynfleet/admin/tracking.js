/**
 * live-tracking.js — Live Driver Location Monitoring Operations Center
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
  const FIREBASE_CONFIG = global.LAYNFLEET_FIREBASE_CONFIG || {
    apiKey: 'AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA',
    authDomain: 'digilayn-projects.firebaseapp.com',
    projectId: 'digilayn-projects',
    storageBucket: 'digilayn-projects.firebasestorage.app',
    messagingSenderId: '95485356681',
    appId: '1:95485356681:web:3cf619a266961009e17458',
    measurementId: 'G-27H9WZSCGQ'
  };

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
    activeTileStyle: 'dark'
  };

  // Map & Layers State
  let map = null;
  let currentTileLayer = null;
  const markerLayers = new Map(); // uid -> L.marker
  const routeLayers = new Map(); // uid -> L.layerGroup
  const breadcrumbHistory = new Map(); // uid -> array of [lat, lng]

  // Firebase instances
  let db = null;
  let rtdb = null;
  let unsubFirestore = [];

  // ---------------------------------------------------------------------------
  // Tile Layer Definitions
  // ---------------------------------------------------------------------------
  const TILE_PROVIDERS = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      options: {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }
    },
    voyager: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      options: {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Clean Crisp Vehicle Icons (SVG paths)
  // ---------------------------------------------------------------------------
  const VEHICLE_SVGS = {
    sedan: `<svg viewBox="0 0 24 24" class="marker-icon-svg"><path fill="currentColor" d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.85 7h10.29l1.08 3.11H5.77L6.85 7zM19 17H5v-4.66l.12-.34h13.77l.11.34V17z"/><circle fill="currentColor" cx="7.5" cy="14.5" r="1.5"/><circle fill="currentColor" cx="16.5" cy="14.5" r="1.5"/></svg>`,
    suv: `<svg viewBox="0 0 24 24" class="marker-icon-svg"><path fill="currentColor" d="M19 8l-2-4H7L5 8H3v8h2v2h2v-2h10v2h2v-2h2V8h-2zm-12-2h10l1 2H6l1-2zm12 8H5v-4h14v4z"/><circle fill="currentColor" cx="7.5" cy="13.5" r="1.5"/><circle fill="currentColor" cx="16.5" cy="13.5" r="1.5"/></svg>`,
    van: `<svg viewBox="0 0 24 24" class="marker-icon-svg"><path fill="currentColor" d="M20 8h-3V4H4c-1.1 0-2 .9-2 2v10h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-4-3zM7 17c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm12 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-8l2.5 3H17V9h1z"/></svg>`,
    tuktuk: `<svg viewBox="0 0 24 24" class="marker-icon-svg"><path fill="currentColor" d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm14-8.5c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zM12 10.5L9.5 8l-2 2 4.5 4.5 4.5-4.5-2-2L12 10.5z"/></svg>`
  };

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

  function getVehicleSvg(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('xl') || t.includes('suv')) return VEHICLE_SVGS.suv;
    if (t.includes('delivery') || t.includes('van') || t.includes('bakkie')) return VEHICLE_SVGS.van;
    if (t.includes('tuktuk') || t.includes('bike')) return VEHICLE_SVGS.tuktuk;
    return VEHICLE_SVGS.sedan;
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
  // Leaflet Map Initialization
  // ---------------------------------------------------------------------------
  function initMap() {
    const isDark = document.documentElement.classList.contains('dark');
    state.activeTileStyle = isDark ? 'dark' : 'light';

    map = L.map('map', {
      center: DEFAULT_MAP_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      zoomControl: false,
      attributionControl: false
    });

    L.control.attribution({ position: 'bottomright' }).addTo(map);
    setTileLayer(state.activeTileStyle);

    map.on('click', (e) => {
      if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest('.leaflet-marker-icon')) {
        return;
      }
      deselectDriver();
    });

    window.addEventListener('themeChanged', () => {
      const darkNow = document.documentElement.classList.contains('dark');
      if (state.activeTileStyle === 'dark' || state.activeTileStyle === 'light') {
        setTileLayer(darkNow ? 'dark' : 'light');
      }
    });
  }

  function setTileLayer(styleKey) {
    if (!TILE_PROVIDERS[styleKey]) styleKey = 'dark';
    state.activeTileStyle = styleKey;

    if (currentTileLayer) {
      map.removeLayer(currentTileLayer);
    }

    const prov = TILE_PROVIDERS[styleKey];
    currentTileLayer = L.tileLayer(prov.url, prov.options);
    currentTileLayer.addTo(map);

    document.querySelectorAll('[data-tile-style]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tileStyle === styleKey);
    });
  }

  // ---------------------------------------------------------------------------
  // Custom Vehicle Marker Generator
  // ---------------------------------------------------------------------------
  function createDriverMarker(driver) {
    const status = driver.computedStatus || 'offline';
    const heading = Math.round(driver.location.heading || 0);
    const speed = Math.round(driver.location.speed || 0);
    const vSvg = getVehicleSvg(driver.vehicle?.type);
    const name = driver.user?.displayName || driver.vehicle?.plate || 'Driver';

    const html = `
      <div class="driver-marker-wrap status-${status}">
        <div class="marker-radar-wave ${status}"></div>
        <div class="marker-vehicle-pin status-${status}" style="transform: rotate(${heading}deg);">
          ${vSvg}
        </div>
        ${speed > 0 ? `<div class="marker-speed-tag">${speed} km/h</div>` : ''}
        <div class="marker-name-tag">${escapeHtml(name)}</div>
      </div>
    `;

    const icon = L.divIcon({
      html: html,
      className: 'custom-driver-leaflet-icon',
      iconSize: [48, 48],
      iconAnchor: [24, 24],
      popupAnchor: [0, -26]
    });

    const marker = L.marker([driver.location.lat, driver.location.lng], {
      icon: icon,
      zIndexOffset: status === 'intrip' ? 1000 : status === 'online' ? 500 : 100
    });

    marker.on('click', () => {
      selectDriver(driver.uid, true);
    });

    marker.bindPopup(() => getDriverPopupHtml(driver), {
      className: 'driver-map-popup'
    });

    return marker;
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

      // Coordinates from RTDB or Firestore currentLocation
      const lat = rtdbEntry.latitude != null ? rtdbEntry.latitude : (rtdbEntry.lat != null ? rtdbEntry.lat : (fDoc.currentLocation?.latitude || fDoc.location?.latitude || null));
      const lng = rtdbEntry.longitude != null ? rtdbEntry.longitude : (rtdbEntry.lng != null ? rtdbEntry.lng : (fDoc.currentLocation?.longitude || fDoc.location?.longitude || null));
      const heading = rtdbEntry.heading != null ? rtdbEntry.heading : (rtdbEntry.bearing != null ? rtdbEntry.bearing : (fDoc.currentLocation?.heading || 0));
      const speed = rtdbEntry.speed != null ? rtdbEntry.speed : 0;
      const updatedAt = rtdbEntry.updatedAt || fDoc.updatedAt || null;

      // Real status calculation
      const ageMs = updatedAt ? (Date.now() - (typeof updatedAt === 'number' ? updatedAt : (updatedAt.toDate ? updatedAt.toDate().getTime() : Date.now()))) : Infinity;
      const isFresh = ageMs < 65000;
      const isOnline = (rtdbEntry.online === true || fDoc.online === true) && isFresh;

      let computedStatus = 'offline';
      if (activeBk) {
        computedStatus = 'intrip';
      } else if (isOnline && speed > 2) {
        computedStatus = 'online';
      } else if (isOnline) {
        computedStatus = 'idle';
      }

      driversMap.set(uid, {
        uid,
        user,
        vehicle: fDoc.vehicle || {},
        approvalStatus: fDoc.approvalStatus || 'APPROVED',
        ratingAvg: fDoc.ratingAvg || 5.0,
        ratingCount: fDoc.ratingCount || 0,
        location: {
          lat: lat != null ? Number(lat) : null,
          lng: lng != null ? Number(lng) : null,
          heading: Number(heading),
          speed: Number(speed),
          accuracy: rtdbEntry.accuracy || 10,
          updatedAt: updatedAt
        },
        hasGpsLock: lat != null && lng != null,
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
        const phone = String(d.user?.phone || '').toLowerCase();
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
      const photo = d.user?.photoUrl;
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
              ${d.user?.phone ? `
                <a class="btn-card-action" href="https://wa.me/${cleanPhone(d.user.phone)}" target="_blank" title="WhatsApp Driver">
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
    const liveCoords = [];

    state.drivers.forEach((driver, uid) => {
      if (!driver.hasGpsLock) {
        // Driver has no GPS broadcast: remove marker if any
        if (markerLayers.has(uid)) {
          map.removeLayer(markerLayers.get(uid));
          markerLayers.delete(uid);
        }
        if (routeLayers.has(uid)) {
          map.removeLayer(routeLayers.get(uid));
          routeLayers.delete(uid);
        }
        return;
      }

      currentUids.add(uid);
      const latlng = [driver.location.lat, driver.location.lng];
      liveCoords.push(latlng);

      // Marker sync
      let marker = markerLayers.get(uid);
      if (!marker) {
        marker = createDriverMarker(driver);
        marker.addTo(map);
        markerLayers.set(uid, marker);
      } else {
        marker.setLatLng(latlng);
        const vSvg = getVehicleSvg(driver.vehicle?.type);
        const heading = Math.round(driver.location.heading || 0);
        const speed = Math.round(driver.location.speed || 0);
        const status = driver.computedStatus;
        const name = driver.user?.displayName || driver.vehicle?.plate || 'Driver';

        const updatedHtml = `
          <div class="driver-marker-wrap status-${status}">
            <div class="marker-radar-wave ${status}"></div>
            <div class="marker-vehicle-pin status-${status}" style="transform: rotate(${heading}deg);">
              ${vSvg}
            </div>
            ${speed > 0 ? `<div class="marker-speed-tag">${speed} km/h</div>` : ''}
            <div class="marker-name-tag">${escapeHtml(name)}</div>
          </div>
        `;

        const updatedIcon = L.divIcon({
          html: updatedHtml,
          className: 'custom-driver-leaflet-icon',
          iconSize: [48, 48],
          iconAnchor: [24, 24],
          popupAnchor: [0, -26]
        });

        marker.setIcon(updatedIcon);
        marker.setZIndexOffset(status === 'intrip' ? 1000 : status === 'online' ? 500 : 100);
      }

      // Breadcrumb history
      if (!breadcrumbHistory.has(uid)) breadcrumbHistory.set(uid, []);
      const history = breadcrumbHistory.get(uid);
      if (!history.length || (history[history.length - 1][0] !== latlng[0] || history[history.length - 1][1] !== latlng[1])) {
        history.push(latlng);
        if (history.length > 25) history.shift();
      }

      // Active trip routes
      syncRouteLayer(driver);
    });

    // Cleanup stale markers
    markerLayers.forEach((marker, uid) => {
      if (!currentUids.has(uid)) {
        map.removeLayer(marker);
        markerLayers.delete(uid);
        if (routeLayers.has(uid)) {
          map.removeLayer(routeLayers.get(uid));
          routeLayers.delete(uid);
        }
      }
    });

    if (state.isFollowMode && state.selectedDriverId) {
      const selDriver = state.drivers.get(state.selectedDriverId);
      if (selDriver && selDriver.hasGpsLock) {
        map.panTo([selDriver.location.lat, selDriver.location.lng], { animate: true, duration: 0.8 });
      }
    }
  }

  function syncRouteLayer(driver) {
    const uid = driver.uid;
    let rLayerGroup = routeLayers.get(uid);

    if (!rLayerGroup) {
      rLayerGroup = L.layerGroup();
      rLayerGroup.addTo(map);
      routeLayers.set(uid, rLayerGroup);
    }

    rLayerGroup.clearLayers();

    if (driver.activeBooking) {
      const b = driver.activeBooking;
      const p1 = b.pickupLocation ? [b.pickupLocation.latitude || b.pickupLocation.lat, b.pickupLocation.longitude || b.pickupLocation.lng] : null;
      const p2 = b.dropoffLocation ? [b.dropoffLocation.latitude || b.dropoffLocation.lat, b.dropoffLocation.longitude || b.dropoffLocation.lng] : null;

      if (p2 && driver.hasGpsLock) {
        const curr = [driver.location.lat, driver.location.lng];
        const polyline = L.polyline([curr, p2], {
          color: '#3b82f6',
          weight: 4,
          opacity: 0.85,
          dashArray: '8, 8',
          lineCap: 'round'
        });
        rLayerGroup.addLayer(polyline);

        const destPin = L.circleMarker(p2, {
          radius: 8,
          fillColor: '#ef4444',
          fillOpacity: 1,
          color: '#ffffff',
          weight: 2
        }).bindTooltip(`🏁 ${escapeHtml(b.destinationAddress || b.dropoffAddress || 'Dropoff')}`, { permanent: false });
        rLayerGroup.addLayer(destPin);
      }
    }

    if (driver.uid === state.selectedDriverId && driver.hasGpsLock) {
      const history = breadcrumbHistory.get(uid) || [];
      if (history.length > 1) {
        const crumbLine = L.polyline(history, {
          color: '#22c55e',
          weight: 3,
          opacity: 0.5,
          dashArray: '4, 6'
        });
        rLayerGroup.addLayer(crumbLine);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Driver Inspector
  // ---------------------------------------------------------------------------
  function selectDriver(uid, focusOnMap = false) {
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
      map.flyTo([driver.location.lat, driver.location.lng], 15, { duration: 1.2 });
    }

    const inspectorEl = $('driver-inspector');
    if (inspectorEl) inspectorEl.classList.remove('is-hidden');
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
  }

  function renderInspector(driver) {
    const el = $('driver-inspector');
    if (!el || !driver) return;

    const name = driver.user?.displayName || 'Driver';
    const photo = driver.user?.photoUrl;
    const phone = driver.user?.phone || 'Not recorded';
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
    $('inspector-rating').textContent = driver.ratingAvg ? `★ ${Number(driver.ratingAvg).toFixed(1)} (${driver.ratingCount || 0} rides)` : '★ 5.0';
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
      if (driver && driver.hasGpsLock) map.panTo([driver.location.lat, driver.location.lng], { animate: true });
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
      map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
      return;
    }
    const latlngs = validDrivers.map((d) => [d.location.lat, d.location.lng]);
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
  }

  // ---------------------------------------------------------------------------
  // Live Firebase Listeners (Real Data)
  // ---------------------------------------------------------------------------
  function attachFirebaseListeners() {
    if (typeof firebase === 'undefined') {
      console.error('Firebase SDK not loaded.');
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
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
      const unsubBookings = bookingsCol.where('status', 'in', ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'])
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

    document.querySelectorAll('[data-tile-style]').forEach((btn) => {
      btn.addEventListener('click', () => setTileLayer(btn.dataset.tileStyle));
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
        setTimeout(() => map && map.invalidateSize(), 300);
      });
    }

    const closeInspector = $('btn-close-inspector');
    if (closeInspector) closeInspector.addEventListener('click', deselectDriver);
  }

  // ---------------------------------------------------------------------------
  // App Bootstrapper
  // ---------------------------------------------------------------------------
  function boot() {
    initMap();
    initDOM();
    attachFirebaseListeners();

    setTimeout(() => {
      fitAllDrivers();
    }, 1500);
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
