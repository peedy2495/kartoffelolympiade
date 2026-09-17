# Goal

Ready: User follow-up after finished gamemaster fixes: viewport modal deletion confirmations; show last recording supervisor on each discipline; rename Kartoffelfest to Kartoffelfeuer; timer/countdown button icons; full-sized theme toggle; fix throwing count overwritten during autosave/poll; reset must clear associated stored field. Preserve completed previous fix and all user work.

# Relevant Instructions

none

# Context

Previous SUCCESS report accepted:45 tests,34 browser checks,built mutation7/7 passed. Do not redo unrelated review. Worktree has modifications .agents/PLAN.md/report, AdminApp.tsx/global.css from previous work; preserve. Some previous work committed by user meanwhile. No commit/push/deploy.
Root cause code evidence: SupervisorApp flush captures f then after awaiting PATCH sets baseSnapshot for result keys from CURRENT cur[d], and unconditionally clears all sent keys from dirty, even if edited during request. Follow-up load then overwrites newer value with old saved value. Poll also accepts older revision and races with pending writes. Reset stopwatch calls onEdit(key, snapshot[key]); countdown reset doesn't clear throwing. Blank fields skipped in flush and API only accepts numbers, so clearing cannot persist. Admin delete confirmation is inline bottom div, unlike proper QrModal portal. Layout contains Kartoffelfest metadata and theme toggle tiny glyph with no fixed size. Supervisor cards don't display attribution; admin table already does.

# Implementation

- [x] Add deterministic regression proving edits during delayed PATCH and late stale GET overwrite latest throwing value before fix. Use tracked browser request interception/delays controlling response ordering, not timing-only luck. Also regression for clear stored result; implement below.
- [x] Supervisor autosave concurrency: snapshot participant ID/editor generation, exact sent fields and per-field edit generation at request send. Update baseline to actual SENT normalized values, not current edit. Clear dirty only for fields unchanged since send (generation/value compare), retain/requeue newer edits through serialized flush. Update refs synchronously inside edit path so rapid clicks and async callbacks cannot see stale refs. Selection/generation guard means late responses/queued work for old participant never mutate new editor. Ignore late polling snapshots older than accepted participant revision; suppress editor overwrite while write pending/dirty; use request generation to reject out-of-order loads. Preserve clean remote updates and deliberate genuine conflict handling, no blind overwrite. Avoid false conflicts on own in-flight updates; base revision monotonically advances. Keep autosave500ms and polling3s. Stepper increment uses latest ref/functional update so rapid + events all counted. Throwing first + from blank yields1 (blank treated0), minus floors0. If helper extracted under src/lib for deterministic unit tests, keep focused and no generic framework.
- [x] Extend PATCH results contract src/lib/api.ts and service parsePatchResults to Partial<Record<Discipline, number|null>>. Omitted means unchanged; explicit null means remove result via DELETE in same existing revision-checked write transaction (no schema changes). Keep auth/collection/finalized/revision checks for deletes; clearing already absent should not invent attribution. Numeric0 remains valid throwing result, other bounds unchanged. On editor blank valid clear send null, distinct from invalid text. Missing result means no last-value author shown (—/Noch kein Eintrag). Finalize requires4 existing valid values; cleared discipline excludes completion. Never auto-finalize.
- [x] Reset stopwatch handler: stop/reset timer and onEdit(field,''); countdown reset handler: stop/reset to60s and onEdit('throwing',''). Persist clears using null protocol. Disable reset while collection closed. Timer internal resets for participant switch/closure MUST NOT call user field-clear handler, preserve values in those lifecycle operations. Pause/start shouldn't implicitly erase recorded hits; only explicit reset clears. Ensure pending earlier save can't restore cleared value. Update explanatory copy on throwing to distinguish countdown progression versus explicit reset.
- [x] Supervisor EditorView receive server result attribution for selected participant, show 'Zuletzt erfasst von: NAME' on EACH four discipline cards; no author yet show 'Noch kein Eintrag'. Use persisted supervisor_name snapshot, not viewer or optimistic fabricated author. Refresh after successful writes including change by other supervisor; preserve historical names for deleted supervisors. Admin already shows last author, retain.
- [x] AdminApp deletion confirmation for participants and supervisors becomes proper centered viewport Base UI Dialog portal/backdrop like QrModal. Accessible title/description, aria modal focus trap, initial focus cancel, Escape/X/cancel close, focus return where possible, scroll lock, fit small viewport, cannot double-submit pending deletion. Show deletion failure inside popup and leave open for retry; no global error hidden behind overlay. Success closes then refreshes. All confirmation requests should be popups; existing window.confirm timer abandonment is already popup, keep unless needed. Avoid unrelated modal framework.
- [x] Supervisor timer/countdown buttons prepend Heroicons outline ClockIcon for Start/Countdown starten/Erneut starten, PauseIcon for Pause, ArrowPathIcon for Zurücksetzen;20px aria-hidden, text retained. Theme button in Layout: same control height as ko-btn at least44px,width44px,min-width44px; visible appropriately-sized sun/moon inline SVG (Astro no React hydration needed), accessible label/title indicates action, update icon/label on toggle and initialization for persisted/system theme. Responsive no overflow.
- [x] Replace product-visible Kartoffelfest with Kartoffelfeuer in source/metadata/docs as relevant, not generated artifacts/node_modules/history. Preserve app name Kartoffelolympiade. README documents modal, attribution, reset clearing and robust saves briefly.

# Verification

- [x] Unit/integration: null clear removes only named discipline,0 preserved, clear respects closed/revoked/finalized/stale, clearing makes finalize incomplete; attribution other disciplines unchanged.
- [x] Browser tests extend existing script using own isolated DB: delayed PATCH1 while extra + edits made => latest total survives both saves+poll and visible another supervisor; late pre-save GET doesn't roll back newer value; reset while PATCH pending stays blank after save/poll and second context; both stopwatch fields/countdown reset clear stored values, reset countdown60s; rapid+from blank starts1. Test real app behavior with interception, no fake test-only app logic. Existing expectations for reset/initial+ must change intentionally.
- [x] Browser confirms participant & supervisor delete modals visible centered without scrolling on long page/mobile, Escape/cancel preserves rows, confirm performs removal, pending double click guarded; per-card attribution identifies distinct supervisors correctly after actual writes; icons present, theme target>=44x44 and toggle works, no Kartoffelfest in page. Preserve prior tests for origin+refresh tooltip/error persistence. Screenshots for mobile modal if useful.
- [x] npm test;npm run build;node scripts/check-browser.mjs;node scripts/smoke-built-mutations.mjs;git diff --check. Ordinary failures fixed within same run. No real DB mutations, tests only artifacts/test. No credential reads/logs beyond normal server env; no external temp paths, no /tmp, no permission changes.
- [x] Self-review only changed scope, then exact six-section report .agents/IMPLEMENTATION_REPORT.md. Status SUCCESS only all requested checks complete, Plan Deviations and Blockers exactly '- none' when none. Update plan checkboxes as completed, no stale report.

# Acceptance Criteria

- [x] Latest clicks and reset intent survive async autosave/poll ordering and participant switches.
- [x] Reset visibly and persistently clears only related value; completion/attribution correct.
- [x] Popups/author labels/Kartoffelfeuer/icons/theme sizing match request.
- [x] Tests/build/browser/bundled mutations passed and user work preserved.

# Progress

Completed. All implementation, verification and acceptance items done: 48 unit/integration tests, 55 browser checks, 7 built-mutation smokes, build and diff-check green. Report in .agents/IMPLEMENTATION_REPORT.md.

# Out of Scope

No deployment/push/commit, no live data mutation, no new auth/routes/stack, no broad refactor, no external messages or recursive delegation.
