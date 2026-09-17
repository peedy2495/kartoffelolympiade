# Kartoffelolympiade

German responsive event scoring app for the Kartoffelfeuer: four disciplines
(Kartoffel-Golf, Hindernisparcours, 7-m-Werfen, Kartoffelschälen), two age
groups (bis 14 / über 14), central Turso persistence.

- Supervisors (`/aufsicht/TOKEN`) share draft participants, autosave results
  with revision locking, and finalize complete entries.
- `/gamemaster` is intentionally public (no login): collection start/stop,
  participant table, statistics, supervisor QR invitations, live leaders.
  Public pages link nowhere near management; the page asks search engines
  not to index it.
- Rankings per age group use competition ranks (1, 1, 3); overall score is
  the sum of the four discipline ranks — lower is better.

## Setup

Requirements: Node 22.

```sh
npm install
cp .env.example .env.development.local  # fill in real Turso values
npm run db:migrate
npm run dev  # loads .env.development.local automatically
```

Environment (dev file and Vercel env alike):

- `TURSO_DATABASE_URL` — e.g. `libsql://…turso.io` (or `file:…` for local tooling)
- `TURSO_AUTH_TOKEN` — token for remote databases

Never commit real credentials. `.env.development.local` is git-ignored.

## Scripts

- `npm run dev` — local dev server
- `npm run build` — `astro check` + production build
- `npm test` — Vitest (unit + file-DB integration, never touches live Turso)
- `npm run test:browser` — Puppeteer end-to-end against a local file DB
- `node scripts/smoke-dev.mjs` — read-only dev smoke: ordinary `astro dev`
  with inherited `TURSO_*` unset (uses `.env.development.local`), GETs
  `/api/gamemaster/state` only
- `node scripts/smoke-built-api.mjs` — read-only production smoke against the
  real Vercel build output with an isolated file DB (GET state only)
- `npm run db:migrate` — idempotent `ko_` schema setup (no test rows)

## Deploy (GitHub → Vercel)

1. Push to GitHub, import the repo in Vercel (Astro preset).
2. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Vercel environment variables
   (runtime; nothing Turso-related is baked into the build).
3. Deploy; the schema initializes lazily on first API request
   (`npm run db:migrate` also works against the live DB for a connectivity check).

### Domains (trusted hosts)

The API accepts same-origin mutations only. Astro keeps the public request
origin only for exact hosts listed in `security.allowedDomains`
(`src/server/allowed-domains.ts`, wired in `astro.config.mjs`):

- `https://kartoffelolympiade.vercel.app` (default production host)
- the current deployment hosts from the `VERCEL_URL`, `VERCEL_BRANCH_URL`
  and `VERCEL_PROJECT_PRODUCTION_URL` build variables (exact match, https)
- an optional custom domain via the `APP_ORIGIN` build variable as an
  explicit absolute `http(s)` origin
  (e.g. `APP_ORIGIN=https://spiele.example.de`; hostnames without scheme,
  paths, query strings, credentials and wildcards are ignored)
- local development: `http://localhost`, `http://127.0.0.1`, `http://[::1]`
  on any port

Cross-origin requests are still rejected with `403`. Wildcard domains are
never configured.

### Reload button (`/gamemaster`)

The “Daten neu laden” icon button (with hover/keyboard tooltip) fetches the
latest central data and shows a spinner while loading; automatic refresh
every 3 s is unchanged. Reloading only re-reads data — it changes nothing,
resets nothing, and never hides a mutation error. Failed actions keep their
error message until dismissed or retried.

### Deletion confirmations, attribution, reset clearing, robust saves

- Deleting a participant or supervisor asks in a centered viewport modal
  (portal + backdrop, Escape/cancel/X closes, focus returns); failures stay
  inside the modal for retry, success closes and refreshes.
- Every discipline card in the supervisor editor shows
  “Zuletzt erfasst von: NAME” from the persisted result attribution
  (“Noch kein Eintrag” when empty); the gamemaster table keeps its author
  labels, including names of removed supervisors.
- “Zurücksetzen” on a stopwatch or the throwing countdown explicitly clears
  the associated stored value (blank autosaves as a deletion); starting,
  pausing, switching participants, or the countdown ticking never clears.
- Autosave (500 ms) and polling (3 s) are ordering-safe: edits made during a
  delayed save survive both saves and later polls, stale responses are
  ignored, and only fields unchanged since sending leave the dirty set.

## Rules & workflow

- Server is authoritative: revision-checked drafts, collection gate and token
  checks run inside write transactions; supervisors only see shared drafts.
- Times are entered in German format (`12,3`), stored as tenths of a second.
- See `AGENTS.md` for the contributor workflow.
