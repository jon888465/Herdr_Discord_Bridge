# Domain Context

## Team orchestration

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
- **Assignment state**: `pending`, `running`, `blocked`, `completed`,
  `failed`, or `cancelled`.
- **Team Task state**: `planning`, `dispatching`, `running`, `synthesizing`,
  `completed`, `failed`, or `cancelled`.
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

## Pending feature index

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
independent console route. Selecting an Agent also displays its bounded visible
terminal snapshots locally and permits replies to its displayed blocked question.
Controls remain available in every state. Direct Agent-pane mirroring to Discord
and multi-Agent question correlation are still pending (ISSUE-010 / ISSUE-012).
Bridge restart preserves other Agent panes and targets tab 1
within the dedicated workspace named `bridge` (created if absent). Legacy bridge
panes elsewhere must be explicitly migrated/stopped before restart.

Normal startup acquires a local OS-owned IPC lock for the Discord bot before
routing state is read or Discord connects. It prevents duplicate new-version
instances; legacy processes without the lock still require explicit migration.
