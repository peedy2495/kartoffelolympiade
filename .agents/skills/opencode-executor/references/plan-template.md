# Goal

Ready: state the exact observable end state in a few sentences.

# Relevant Instructions

List only task-specific skills/references Muse needs, using exact paths. Keep this list stable and minimal; the executor sorts paths before composing the handoff so identical skill sets form a reusable prompt prefix. Use `none` when the plan itself contains all required constraints.

- `.agents/skills/.../SKILL.md`

Do not list root `AGENTS.md` or `.agents/AGENTS.md`.

# Context

- Relevant files/symbols and current behavior.
- Dirty/staged/untracked user work that must be preserved, if any.
- Material constraints or known baseline failures.

Keep this section task-local; do not restate unrelated product requirements.

# Implementation

- [ ] `path/to/file`: concrete change and intended behavior.
- [ ] `path/to/file`: concrete change and intended behavior.

Name exact interfaces/types/state/persistence details only when they constrain the implementation. Local implementation details not affecting architecture/public contracts may be left to Muse.

# Verification

Run only checks meaningful for this change, in order. The executor owns ordinary repair and reruns within the same execution; do not plan a routine Codex verification pass afterward.

- [ ] Smallest focused check/test that proves the changed behavior.
- [ ] Broader build/test only when scope or risk warrants it; avoid broad suites "just in case".
- [ ] `git diff --check` when applicable.
- [ ] Self-review actual changes against this plan and preserve unrelated user work.

# Acceptance Criteria

- [ ] Concrete observable requirement.
- [ ] Relevant checks pass or documented baseline exceptions remain unchanged.
- [ ] `.agents/IMPLEMENTATION_REPORT.md` records actual status, verification, deviations and blockers.

# Progress

Update checked steps as soon as completed. Record concise verification results and the next unfinished action here before long checks or interruption; preserve this evidence on continuation.

# Out of Scope

List only important boundaries that could otherwise be mistaken as part of the task.

# Optional Architecture Detail

Include this section only when needed for cross-cutting architecture, persistence/migration semantics, security/concurrency boundaries, or materially different implementation choices.

- Required interfaces/contracts and ownership boundaries.
- Data/control flow and lifecycle/cancellation semantics.
- Error/rollback/persistence behavior.
- Chosen design and materially rejected alternatives.
