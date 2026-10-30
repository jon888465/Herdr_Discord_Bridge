# Herdr Discord Bridge

Drive coding agents in Herdr panes from Discord, with optional Team profiles for on-demand persistent CLI startup. The
bridge uses Discord's outbound Gateway WebSocket and Herdr's local socket; it
does not expose a public HTTP endpoint and does not replace Herdr's PTY/runtime.

[English](README.md) | [繁體中文](README.zh-TW.md)

## Install, update, and run as a Herdr plugin

Install the plugin from GitHub and enable it:

```text
herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
herdr plugin enable herdr-discord-bridge
```

Create the configuration file. The command prints the directory used by the
plugin; copy the example there and fill in the bot token and allowlists:

```text
herdr plugin config-dir herdr-discord-bridge
cp config.example.jsonc <config-dir>/config.json
```

Start the Discord bridge pane:

```text
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

To update an existing installation, close the old pane using its `pane_id` from
the pane-open response, reinstall the plugin, then open a new pane:

```text
herdr plugin pane close <pane_id>
herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

The install step runs the plugin build automatically. The pane starts
`node dist/src/index.js`, which is the compiled bridge entrypoint.

To run local changes before pushing them to GitHub, first close any existing
bridge pane, then build and link this checkout:

```text
herdr pane list
herdr plugin pane close <pane_id>  # only if a bridge pane is open
npm ci
npm run build
herdr plugin unlink herdr-discord-bridge  # only if the GitHub copy is installed
herdr plugin link . --enabled
herdr plugin config-dir herdr-discord-bridge
```

Keep the existing `config.json`, or create it in the directory printed by the
last command. Open the linked plugin:

```text
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

After editing local source files, run `npm run build` again and reopen the pane
to load the new code. Check the installed source with `herdr plugin list`; it
should identify the plugin as a local link.

Use the restart script in one of three modes:

```text
./scripts/run.sh       # start only; no rebuild or reinstall
./scripts/run.sh -r    # npm ci, build, and run the local checkout
./scripts/run.sh -rg   # reinstall main from GitHub and run
```

If the Herdr server is not running, `run.sh` starts the headless server and waits for its socket before continuing; you do not need to type `herdr` first, and the script does not stop an existing Herdr server.

All modes place the bridge in tab 1 of a dedicated workspace named `bridge`.
The script reuses that workspace or creates it with the project cwd and
`--no-focus`; duplicate names are rejected. Other Agent panes stay in place.
If an old bridge still runs in another workspace, the script reports its pane
ID and stops: explicitly move or stop that old bridge before restarting.
Only labelled non-Agent bridge panes in the dedicated tab are replaced.
The script does not modify the plugin configuration or Discord token.

Fill in the bot token and explicit guild/channel/user allowlists in `config.json`
or use environment variables. Never commit that file. Discord Message Content
must be enabled because the bridge accepts the `/herdr ...` text commands,
direct prompts in mapped threads, and free-text replies in approval threads.

## Commands

The bridge accepts both command forms:

```text
@bridge agents
@bridge use codex
@bridge help
```

The original prefixed form remains supported:

```text
/herdr workspaces
/herdr wk use <workspace-id-or-name>
/herdr agents
/herdr status
/herdr current
/herdr use <agent-name-or-pane-id>
/herdr ask <prompt>（pane 使用目前選定 Agent）；Discord 使用 ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr model <model>
/herdr model <agent-name-or-pane-id> <model>
/herdr discord enable|disable|status
/herdr read <agent-name-or-pane-id>
/herdr wait <agent-name-or-pane-id>
/herdr cancel <agent-name-or-pane-id>
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team list
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask [--coding] <prompt>
```

When `requireMention` is enabled, mention the bot for both forms, for example
`@bridge agents` or `@bridge /herdr agents`. In a mapped thread, a message
whose first word is not a known command remains a direct prompt to the active
Agent.

In `bridge>`, run `agent`, then `agent use <pane ID>`, then `current`. Selection saves both the local workspace and its active Agent. Discord user/thread routes stay independent unless you explicitly select a shared `thread <ID>`.

Selecting an Agent keeps the console in conversation mode: only the current request's correlated answer is delivered. `attach [pane]` explicitly inspects bounded terminal snapshots (40 visible lines / 6,000 characters); `watch [pane]` shows status changes; `detach` returns to conversation mode. Inspection does not change the conversation target. Blocked questions remain visible and replyable. This is not native PTY attachment or a complete terminal stream, and it does not mirror Discord.

Type `ask <text>` or ordinary text to the selected Agent. When idle/done it starts a prompt; when blocked it answers the question shown in bridge. Changed or unseen questions must be read and answered again. Duplicate answers are rejected. `help`, `current`, `agent use`, `wk` and other controls remain available while working or blocked; new prompts during working/unknown are rejected. Use `ask current` if the answer itself is a command word. Output preserves the line being edited. `read [agent]`, `wait [agent]`, `cancel [agent]` remain explicit controls. `team list` lists workspace Teams; other Team operations require a workspace. Team questions use explicit task/question IDs (see below); Discord mirroring remains pending.

### Selecting an Agent

Selecting a workspace and selecting an Agent are separate operations. To route
a thread to an Agent already running in Herdr:

```text
@bridge agents
@bridge use w2:p1
@bridge current
```

`wk use <workspace>` only records the workspace route; it does not move,
restart, or automatically select an Agent. Use the pane ID shown by `agents`,
especially when multiple workspaces contain an Agent with the same name (such
as `codex`).

`/herdr model <model>` switches the model of the current thread Agent without
restarting its pane or conversation. Use `/herdr model <agent> <model>` to target
a specific Agent. The model string is passed through the selected CLI adapter as
that CLI's model-switch command; the Agent must be idle. Running `/herdr model` shows a Discord select menu for the
selected Agent; choosing an option disables the menu and reports the requested
switch. Direct model names remain supported for models not listed by the picker.
Claude uses `sonnet`, `opus`, and `haiku` aliases with `/model <name>`; availability depends on your CLI/account.

To pause Discord command and approval handling while keeping the bot connected, use:

```text
/herdr discord disable
/herdr discord status
/herdr discord enable
```

Only user IDs listed in `discord.allowedUserIds` can change this state. The restart
script keeps the bridge in tab 1 without focusing it; leave the active tab unchanged
so subsequently opened Agent panes are not implicitly placed in tab 1.

`/herdr use <agent>` switches the active Agent for the current Discord thread
without moving or restarting any Herdr pane. `/herdr ask <agent> ...` sends a
one-shot prompt to an explicitly named Agent without switching the active
Agent. Agent, workspace, and pane IDs are looked up from Herdr JSON responses;
Discord users cannot provide arbitrary filesystem paths.

For a continuing one-to-one conversation, create a Discord thread and run
`/herdr use <agent-name-or-pane-id>` once. Subsequent ordinary messages in
that thread are sent only to the active Agent. The bridge requires an explicit
mention when `requireMention` is enabled. Each thread stores its active Agent
and can retain additional Agent mappings. `team add` manages workspace Team members; members are not automatically given the thread's full history.

`/herdr team ask ...` lets the selected Lead plan bounded Assignments, dispatch to live members or enabled profiles, and decide follow-up work from their reports before verification and synthesis. It can also choose no Workers and handle the task directly. `team ask --coding <prompt>` opts into the local Git coding gate: one writer, a different known-session review, and version-bound test evidence before completion. A review or verify does not stay valid if the tree changes during that turn. The flag is not inferred from the prompt text. It does not commit, push, or isolate writers with an OS lock. See [the local coding workflow](docs/coding-workflow-proposal.md) and ISSUE-025. It does not copy the Discord thread
or terminal history. Tasks now persist across restarts; `team status [task-id]` shows saved state and `team cancel <task-id>` cancels the whole task. Restart reconciliation never automatically redispatches; uncertain sessions remain blocked/cancelling for inspection. Interactive blocked Assignments use `team questions <task-id>` and `team reply <task-id> <question-id> <answer>`. See [Phase 2 behavior and limits](docs/team-question-queue.md). See [durable task behavior and limits](docs/durable-task-engine.md). Use
`/herdr handoff <from> <to>` when a CLI reaches a token/context limit. Handoff
reads only a bounded recent output window (`handoffLines` and
`handoffMaxChars`), redacts common credential formats, posts a concise bounded
summary, and sends that summary to the destination Agent.

For native session recovery across CLIs, including Grok Build, and checkpoints before quota exhaustion,
ask your CLI to read the standalone [handoff-session skill](skills/handoff-session/SKILL.md).
Copy the whole skill directory for manual installation; discovery paths vary by CLI.
The skill can read a local `grok export`; the Bridge runtime does not decode Grok session files.
See [usage and the Bridge comparison](docs/session-handoff.md). This agent workflow
has no automatic quota watcher. Bridge Phase 4 adds failover from explicit quota observations (below); live cross-CLI acceptance is pending.

Agent replies and progress messages are labeled with Agent, Workspace, and
Pane. A typical Discord thread therefore looks like:

```text
┌─────────────────────────────┐
│ 🤖 Codex · backend           │
│ Workspace: project-backend  │
│ Pane: w1:p2                  │
└─────────────────────────────┘

正在檢查 auth middleware...
```

The bridge uses one Discord bot token for all Herdr Agents. Agent sessions stay
in Herdr; switching or handing off only changes routing and does not reset the
source pane. No full Discord or CLI history is copied to another Agent.

For Discord single-Agent prompt replies, the bridge records the terminal snapshot before sending the
prompt and forwards only output after that prompt. CLI-specific prompt markers
and terminal chrome are handled by adapters in `src/cli-adapter.ts`; Codex,
Antigravity (`agy`), OpenCode, Grok, Claude, and pi have separate adapters, while unknown CLIs use
a safe generic adapter. If no reliable prompt boundary is found, historical output is
not forwarded. The default `notifyOn` setting is `["blocked"]`, so a separate
`done` notification is not posted after a completed prompt.

When Herdr reports an agent blocked, the bridge posts terminal context in a
Discord thread with an approval button. An allowlisted user can press it or
reply in that thread. The reply is revalidated against the live Herdr terminal
before being delivered through Herdr's agent API.

## Development

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

See [SPEC.md](./SPEC.md) for the protocol, security model, routing semantics,
failure behavior, and acceptance criteria.

### Share Discord routing with the bridge console

In `bridge>`, run `threads`, then `thread <thread ID from the list>`, then
`current`. Both interfaces now share the same active Agent and Team; `use`
and Team changes apply to that workspace and are visible from any authorized Discord thread routed to it. Selection survives bridge restarts.
Use `thread off` to restore independent console routing. Unknown or
unauthorized threads are rejected. Console replies stay in the pane;
this does not enable direct Agent conversation mirroring to Discord.

Normal startup rejects a second local instance for the same Discord bot before login. The lock is independent of workspace and config directory. Linux releases it even after a crash. Older bridge builds without this lock must still be stopped during the first upgrade.

Inbound attachment folders (`<cwd>/.herdr-discord-bridge/attachments/message-*`) older than 3 days are removed automatically, locally and on remote machines, at startup and every 6 hours (ISSUE-043).

## Remote Herdr machines

After `herdr machine add`, list the machine under `machines` in the plugin config (see [config.example.jsonc](config.example.jsonc)): `id`, `ssh` (a Host from `~/.ssh/config`) and `socket`, the absolute path of the remote Herdr API socket. The bridge forwards that socket with `ssh -L`; remote IDs carry an `<id>:` prefix (for example `agy-pod:w2:p1`) and unprefixed IDs are always local. Supported: text conversation and Discord → remote-agent attachments (uploaded over ssh into the remote cwd). Not supported: agent → Discord file return and `herdr-discord-send` for remote agents. Text conversation is accepted; remote attachments await acceptance (ISSUE-041).

## Agent profiles and quiet console

Define `agentProfiles` in the plugin config (see [config.example.jsonc](config.example.jsonc)). Profiles configure CLI kind, optional model/arguments and capabilities; no model name is assumed valid for your account.

```text
agent use <lead-pane>
team pool
team select
team bind helper <existing-worker-pane>
team ask <task>
attach <worker-pane>
detach
```

`team select` opens a numbered checkbox list in the bridge pane: enter numbers to toggle, `done` to save, `cancel` to cancel. Discord uses `team select <profile> on|off`. Binding is optional: an unbound selected profile starts only when the Lead assigns it work. Use `team add profile:<id>` / `team remove profile:<id>` as explicit aliases.

Existing sessions require explicit binding and retain their CLI context. New or unidentified sessions receive the original task and bounded reports, without claiming complete context recovery. Release and Team removal preserve the process. Startup failures with uncertain delivery require inspection and explicit binding before retrying; panes are not automatically closed. See [architecture, limits and acceptance](docs/agent-pool-console.md).

### Durable session handoff (Phase 3)

Use `handoff checkpoint <source> <goal>`, then `handoff verify <id> <destination> confirm-source-stopped`, `handoff accept <id>`, and `handoff continue <id>`. Inspect with `handoff status [id]` / `handoff packet <id>`; `handoff cancel <id>` releases settled ownership without stopping a CLI. Explicitly confirm source/background writers are stopped. Repository/HEAD/dirty files and exact sessions are checked; current support requires the same local workspace and worktree. See [behavior, adapters and live acceptance](docs/session-handoff-runtime.md). Phase 4 adds quota policies described below.

### Phase 4: Quota / Failover Manager

Use `failover arm <source> <candidate1,candidate2> <goal-and-constraints>` to authorize an ordered set of existing sessions. Report observations with `quota report <pane> <available|limited|exhausted|unknown> <budget-group> [valid-seconds]`. A source limited/exhausted report prepares a checkpoint without calling its model. After stopping source/background writers, `failover run <id> confirm-source-stopped` chooses a fresh available candidate on a different budget, verifies recovery and repository state, transfers ownership, then continues. `quota status`, `failover status [id]`, and `failover cancel <id>` inspect or release policies.

This version uses operator reports, not provider quota APIs. Expired/unknown/shared-budget-conflicting observations cannot authorize a destination. No account/credential rotation or automatic retry after uncertain dispatch. See [commands, journal behavior, limitations and live acceptance](docs/quota-failover-manager.md).

Grok terminal support targets the observed 1.0.46 boxed and completed unboxed answers, including wrapped
Bridge response markers. It is not a structured transcript source; clipped boxes
and changed terminal formats can leave capture incomplete. See ISSUE-023 in
[known issues](docs/known-issues.md) for validation and deployment status.

Discord response capture waits up to 30 seconds if the original Agent or its known session metadata temporarily disappears. It resumes only after the original identity is verified; explicit session replacements stop capture. Reusing a Discord thread routes to a live pane and does not restore its old CLI conversation. Live acceptance remains pending (ISSUE-003/008).

Claude terminal capture handles multiline prompt echoes and message gutters; it is
an observed excerpt, not a native transcript. Claude image delivery now uses local file paths (2026-10-05, pending live Discord acceptance).
If Herdr omits Claude session identity, coding review and session handoff/failover
keep their known-session requirements. Live acceptance is pending in
[ISSUE-026](docs/known-issues.md); build and fixture tests do not establish Discord acceptance.

## Sending files back to Discord

An Agent can attach files to its final reply by putting `[[discord-attach: /absolute/path]]` on its own line. Files must be regular, non-empty, ≤ 8 MiB, at most 10 per reply, and located under the Agent's working directory (secrets such as `.env` and `.git` are refused). Tell your Agent about this convention (e.g. in its `AGENTS.md`). See SPEC.md and ISSUE-034.

If you talk to an Agent directly in Herdr, it can also ask the bridge to post to the Discord thread mapped to it: `[[discord-send]]` / text / `[[/discord-send]]` for a message, or `[[discord-attach: /path]]` for a file. The bridge relays them when the Agent becomes idle (ISSUE-037; pending live acceptance).

The marker convention is packaged as the [discord-send skill](skills/discord-send/SKILL.md); link it into your agent's skills directory (e.g. `ln -s "$PWD/skills/discord-send" ~/.claude/skills/discord-send`) so every project's agent knows it.

### Hook channel (Claude, Codex) — ISSUE-045

Single-Agent automatic observation uses visible snapshots, including post-completion marker scanning (ISSUE-050). Off-screen content requires hook/transcript delivery; prefer `herdr-discord-send` for outbound messages and files. Without a final, captured output may be incomplete. Explicit `read` can still request history.

By default the bridge reads each reply from the terminal screen (the parser). A CLI hook gives it the reply and the permission request directly, which is more reliable. **Hook is preferred; the parser is always kept as the fallback**, a missing hook or lost event falls back to screen capture, which may be incomplete when the reply boundary has scrolled away. Install the pi extension on each machine running pi, then run `/reload` in that pi session or restart pi. Restarting only the bridge does not load pi extensions (ISSUE-045/033).

| CLI    | Hooks to enable                                                                                       | Where                                                                                                                                                           | Extra step                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude | `Stop`, `PermissionRequest`                                                                           | `~/.claude/settings.json`                                                                                                                                       | none                                                                                              |
| Codex  | `Stop` only (permissions use `y`/`esc` hotkeys; a `PermissionRequest` hook would hide Codex's prompt) | `~/.codex/hooks.json`                                                                                                                                           | run `/hooks` inside Codex and trust the entry (until trusted it is skipped)                       |
| agy    | `Stop` only (permissions stay on the screen parser)                                                   | `~/.gemini/config/hooks.json` (group `herdr-discord-bridge`, `{ "Stop": [{ "command": ".../scripts/herdr-discord-hook", "timeout": 10, "type": "command" }] }`) | none                                                                                              |
| pi     | extension, `agent_settled` (permissions: pi has no built-in prompts)                                  | `~/.pi/agent/extensions/herdr-discord-bridge.ts`                                                                                                                | `cp scripts/pi/herdr-discord-bridge.ts ~/.pi/agent/extensions/`, then restart pi or run `/reload` |
| others | not supported yet                                                                                     | —                                                                                                                                                               | parser only                                                                                       |

Add both events pointing at the absolute path of `scripts/herdr-discord-hook` (the `Stop` timeout can be short, the `PermissionRequest` timeout should be about 300 seconds):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/scripts/herdr-discord-hook",
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/scripts/herdr-discord-hook",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

- Check the state with `hooks` in Discord (`@bot hooks`) or at the `bridge>` console: it shows the mode and whether each event is registered. Codex trust is not detected; check `/hooks` in Codex.
- Choose the channel per CLI in the plugin `config.json`: `"hookTransport": { "claude": "auto", "codex": "auto" }`. `auto` (default) = hook first, parser fallback. `parser` = ignore hooks for that CLI. Restart the bridge after changing it.
- With a hook, reply `allow` / `deny` (or press the approve button) in the approval thread to answer a permission prompt; other text, including option numbers, is typed into the TUI as before. Permission hooks only fire when the CLI actually asks (Claude's auto mode never asks; Codex asks only for commands that need approval).
- The bridge must be running for the hook to do anything; without it the hook exits silently and the TUI works as usual.

Preferred for Agents: the `herdr-discord-send` command (`scripts/herdr-discord-send`; link it onto PATH, e.g. `ln -s "$PWD/scripts/herdr-discord-send" ~/.local/bin/herdr-discord-send`). `herdr-discord-send "text"`, `--file PATH`, `--stdin`. It talks to the running bridge over a user-only local socket (`~/.config/herdr-discord-bridge/send.sock`), identifies the pane by `HERDR_PANE_ID`, and fails clearly when the pane has no mapped thread. Pending live acceptance (ISSUE-037).

Card files: `scripts/herdr-card-check FILE...` checks Markdown card files against the card format ([ADR-0001](docs/adr/0001-portable-md-cards.md), examples and Mantis conversion guide in [docs/card-examples](docs/card-examples/README.md)). Prints `OK`/`FAIL` per file; exit 0 all valid, 1 any invalid or unreadable, 2 usage error. Format only; run `npm run build` first. The bridge does not read cards. Pending acceptance (ISSUE-054).

Inbound attachments: besides PNG/JPEG/WebP images, any other Discord file (≤ 10 MiB, up to four per message) is saved under the Agent cwd and its path is given to the Agent (ISSUE-039; pending live acceptance).

### Hooks on remote machines

Remote Agents use the parser unless the machine sets `hookSocket` (an absolute path on the remote). The bridge then keeps a second `ssh -R <hookSocket>:<local hook socket>` open (separate from the `-L` tunnel, so a failed forward never breaks remote control) and creates the remote directory with mode 0700. On the remote, install `scripts/remote/herdr-discord-hook.py` (Python 3 only, no Node) and register it as the CLI's `Stop` hook; for agy that is `~/.gemini/config/hooks.json`: `{ "herdr-discord-bridge": { "Stop": [{ "command": "/root/.local/bin/herdr-discord-hook.py --machine <id>", "timeout": 10, "type": "command" }] } }`. Claude/Codex-style `Stop` payloads are accepted too. The remote script reads the agy transcript on the remote, so no transcript file crosses the tunnel.
