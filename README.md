# Precision Campus Navigation System (PCNS)

PCNS is a mobile-responsive, browser-based campus navigation prototype. It combines outdoor geolocation with an NFC anchor handoff to indoor pedestrian dead reckoning (PDR), a Leaflet map, editable local landmarks, and a GeoJSON floor-plan overlay.

## Implemented

- Outdoor GPS position and searchable landmark distances.
- Google Maps directions links for saved destinations.
- NFC anchor lookup by saved tag UID, with JSON-payload fallback and confirmation.
- Indoor step/heading estimates, manual re-sync at a selected floor-tagged landmark, and optional hallway snapping.
- Floor-aware landmarks and floor plans, plus training-marker capture.
- Browser-local landmark/settings storage and CSV export of training markers.
- Debug controls to simulate NFC, steps, heading, and GPS for desktop testing.

## Run the frontend

Requirements: Node.js and npm.

```powershell
cd frontend
npm install
npm start
```

Open `http://localhost:3000`. Leaflet and OpenStreetMap tiles are loaded from the internet. Real NFC, GPS, and motion sensors require browser/device support and permissions, and generally require a secure context (HTTPS or localhost). Use the Debug controls to verify flows on desktop.

## Optional health-check backend

The frontend is client-side and does not depend on the FastAPI service. The backend only exposes `/api/health` and `/api/`.

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8001
```

## Data and configuration

- Landmarks, training markers, settings, and the admin password hash are stored in the current browser's `localStorage`. They are not shared across users/devices and are not backed up by the backend.
- The Admin panel's initial password is `amity2026`; change it for the browser profile you use. This client-side password is not suitable for protecting sensitive data.
- Add campus destinations, floor numbers, and NFC UIDs in the Admin panel. Select a saved landmark on the current floor before using **I am here** to re-sync. Replace `frontend/public/demo-floor.geojson` with verified floor-plan geometry and ensure each feature's `floor` matches the app's floor numbering (`0` is Ground).
- The included E-Block floor plan is demonstration geometry, not a surveyed building map.
- The app uses a fixed 0.7 m stride estimate. It is not a learned/calibrated positioning model and does not provide indoor route finding or turn-by-turn guidance.
- The browser-side admin password is a convenience gate for local editing, not a security boundary for sensitive data.

## Project layout

- `frontend/public/index.html` — application shell
- `frontend/public/pcns.css` — responsive styles
- `frontend/public/pcns.js` — map, GPS, NFC, PDR, storage, and admin logic
- `frontend/public/demo-floor.geojson` — sample floor geometry
- `backend/server.py` — optional health-check API
