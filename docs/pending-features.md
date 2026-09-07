# Pending Features

## Herdr direct interaction mirror to Discord

Status: Planned

### Goal

When the user interacts with an Agent directly inside a Herdr pane, preserve
the prompt and response context by forwarding the interaction to the Discord
thread mapped to that pane.

This is separate from the existing Discord-to-Herdr flow. The bridge must not
send the mirrored message back to Herdr or create a dispatch loop.

### Proposed user experience

Enable mirroring for the current Discord thread and its selected pane:

```text
/herdr use w2:p1
/herdr mirror on
```

Supported management commands:

```text
/herdr mirror off
/herdr mirror status
```

After enabling the mode, a prompt entered directly in `w2:p1` and the Agent's
completed response are posted to the same Discord thread. Mirrored messages
should identify the source Agent, workspace, and pane.

### First-release scope

- One-way relay: Herdr pane -> mapped Discord thread.
- Explicit opt-in per Discord thread and pane; disabled by default.
- One Discord thread per mirrored pane route. Ambiguous routes fail closed.
- Cursor or fingerprint based deduplication across polling cycles and bridge
  restarts.
- Discord-safe splitting for long responses.
- ANSI/control-sequence removal before posting.
- No hidden chain-of-thought or full unrelated terminal history is forwarded.

### Implementation outline

1. Add a persisted `MirrorRoute` containing pane/terminal identity, Discord
   guild/channel/thread identity, enabled state, and the last observed cursor.
2. Add an `AgentOutputWatcher` that detects direct Herdr prompts and completed
   Agent output. The initial implementation may poll Herdr because the current
   watcher exposes status transitions but not raw terminal output events.
3. Add a `MirrorRelay` seam that performs route validation, boundary detection,
   deduplication, output formatting, and Discord delivery.
4. Reuse the existing CLI adapter and Discord splitting/error handling where
   possible, while keeping the watcher testable with fake Herdr and Discord
   adapters.
5. Add tests for direct prompts, long output, duplicate polls, bridge restart
   recovery, stale panes, ambiguous routes, blocked Agents, and failed Discord
   delivery.

### Acceptance criteria

- A direct prompt in an enabled Herdr pane appears once in the mapped Discord
  thread.
- Its completed response appears once in the same thread and retains the
  prompt-to-response context.
- Existing Discord-originated prompts are not duplicated by mirror mode.
- Disabling mirror stops forwarding without stopping the Agent or Discord bot.
- A missing, stale, unauthorized, or ambiguous route is not broadcast.
- Long responses remain readable and do not cause the Discord interaction to
  be reported as `no response` merely because delivery requires multiple
  messages.
