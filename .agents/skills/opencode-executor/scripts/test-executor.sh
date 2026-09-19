#!/usr/bin/env bash
set -euo pipefail

# Only isolated fixtures and a fake CLI; never call Muse or alter user work.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../../../.." && pwd -P)"
mkdir -p -- "$repo_root/artifacts/opencode/tmp"
fixture="$(mktemp -d "$repo_root/artifacts/opencode/tmp/dlens-executor-test.XXXXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
repo="$fixture/repo with spaces"
mkdir -p "$repo/.agents/skills/opencode-executor/scripts" "$repo/.agents/skills/opencode-executor/references" "$repo/.agents/skills/testing" "$fixture/bin"
cp "$script_dir/execute-plan.sh" "$script_dir/recover-report.mjs" "$repo/.agents/skills/opencode-executor/scripts/"
cp "$script_dir/../references/implementation-report-template.md" "$script_dir/../references/implementation-rules.md" "$repo/.agents/skills/opencode-executor/references/"
printf '# Fixture testing skill\n\nStable fixture instructions.\n' > "$repo/.agents/skills/testing/SKILL.md"
git init -q "$repo"
runner="$repo/.agents/skills/opencode-executor/scripts/execute-plan.sh"
bash_bin="$(command -v bash)"
cat > "$fixture/bin/opencode" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${TMPDIR:-}" == "$PWD/artifacts/opencode/tmp" && -d "$TMPDIR" ]] || exit 98
printf '%s\0' "$PWD" "${OPENCODE_DISABLE_PROJECT_CONFIG:-}" "$@" >> "$EXECUTOR_TEST_CAPTURE"
case "${EXECUTOR_TEST_REPORT:-SUCCESS}" in
  absent) rm -f .agents/IMPLEMENTATION_REPORT.md ;;
  unchanged) : ;;
  malformed) printf '# Status\n\nSUCCESS\n' > .agents/IMPLEMENTATION_REPORT.md ;;
  *)
    cat > .agents/IMPLEMENTATION_REPORT.md <<REPORT
# Status

${EXECUTOR_TEST_REPORT:-SUCCESS}

# Implemented

- Fixture task.

# Changed Files

- fixture.txt

# Verification

- Fixture check: passed; self-review: passed.

# Plan Deviations

${EXECUTOR_TEST_DEVIATIONS:-- none}

# Blockers

${EXECUTOR_TEST_BLOCKERS:-- none}
REPORT
    ;;
esac
if [[ -n "${EXECUTOR_TEST_OUTPUT:-}" ]]; then
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.env.EXECUTOR_TEST_OUTPUT, "utf8");
    const type = process.env.EXECUTOR_TEST_EVENT || "text";
    console.log(JSON.stringify({type, part: {type, text}}));
    if (process.env.EXECUTOR_TEST_TRAILING) console.log(JSON.stringify({type:"text", part:{type:"text", text:"SUCCESS: report path"}}));
  '
fi
exit "${EXECUTOR_TEST_EXIT:-0}"
MOCK
chmod +x "$fixture/bin/opencode"
export EXECUTOR_TEST_CAPTURE="$fixture/invocations"
export PATH="$fixture/bin:$PATH"
cd "$fixture"
expect_exit() {
  local expected="$1" actual=0
  shift
  "$@" > "$fixture/output" 2>&1 || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    cat "$fixture/output" >&2
    printf 'Expected exit %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}
expect_exit 0 "$bash_bin" "$runner" --help
# Root PLAN.md alone is deliberately not sufficient.
printf '# Goal\nReady: obsolete root fixture.\n' > "$repo/PLAN.md"
expect_exit 66 "$bash_bin" "$runner" --check
[[ ! -e "$EXECUTOR_TEST_CAPTURE" ]]
cat > "$repo/.agents/PLAN.md" <<'PLAN'
# Goal

Ready: fixture-only test.

# Relevant Instructions

- `.agents/skills/testing/SKILL.md`

# Context

- Fixture context.
PLAN
printf 'Existing report must survive --check.\n' > "$repo/.agents/IMPLEMENTATION_REPORT.md"
cp "$repo/.agents/IMPLEMENTATION_REPORT.md" "$fixture/original-report"
expect_exit 0 "$bash_bin" "$runner" --check
cmp "$repo/.agents/IMPLEMENTATION_REPORT.md" "$fixture/original-report"
[[ ! -e "$EXECUTOR_TEST_CAPTURE" ]]
expect_exit 64 "$bash_bin" "$runner" --effort
expect_exit 64 "$bash_bin" "$runner" --effort default
expect_exit 64 "$bash_bin" "$runner" --model other/model
expect_exit 64 "$bash_bin" "$runner" --effort xhigh
expect_exit 0 "$bash_bin" "$runner" --check --effort xhigh --allow-xhigh
[[ ! -e "$EXECUTOR_TEST_CAPTURE" ]]
export TMPDIR="$fixture/external-temp-must-not-be-used"
expect_exit 0 "$bash_bin" "$runner"
[[ ! -e "$TMPDIR" ]]
mapfile -d '' -t invocation < "$EXECUTOR_TEST_CAPTURE"
[[ "${#invocation[@]}" == 12 ]]
[[ "${invocation[0]}" == "$repo" && "${invocation[1]}" == 1 && "${invocation[2]}" == run ]]
[[ "${invocation[3]}" == --agent && "${invocation[4]}" == build ]]
[[ "${invocation[5]}" == --model && "${invocation[6]}" == opencode/muse-spark-1.3-contributor-free ]]
[[ "${invocation[7]}" == --variant && "${invocation[8]}" == medium ]]
[[ "${invocation[9]}" == --format && "${invocation[10]}" == json ]]
[[ "${invocation[11]}" == *'# Fixture testing skill'* && "${invocation[11]}" == *'# Task plan'* && "${invocation[11]}" == *'Ready: fixture-only test.'* ]]
[[ "${invocation[11]}" == *'# Fixture testing skill'* && "${invocation[11]%%# Task plan*}" == *'# Fixture testing skill'* ]]
[[ "${invocation[11]}" != *'Read AGENTS.md, .agents/AGENTS.md'* ]]
[[ "${invocation[11]}" == *'Never use hard-coded /tmp paths'* ]]
[[ "${invocation[11]}" == *'Perform Git delivery only when the task plan records user authorization'* ]]
[[ "${invocation[11]}" == *'Update .agents/PLAN.md immediately after each completed implementation step or check'* ]]
while IFS= read -r rule; do
  [[ "$rule" == '- '* ]] || continue
  [[ "${invocation[11]}" == *"$rule"* ]] || { printf 'Missing injected rule: %s\n' "$rule" >&2; exit 1; }
done < "$repo/.agents/skills/opencode-executor/references/implementation-rules.md"
# Old SUCCESS must not survive a run which fails to produce a report.
export EXECUTOR_TEST_REPORT=unchanged
expect_exit 3 "$bash_bin" "$runner"
for mode in absent malformed INVALID; do
  export EXECUTOR_TEST_REPORT="$mode"
  expect_exit 65 "$bash_bin" "$runner"
done
export EXECUTOR_TEST_REPORT=PARTIAL
expect_exit 2 "$bash_bin" "$runner"
export EXECUTOR_TEST_REPORT=BLOCKED
expect_exit 3 "$bash_bin" "$runner"
export EXECUTOR_TEST_REPORT=SUCCESS
export EXECUTOR_TEST_DEVIATIONS='- Changed an unspecified API.'
expect_exit 2 "$bash_bin" "$runner"
unset EXECUTOR_TEST_DEVIATIONS
export EXECUTOR_TEST_BLOCKERS='- Missing verification.'
expect_exit 2 "$bash_bin" "$runner"
unset EXECUTOR_TEST_BLOCKERS
: > "$EXECUTOR_TEST_CAPTURE"
export EXECUTOR_TEST_EXIT=42
expect_exit 42 "$bash_bin" "$runner" --effort high
mapfile -d '' -t invocation < "$EXECUTOR_TEST_CAPTURE"
[[ "${#invocation[@]}" == 12 && "${invocation[8]}" == high && "${invocation[1]}" == 1 ]]
# Recover only complete final assistant reports from this invocation.
unset EXECUTOR_TEST_EXIT
export EXECUTOR_TEST_REPORT=SUCCESS
expect_exit 0 "$bash_bin" "$runner"
cp "$repo/.agents/IMPLEMENTATION_REPORT.md" "$fixture/recovery-report"
export EXECUTOR_TEST_OUTPUT="$fixture/recovery-report"
for mode in unchanged absent; do
  export EXECUTOR_TEST_REPORT="$mode"
  expect_exit 0 "$bash_bin" "$runner"
  cmp "$fixture/recovery-report" "$repo/.agents/IMPLEMENTATION_REPORT.md"
done
# Tool output and non-final report text are not recovery sources.
export EXECUTOR_TEST_REPORT=unchanged EXECUTOR_TEST_EVENT=tool_use
expect_exit 3 "$bash_bin" "$runner"
unset EXECUTOR_TEST_EVENT
export EXECUTOR_TEST_TRAILING=1
expect_exit 3 "$bash_bin" "$runner"
unset EXECUTOR_TEST_TRAILING
# Existing reports remain authoritative, including malformed/blocked ones.
export EXECUTOR_TEST_REPORT=BLOCKED
expect_exit 3 "$bash_bin" "$runner"
export EXECUTOR_TEST_REPORT=malformed
expect_exit 65 "$bash_bin" "$runner"
# Recovery does not bypass status or deviation checks.
export EXECUTOR_TEST_REPORT=absent
sed 's/^SUCCESS$/PARTIAL/' "$fixture/recovery-report" > "$fixture/partial-report"
export EXECUTOR_TEST_OUTPUT="$fixture/partial-report"
expect_exit 2 "$bash_bin" "$runner"
sed 's/^SUCCESS$/BLOCKED/' "$fixture/recovery-report" > "$fixture/blocked-report"
export EXECUTOR_TEST_OUTPUT="$fixture/blocked-report"
expect_exit 3 "$bash_bin" "$runner"
sed 's/^- none$/- Unresolved item./' "$fixture/recovery-report" > "$fixture/deviation-report"
export EXECUTOR_TEST_OUTPUT="$fixture/deviation-report"
expect_exit 2 "$bash_bin" "$runner"
printf '# Status\n\nSUCCESS\n' > "$fixture/short-report"
export EXECUTOR_TEST_OUTPUT="$fixture/short-report"
expect_exit 65 "$bash_bin" "$runner"
export EXECUTOR_TEST_OUTPUT="$fixture/recovery-report" EXECUTOR_TEST_EXIT=42
expect_exit 42 "$bash_bin" "$runner"
[[ ! -e "$repo/.agents/IMPLEMENTATION_REPORT.md" ]]
unset EXECUTOR_TEST_OUTPUT EXECUTOR_TEST_EXIT
mkdir "$fixture/no-cli"
ln -s "$(command -v git)" "$fixture/no-cli/git"
ln -s "$(command -v dirname)" "$fixture/no-cli/dirname"
previous_path="$PATH"
export PATH="$fixture/no-cli"
expect_exit 69 "$bash_bin" "$runner" --check
export PATH="$previous_path"
printf '%s\n' 'PASS: focused canonical plan, project AGENTS discovery disabled, stable task instructions precede dynamic plan, arbitrary cwd/spaces, check-only preservation, fixed model/effort, xhigh gate, current reports, SUCCESS/PARTIAL/BLOCKED, malformed reports, deviation/blocker triage, structured final-report recovery with authoritative-file preservation and CLI failure propagation without retries (mock only).'
