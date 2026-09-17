# Goal

Ready: Fix game master HTTP 500 locally and in Vercel build; move management to /gamemaster, remove all public-page promotion. Preserve data and all existing gameplay behavior. User explicitly replaces old /admin requirement.

# Relevant Instructions

none

# Context

- Clean git worktree at start. Current Astro5 React19 Turso app. All previous changes committed by user; preserve them.
- Root cause 1 reproduced by Codex: npm run dev -- --host 127.0.0.1 --port 4331 then GET /api/admin/state => HTTP500; server logs Missing Turso configuration. src/server/db.ts getClient reads only process.env. Astro/Vite .env.development.local lives in import.meta.env instead. File exists with both secrets, never print them.
- Root cause 2 reproduced on existing built artifact: setting isolated process.env.TURSO_DATABASE_URL then invoking page().ALL from .vercel/output/functions/_render.func/dist/server/pages/api/_---path_.astro.mjs returns HTTP500 ENOENT .../pages/api/schema.sql. db.ts reads file relative to import.meta.url, transformed bundle relocates module and schema not included.
- Layout.astro currently advertises /admin in header and footer; index.astro advertises it in prose/button. User wants no promotion, management /gamemaster without credentials still. Move API namespace too so old /api/admin does not remain active. No aliases or redirects from old paths.
- scripts/check-browser.mjs tests only dev with process.env file DB, missing both real failure modes. Existing Vitest tests mock explicit DB too.
- Use project-local scratch artifacts/opencode and isolated DB artifacts/test only, NEVER /tmp paths or external scratch. No permission changes, no delegation, no commit/push/deploy.

# Implementation

- [x] First add meaningful failing regression tests/scripts for both demonstrated bugs before fixes. Startup test must exercise real Astro dev env loading with .env.development.local and unset inherited TURSO variables, without printing credentials and without modifying real DB data (GET state only). Keep a tracked read-only smoke command; can use optional live mode for actual local credentials. Prefer fixture isolated Astro project/env or Vite loadEnv regression for automated default test, plus actual app read-only smoke for verification. Production regression must invoke built API with isolated file DB and runtime process.env, proving schema packaging. Must run against actual build artifact not source import; no whole-bundle brittle text match as substitute.
- [x] src/server/db.ts: replace runtime file read with import schema from './schema.sql?raw' so SQL bundled server-side. Keep scripts/migrate.mjs source read (works unbundled). Resolve config process.env first; dev-only fallback via import.meta.env.DEV ? import.meta.env.TURSO_DATABASE_URL/auth : undefined. Production must use runtime env, no Turso secret build-time injection/client leakage. Keep server-only module and no schema/data changes. Preserve local file DB override behavior. Add needed env types if required. Test precedence and dev fallback, production API smoke.
- [x] Rename src/pages/admin.astro -> gamemaster.astro; rename /api/admin namespace to /api/gamemaster in dispatcher, src/lib/api.ts, browser tests and docs. Old /admin page and /api/admin/state GET must return 404; don't redirect or initialize database for known removed route. Keep internal adminApi/admin service names if convenient. User-facing title Spielleitung rather than Admin-Bereich. No auth added.
- [x] Layout.astro: remove management nav link entirely and remove public footer path/access disclosure, retaining neutral footer/theme/brand. index.astro: only invite/QR guidance, remove admin-section references, winner-page promotion, management link; no /gamemaster URLs or management component import in public homepage or supervisor page. Add noindex/nofollow metadata for gamemaster via optional Layout prop, not as substitute for auth. Don't create robots path advertisement.
- [x] README: new path, ordinary npm run dev loads .env.development.local, Vercel runtime variables, smoke test commands. AGENTS.md replace obsolete /admin instruction with /gamemaster public without login, no public UI links. No other workflow changes.

# Verification

- [x] Record failing dev and bundled-production regression before fix then passing after.
- [x] npm test and npm run build pass; node scripts/check-browser.mjs passes after route adaptation plus assertions homepage has no management link/path/promotion, supervisor has no management nav, /gamemaster usable and /admin 404. Strengthen existing QR X assertion to remove unconditional `|| true` because affected navigation test must be real.
- [x] Production smoke using freshly generated Vercel output and isolated local DB passes GET /api/gamemaster/state HTTP200 and /api/admin/state404. Ensure no real DB writes or schema changes during smoke. Return only statuses/counts in logs, not tokens/participant names.
- [x] Actual ordinary npm run dev on available port with inherited TURSO vars unset uses existing .env.development.local and GET /api/gamemaster/state returns HTTP200; print only HTTP/status summary. Do not create/edit/delete real participants/supervisors/settings. No need rerun live migration.
- [x] Check git diff --check and secret safety (no secret values printed or bundled client-side). Self-review only changes for this task. Write exact six-section report, Plan Deviations and Blockers exactly '- none' if none, with no parenthetical additions (runner parser requires exact string). Mark plan Completed only after all checks.

# Acceptance Criteria

- [x] Game master loads with normal local startup and built runtime, regression tested.
- [x] /gamemaster replaces /admin, API namespace likewise, no public promotion.
- [x] No changes to data or authentication semantics beyond path; existing gameplay passes.
- [x] .agents/IMPLEMENTATION_REPORT.md truthful checks and remaining limitations.

# Progress

Completed. All implementation and verification steps passed; see .agents/IMPLEMENTATION_REPORT.md.

# Out of Scope

No broad refactor, no login, no live data mutation, no model fallback, no commit/push/deploy, no changes to sibling projects. Codex diagnostic server on port4331 may be running; use owned different port and stop only own processes.
