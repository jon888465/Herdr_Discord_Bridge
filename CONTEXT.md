# Domain Context

## Team orchestration

- **1:1:N Multi-Agent Task**: One Human, one Discord thread/task context, and N
  Herdr or CLI Agents. The thread has one Lead as the sole formal reporting
  window; Workers execute bounded Assignments and report evidence to the Lead.
- **Team**: The set of Herdr Agents attached to one workspace for
  collaborative work. A Team is scoped to that workspace and does not imply that
  every Agent receives every user message.
- **Lead**: The Team's active Agent at the moment a Team Task starts. The Lead
  plans the work and produces the final synthesis for the user.
- **Participant**: A non-lead Agent in the Team that receives an assigned
  subtask and reports its result to the Lead.
- **Team Task**: One user request submitted to a Team. It has a lifecycle,
  child assignments, and a final synthesis.
- **Assignment**: A bounded child task sent to one Participant. It has one
  owner, an instruction, optional dependencies, and a report.
- **Roster**: The frozen set of Team members and their roles captured when a
  Team Task starts. Changes to the Discord Team affect later tasks, not a task
  already running.
- **Assignment state**: `pending`, `assigned`, `working`, `blocked`, `done`,
  `failed`, or `cancelled` (the scheduler and durable engine share this lifecycle).
- **Team Task state**: `planning`, `running`, `blocked`, `cancelling`, `synthesizing`,
  `completed`, `failed`, or `cancelled`. Synthesis includes direct work and verification.
- **Report**: A bounded, observable result from an Assignment. It is not the
  Agent's hidden reasoning or full terminal history.
- **Synthesis**: The Lead's bounded final report combining Assignment reports,
  including incomplete or failed work.

## Invariants

- A Team belongs to exactly one Herdr workspace and may be used from multiple Discord delivery contexts.
- Team members must belong to the Team workspace; Agents from different workspaces are different Teams.
- Team membership mappings persist across bridge restarts; unavailable panes remain stale and are not dispatchable until Herdr reports them again.
- A Team Task has exactly one Lead and zero or more Participants.
- The Lead is selected from the active Agent mapping when the task begins.
- A Team Task never silently changes its Lead or Roster while running.
- Assignment and Synthesis output is posted with Agent, workspace, and pane
  identity.
- Missing, stale, unauthorized, or ambiguous Agent targets fail closed.
- Reports are bounded observed output; hidden chain-of-thought is never shared.
- The first orchestration implementation of `team ask` now asks the Lead for a
  validated Assignment plan, dispatches bounded work through Herdr, collects
  Worker reports, and asks the Lead for synthesis. Phase 1 now persists that same
  lifecycle and reconciles interrupted tasks without redispatch. Interactive
  blocked-Assignment continuation now uses the Phase 2 durable question queue; live acceptance remains pending.

## Pending feature index

- [ISSUE-013/014 handoff and Herdr delegation methods](docs/team-orchestration-issues-013-014-handoff.md):
  user-provided CLI/A2A approaches, installed Herdr 0.8.0 findings, unfinished
  response-correlation patch, and remaining verification after the user-requested pause.

- [Herdr direct interaction mirror to Discord](docs/pending-features.md):
  explicitly relay direct Herdr prompts and Agent responses to the mapped
  Discord thread to preserve conversation context.

## Project maintenance

All contributors must follow [AGENTS.md](AGENTS.md), including same-session
issue/spec documentation updates and reopening issues after failed acceptance.
The current issue and verification ledger is [known issues](docs/known-issues.md).

## Console routing

The local bridge console can explicitly select an existing Discord thread with
`thread <ID>` (`threads` lists choices). This persists a reference to the same
thread route, sharing active Agent and Team changes. `thread off` restores the
independent console route. Selecting an Agent keeps the console in conversation mode. Explicit `attach` displays bounded visible terminal snapshots; `watch` displays state changes. Blocked questions remain visible and replyable in every mode.
Controls remain available in every state. Direct Agent-pane mirroring to Discord
is still pending (ISSUE-010). Explicit Team question correlation is implemented; live acceptance is tracked in ISSUE-012.
Bridge restart preserves other Agent panes and targets tab 1
within the dedicated workspace named `bridge` (created if absent). Legacy bridge
panes elsewhere must be explicitly migrated/stopped before restart.

Normal startup acquires a local OS-owned IPC lock for the Discord bot before
routing state is read or Discord connects. It prevents duplicate new-version
instances; legacy processes without the lock still require explicit migration.

## Agent profiles and sessions

- [Cross-CLI session handoff](docs/session-handoff.md): portable [skill](skills/session-handoff/SKILL.md), native-history-first recovery and quota checkpoints; comparison with bounded Bridge handoff. The standalone skill has no quota watcher; Bridge Phase 4 uses explicit observations below. Live skill acceptance is tracked in ISSUE-017.

- [Agent Pool and console separation](docs/agent-pool-console.md): 2026-09-18 implementation of per-workspace profile permissions, lazy persistent CLI startup, explicit existing-session binding, session continuity checks, dynamic Lead replanning, and console selection/inspection modes.
- Profiles are definitions, sessions hold CLI context, panes host processes. Removing a profile from a Team does not stop its session.
- Team roster may contain live mappings and enabled profiles; only selected profiles start. Lead may choose zero Workers. Tasks now have durable state and conservative restart reconciliation; automatic resume is not implemented.

## Durable Tasks

[Phase 1 architecture and acceptance](docs/durable-task-engine.md): versioned atomic event journals, frozen task identity, shared Assignment lifecycle, status/cancel commands, restart quarantine and reservation ownership. ISSUE-018 tracks source/test evidence separately from live acceptance.

## Team Questions

[Phase 2 question queue](docs/team-question-queue.md): durable question identities, explicit workspace/task/question replies plus scoped Discord button/modal answers, original turn continuation, cross-interface deduplication, conservative restart invalidation. Schema v2 reads v1. ISSUE-012 tracks fixture evidence separately from live acceptance.

## Session Handoff Runtime

[Phase 3](docs/session-handoff-runtime.md): persistent checkpoint registry and derived HANDOFF packets, public session adapters, repository acceptance, explicit ownership transfer and continuation. Same local workspace/worktree, operator-attested stopped writers, no live Team roster replacement; restart quarantines rather than replays. ISSUE-019 records tests and remaining live acceptance. Phase 4 builds on these gates; see below.

## Quota / Failover Manager

[Phase 4](docs/quota-failover-manager.md): explicit operator quota observations with TTL and shared-budget groups; ordered frozen candidate policy, quota-triggered checkpoint and operator-confirmed verify/accept/continue chain. Durable intents, no retry/cascade after unknown delivery, restart quarantine, exact session/worktree acceptance. No provider quota watcher or credential/account switching. ISSUE-020 separates source/fixture evidence from pending live acceptance.

## Automated validation and entrypoints

[CI and startup](docs/ci.md): Ubuntu/macOS Node 22 full-suite workflow, standalone npm/bin entrypoints aligned with dist/src/index.js. ISSUE-021 records the original full-suite pass on Ubuntu (206/206) and macOS (205 pass, one existing Linux-only skip) on 2026-09-20, plus the fixed macOS restart-script mapfile incompatibility; a draft PR does not merge/deploy or authorize live model work.
