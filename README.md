# Kartoffelolympiade

German responsive event scoring app for a potato festival: four disciplines
(Kartoffel-Golf, Hindernisparcours, 7-m-Werfen, Kartoffelschälen), two age
groups (bis 14 / über 14), central Turso persistence.

- Supervisors (`/aufsicht/TOKEN`) share draft participants, autosave results
  with revision locking, and finalize complete entries.
- `/admin` is intentionally public (no login): collection start/stop,
  participant table, statistics, supervisor QR invitations, live leaders.
- Rankings per age group use competition ranks (1, 1, 3); overall score is
  the sum of the four discipline ranks — lower is better.

## Setup

Requirements: Node 22.

```sh
npm install
cp .env.example .env.development.local  # fill in real Turso values
npm run db:migrate
npm run dev
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
- `npm run db:migrate` — idempotent `ko_` schema setup (no test rows)

## Deploy (GitHub → Vercel)

1. Push to GitHub, import the repo in Vercel (Astro preset).
2. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Vercel environment variables.
3. Deploy; the schema initializes lazily on first API request
   (`npm run db:migrate` also works against the live DB for a connectivity check).

## Rules & workflow

- Server is authoritative: revision-checked drafts, collection gate and token
  checks run inside write transactions; supervisors only see shared drafts.
- Times are entered in German format (`12,3`), stored as tenths of a second.
- See `AGENTS.md` for the contributor workflow.
