# Herdr Discord Bridge specification

## 1. Scope and architecture

This plugin is a local Herdr control client with Discord as the human interface.
The coding CLI remains a real process in a Herdr pane:

```text
Discord Gateway (outbound WebSocket)
        -> this bridge
        -> Herdr local Unix socket / Windows named pipe
        -> Herdr workspace, pane and recognized agent
        -> the CLI already running in that pane
```

The bridge is not an ACP broker and never starts a coding CLI itself. A Discord
disconnect therefore cannot stop an agent. The bridge also never exposes an
HTTP listener or a public endpoint.

The design follows Herdr's documented plugin v1 manifest and socket API, and
the blocked/approval pattern from `herdr-hail`: status observation, terminal
context read, a Discord thread, then an API-delivered response.

## 2. Runtime and configuration

The plugin is TypeScript compiled to `dist/` and started by the manifest pane
with `node dist/src/index.js`. The local restart script targets tab 1 in all modes:
no argument starts the installed plugin, `-r` rebuilds and links the local checkout,
and `-rg` reinstalls `jon888465/Herdr_Discord_Bridge` from GitHub. It does not
focus that tab, so subsequent Agent panes use the caller's existing tab rather
than being implicitly placed in tab 1. Herdr injects `HERDR_SOCKET_PATH` and
`HERDR_PLUGIN_CONFIG_DIR`; the bridge also supports the documented default
socket and `HERDR_SESSION` resolution for standalone operation.
socket and `HERDR_SESSION` resolution for standalone operation.

Configuration is read from `config.json` in `HERDR_PLUGIN_CONFIG_DIR` (or
`~/.config/herdr-discord-bridge/config.json` standalone). Tokens may be
provided by `HERDR_DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN`. The example file
is JSONC, but the real file is gitignored. Environment variables override file
values. State is stored below `HERDR_PLUGIN_STATE_DIR` (or the config
directory's `state/`) and the configured state filename is restricted to one
basename, preventing traversal.

Handoff context is bounded by `handoffLines` (default `40`) and
`handoffMaxChars` (default `6000`). These limits are applied before a handoff
is posted to Discord or sent to the destination Agent.

The Discord adapter requires `messageContent` because the requested
`/herdr ...` commands, mapped-thread prompts, and free-text approval replies are
text messages. It uses only the Gateway intents needed for guild messages plus
message content;
there is no inbound web server. Guild, channel and user allowlists are checked
before command, reply, or button handling. Empty lists mean “not restricted by
that dimension” and should be replaced with explicit IDs for a sensitive
deployment. `allowedWorkspaceIds`, when non-empty, is an additional Herdr
workspace authorization boundary.

## 3. Herdr protocol client

`HerdrClient` sends one newline-delimited JSON request over a fresh local
socket connection. A response with `error` becomes a typed `HerdrError`; no
request parameters or prompt text are included in error logs. Fresh bounded
connections avoid a broken long-lived request multiplexing every operation.

Socket failures retry at most twice with exponential backoff starting at
`reconnectBaseMs`. Protocol errors do not retry. The watcher continues on the
next interval after an outage, so a socket failure is reported without a crash
loop and without affecting Herdr panes.

The client uses these official methods:

| Bridge operation | Herdr method                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| health           | `ping`                                                                                      |
| workspaces       | `workspace.list`, with `session.snapshot` fallback                                          |
| agents           | `agent.list`                                                                                |
| output           | `agent.read`                                                                                |
| assign           | `agent.prompt`, with legacy `agent.send` fallback                                           |
| blocked reply    | legacy-compatible `agent.send`, with `agent.prompt` and official `pane.send_input` fallback |
| wait             | `agent.wait`                                                                                |
| cancel           | `agent.send_keys` with `ctrl+c`                                                             |

IDs are always copied from Herdr JSON responses. The bridge never predicts a
workspace or pane ID and never accepts a filesystem path as a workspace
selector. `agent.prompt` and `agent.send` carry JSON text; Discord input is not
passed through a shell.

## 4. Routing and authorization

The persisted routing record contains the requested Discord and Herdr fields:

```json
{
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordThreadId": "...",
  "discordUserId": "...",
  "workspaceId": "...",
  "agentName": "...",
  "paneId": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Mappings are separate maps and are resolved in this exact order:

```text
thread mapping > user mapping > channel default
```

Thread mappings are keyed by guild, parent channel and thread. Each thread
route contains an `activeAgentKey` plus independent Agent mappings:

```json
{
  "activeAgentKey": "w1:p2",
  "agents": {
    "w1:p2": {
      "workspaceId": "project-backend",
      "agentName": "codex",
      "paneId": "w1:p2"
    },
    "w1:p3": {
      "workspaceId": "project-review",
      "agentName": "hermes",
      "paneId": "w1:p3"
    }
  }
}
```

User mappings are keyed by guild and user, so one user's default cannot
replace another user's selection. `/herdr use <agent>` changes only
`activeAgentKey`; it does not call any Herdr focus, move, close, restart, or
create method. Existing Agent sessions are never reset by routing changes.

Agent commands resolve a live agent from `agent.list`. A target can match a
unique agent name/alias, agent kind, pane ID, terminal ID, or terminal title;
ambiguous matches are rejected and pane ID is requested. Every resolved target
is checked against the selected workspace and configured workspace allowlist.
Missing panes, exited agents, workspace changes, and stale mappings fail closed.

## 5. Discord commands and output

The text command prefix defaults to `/herdr`; an optional mention requirement
can be enabled with `requireMention` or `HERDR_DISCORD_REQUIRE_MENTION`.
When the bridge bot is mentioned, a known command may omit the prefix, so both
`@bridge agents` and `@bridge /herdr agents` are accepted. Unknown mention text
is treated as a direct prompt only when the message is in a mapped thread;
this keeps ordinary conversation from becoming an accidental command while
supporting the shorter syntax. `help` documents these forms and all supported
operations.

```text
/herdr workspaces
/herdr agents
/herdr status
/herdr current
/herdr use <agent-name-or-pane-id>
/herdr ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr read [agent-name-or-pane-id]
/herdr wait [agent-name-or-pane-id]
/herdr cancel [agent-name-or-pane-id]
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask <prompt>
```

`workspaces` displays Herdr-returned label/path, IDs, and agent states.
`wk use <workspace-id-or-name>` binds only an existing, authorized Herdr workspace for the current route; it does not create a workspace, pane, or Agent. Select an Agent afterward with `use`, `target`, or `assign`.
`current` displays the effective mapping and reports stale agent/pane data.
`use` binds one live Agent as the active target for the current Discord thread
(or user when used outside a thread) without sending a prompt. `target` is a
backward-compatible alias. In a thread with an active target, an ordinary
user message is a direct prompt to that Agent, subject to the same allowlist,
stale-mapping, and busy checks as `assign`. `ask` sends a one-shot prompt to a
named Agent and records that Agent in the thread without changing its active
target. `team add` and `team remove` manage independent thread participants;
`team ask` sends only the supplied prompt to each participant and never
broadcasts the thread or terminal history.
`assign` binds the current thread or user to the selected workspace/agent and
uses `agent.prompt`; a working agent or duplicate active stream is rejected as
busy. `read` uses `recent_unwrapped`, `wait` uses the event-driven Herdr wait,
and `cancel` uses Herdr's official key API rather than simulated keyboard
input.

Every Agent response and progress message includes an explicit Agent,
Workspace, and Pane identity header. The WK row includes both its Herdr ID and
name when available. When one thread has multiple participants,
each output is posted as a separate labeled response; the bridge does not use
multiple Discord bot tokens.

`handoff <from> <to>` reads only `handoffLines` of recent source output and
limits the generated handoff to `handoffMaxChars`. It redacts common token and
authorization formats, wraps the excerpt as untrusted observed output, and
sends only that bounded summary plus an optional user instruction to the
destination. This supports a deliberate transfer after a token/context limit
without copying the source Agent's full history. The destination becomes the
active thread Agent only after the handoff prompt is delivered successfully.

### Response streaming v1

The progress message shows the latest 1,500 characters of the prompt-scoped
CLI response, refreshed every ten seconds (on the next stream poll). Elapsed wall time is
shown after the status even when output is unchanged. The first card and final
are sent promptly. Final duration is frozen when completion is observed, excluding
Discord delivery time; blocked waiting time is included. This is polling-based
rolling preview, not a token stream. State changes remain visible even without
new text. Progress delivery failure does not prevent final delivery.

For Codex, before dispatch the bridge resolves the exact Herdr agent_session
ID under CODEX_HOME/sessions (default ~/.codex/sessions) and records the file
offset. Only subsequent event_msg records are consumed. task_started plus an
exact user_message match associates a turn; agent_message with phase
final_answer supplies the answer, and matching task_complete confirms completion.
Both legacy user_message/agent_message and item_completed envelopes containing
UserMessage/AgentMessage are supported. Item events must match the active turn_id.
Public commentary and command-execution status provide preview when terminal
prompt extraction is unavailable; Reasoning items are ignored.
Reasoning and commentary records are not used as final. No second Agent is started.
Missing, ambiguous, inaccessible or incompatible transcripts use the terminal
fallback. Different per-pane CODEX_HOME settings require the bridge to use the
same catalog; remote-only session files are not supported.

The terminal fallback retains the longest prompt-scoped observed excerpt.
It does not claim this excerpt is a complete final or an accumulated transcript.
Only four unchanged successful reads in idle/done, followed by ten seconds of
continued settlement, allow fallback completion. blocked, unknown, changing
output and failed reads reset settlement. A structured completion can finish
without a successful terminal read. A replaced Agent session stops observation.

Final is sent separately, using Markdown-aware chunks below Discord's content
limit. finished is shown after all chunks are sent. Missing final is described
as capture incomplete, never as proof of an empty Agent answer. Partial/failed
Discord delivery is reported separately. Progress edit failures are isolated.
No hidden reasoning events are consumed. Terminal preview is still observed CLI
text and is not a semantic tool-event feed.

This first version does not implement persistent delivery retries, mirror
commands, an agy structured transcript adapter, or automatic attachment mode.
Already-sent chunks are not replayed on delivery failure; SDK transport handling
remains in effect. Monitoring has a 24-hour ceiling. This experimental local
transcript format is version-dependent and must retain regression fixtures.

Discord command and approval handling can be paused without disconnecting the
bot with /herdr discord disable; status and enable remain available.
Only discord.allowedUserIds may change this state. The default notifyOn remains
blocked, avoiding a duplicate done notification.

See [Chinese response design](docs/response-events-design.zh-TW.md) for the
longer-term event contract and implementation phases.

## 6. Blocked and approval flow

The watcher polls `agent.list` at a bounded interval and ignores the initial
snapshot. A configured transition to `blocked` reads the detection snapshot and
posts it to every mapped Discord destination for that Agent. If the destination
is already a mapped thread, that thread is reused; otherwise the bridge starts
a Discord thread. The bridge creates a random opaque approval token only after
the thread exists and stores it with guild, channel, thread, message, terminal,
workspace and pane identity plus an expiry.

The root message receives a tokenized “Approve / continue” button. A button is
accepted only when the token was minted by this bridge, the guild/channel match,
the caller passes the allowlist, the token is active and unexpired, and a fresh
`agent.list` still has the same terminal, workspace and pane in `blocked` state.
Free-text replies are accepted only inside the exact thread stored with that
approval and pass the same allowlist and live-target checks. The text is sent
through `agent.send`/`agent.prompt`; on newer Herdr versions where a blocked
`agent.prompt` is intentionally rejected, the official `pane.send_input` API
submits the text and Enter atomically. It is never shell-evaluated.

Approvals expire, are bounded in count, and are deactivated when the agent
recovers, exits, or the target becomes stale. Recovery/exit notices are best
effort and deleted Discord threads are safe to ignore. State is atomically
written with restrictive file permissions and is flushed on shutdown.

## 7. Lifecycle and failure behavior

Discord.js owns Gateway reconnect behavior. The Herdr watcher has one
in-flight poll at a time and retries socket operations only a finite number of
times. Discord or Herdr failure is surfaced to the Discord command or process
log without stopping remote work. A long assignment stream can run for up to
24 hours and can be inspected at any time with `read`; it reports an exited
pane and stops tracking when Herdr no longer returns the target.

## 8. Verification and completion definition

The repository must pass:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Tests cover message splitting/ANSI handling, routing precedence and
authorization/stale mapping, active Agent selection, multiple thread Agent
mappings, legacy state migration, Agent identity headers, config path safety,
and a mock newline-delimited Herdr socket for ping/list/read/prompt/wait/cancel
plus bounded retry. A final diff scan must contain no real credentials, tokens,
private local config, or runtime state. The plugin manifest must be linkable by
Herdr. Commit/push and runtime restart or deployment follow the user's authorization;
automated checks do not by themselves authorize publication.

## Discord replies and local image delivery (2026-09-09)

An authorized same-channel reply to this bot satisfies the prompt mention gate.
References are fetched and validated against bot, guild and channel identity.
Unresolvable references and parent-channel image/reply prompts receive errors;
the bridge never guesses a cross-thread destination. Existing routing and
workspace validation still apply. Paused prompts are not dispatched.

Image-only thread messages use a default image-inspection prompt. Up to four
PNG/JPEG/WebP attachments, each at most 5 MiB, are downloaded from Discord HTTPS
CDN hosts with no redirects, a timeout, streamed byte limit and signature checks.
Generated local paths under the bridge state attachments directory are passed
to Codex/agy with an explicit instruction to use an image-viewing tool.
This is local file delivery, not native multimodal input, and requires the Agent
to access the same filesystem. Unsupported agents/formats and failed downloads
are reported. Successful files are retained (no automatic retention cleanup yet);
failed batches remove only their own newly created temporary directory.
The terminal is reserved during preparation to prevent concurrent dispatches.

## Documentation and issue lifecycle (mandatory)

All agents must follow [AGENTS.md](AGENTS.md). Every behavior change must update
this specification and affected documentation in the same work session.
New defects, failed tests, user acceptance failures and regressions must be
recorded in [known issues](docs/known-issues.md), including when no fix is made.
Reopen recurring issues without deleting previous investigation history.

Record dated evidence, reproduction conditions, confirmed versus suspected
causes, test commands/results and remaining acceptance steps. Distinguish
source-fixed, built, running/deployed and live-verified states. Unit tests and
build success do not close an issue requiring Discord/Herdr/CLI acceptance.
Keep proposed features separate from implemented behavior and reconcile stale
or contradictory statements before handoff. Pure documentation changes need
content/link/diff checks, not an unrelated full code test rerun.
