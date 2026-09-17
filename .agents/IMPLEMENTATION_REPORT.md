# Status

SUCCESS

# Implemented

- Fixed dev HTTP 500: Turso config now falls back to Vite dev env when runtime env is empty.
- Fixed Vercel HTTP 500: schema.sql bundled via `?raw` import, no runtime file read.
- Moved management to /gamemaster (page + /api/gamemaster); old /admin page and API return 404.
- Removed all public promotion of management; gamemaster page carries noindex/nofollow.
- Added dev/prod read-only smoke scripts and env regression tests; docs updated.

# Changed Files

- src/server/db.ts, src/pages/api/[...path].ts, src/pages/gamemaster.astro (renamed from admin.astro), src/pages/index.astro, src/components/Layout.astro, src/components/AdminApp.tsx, src/components/SupervisorApp.tsx, src/lib/api.ts
- tests/db-env.test.ts, scripts/smoke-dev.mjs, scripts/smoke-built-api.mjs, scripts/check-browser.mjs, README.md, AGENTS.md

# Verification

- `npx vitest run tests/db-env.test.ts` before fix — failed (4 failed, missing dev fallback); after fix `npx vitest run` — passed (34 passed).
- `node scripts/smoke-built-api.mjs --path /api/admin/state` on old build — failed (HTTP 500 ENOENT schema.sql); on fresh build `GET /api/gamemaster/state` — passed (HTTP 200), `GET /api/admin/state` — passed (HTTP 404).
- `node scripts/smoke-dev.mjs --path /api/admin/state` before fix — failed (HTTP 500); after fix `GET /api/gamemaster/state` — passed (HTTP 200, real .env.development.local, GET only).
- `npm run build` — passed; `node scripts/check-browser.mjs` — passed (26/26, incl. no-promotion, /admin 404, real QR X close).
- `git diff --check` — passed; client-bundle TURSO scan clean; /gamemaster noindex, /admin 404, public pages link-free verified via live curl.
- Self-review — passed.

# Plan Deviations

- none

# Blockers

- none
