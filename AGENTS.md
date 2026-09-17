# AGENTS

Product: German event scoring app (Kartoffelolympiade). Astro 5 + React 19,
TypeScript strict, Tailwind 4, Vitest. Central Turso persistence via
`@libsql/client`; no browser-only stores.

Workflow:

- Track work in `.agents/PLAN.md` ( checkboxes, next action explicit) and
  report in `.agents/IMPLEMENTATION_REPORT.md`.
- Comments in English, product UI in German.
- `/admin` stays public — never add authentication there.
- Never print, copy, commit or expose Turso credentials.
- Scratch/logs/browser profiles go under `artifacts/opencode/` (git-ignored);
  reusable regression scripts live in `scripts/`.
- Verify with `npm test` and `npm run build`; repair failures in the same run.

Architecture: `src/lib/` (contracts, validation, rankings), `src/server/`
(DB, repository, service, HTTP helpers), `src/pages/api/[...path].ts`
(dispatcher), React components under `src/components/`.
