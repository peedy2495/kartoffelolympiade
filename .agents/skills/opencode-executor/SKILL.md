---
name: opencode-executor
description: Delegate implementation or authorized Git delivery to OpenCode/Muse from a focused .agents/PLAN.md and consume its compact report. Maintain the executor workflow directly.
---

# OpenCode executor

Use delegated execution for substantial implementation and Git delivery. Prefer direct Codex implementation for trivial/local edits where delegation would add more context than value. For Git delivery, load `.agents/skills/git/SKILL.md` and state the exact user-authorized actions in the plan; the same executor performs them after verification. A delivery-only follow-up reuses existing verification evidence.

The default workflow is exactly three phases: one focused Codex handoff, one autonomous Muse execution, one report-only Codex closeout. Add another reasoning/execution loop only for a concrete unresolved blocker, failed requested verification, or material plan deviation.

## Before execution

- Resolve only material uncertainty needed for a safe handoff. Do not explore unrelated repository areas.
- Inspect relevant implementation, current diffs/user work, and only the task skills selected by `.agents/AGENTS.md` routing.
- Preserve user edits; never stash, reset or clean them automatically.
- Write `.agents/PLAN.md` using `references/plan-template.md`.
- Default to a focused plan. Add optional architecture detail only when interfaces, persistence semantics, multiple subsystems, concurrency/security boundaries, or migration behavior require it.
- In the plan, list the exact task skills/references Muse may read. Do not pass global agent files merely as background context.
- Put all ordinary verification and repair expectations in the initial plan, including tracked scripts/tests for meaningful browser regressions rather than temporary-only probes. Do not reserve a routine second pass for Codex.
- Never execute a stale/completed plan. Root `PLAN.md` is not executor input.
- Use checkboxes for implementation and verification steps. Muse updates `.agents/PLAN.md` immediately after each completed step/check, with a short result and any remaining blocker; never wait until the final report. Before a long check or context exhaustion, record the current next action. On continuation, resume unchecked work using this evidence instead of repeating completed work. Mark overall Completed only after all required work and checks succeed.

## Execute

Run `bash .agents/skills/opencode-executor/scripts/execute-plan.sh` from the repository root (or use its absolute path). Default effort is medium. `--effort minimal|low|medium|high|xhigh` overrides require justification in the plan; xhigh also requires explicit user authorization and `--allow-xhigh`.

Muse owns implementation, ordinary failure repair, requested verification and self-review of its actual changes against the plan **within the same executor run**. A failed compile/type/test caused by the task is not a reason to stop and hand routine repair back to Codex. Do not run a second executor against the same worktree merely for review or ordinary cleanup.

The delegated process should be quiet: no narrated progress, running commentary, repeated summaries, or explanations of tool calls. It should use tools, repair ordinary failures, write the compact implementation report, and finish with only report status/path. User-visible progress belongs to Codex only when genuinely useful.

The executor builds one deterministic handoff prompt in this order: stable executor contract, stable report format, task skills/references sorted by path, then the changing `.agents/PLAN.md`. This keeps reusable context before task-local context and avoids model-side file-reading turns. Project `AGENTS.md` auto-discovery is disabled for the delegated OpenCode process because Codex has already routed the applicable instructions. Global OpenCode instructions may still apply.

Write the report to `.agents/IMPLEMENTATION_REPORT.md`, not merely to the final response. The runner captures structured CLI events and may recover one complete report from the last assistant text event only if the file is missing, empty or still the untouched invocation placeholder. It never replaces a written report, retries the model, or treats CLI failure as success; recovered reports pass the same validation and deviation/blocker checks.

The script pins the configured model/build and does not auto-approve permissions, retry or switch models. Muse may perform Git actions only within the authorization recorded in the plan and routed Git skill. Tool/model/permission failure is a blocker, not permission to use a fallback.

## Temporary files

Use repository-local `artifacts/opencode/` for scratch scripts, logs, browser profiles and message files. The runner sets `TMPDIR` to `artifacts/opencode/tmp` under the repository, even when the inherited value points elsewhere. Never hard-code `/tmp` or copy/read external temporary scripts in delegated commands: OpenCode may reject external-directory access. Create scripts directly in the project; keep reusable regression scripts under `scripts/`. Do not add scratch files to Git. A rejected external path is resolved by moving the needed artifact into the workspace, not by changing permissions or retrying the same command.

## After execution

Read only `.agents/IMPLEMENTATION_REPORT.md` and the executor outcome first. Treat that report as the closeout interface, not as an invitation to reopen the implementation.

- `SUCCESS` with no deviations/blockers and executor success: report completion immediately. **Do not** reread the full diff, reopen changed source files, rerun checks, inspect test logs, or perform a second code review unless the user explicitly asks or a concrete high-risk condition in the plan requires it.
- `PARTIAL`: inspect only the named unresolved item. Prefer one targeted revised plan/delegation when implementation work remains; direct Codex correction is for genuinely tiny fixes where another handoff would cost more context than the fix itself.
- `BLOCKED`: resolve only the named missing decision/blocker before another delegation. Do not retry an identical blocker or escalate effort automatically.
- Missing/invalid report, nonzero CLI exit, or `SUCCESS` containing deviations/blockers: investigate only the reported/invocation gap. Do not perform an automatic whole-repository review.
- Do not ask Muse for an additional summary after the report; the report is the summary.
- A broader review is appropriate only when the user requests it or a specific risk warrants it.

## Workflow maintenance

Maintain/test this workflow directly with Codex rather than through a feature delegation. `scripts/test-executor.sh` uses an isolated project-local Git fixture and fake CLI, without external temporary paths. `execute-plan.sh --check` validates local prerequisites without a model call or report mutation.
