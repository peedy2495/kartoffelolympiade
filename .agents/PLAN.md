# Goal

Ready: Restore gamemaster POST actions in deployed SSR, clarify refresh icon with tooltip, keep mutation errors visible. No gameplay/data/auth changes. Implement and verify through existing workflow.

# Relevant Instructions

none

# Context

- User reports cannot add supervisor or start collection, asks reload tooltip. Environment clarification pending but concrete production bug reproduced. Local POST with same origin + invalid payload returns correct400, Turso UPDATE and INSERT succeed in rolled-back diagnostic write transaction (no persistent change).
- Root cause reproduced using INSTALLED Astro NodeApp.createRequest: socket=new EventEmitter, method POST, url /api/gamemaster/collection, headers host and x-forwarded-host kartoffelolympiade.vercel.app, x-forwarded-proto https, origin https://kartoffelolympiade.vercel.app, skipBody true. Default allowedDomains [] produces request.url origin https://localhost. src/pages/api/[...path].ts compares Origin against URL origin and returns403. astro.config.mjs lacks security.allowedDomains.
- node_modules/astro/dist/core/app/node.js and validate-headers.js confirm both host and forwarded host discarded unless allowedDomains matches. Official config reference https://docs.astro.build/en/reference/configuration-reference/#securityalloweddomains documents allowedDomains. Keep same-origin protection, fix config source; NEVER accept arbitrary Origin or disable checkOrigin.
- AdminApp load unconditionally setError(null) on successful background poll; hides mutation failures in <=3s, load callback closes over initial state. Refresh aria-label exists but no visible tooltip.
- Worktree initially clean. Existing .env.development.local secret; never print/copy/bundle/commit it. No live data mutations in verification. Diagnostic dev server port4331 may run, own different port for tests.

# Implementation

- [ ] Add regression before fix reproducing actual NodeApp request URL normalization through current astro config allowedDomains, then route mutation behavior against isolated file DB. Don't test only handcrafted Request URL; this missed issue before. Prove fails403 before fix. Test both collection start/stop and supervisor creation with browser Origin header.
- [ ] astro.config.mjs and optional small config helper: set security.allowedDomains with exact host/protocol patterns: default https kartoffelolympiade.vercel.app; current Vercel deployment hosts from VERCEL_URL, VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL build env; optional APP_ORIGIN explicit absolute http(s) URL for custom domain documented in .env.example and README (no credentials/query/path/wildcard accepted). Local patterns http localhost and 127.0.0.1 and ::1 if supported by parser, unrestricted local port to match dev tests. Deduplicate, no blanket *.vercel.app or [{}]. Test exact Vercel env host parsing, malicious malformed values rejected, and foreign Origin still403. Do not trust forwarded headers ad hoc in dispatcher; let Astro handle validated config. Read actual config in test to catch missing wiring. Keep production runtime Turso env behavior untouched.
- [ ] src/components/AdminApp.tsx: separate load-error/stale state from actionError. Background GET must never clear actionError and must mark existing state stale on failure using ref or stable load function without stale initial closure. Action errors role alert persist until explicit dismiss or same action retry/success. Preserve entered supervisor name on failure. Reuse concise accessible error text. Add refresh title='Daten neu laden', aria-label same, and hover/focus tooltip (simple CSS + role tooltip/aria-describedby or existing Base UI if easy; no new dependency). Explain only fetches latest central data, not reset. Add visible loading feedback/spinning while manual refresh and disable duplicate manual refresh requests; automatic3s polling unchanged, no unnecessary full-page reload. No broad admin refactor.
- [ ] README document exact production/custom-domain configuration and reload behavior. Keep /gamemaster unlinked on public pages. No unrelated vercel.json/stack/auth changes.

# Verification

- [ ] Meaningful regression tests: NodeApp normalization with current config, allowed public host survives, mutation endpoints200/201 using real dispatcher isolated DB, foreign Origin403, unknown forwarded host not trusted. Config/env exact matches. Red before green evidence.
- [ ] Extend scripts/smoke-built-api.mjs or add scripts/smoke-built-mutations.mjs to exercise built artifact through NodeApp normalization using actual built manifest allowedDomains (not source-only config or duplicate hardcoded allowlist) plus Origin and JSON payload; isolated file DB below artifacts/test. Start and stop collection, create supervisor, confirm persisted state. No tokens/names logged. Both public production and simulated known preview host patterns verified in unit tests; default production host in bundled smoke. Ensure cleanup closes DB/remove only own files.
- [ ] Extend browser regression to assert tooltip accessible on hover/focus and refresh fetches state; intercept one POST failure each for supervisor create and collection toggle, verify error persists after successful auto poll, input preserved and retry succeeds. Existing 26 checks still pass. Verify root has no admin link.
- [ ] npm test; npm run build; built mutation smoke; node scripts/check-browser.mjs; git diff --check; self-review actual scoped changes and no secret leakage. Keep logs/scratch under artifacts/opencode, never /tmp. No calls mutating live Turso or deployed app. No commits/push/deploy.
- [ ] Update plan progress promptly. Write six-section .agents/IMPLEMENTATION_REPORT.md with exact '- none' for no deviations/blockers, status truthfully. Report checks separately and don't claim live deployment tested.

# Acceptance Criteria

- [ ] Legitimate gamemaster actions work through Vercel-style request handling; cross-origin remains rejected.
- [ ] Refresh has clear hover/keyboard tooltip and feedback; action errors survive polling.
- [ ] Tests/build/browser and built API mutation smoke pass; no persistent live data changes.

# Progress

Ready. Next reproduce regression test with existing config then fix narrowly.

# Out of Scope

No auth, routing changes, unrelated refactors, dependency upgrades, deployment/git delivery, real data mutation, external messages, recursive delegation, permissions changes, /tmp usage.
