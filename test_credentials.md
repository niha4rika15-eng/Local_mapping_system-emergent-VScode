# PCNS Test Credentials

## Admin Dashboard
- **Default factory password**: `amity2026` (only used when no hash is set in localStorage)
- **After password change**: stored as SHA-256 hex hash under `localStorage.pcns.adminPassHash` (the legacy plain-text key `pcns.adminPass` is cleared on update)
- Reset to factory: clear `pcns.adminPassHash` from devtools

Location: Click the ⚙ cog icon (top-right of search bar) → enter password.

## Notes
- No user accounts — client-side only
- All data (landmarks, training mode, heatmap mode, password hash) stored in browser localStorage
- Backend exposes only `/api/health` (no auth required)
