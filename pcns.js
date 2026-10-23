/* PCNS — Precision Campus Navigation System
 * Pure vanilla JS. Outdoor GPS -> NFC handover -> Indoor PDR.
 */
(() => {
  "use strict";

  // ---------- Config ----------
  const ADMIN_PASSWORD = "amity2026"; // change in localStorage key 'pcns.adminPass' via admin later
  const ARRIVAL_RADIUS_M = 5;
  const DEFAULT_STEP_LENGTH_M = 0.7; // ~average
  const STEP_SIGNAL_THRESHOLD = 1.2; // m/s^2 dynamic acceleration
  const STEP_RELEASE_THRESHOLD = 0.5;
  const STEP_MIN_INTERVAL_MS = 280;
  const SNAP_MAX_DISTANCE_M = 15;
  const AMITY_NOIDA_CENTER = [28.5440, 77.3350];
  const DEFAULT_FLOORS = [0, 1, 2, 3];

  const LS = {
    landmarks: "pcns.landmarks",
    adminPass: "pcns.adminPass",      // legacy plain text (back-compat)
    adminHash: "pcns.adminPassHash",  // SHA-256 hex of password
    training: "pcns.training",
    heatmap: "pcns.heatmap",
  };

  // ---------- State ----------
  const state = {
    mode: "OUTDOOR", // OUTDOOR | INDOOR
    userLatLng: null,
    selectedLandmarkId: null,
    arrivedGateId: null,
    // PDR
    anchor: null,            // { lat, lng, floor, label }
    heading: 0,              // degrees 0..359
    stepCount: 0,
    pdrOffsetMeters: { x: 0, y: 0 }, // accumulated E/N offset from anchor
    lastStepTs: 0,
    stepSignalAbove: false,
    // Floor plan
    floorGeo: null,
    // Training mode
    training: false,
    // Heatmap mode (dim other floors instead of hiding)
    heatmap: false,
    // Floor awareness
    currentFloor: "ALL",          // "ALL" | integer (0 = Ground)
    availableFloors: [...DEFAULT_FLOORS],
    // Markers
    userMarker: null,
    headingMarker: null,
    landmarkMarkers: new Map(),
    watchId: null,
  };

  // ---------- Storage ----------
  let storageWarningShown = false;
  function reportStorageProblem(message, error) {
    console.error(message, error);
    if (!storageWarningShown) {
      storageWarningShown = true;
      alert(message);
    }
  }

  function isValidLandmark(lm) {
    return !!lm && typeof lm === "object" && !Array.isArray(lm) &&
      typeof lm.id === "string" && /^[\w-]+$/.test(lm.id) &&
      typeof lm.name === "string" && !!lm.name.trim() &&
      Number.isFinite(lm.lat) && Math.abs(lm.lat) <= 90 &&
      Number.isFinite(lm.lng) && Math.abs(lm.lng) <= 180 &&
      (lm.floor == null || Number.isInteger(lm.floor)) &&
      (lm.uid == null || typeof lm.uid === "string") &&
      (lm.anchor == null || typeof lm.anchor === "string") &&
      (lm.offset == null || (
        typeof lm.offset === "object" &&
        Number.isFinite(lm.offset.x) && Number.isFinite(lm.offset.y)
      ));
  }

  function loadLandmarks() {
    let raw;
    try {
      raw = localStorage.getItem(LS.landmarks);
    } catch (error) {
      reportStorageProblem("Browser storage is unavailable. Saved landmarks cannot be loaded.", error);
      return [];
    }
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      reportStorageProblem("Saved landmark data is damaged and could not be read. The original data was left unchanged.", error);
      return [];
    }
    if (!Array.isArray(parsed)) {
      reportStorageProblem("Saved landmark data has an invalid format. The original data was left unchanged.", new TypeError("Expected a landmark array."));
      return [];
    }

    const ids = new Set();
    const valid = parsed.filter(lm => {
      if (!isValidLandmark(lm) || ids.has(lm.id)) return false;
      ids.add(lm.id);
      return true;
    });
    if (valid.length !== parsed.length) {
      reportStorageProblem("Some saved landmarks are invalid and were skipped. Review or remove the damaged entries from browser storage.", new TypeError("Invalid or duplicate landmark records."));
    }
    return valid;
  }

  function saveLandmarks(arr) {
    try {
      localStorage.setItem(LS.landmarks, JSON.stringify(arr));
      refreshAvailableFloors(arr);
      return true;
    } catch (error) {
      reportStorageProblem("Landmarks could not be saved. Check browser storage permissions and available space.", error);
      return false;
    }
  }

  function readStoredSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      reportStorageProblem("Browser storage is unavailable. App settings cannot be restored.", error);
      return null;
    }
  }

  function writeStoredSetting(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      reportStorageProblem("App settings could not be saved. Check browser storage permissions and available space.", error);
      return false;
    }
  }

  function refreshAvailableFloors(landmarks = loadLandmarks()) {
    const floors = new Set(DEFAULT_FLOORS);
    if (Number.isInteger(state.anchor?.floor)) floors.add(state.anchor.floor);
    landmarks.forEach(lm => {
      if (Number.isInteger(lm.floor)) floors.add(lm.floor);
    });
    state.availableFloors = [...floors].sort((a, b) => a - b);
    if (state.currentFloor !== "ALL" && !floors.has(state.currentFloor)) state.currentFloor = "ALL";
    renderFloorSwitch();
    applyFloorFilterToGeo();
  }

  // ---------- Geo utils ----------
  const R = 6371000; // meters
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // offset in meters (eastMeters, northMeters) added to a lat/lng
  function offsetLatLng(lat, lng, eastMeters, northMeters) {
    const dLat = (northMeters / R) * (180 / Math.PI);
    const dLng = (eastMeters / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  // Parse "lat,lng" or Google Maps URL
  function parseCoords(text) {
    if (!text) return null;
    const s = text.trim();
    // simple "lat, lng"
    let m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    // Google Maps @lat,lng,zoom
    const gm = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    // q=lat,lng
    const qm = s.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const mm = gm || qm || m;
    if (!mm) return null;
    const lat = parseFloat(mm[1]), lng = parseFloat(mm[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView(AMITY_NOIDA_CENTER, 17);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "© OpenStreetMap",
  }).addTo(map);

  function setUserPosition(lat, lng, { pan = true } = {}) {
    state.userLatLng = { lat, lng };
    const icon = L.divIcon({
      className: "",
      html: `<div class="user-marker ${state.mode === "INDOOR" ? "indoor" : ""}"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9],
    });
    if (!state.userMarker) {
      state.userMarker = L.marker([lat, lng], { icon }).addTo(map);
    } else {
      state.userMarker.setLatLng([lat, lng]);
      state.userMarker.setIcon(icon);
    }
    if (pan) map.setView([lat, lng], Math.max(map.getZoom(), state.mode === "INDOOR" ? 20 : 18));
  }

  // ---------- Landmarks ----------
  function landmarkOnCurrentFloor(lm) {
    if (state.currentFloor === "ALL") return true;
    if (lm.floor == null) return true;
    return Number(lm.floor) === Number(state.currentFloor);
  }

  function renderLandmarkMarkers() {
    state.landmarkMarkers.forEach(m => map.removeLayer(m));
    state.landmarkMarkers.clear();
    const all = loadLandmarks();
    // In heatmap mode, render all but dim the off-floor ones; otherwise filter.
    const list = state.heatmap ? all : all.filter(landmarkOnCurrentFloor);
    list.forEach(lm => {
      const isTraining = lm.source === "training";
      const offFloor = state.heatmap && !landmarkOnCurrentFloor(lm);
      const m = L.circleMarker([lm.lat, lm.lng], {
        radius: isTraining ? 6 : 8,
        color: isTraining ? "#f5f2ff" : "#9B30FF",
        fillColor: isTraining ? "#9B30FF" : "#b769ff",
        fillOpacity: offFloor ? 0.18 : 0.9,
        opacity:     offFloor ? 0.20 : 1,
        weight: 2,
      }).bindPopup(
        `<b>${escapeHtml(lm.name)}</b>` +
        (isTraining ? ` <em style="color:#b769ff">[training]</em>` : "") +
        (lm.floor != null ? ` <span style="color:#b769ff">· Floor ${lm.floor}</span>` : "") +
        `<br/>${lm.lat.toFixed(5)}, ${lm.lng.toFixed(5)}` +
        (lm.uid ? `<br/><span style="color:#8a7ea3">UID: ${escapeHtml(lm.uid)}</span>` : "")
      );
      m.addTo(map);
      state.landmarkMarkers.set(lm.id, m);
    });
  }

  // ---------- Floor Switcher ----------
  function floorLabel(f) { return f === 0 ? "G" : String(f); }

  function renderFloorSwitch() {
    const box = $("#floorSwitch");
    const floors = [...state.availableFloors].sort((a, b) => b - a); // top-down: highest first
    const btns = floors.map(f => `
      <button class="floor-btn ${state.currentFloor === f ? "active" : ""}"
              data-floor="${f}" data-testid="floor-btn-${f}" title="Floor ${floorLabel(f)}">
        ${floorLabel(f)}
      </button>`).join("");
    const allBtn = `
      <button class="floor-btn all-btn ${state.currentFloor === "ALL" ? "active" : ""}"
              data-floor="ALL" data-testid="floor-btn-all" title="All floors">ALL</button>`;
    box.innerHTML = btns + allBtn;
    box.querySelectorAll("button[data-floor]").forEach(b =>
      b.addEventListener("click", () => {
        const f = b.dataset.floor;
        setCurrentFloor(f === "ALL" ? "ALL" : Number(f));
      })
    );
  }

  function setCurrentFloor(f) {
    if (Number.isInteger(f) && !state.availableFloors.includes(f)) {
      state.availableFloors.push(f);
      state.availableFloors.sort((a, b) => a - b);
    }
    state.currentFloor = f;
    renderFloorSwitch();
    renderLandmarkMarkers();
    applyFloorFilterToGeo();
    refreshSearch();
  }

  function applyFloorFilterToGeo() {
    if (!floorLayer) return;
    floorLayer.eachLayer(layer => {
      const floor = layer.feature?.properties?.floor;
      const onFloor =
        state.currentFloor === "ALL" || floor == null || Number(floor) === Number(state.currentFloor);
      const el = layer.getElement ? layer.getElement() : null;
      if (!el) return;
      if (state.heatmap) {
        el.style.display = "";
        el.classList.toggle("heatmap-dim", !onFloor);
      } else {
        el.style.display = onFloor ? "" : "none";
        el.classList.remove("heatmap-dim");
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }

  // ---------- Search ----------
  const $ = sel => document.querySelector(sel);
  const searchInput = $("#searchInput");
  const searchResults = $("#searchResults");

  function refreshSearch() {
    const q = searchInput.value.trim().toLowerCase();
    const here = state.userLatLng;
    const items = loadLandmarks()
      .filter(landmarkOnCurrentFloor)
      .map(lm => ({
        ...lm,
        dist: here ? haversine(here, lm) : null,
      }))
      .filter(lm => !q || lm.name.toLowerCase().includes(q))
      .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
      .slice(0, 20);

    searchResults.innerHTML = items.map(lm => `
      <li data-id="${lm.id}" data-testid="search-result-${lm.id}">
        <span class="search-result-name">${escapeHtml(lm.name)}</span>
        <span class="search-result-actions">
          <span class="dist">${lm.dist != null ? Math.round(lm.dist) + " m" : ""}</span>
          <a class="search-result-directions" href="${googleMapsDirectionsUrl(lm)}"
             target="_blank" rel="noopener noreferrer" aria-label="Get directions to ${escapeHtml(lm.name)}">Directions</a>
        </span>
      </li>`).join("");

    searchResults.querySelectorAll("li").forEach(li => {
      li.addEventListener("click", () => selectLandmark(li.dataset.id));
    });
    searchResults.querySelectorAll(".search-result-directions").forEach(link =>
      link.addEventListener("click", event => event.stopPropagation())
    );
  }

  function googleMapsDirectionsUrl(landmark) {
    const destination = encodeURIComponent(`${landmark.lat},${landmark.lng}`);
    return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
  }

  function selectLandmark(id) {
    const lm = loadLandmarks().find(x => x.id === id);
    if (!lm) return;
    state.selectedLandmarkId = id;
    map.setView([lm.lat, lm.lng], 19);
    const marker = state.landmarkMarkers.get(id);
    if (marker) marker.openPopup();
    searchInput.value = lm.name;
    searchResults.innerHTML = "";
    checkArrival();
  }

  searchInput.addEventListener("input", refreshSearch);
  searchInput.addEventListener("focus", refreshSearch);

  // ---------- Arrival check ----------
  function checkArrival() {
    if (state.mode !== "OUTDOOR" || !state.userLatLng || !state.selectedLandmarkId) return;
    const lm = loadLandmarks().find(x => x.id === state.selectedLandmarkId);
    if (!lm) return;
    const d = haversine(state.userLatLng, lm);
    if (d <= ARRIVAL_RADIUS_M && state.arrivedGateId !== lm.id) {
      state.arrivedGateId = lm.id;
      showToast();
    }
  }

  function showToast() {
    const t = $("#arrivalToast");
    t.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (t.hidden = true), 6000);
  }

  // ---------- Outdoor: Geolocation ----------
  function startGeoWatch() {
    if (!navigator.geolocation) {
      alert("Geolocation is unavailable in this browser. Use Debug → Jump GPS for a desktop simulation.");
      return;
    }
    if (state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(
      pos => {
        if (state.mode !== "OUTDOOR") return;
        setUserPosition(pos.coords.latitude, pos.coords.longitude, { pan: false });
        checkArrival();
        refreshSearch();
      },
      error => {
        if (state.mode !== "OUTDOOR") return;
        console.error("Geolocation watch failed.", error);
        stopGeoWatch();
        alert("Location could not be read. Allow location access or use Debug → Jump GPS.");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }
  function stopGeoWatch() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
  }

  // ---------- NFC Handover ----------
  function normalizeUid(serial) {
    if (!serial) return "";
    return String(serial).toUpperCase().replace(/\s+/g, "").replace(/:/g, "");
  }

  function findLandmarkByUid(uid) {
    if (!uid) return null;
    const norm = normalizeUid(uid);
    return loadLandmarks().find(lm => lm.uid && normalizeUid(lm.uid) === norm) || null;
  }

  let activeNfcController = null;

  function stopNfcScan() {
    if (activeNfcController) {
      activeNfcController.abort();
      activeNfcController = null;
    }
  }

  async function startNfcScan() {
    if (!("NDEFReader" in window)) {
      alert("Web NFC not supported on this device/browser. Use Debug → Simulate NFC Tap.");
      return;
    }
    stopNfcScan();
    const controller = new AbortController();
    activeNfcController = controller;
    const reader = new window.NDEFReader();
    reader.onreading = (event) => {
      if (activeNfcController !== controller) return;
      stopNfcScan();
      // 1) UID match takes priority
      const uid = event.serialNumber;
      const match = findLandmarkByUid(uid);
      if (match) {
        promptAnchorConfirm({
          lat: match.lat, lng: match.lng, floor: match.floor ?? 1, label: match.name,
        }, `Matched tag UID ${uid} → "${match.name}"`);
        return;
      }
      // 2) Otherwise parse JSON payload
      for (const rec of event.message.records) {
        if (rec.recordType === "text" || rec.mediaType === "application/json") {
          try {
            const text = new TextDecoder().decode(rec.data);
            const payload = JSON.parse(text);
            promptAnchorConfirm(payload, "NFC tag payload received");
            return;
          } catch (error) {
            console.warn("Ignoring an invalid NFC payload record.", error);
          }
        }
      }
      alert(`NFC tag read (UID: ${uid || "unknown"}) but no known UID or valid payload found.`);
    };
    reader.onreadingerror = () => {
      if (activeNfcController !== controller) return;
      stopNfcScan();
      alert("The NFC tag could not be read. Try again or use Debug → Simulate NFC Tap.");
    };
    try {
      await reader.scan({ signal: controller.signal });
    } catch (error) {
      if (activeNfcController === controller) {
        stopNfcScan();
        alert("NFC scan failed: " + error.message);
      }
    }
  }

  // Scan only the UID (used from Admin form)
  async function scanUidOnly() {
    if (!("NDEFReader" in window)) {
      alert("Web NFC not supported. Enter UID manually.");
      return null;
    }
    const statusEl = $("#lmUidStatus");
    statusEl.hidden = false;
    statusEl.textContent = "Waiting for tag… tap one now.";
    stopNfcScan();
    const controller = new AbortController();
    activeNfcController = controller;
    const reader = new window.NDEFReader();
    let timer;
    let finish;
    let completed = false;
    const reading = new Promise(resolve => {
      finish = uid => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (reader.onreading) reader.onreading = null;
        reader.onreadingerror = null;
        if (activeNfcController === controller) stopNfcScan();
        resolve(uid);
      };
    });
    reader.onreading = event => finish(event.serialNumber || "");
    reader.onreadingerror = () => finish(null);
    controller.signal.addEventListener("abort", () => finish(null), { once: true });
    timer = setTimeout(() => finish(null), 15000);
    try {
      await reader.scan({ signal: controller.signal });
      return await reading;
    } catch (error) {
      finish(null);
      statusEl.textContent = "Scan failed: " + error.message;
      return null;
    }
  }

  function validAnchor(payload) {
    if (!payload || typeof payload !== "object" ||
        typeof payload.lat !== "number" || !Number.isFinite(payload.lat) ||
        Math.abs(payload.lat) > 90 ||
        typeof payload.lng !== "number" || !Number.isFinite(payload.lng) ||
        Math.abs(payload.lng) > 180 ||
        (payload.floor != null && !Number.isInteger(payload.floor)) ||
        (payload.label != null && typeof payload.label !== "string")) {
      return null;
    }
    return {
      lat: payload.lat,
      lng: payload.lng,
      floor: payload.floor ?? 1,
      label: payload.label?.trim() || "",
    };
  }

  function promptAnchorConfirm(p, reason) {
    const anchor = validAnchor(p);
    if (!anchor) {
      alert("Invalid NFC payload. Expected valid coordinates and an optional integer floor and text label.");
      return;
    }
    const label = anchor.label || "(unnamed)";
    const ok = confirm(
      `${reason}\n\nAnchor you to:\n  ${label}\n  ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` +
      `  (floor ${anchor.floor})` +
      `\n\nSwitch to Indoor Navigation?`
    );
    if (ok) enterIndoorMode(anchor);
  }

  function handleNfcPayload(p) { promptAnchorConfirm(p, "NFC tag scanned"); }

  // ---------- Indoor / PDR ----------
  function enterIndoorMode(anchor) {
    stopGeoWatch();
    stopSensors();
    state.mode = "INDOOR";
    state.anchor = { lat: anchor.lat, lng: anchor.lng, floor: anchor.floor ?? 1, label: anchor.label || "" };
    state.stepCount = 0;
    state.pdrOffsetMeters = { x: 0, y: 0 };
    state.lastStepTs = 0;
    state.stepSignalAbove = false;
    $("#hudMode").textContent = `INDOOR${anchor.label ? " • " + anchor.label : ""}`;
    $("#hudMode").classList.add("indoor");
    $("#arrivalToast").hidden = true;
    setUserPosition(state.anchor.lat, state.anchor.lng, { pan: true });
    // Auto-switch floor to anchor floor + prefill drop-floor input
    setCurrentFloor(Number(state.anchor.floor));
    $("#dropFloor").value = String(state.anchor.floor);
    loadFloorGeo();
    startSensors();
    updateDropMarkerVisibility();
    updateTrainingHud();
  }

  function exitIndoorMode() {
    state.mode = "OUTDOOR";
    state.anchor = null;
    $("#hudMode").textContent = "OUTDOOR";
    $("#hudMode").classList.remove("indoor");
    clearFloorGeo();
    stopSensors();
    updateDropMarkerVisibility();
    startGeoWatch();
  }

  function updatePdrPosition() {
    if (state.mode !== "INDOOR" || !state.anchor) return;
    const { x, y } = state.pdrOffsetMeters;
    let { lat, lng } = offsetLatLng(state.anchor.lat, state.anchor.lng, x, y);
    // path snapping
    const snapped = snapToHallway(lat, lng);
    if (snapped) ({ lat, lng } = snapped);
    setUserPosition(lat, lng, { pan: false });
    refreshSearch();
  }

  function addStep() {
    state.stepCount += 1;
    const theta = toRad(state.heading); // 0° = North (heading convention)
    // East = sin(theta), North = cos(theta); step length fixed for simplicity
    const dx = DEFAULT_STEP_LENGTH_M * Math.sin(theta); // east
    const dy = DEFAULT_STEP_LENGTH_M * Math.cos(theta); // north
    state.pdrOffsetMeters.x += dx;
    state.pdrOffsetMeters.y += dy;
    $("#hudSteps").textContent = String(state.stepCount);
    updatePdrPosition();
    updateTrainingHud();
  }

  function updateTrainingHud() {
    if (!state.training) return;
    const fmt = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);
    $("#hudX").textContent = fmt(state.pdrOffsetMeters.x);
    $("#hudY").textContent = fmt(state.pdrOffsetMeters.y);
  }

  function setHeading(deg) {
    state.heading = ((deg % 360) + 360) % 360;
    $("#hudHeading").textContent = Math.round(state.heading) + "°";
  }

  // ---------- Sensors ----------
  let motionHandler = null, orientHandler = null;
  let sensorGeneration = 0;

  async function startSensors() {
    stopSensors();
    const generation = sensorGeneration;
    let motionAllowed = typeof DeviceMotionEvent !== "undefined";
    let orientationAllowed = typeof DeviceOrientationEvent !== "undefined";
    try {
      if (motionAllowed && typeof DeviceMotionEvent.requestPermission === "function") {
        motionAllowed = await DeviceMotionEvent.requestPermission() === "granted";
      }
      if (orientationAllowed && typeof DeviceOrientationEvent.requestPermission === "function") {
        orientationAllowed = await DeviceOrientationEvent.requestPermission() === "granted";
      }
    } catch (error) {
      console.error("Motion sensor permission request failed.", error);
      motionAllowed = false;
      orientationAllowed = false;
    }
    if (generation !== sensorGeneration) return;

    if (!motionAllowed && !orientationAllowed) {
      alert("Motion and heading sensors are unavailable or permission was denied. Use the Debug panel to simulate indoor movement.");
      return;
    }
    if (!motionAllowed) {
      alert("Step detection is unavailable or motion permission was denied. Indoor heading may still work; use Debug to simulate steps.");
    } else if (!orientationAllowed) {
      alert("Heading is unavailable or orientation permission was denied. Indoor step counts may still work; use Debug to set heading.");
    }

    if (motionAllowed) {
      motionHandler = (e) => {
        const usesLinearAcceleration = !!e.acceleration;
        const a = e.acceleration || e.accelerationIncludingGravity;
        if (!a) return;
        const magnitude = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
        const signal = usesLinearAcceleration ? magnitude : Math.abs(magnitude - 9.81);
        const now = Date.now();
        if (signal >= STEP_SIGNAL_THRESHOLD && !state.stepSignalAbove) {
          if (now - state.lastStepTs > STEP_MIN_INTERVAL_MS) {
            state.lastStepTs = now;
            addStep();
          }
          state.stepSignalAbove = true;
        } else if (signal <= STEP_RELEASE_THRESHOLD) {
          state.stepSignalAbove = false;
        }
      };
      window.addEventListener("devicemotion", motionHandler);
    }
    if (orientationAllowed) {
      orientHandler = (e) => {
        // webkitCompassHeading is absolute on iOS; alpha may be device-relative.
        const h = (typeof e.webkitCompassHeading === "number")
          ? e.webkitCompassHeading
          : (typeof e.alpha === "number" ? 360 - e.alpha : null);
        if (h != null) setHeading(h);
      };
      window.addEventListener("deviceorientation", orientHandler);
    }
  }

  function stopSensors() {
    sensorGeneration += 1;
    if (motionHandler) window.removeEventListener("devicemotion", motionHandler);
    if (orientHandler) window.removeEventListener("deviceorientation", orientHandler);
    motionHandler = orientHandler = null;
    state.stepSignalAbove = false;
  }

  // ---------- Floor GeoJSON + path snapping ----------
  let floorLayer = null;

  async function loadFloorGeo() {
    const requestedAnchor = state.anchor;
    try {
      const res = await fetch("demo-floor.geojson");
      if (!res.ok) throw new Error(`Floor plan request failed with HTTP ${res.status}.`);
      const geo = await res.json();
      if (geo?.type !== "FeatureCollection" || !Array.isArray(geo.features) ||
          geo.features.some(feature =>
            !feature || feature.type !== "Feature" ||
            !feature.geometry || typeof feature.geometry.type !== "string" ||
            !Array.isArray(feature.geometry.coordinates)
          )) {
        throw new TypeError("Floor plan must be a GeoJSON FeatureCollection with valid feature geometries.");
      }
      if (state.mode !== "INDOOR" || state.anchor !== requestedAnchor) return;
      state.floorGeo = geo;
      if (floorLayer) map.removeLayer(floorLayer);
      floorLayer = L.geoJSON(geo, {
        style: (f) => f.properties?.type === "wall"
          ? { color: "#9B30FF", weight: 1, fillColor: "#241238", fillOpacity: 0.5 }
          : { color: "#f5f2ff", weight: 2, dashArray: "4 4" },
      }).addTo(map);
      applyFloorFilterToGeo();
    } catch (error) {
      if (state.mode === "INDOOR" && state.anchor === requestedAnchor) {
        console.error("Indoor floor plan could not be loaded.", error);
        alert("The indoor floor plan could not be loaded. Position tracking will continue without map matching.");
      }
    }
  }
  function clearFloorGeo() {
    if (floorLayer) { map.removeLayer(floorLayer); floorLayer = null; }
    state.floorGeo = null;
  }

  function toLocalMeters(point, origin) {
    const latitudeScale = Math.cos(toRad(origin[1]));
    return [
      (point[0] - origin[0]) * Math.PI / 180 * R * latitudeScale,
      (point[1] - origin[1]) * Math.PI / 180 * R,
    ];
  }

  function nearestPointOnSegment(p, a, b) {
    const pm = toLocalMeters(p, p);
    const am = toLocalMeters(a, p);
    const bm = toLocalMeters(b, p);
    const dx = bm[0] - am[0], dy = bm[1] - am[1];
    const len2 = dx * dx + dy * dy || 1e-18;
    let t = ((pm[0] - am[0]) * dx + (pm[1] - am[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = am[0] + t * dx;
    const qy = am[1] + t * dy;
    const latitudeScale = Math.cos(toRad(p[1]));
    const q = [
      p[0] + qx / (R * latitudeScale) * 180 / Math.PI,
      p[1] + qy / R * 180 / Math.PI,
    ];
    return { point: q, distance: Math.hypot(pm[0] - qx, pm[1] - qy) };
  }

  function isCoordinatePair(point) {
    return Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]);
  }

  function snapToHallway(lat, lng) {
    const geo = state.floorGeo;
    if (!geo || !Array.isArray(geo.features)) return null;
    const pt = [lng, lat];
    const activeFloor = state.anchor?.floor;
    const onActiveFloor = feature =>
      feature?.properties?.floor == null || Number(feature.properties.floor) === Number(activeFloor);
    const halls = geo.features.filter(f =>
      f?.properties?.type === "hallway" && onActiveFloor(f) && f.geometry
    );
    let best = null, bestDistance = Infinity;
    for (const h of halls) {
      const geometry = h.geometry;
      const lines = geometry.type === "LineString"
        ? [geometry.coordinates]
        : (geometry.type === "MultiLineString" ? geometry.coordinates : []);
      for (const coords of lines) {
        if (!Array.isArray(coords)) continue;
        for (let i = 0; i < coords.length - 1; i++) {
          if (!isCoordinatePair(coords[i]) || !isCoordinatePair(coords[i + 1])) continue;
          const candidate = nearestPointOnSegment(pt, coords[i], coords[i + 1]);
          if (candidate.distance < bestDistance) {
            bestDistance = candidate.distance;
            best = candidate.point;
          }
        }
      }
    }
    if (!best || bestDistance > SNAP_MAX_DISTANCE_M) return null;
    return { lat: best[1], lng: best[0] };
  }

  // ---------- Admin ----------
  function openModal(id) { $("#" + id).hidden = false; }
  function closeModal(id) { $("#" + id).hidden = true; }

  document.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(b.dataset.close))
  );

  $("#adminBtn").addEventListener("click", () => {
    openModal("adminModal");
    $("#adminLogin").hidden = false;
    $("#adminPanel").hidden = true;
    $("#adminPass").value = "";
    $("#adminLoginErr").hidden = true;
  });

  // ---------- Password hashing ----------
  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function verifyAdminPass(input) {
    const storedHash = readStoredSetting(LS.adminHash);
    if (storedHash) {
      const h = await sha256Hex(input);
      return h === storedHash;
    }
    // Legacy plain (or factory default fallback)
    const legacy = readStoredSetting(LS.adminPass) || ADMIN_PASSWORD;
    return input === legacy;
  }

  $("#adminLoginBtn").addEventListener("click", async () => {
    const ok = await verifyAdminPass($("#adminPass").value);
    if (ok) {
      $("#adminLogin").hidden = true;
      $("#adminPanel").hidden = false;
      renderLandmarkList();
    } else {
      $("#adminLoginErr").hidden = false;
    }
  });
  $("#adminPass").addEventListener("keydown", e => {
    if (e.key === "Enter") $("#adminLoginBtn").click();
  });
  $("#adminLogoutBtn").addEventListener("click", () => {
    $("#adminLogin").hidden = false;
    $("#adminPanel").hidden = true;
  });

  $("#lmPaste").addEventListener("input", () => {
    const c = parseCoords($("#lmPaste").value);
    if (c) { $("#lmLat").value = c.lat; $("#lmLng").value = c.lng; }
  });

  $("#lmScanUidBtn").addEventListener("click", async () => {
    const uid = await scanUidOnly();
    if (uid) {
      $("#lmUid").value = uid;
      $("#lmUidStatus").textContent = "Captured UID: " + uid;
    } else {
      $("#lmUidStatus").textContent = "No tag detected.";
    }
  });

  $("#lmAddBtn").addEventListener("click", () => {
    const name = $("#lmName").value.trim();
    const lat = parseFloat($("#lmLat").value);
    const lng = parseFloat($("#lmLng").value);
    const floorText = $("#lmFloor").value.trim();
    const floor = floorText ? $("#lmFloor").valueAsNumber : null;
    const uid = $("#lmUid").value.trim();
    const err = $("#lmErr");
    err.hidden = true;
    if (!name) { err.textContent = "Name required."; err.hidden = false; return; }
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180) {
      err.textContent = "Enter a latitude between -90 and 90 and a longitude between -180 and 180.";
      err.hidden = false;
      return;
    }
    if (floorText && !Number.isInteger(floor)) {
      err.textContent = "Floor must be a whole number.";
      err.hidden = false;
      return;
    }
    // UID duplicate check
    if (uid && findLandmarkByUid(uid)) {
      err.textContent = "That UID is already mapped to another landmark."; err.hidden = false; return;
    }
    const list = loadLandmarks();
    const landmark = { id: "lm_" + Date.now().toString(36), name, lat, lng, uid: uid || undefined };
    if (floor != null) landmark.floor = floor;
    list.push(landmark);
    if (!saveLandmarks(list)) return;
    $("#lmName").value = ""; $("#lmPaste").value = "";
    $("#lmLat").value = ""; $("#lmLng").value = "";
    $("#lmFloor").value = "";
    $("#lmUid").value = ""; $("#lmUidStatus").hidden = true;
    renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
  });

  function renderLandmarkList() {
    const ul = $("#lmList");
    const list = loadLandmarks();
    if (list.length === 0) {
      ul.innerHTML = `<li class="meta" style="justify-content:center">No landmarks yet.</li>`;
      return;
    }
    ul.innerHTML = list.map(lm => `
      <li data-testid="lm-item-${lm.id}">
        <div>
          <div>${escapeHtml(lm.name)}${lm.source === "training" ? ' <span class="badge">TRAINING</span>' : ""}${lm.uid ? ' <span class="badge">UID</span>' : ""}${lm.floor != null ? ` <span class="badge">F${lm.floor}</span>` : ""}</div>
          <div class="meta">${lm.lat.toFixed(5)}, ${lm.lng.toFixed(5)}${lm.uid ? " · " + escapeHtml(lm.uid) : ""}</div>
        </div>
        <button data-id="${lm.id}" data-testid="lm-delete-${lm.id}" title="Delete">✕</button>
      </li>`).join("");
    ul.querySelectorAll("button[data-id]").forEach(b =>
      b.addEventListener("click", () => {
        const id = b.dataset.id;
        if (!saveLandmarks(loadLandmarks().filter(x => x.id !== id))) return;
        renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
      })
    );
  }

  // ---------- Training Mode ----------
  function setTrainingMode(on) {
    state.training = !!on;
    writeStoredSetting(LS.training, state.training ? "1" : "0");
    document.body.classList.toggle("training-on", state.training);
    $("#trainingBanner").hidden = !state.training;
    $("#hudXY").hidden = !state.training;
    // Drop marker only shows when training AND indoor
    updateDropMarkerVisibility();
    updateTrainingHud();
    const tog = $("#trainingToggle");
    if (tog) tog.checked = state.training;
  }

  function updateDropMarkerVisibility() {
    const show = state.training && state.mode === "INDOOR";
    $("#dropMarkerBtn").hidden = !show;
    $("#dropFloorWrap").hidden = !show;
  }

  $("#trainingToggle").addEventListener("change", (e) => setTrainingMode(e.target.checked));

  // ---------- Floor Heatmap ----------
  function setHeatmapMode(on) {
    state.heatmap = !!on;
    writeStoredSetting(LS.heatmap, state.heatmap ? "1" : "0");
    const tog = $("#heatmapToggle");
    if (tog) tog.checked = state.heatmap;
    renderLandmarkMarkers();
    applyFloorFilterToGeo();
  }
  $("#heatmapToggle").addEventListener("change", (e) => setHeatmapMode(e.target.checked));

  // ---------- CSV Export ----------
  function csvCell(v, isText = false) {
    if (v == null) return "";
    let s = String(v);
    if (isText && /^\s*[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  $("#exportCsvBtn").addEventListener("click", () => {
    const training = loadLandmarks().filter(l => l.source === "training");
    if (training.length === 0) {
      alert("No training markers to export yet.");
      return;
    }
    const header = ["name", "lat", "lng", "floor", "anchor", "x", "y"];
    const rows = training.map(l => [
      l.name, l.lat, l.lng, l.floor ?? "", l.anchor ?? "",
      l.offset?.x ?? "", l.offset?.y ?? "",
    ].map((value, index) => csvCell(value, index === 0 || index === 4)).join(","));
    const csv = header.join(",") + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `pcns-training-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  });

  // ---------- Change Admin Password ----------
  $("#changePassBtn").addEventListener("click", async () => {
    const status = $("#passStatus");
    const a = $("#newPass").value;
    const b = $("#newPass2").value;
    status.hidden = false;
    if (!a || a.length < 4) { status.textContent = "Password must be at least 4 characters."; return; }
    if (a !== b) { status.textContent = "Passwords do not match."; return; }
    const hash = await sha256Hex(a);
    if (!writeStoredSetting(LS.adminHash, hash)) {
      status.textContent = "Password could not be saved. Check browser storage permissions.";
      return;
    }
    try {
      localStorage.removeItem(LS.adminPass);
    } catch (error) {
      reportStorageProblem("The new password was saved, but the legacy password could not be removed.", error);
    }
    $("#newPass").value = ""; $("#newPass2").value = "";
    status.textContent = "Password updated. Hash stored locally.";
  });

  $("#dropMarkerBtn").addEventListener("click", () => {
    if (state.mode !== "INDOOR" || !state.anchor) {
      alert("Enter Indoor mode (tap an NFC anchor) before dropping markers.");
      return;
    }
    const floorInput = $("#dropFloor").valueAsNumber;
    if (!Number.isInteger(floorInput)) {
      alert("Enter a whole-number floor before dropping a marker.");
      return;
    }
    const floor = floorInput;
    const suggested = `Marker @ F${floor} (${state.pdrOffsetMeters.x.toFixed(1)}, ${state.pdrOffsetMeters.y.toFixed(1)})`;
    const name = prompt("Name this indoor marker:", suggested);
    if (!name || !name.trim()) return;
    const { x, y } = state.pdrOffsetMeters;
    const p = state.userLatLng || offsetLatLng(state.anchor.lat, state.anchor.lng, x, y);
    const list = loadLandmarks();
    list.push({
      id: "lm_" + Date.now().toString(36),
      name: name.trim(),
      lat: p.lat, lng: p.lng,
      floor,
      source: "training",
      anchor: state.anchor.label || null,
      offset: { x: +x.toFixed(3), y: +y.toFixed(3) },
    });
    if (!saveLandmarks(list)) return;
    renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
  });

  // Restore persisted training mode on boot (applied after boot section below)

  // ---------- Debug ----------
  $("#debugBtn").addEventListener("click", () => openModal("debugModal"));
  $("#simNfcBtn").addEventListener("click", () => {
    handleNfcPayload({ lat: 28.54412, lng: 77.33500, floor: 1, label: "E-BLOCK L1" });
    closeModal("debugModal");
  });
  $("#simUidBtn").addEventListener("click", () => {
    const uid = $("#simUidInput").value.trim();
    if (!uid) { alert("Enter a UID to simulate."); return; }
    const match = findLandmarkByUid(uid);
    if (match) {
      closeModal("debugModal");
      promptAnchorConfirm(
        { lat: match.lat, lng: match.lng, floor: match.floor ?? 1, label: match.name },
        `Matched tag UID ${uid} → "${match.name}"`
      );
    } else {
      alert(`No landmark mapped to UID "${uid}". Add one in Admin first.`);
    }
  });
  $("#simStepBtn").addEventListener("click", () => { if (ensureIndoor()) addStep(); });
  $("#simStep10Btn").addEventListener("click", () => {
    if (!ensureIndoor()) return;
    for (let i = 0; i < 10; i++) addStep();
  });
  $("#simHeading").addEventListener("input", (e) => setHeading(parseInt(e.target.value, 10)));
  $("#simTurnLBtn").addEventListener("click", () => { setHeading(state.heading - 15); $("#simHeading").value = Math.round(state.heading); });
  $("#simTurnRBtn").addEventListener("click", () => { setHeading(state.heading + 15); $("#simHeading").value = Math.round(state.heading); });
  $("#simGpsBtn").addEventListener("click", () => {
    const lm = loadLandmarks().find(x => x.id === state.selectedLandmarkId) || loadLandmarks()[0];
    if (!lm) { alert("Add a landmark first (Admin)."); return; }
    // place user ~3m west of the gate
    const p = offsetLatLng(lm.lat, lm.lng, -3, 0);
    setUserPosition(p.lat, p.lng, { pan: true });
    state.selectedLandmarkId = lm.id;
    searchInput.value = lm.name;
    checkArrival();
    closeModal("debugModal");
  });
  $("#simResetBtn").addEventListener("click", () => {
    exitIndoorMode();
    $("#hudSteps").textContent = "0";
    state.pdrOffsetMeters = { x: 0, y: 0 };
    updateTrainingHud();
    closeModal("debugModal");
  });

  function ensureIndoor() {
    if (state.mode !== "INDOOR") {
      alert("Enter Indoor mode first: tap NFC SCAN or Debug → Simulate NFC Tap.");
      return false;
    }
    return true;
  }

  // ---------- NFC button + Resync ----------
  $("#nfcBtn").addEventListener("click", startNfcScan);
  $("#resyncBtn").addEventListener("click", () => {
    if (state.mode === "INDOOR" && state.anchor) {
      const landmark = loadLandmarks().find(lm => lm.id === state.selectedLandmarkId);
      if (!landmark || !Number.isInteger(landmark.floor)) {
        alert("Select a saved indoor landmark with a floor number before re-syncing.");
        return;
      }
      if (Number(landmark.floor) !== Number(state.anchor.floor)) {
        alert("Select a landmark on the current floor before re-syncing.");
        return;
      }
      state.anchor = {
        lat: landmark.lat,
        lng: landmark.lng,
        floor: landmark.floor,
        label: landmark.name,
      };
      state.pdrOffsetMeters = { x: 0, y: 0 };
      state.stepCount = 0;
      state.lastStepTs = 0;
      state.stepSignalAbove = false;
      $("#hudSteps").textContent = "0";
      $("#hudMode").textContent = `INDOOR • ${state.anchor.label}`;
      setUserPosition(state.anchor.lat, state.anchor.lng, { pan: true });
      updateTrainingHud();
      refreshSearch();
    } else if (state.userLatLng) {
      map.setView([state.userLatLng.lat, state.userLatLng.lng], 19);
    } else {
      alert("No position yet. Allow location or use Debug → Jump GPS.");
    }
  });

  // ---------- Boot ----------
  refreshAvailableFloors();
  renderLandmarkMarkers();
  renderFloorSwitch();
  refreshSearch();
  startGeoWatch();
  // Restore training mode persistence
  setTrainingMode(readStoredSetting(LS.training) === "1");
  setHeatmapMode(readStoredSetting(LS.heatmap) === "1");

  // Expose small debug hook
  window.PCNS = { state, loadLandmarks, saveLandmarks, handleNfcPayload, addStep, setHeading, setTrainingMode, setCurrentFloor, setHeatmapMode };
})();
