# Team Orchestration Implementation Plan

Status: Proposed

This plan implements [team-orchestration-spec.md](./team-orchestration-spec.md)
without changing the existing single-Agent routing semantics.

## Phase 1 — Domain types and persistence

Add explicit types for `TeamTask`, `Assignment`, `TeamRoster`, `TaskReport`,
and their states. Extend persisted routing state with task records keyed by a
stable task ID. Add bounded retention and cleanup rules.

Deliverables:

- types and state migration;
- task ID generation;
- serialization tests;
- stale task recovery policy.

## Phase 2 — Planning module

Create a deep `TeamPlanner` module with a small interface:

```text
plan(task, lead, roster) -> validated AssignmentPlan
```

Its implementation sends the planning prompt to the Lead, parses the strict
JSON envelope, validates assignment targets/dependencies, and returns either a
safe plan or a typed failure. Keep prompt construction and parsing behind the
module seam so tests do not need Discord or Herdr.

## Phase 3 — Scheduler module

Create a deep `TeamScheduler` module with a small interface:

```text
start(task, plan) -> task lifecycle events
cancel(taskId) -> result
```

Inject the Herdr Adapter, clock, persistence store, and event sink. The
implementation owns dependency ordering, concurrency, duplicate-dispatch
prevention, state transitions, timeout handling, and restart recovery.

## Phase 4 — Discord integration

Change `team ask` so it creates an orchestration task when the thread has a
Team. Keep `team add`, `team remove`, `ask`, and ordinary active-Agent prompts
backward compatible.

Add concise Discord messages for:

- task accepted and Lead/Roster;
- plan accepted or rejected;
- assignment started/completed/blocked/failed;
- synthesis started;
- final synthesis.

All messages must use the existing Agent/workspace/pane identity header and
Discord-safe splitting.

## Phase 5 — Approval, cancellation, and recovery

Reuse the existing approval records for blocked assignments, adding task and
assignment identity to the approval context. Add a task-level cancel command
only after the internal lifecycle is reliable:

```text
/herdr team cancel <task-id>
/herdr team status [task-id]
```

On bridge restart, reload non-terminal tasks, query Herdr state, and resume
only assignments whose dispatch identity is still valid. Never replay a
completed prompt solely because the bridge restarted.

## Phase 6 — Tests

Build tests at the module seams:

- planner accepts valid JSON and rejects malformed/unsafe plans;
- planner rejects duplicate, non-roster, lead, and cyclic assignments;
- scheduler dispatches independent work in parallel;
- scheduler waits for dependencies;
- busy, blocked, stale, and unknown Agents produce the specified states;
- cancellation prevents future dispatches and uses Herdr's official cancel;
- restart recovery is idempotent;
- synthesis includes successes, failures, and skipped dependencies;
- Discord output preserves all task reports across message chunks.

Use fake Herdr and Discord Adapters. Do not test orchestration by driving a
real terminal unless an end-to-end smoke test is added separately.

## Phase 7 — Rollout

Ship behind a configuration flag, disabled by default during the first
deployment. Enable it for an allowlisted guild/user, observe task state and
failure rates, then make it the default after the smoke test is stable.

Suggested configuration:

```json
{
  "teamOrchestration": {
    "enabled": false,
    "maxConcurrentAssignments": 2,
    "planningTimeoutMs": 120000,
    "synthesisTimeoutMs": 120000,
    "taskTimeoutMs": 3600000,
    "maxAssignments": 8
  }
}
```

## Open decisions before implementation

1. Should the first release keep `team ask` as the only entry point, or add
   an explicit `team plan` command?
2. Should the Lead always remain planner/synthesizer, or may it also receive a
   child assignment?
3. Should two assignments in the same workspace be rejected by default when
   they might touch overlapping files?
4. Should a blocked assignment pause the whole task or allow independent
   assignments to continue?
5. Should final synthesis be posted only after every assignment terminates,
   or allow a user-requested partial report?
