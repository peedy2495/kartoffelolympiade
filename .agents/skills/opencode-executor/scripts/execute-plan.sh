#!/usr/bin/env bash
set -euo pipefail

# Verified with OpenCode 1.18.30; never replace this with a runtime fallback.
readonly model='opencode/muse-spark-1.3-contributor-free'
readonly plan='.agents/PLAN.md'
readonly report='.agents/IMPLEMENTATION_REPORT.md'
readonly implementation_rules='.agents/skills/opencode-executor/references/implementation-rules.md'
readonly report_template='.agents/skills/opencode-executor/references/implementation-report-template.md'
effort='medium'
check_only=false
allow_xhigh=false

fail() { printf 'Executor: %s\n' "$2" >&2; exit "$1"; }
usage() {
  printf '%s\n' 'Usage: execute-plan.sh [--check] [--effort minimal|low|medium|high|xhigh] [--allow-xhigh]' \
    'Runs the detailed .agents/PLAN.md with the fixed Muse Contributor model.' \
    '--check validates local prerequisites only; no model call or report write.' \
    '--allow-xhigh requires an explicit user request recorded in .agents/PLAN.md.'
}
while (($#)); do
  case "$1" in
    --check) check_only=true; shift ;;
    --effort) (($# >= 2)) || fail 64 '--effort requires a value'; effort="$2"; shift 2 ;;
    --allow-xhigh) allow_xhigh=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail 64 "Unknown argument: $1" ;;
  esac
done
case "$effort" in minimal|low|medium|high|xhigh) ;; *) fail 64 "Unsupported effort: $effort" ;; esac
if [[ "$effort" == xhigh && "$allow_xhigh" != true ]]; then
  fail 64 'xhigh requires an explicit user request and --allow-xhigh'
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../../../.." && pwd -P)"
cd -- "$repo_root"
command -v git >/dev/null 2>&1 || fail 69 'git is not available on PATH'
git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail 66 'Executor is not inside a Git repository'
[[ "$(cd -- "$git_root" && pwd -P)" == "$repo_root" ]] || fail 66 'Script layout does not resolve to the repository root'
for required in "$plan" "$report_template" "$implementation_rules"; do
  [[ -f "$required" && -r "$required" && -s "$required" ]] || fail 66 "Missing, empty or unreadable $repo_root/$required"
done
command -v opencode >/dev/null 2>&1 || fail 69 'opencode is not available on PATH; no implementation fallback will run'
command -v awk >/dev/null 2>&1 || fail 69 'awk is required for report validation'
command -v node >/dev/null 2>&1 || fail 69 'node is required for structured report recovery'
printf 'Repository: %s\nPlan: %s\nModel: %s\nEffort: %s\n' "$repo_root" "$plan" "$model" "$effort"
if [[ "$check_only" == true ]]; then
  printf '%s\n' 'Local prerequisites OK. No model call or report write; credentials and service availability are untested.'
  exit 0
fi
# Do not allow a previous run's SUCCESS to survive a failed/aborted invocation.
cat > "$report" <<'REPORT'
# Status

BLOCKED

# Implemented

- Executor started; Muse has not written the current report.

# Changed Files

- Not yet reported.

# Verification

- Not yet reported.

# Plan Deviations

- none

# Blockers

- Current invocation has not produced an implementation report.
REPORT
# Build one deterministic handoff prompt. Stable executor rules and stable task skills
# precede the changing plan so providers can reuse the longest possible prompt prefix.
# Project AGENTS discovery is disabled for the delegated run because Codex has already
# routed and distilled the applicable instructions into this handoff.
mapfile -t relevant_instructions < <(
  awk '
    /^# Relevant Instructions[[:space:]]*$/ { active=1; next }
    /^# / && active { exit }
    active {
      line=$0
      if (line ~ /^-[[:space:]]+`[^`]+`[[:space:]]*$/) {
        sub(/^-[[:space:]]+`/, "", line)
        sub(/`[[:space:]]*$/, "", line)
        print line
      }
    }
  ' "$plan" 2>/dev/null | LC_ALL=C sort -u
)
for instruction in "${relevant_instructions[@]}"; do
  [[ "$instruction" == .agents/skills/* ]] || fail 65 "Relevant instruction must be below .agents/skills/: $instruction"
  [[ "$instruction" != *'..'* ]] || fail 65 "Relevant instruction may not contain '..': $instruction"
  [[ -f "$instruction" && -r "$instruction" && -s "$instruction" ]] || fail 66 "Missing, empty or unreadable relevant instruction: $instruction"
done
scratch_dir="$repo_root/artifacts/opencode/tmp"
mkdir -p -- "$scratch_dir"
export TMPDIR="$scratch_dir"
prompt_file="$(mktemp "$TMPDIR/dlens-muse-handoff.XXXXXXXX")"
events_file="$(mktemp "$TMPDIR/dlens-muse-events.XXXXXXXX")"
placeholder_file="$(mktemp "$TMPDIR/dlens-muse-placeholder.XXXXXXXX")"
cp -- "$report" "$placeholder_file"
trap 'rm -f -- "$prompt_file" "$events_file" "$placeholder_file"' EXIT
cat > "$prompt_file" <<'PROMPT'
# DLens delegated implementation executor

You are the implementation executor, not the planner. The handoff below is the complete task context supplied by Codex.
Treat a Ready plan as binding; if it is stale or completed, write BLOCKED and stop.
Preserve recorded dirty/staged/untracked user work. Never stash, reset or clean user work.
Use repository-local artifacts/opencode/ for scratch scripts, logs, browser profiles and Git message files. TMPDIR is set there by the runner. Never use hard-coded /tmp paths or read/copy external temporary scripts; create needed artifacts inside this repository. Keep reusable regression scripts in scripts/ and exclude disposable scratch files from Git.
Work quietly: do not narrate progress, announce tool calls, restate the plan, emit intermediate summaries, or ask for routine confirmation. Use tools directly and reserve prose for the required final status/path.
You may choose unspecified local implementation details and make small technical adjustments that do not alter architecture, public contracts, persisted-data semantics, security boundaries or task scope.
Own ordinary implementation repair in this same run. Fix compile/type/test failures caused by your changes, rerun only the affected requested check, and continue until the planned work is genuinely complete or a material blocker remains.
If implementation requires a materially missing decision with substantially different architectural/public/persistence/security outcomes, write BLOCKED with that exact decision and stop.
Do not expand scope, perform unrelated refactors, inspect product/Git history unless explicitly required by the plan, recursively delegate, switch models, deploy or change permissions. Perform Git delivery only when the task plan records user authorization and routes the Git skill; otherwise do not commit or push.
Update .agents/PLAN.md immediately after each completed implementation step or check: mark its checkbox, record a concise result, and keep the next unfinished action explicit before long checks or context exhaustion. Resume unchecked work from existing evidence on continuation; never defer all progress updates to the final report.
Run only verification requested by the plan. Then self-review actual changed/staged/new files against the plan, acceptance criteria and preserved user work; repair ordinary issues yourself. Never claim skipped or failed checks passed.
Write the implementation report to .agents/IMPLEMENTATION_REPORT.md using a file tool before finishing; printing it alone does not fulfill the handoff. For authorized Git delivery, record the commit hash, actual push result/destination and remaining worktree changes in the report; reuse prior verification evidence. Keep the implementation report compact and factual: no plan repetition, full diffs, debugging transcript, chronology, or commentary. SUCCESS requires completed planned work, requested checks and self-review. Mark .agents/PLAN.md Completed on SUCCESS. Finish with only the report status and path.

PROMPT
cat "$implementation_rules" >> "$prompt_file"
printf '\n# Implementation report format\n' >> "$prompt_file"
cat "$report_template" >> "$prompt_file"
printf '\n# Task instructions\n' >> "$prompt_file"
if ((${#relevant_instructions[@]} == 0)); then
  printf '%s\n' 'No additional task skill/reference was supplied.' >> "$prompt_file"
else
  for instruction in "${relevant_instructions[@]}"; do
    printf '\n## Instruction: %s\n' "$instruction" >> "$prompt_file"
    cat "$instruction" >> "$prompt_file"
    printf '\n' >> "$prompt_file"
  done
fi
printf '\n# Task plan\n' >> "$prompt_file"
cat "$plan" >> "$prompt_file"
prompt="$(cat "$prompt_file")"
status=0
OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode run --agent build --model "$model" --variant "$effort" --format json "$prompt" </dev/null >"$events_file" || status=$?
printf '\nExecutor CLI exit: %s. Report: %s\n' "$status" "$report"
if ((status != 0)); then
  cat -- "$events_file" >&2
  printf 'Executor: OpenCode failed; no retry or model fallback. Inspect the error and report, not a second full code review.\n' >&2
  exit "$status"
fi
if [[ ! -s "$report" ]] || cmp -s -- "$report" "$placeholder_file"; then
  if node "$script_dir/recover-report.mjs" "$events_file" "$report"; then
    printf '%s\n' 'Executor: recovered report from final assistant output; validating it normally.'
  fi
fi
[[ -f "$report" && -s "$report" ]] || fail 65 'Current implementation report is missing or empty'
section() {
  awk -v heading="# $1" '
    /^# / { active = ($0 == heading); next }
    active && NF { sub(/\r$/, ""); print }
  ' "$report"
}
for heading in Status Implemented 'Changed Files' Verification 'Plan Deviations' Blockers; do
  count="$(awk -v heading="# $heading" '$0 == heading { n++ } END { print n+0 }' "$report")"
  [[ "$count" == 1 && -n "$(section "$heading")" ]] || fail 65 "Malformed report section: $heading"
done
report_status="$(section Status)"
case "$report_status" in
  SUCCESS)
    if [[ "$(section 'Plan Deviations')" != '- none' || "$(section Blockers)" != '- none' ]]; then
      fail 2 'SUCCESS contains deviations or blockers; Codex must triage the report'
    fi
    printf '%s\n' 'SUCCESS: read the compact report and report completion; no automatic second review or test rerun.'
    ;;
  PARTIAL) fail 2 'PARTIAL: Codex must choose targeted correction or replanning from the report' ;;
  BLOCKED) fail 3 'BLOCKED: Codex must resolve the reported decision or execution blocker' ;;
  *) fail 65 'Invalid report status; expected SUCCESS, PARTIAL or BLOCKED' ;;
esac
