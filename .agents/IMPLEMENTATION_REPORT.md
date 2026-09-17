# Status

SUCCESS

# Implemented

- Autosave/poll ordering-safe: sent-value baselines, per-field generations, stale-revision guards, no false conflicts; explicit reset clears stored values via null protocol.
- Server PATCH accepts explicit null as DELETE in the revision-checked transaction; per-card "Zuletzt erfasst von / Noch kein Eintrag" attribution.
- Admin deletions via centered Base UI viewport modal with in-popup retry and single-DELETE guard; 44px theme toggle with sun/moon; timer icons; Kartoffelfeuer naming.
- Regression coverage: 3 null-clear integration tests; 23 new deterministic interception-based browser checks (55 total).
- README documents modal, attribution, reset clearing, robust saves.

# Changed Files

- src/components/SupervisorApp.tsx, src/components/AdminApp.tsx, src/components/Layout.astro, src/styles/global.css, src/lib/api.ts, src/server/service.ts, tests/integration.test.ts, scripts/check-browser.mjs, README.md

# Verification

- `npm test` — passed (48/48, incl. 3 new null-clear tests).
- `npm run build` — passed.
- `node scripts/check-browser.mjs` — passed (55/55).
- `node scripts/smoke-built-mutations.mjs` — passed (7/7).
- `git diff --check` — passed.
- Self-review — passed (scope-only diff, prior tooltip user work preserved).

# Plan Deviations

- none

# Blockers

- none
