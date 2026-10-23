# PCNS — Precision Campus Navigation System (Amity University)

## Original problem statement
Build a mobile-responsive hybrid navigation web app for Amity University that transitions from outdoor GPS to indoor Pedestrian Dead Reckoning (PDR) via an NFC "Punch-In" handover. Pure vanilla JS + Leaflet + OSM. LocalStorage only (no DB).

## Architecture
- **Frontend**: Vanilla JS (ES6+), HTML5, CSS3 served by `http-server` on :3000
- **Map**: Leaflet.js 1.9.4 + OpenStreetMap tiles (dark CSS filter)
- **Browser APIs**: Geolocation, Web NDEFReader (NFC), DeviceMotionEvent, DeviceOrientationEvent
- **Storage**: browser localStorage (`pcns.landmarks`, `pcns.adminPassHash` with legacy `pcns.adminPass`, `pcns.training`, `pcns.heatmap`); floor choices derive from saved landmarks
- **Backend**: Minimal FastAPI on :8001 with `/api/health` only (frontend is fully client-side)

## File map
- `/app/frontend/public/index.html` — single-page shell (HUD, search, buttons, modals)
- `/app/frontend/public/pcns.css` — dark / plum (#9B30FF) / neon white theme
- `/app/frontend/public/pcns.js` — all logic (outdoor GPS, NFC, PDR, snapping, admin, debug)
- `/app/frontend/public/demo-floor.geojson` — sample E-Block walls + hallways
- `/app/backend/server.py` — health endpoint

## Core features implemented (Jan 2026)
- Outdoor: live Geolocation `watchPosition`, arrival detection within 5 m
- NFC: `NDEFReader` listener parsing `{lat,lng,floor,label}` JSON payload → resets marker
- Indoor PDR: accelerometer step detection based on dynamic acceleration (1.2 m/s² threshold with release hysteresis and a 280 ms minimum interval), orientation heading; with 0° = North, east = `step·sin(θ)` and north = `step·cos(θ)`
- Path snapping: nearest hallway-segment projection within 15 m, measured in local meters and restricted to the active floor
- Manual re-sync "I am here" button uses a selected saved landmark on the active floor
- Admin panel (password-protected, default `amity2026`): add landmarks via Google Maps URL or raw lat,lng, assign an optional floor, map NFC UIDs, delete; persisted in localStorage
- Search results include Google Maps directions links for outdoor navigation
- Debug menu: simulate NFC tap, simulate NFC tap by UID, +1/+10 steps, heading slider & ±15° turn buttons, jump GPS near selected landmark, reset to outdoor
- HUD: MODE / STEPS / HEADING cards

## Feature additions (Jan 2026, iteration 2)
### NFC UID Mapping
- Admin form: **NFC UID** text field + **Scan tag** button (uses `NDEFReader` serialNumber)
- On real NFC read, UID match is checked **first** (localStorage lookup, UID normalized — strips `:` and spaces, uppercases); if matched → confirm dialog → anchor to stored landmark lat/lng
- Falls back to JSON payload parsing when UID is unknown (backward compatible)
- Duplicate UID prevention on landmark add
- Landmark list + map popup show **UID** badge when set

### Training Mode (Indoor Mapping)
- Toggle switch in Admin Panel (plum styled, 22px sliding thumb)
- **Persisted** in localStorage (key `pcns.training`) so it survives reloads
- When ON:
  - Pulsing top banner "⚠ TRAINING MODE ACTIVE" (plum glow, impossible to miss)
  - Floating **X/Y HUD card** (plum-bordered) showing live PDR offset in meters
  - **Drop Marker** floating button (only appears when also in INDOOR mode)
- Drop Marker prompts for name → saves landmark with `source:"training"`, `anchor:<label>`, `offset:{x,y}`, computed `lat/lng` from anchor + PDR offset
- Training-sourced landmarks render with neon-white fill on the map and show a "TRAINING" badge in the admin list

### Confirm-before-anchor
- All NFC taps (real or simulated) now prompt a native `confirm()` dialog summarizing the target landmark before switching to Indoor mode — prevents accidental re-anchors

### Floor Awareness (Jan 2026, iteration 3)
- Landmark schema extended with optional `floor` property (integer, 0 = Ground)
- **Drop Marker HUD** now includes a **Floor Number** input (auto-filled from current anchor's floor; editable before dropping)
- Dropped markers save `{lat, lng, floor, x, y, source, ...}` as one unified data point
- **Floor Switcher** — right-side vertical elevator-style button group (G / 1 / 2 / 3 / ALL) in plum purple with neon active state
  - Clicking a floor filters on-map landmarks + GeoJSON floor-plan features to that floor only
  - Landmarks without a floor property (e.g., outdoor gates) always show — treated as "global"
  - `availableFloors` is rebuilt from saved landmark floors on launch and when landmarks change
  - Search results also filtered by current floor selection
- Anchor tap via NFC/UID now auto-switches the elevator to that anchor's floor

### Current implementation (Jan 2026, iteration 4)
- **Floor Heatmap toggle** in admin: dims off-floor markers + GeoJSON to 20% opacity instead of hiding them — useful for verifying vertical alignment of stairwell anchors during training. Persisted in `localStorage.pcns.heatmap`.
- **Export to CSV** button in admin: downloads all training markers (`name, lat, lng, floor, anchor, x, y`) as `pcns-training-<timestamp>.csv` for research documentation.
- **Change Admin Password**: SHA-256 hashed (via `crypto.subtle.digest`) stored in `localStorage.pcns.adminPassHash`. Old plain-text key cleared on update. Login transparently uses hash if present, falls back to factory default `amity2026` only when no hash exists.
- **Reliability corrections**: saved landmark records and NFC anchors are range/type checked; browser storage failures are reported; direct coordinate entry enforces geographic bounds; indoor entry stops the outdoor GPS watch; repeated sensor/NFC scans are cleaned up; and hallway snapping uses local meter coordinates and the active floor.
- The available floor list is derived from saved landmarks plus the default floors, rather than stored in a separate localStorage key.

## Current implementation limits

- Step length remains fixed at 0.7 m; there is no calibration or learned positioning model.
- Hallway snapping corrects estimated position only; it is not route finding and does not produce turn-by-turn instructions.
- Accurate operation requires verified campus landmark coordinates, NFC tags, and surveyed floor-plan geometry. The bundled floor plan is demonstration data.
- Leaflet, map tiles, GPS, and NFC require network/device/browser support; there is no offline PWA cache.
- Local browser storage is device- and origin-scoped and is not synchronized or backed up.

## Backlog / P1
- Add real Amity Noida campus landmarks pre-seed set (user chose empty start)
- Step-length calibration screen (currently fixed 0.7 m)
- Export/import landmark JSON
- PWA offline support

## P2
- Indoor route finding and turn-by-turn routing overlay
- Route recording for crowd-sourced hallway graph
