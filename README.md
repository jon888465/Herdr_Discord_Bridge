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

All Herdr modes place the bridge in tab 1 of a dedicated workspace named `bridge`.
The script reuses that workspace or creates it with the project cwd and
`--no-focus`; duplicate names are rejected. Other Agent panes stay in place.
If an old bridge still runs in another workspace, the script reports its pane
ID and stops: explicitly move or stop that old bridge before restarting.
Only labelled non-Agent bridge panes in the dedicated tab are replaced.
The script does not modify the plugin configuration or Discord token.

### Select Herdr or Herdr Core

```text
Usage: scripts/run.sh [--herdr|--core] [-r|-rg]
Backend defaults to --herdr. Options may appear in any order.
-r: rebuild local checkout; -rg: reinstall from GitHub (Herdr only).
--core -rg is unsupported; no changes are made.
```

The existing commands above keep their Herdr behavior; `--herdr` makes that choice explicit. For Core, install `herdr-core` (tested with hc 0.1.20), Node.js, npm and jq. Use `./scripts/run.sh --core -r` to build this checkout and start a Core terminal, or `./scripts/run.sh --core` to use its existing build. Duplicate/conflicting flags, unknown arguments and Core `-rg` exit 2 before runtime/npm calls; `-h`/`--help` prints usage.

For direct Node startup, selection is `HERDR_BRIDGE_RUNTIME` > config `runtime` > `herdr`; unknown values fail without fallback. Set Core configuration in the usual bridge config directory (default `~/.config/herdr-discord-bridge/config.json`, overridden by `HERDR_PLUGIN_CONFIG_DIR`), including the Discord token/allowlists and:

```json
{"runtime":"core","coreAllowedTerminals":["t2"],"allowedWorkspaceIds":[],"machines":[]}
```

Use addresses obtained from Core, not the example t2 blindly. Empty `coreAllowedTerminals` allows listing and reading but rejects all input. Input also requires a current, live terminal and matching Core identity. Nonempty `allowedWorkspaceIds` or legacy `machines` rejects Core startup. Core socket selection is `HC_SOCKET` > `HC_TERMINAL_SOCKET` (injected by Core inside a Core terminal; used only when HC_SESSION is unset) > per session (`HC_SESSION`, default `default`): `$XDG_RUNTIME_DIR/herdr-core/<session>.sock` (where Core 0.1.20 listens on Linux, e.g. `/run/user/1000/herdr-core/default.sock`) and `$XDG_STATE_HOME|~/.local/state/herdr-core/<session>/<session>.sock` (macOS), taking whichever exists, else the XDG_RUNTIME_DIR candidate. `HERDR_SOCKET_PATH` applies only to Herdr; a `socket` set in Core's config.toml is not read, so set HC_SOCKET explicitly there. When the bridge was installed as a Herdr plugin, its config.json lives in `herdr plugin config-dir herdr-discord-bridge` rather than the standalone default `~/.config/herdr-discord-bridge`. Without explicit HERDR_PLUGIN_CONFIG_DIR, `run.sh --core` uses the standalone file when it exists, otherwise falls back to `~/.config/herdr/plugins/config/herdr-discord-bridge/config.json` together with Herdr's plugin state directory `~/.local/state/herdr/plugins/herdr-discord-bridge` and prints `Using Herdr plugin config: …`. If neither exists it refuses before any npm/herdr-core call, printing the path; an explicitly set directory without config.json is never overridden, only hinted (ISSUE-151).

Core currently supports listing, visible-screen reading, sending, keys and runtime status: `/herdr agents`, `read [terminal]`, `ask <terminal> <text>`, `status`, `agent keys <terminal> <keys...>` and `cancel [terminal]`. Within a thread, `target <terminal>`, `use <terminal>` or `agent use <terminal>` explicitly binds an authorized target before free-text prompts can be sent. Read uses lines:0 and marks incomplete output. Missing status remains unknown; sends do not force blocked programs or retry uncertain delivery. Other commands, including workspace, Team/card, pool/start, worktree, handoff, approval and failover, are explicitly rejected. There is no automatic final-response streaming in this minimal Core mode; use read to inspect output. The remaining command documentation describes Herdr unless stated otherwise.

Core run.sh checks status, starts the server once only on an explicit “no core running” failure, then polls readiness. Other errors stop. It checks live terminals for the same bridge role/project (using get if ls omits labels) and refuses duplicates. It never kills/removes terminals or stops/restarts Core, and never calls the old herdr CLI. The same bot instance lock prevents both backends from logging in together; an existing production bridge must be handled explicitly by its operator. `Core bridge terminal: <address>` confirms terminal creation, not successful Discord login.

The Herdr launcher explicitly passes `--env HERDR_BRIDGE_RUNTIME=herdr` (supported by the installed CLI), so `--herdr` and the default path select Herdr even when plugin config says core. Config is not rewritten. Core explicitly passes HERDR_PLUGIN_CONFIG_DIR and HERDR_PLUGIN_STATE_DIR (caller values, or resolved defaults), plus caller HC_SOCKET/HC_SESSION when set. Inherited Core locator variables are cleared first. Tokens never appear in argv: Core launch clears HERDR_DISCORD_BOT_TOKEN/DISCORD_BOT_TOKEN and uses discord.botToken from JSONC config.json. If the caller supplies only an environment token and the file has none, run.sh refuses before launching; move that token into the private config file.

Core uses separate `core-routing.json` and `core-discord.json` under the bridge state directory; old Herdr routes are not migrated. Read-only validation is available with `HERDR_BRIDGE_RUNTIME=core node dist/src/index.js --dry-run`. As of 2026-11-12, automated tests and local Core dry-run passed; deployment, a running-bridge restart and real Core/Herdr startup plus Discord round trips remain pending. Design, errors, limits and acceptance steps: [Herdr Core runtime](docs/herdr-core-runtime.md), tracked in ISSUE-151.

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

Start an Agent ad hoc: `agent start <machine:agent:model:level> [--cwd <path>]` (`/herdr` prefix in Discord). Omitted `machine`/`agent` follow the selected Agent; omitted `model`/`level` use the CLI default, e.g. `agent start :codex:gpt-6.1-sol:medium`. No auto `agent use`; trust prompts are never auto-confirmed. See `SPEC.md`, ISSUE-114 (not verified on a real machine).

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

E14 automatic candidates (updated 2026-11-11, ISSUE-140): when `--coding` has no specified Worker, the bridge enables claude/codex/pi profiles plus agy profiles whose `capabilities` include `implementation` or `review`; one eligible profile is sufficient. With a single profile, each coding assignment gets a fresh independent session so author/reviewer independence is preserved. Specified Workers are used as given. agy with missing, empty or analysis-only capabilities remains excluded; capabilities control automatic inclusion, not role assignment. The user reports pi has been verified as a coding Worker; detailed live evidence remains to be recorded. agy end-to-end acceptance is still pending (ISSUE-107).

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


### Remote card reviewer (optional)

Add `"cardReview": { "root": "/root/hdb-card-review", "kinds": ["agy"] }` to a machine to let a card declare `roles: {reviewer: "agy-pod:agy"}`: after the PR is pushed the bridge clones the GitHub `origin` over anonymous https into `<root>/` on that machine, checks out the PR head, verifies HEAD equals the PR head sha and runs the reviewer there (no credentials forwarded, no fallback to local). `root` is a bridge-only absolute path; `kinds` lists allowed agent kinds. Only `reviewer` can be remote; the card text and PR diff are sent to that machine. Without `cardReview` nothing changes, and cards without `roles` cannot get a remote reviewer picked by the Lead (follow-up card REQ-20261111-remote-in-task-roles). Not accepted on real machines yet (ISSUE-143, [docs/remote-card-reviewer.md](docs/remote-card-reviewer.md)).

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

Card files: `scripts/herdr-card-check [--ledger] FILE...` checks Markdown card files against the card format ([ADR-0001](docs/adr/0001-portable-md-cards.md), examples and Mantis conversion guide in [docs/card-examples](docs/card-examples/README.md)). Prints `OK`/`FAIL` per file; exit 0 all valid, 1 any invalid or unreadable, 2 usage error. Files over 512 KiB are refused (`--ledger` raises it to 1 MiB for operational cards). Format only; run `npm run build` first. Pending acceptance (ISSUE-054).

Operational cards (stage 2a, accepted 2026-11-02 — ISSUE-057): `card list [status]`, `card show <id>` and `card import` (attach one `.md` file on Discord; a local path in the console, optionally `--slug <name>`) work in Discord and the console. Cards live in `<state dir>/cards/` (not in git); the directory is created `0700`, and an existing one readable by others is refused with a `chmod 700` hint. Imported cards are always `draft`; set `status: ready` by editing the file. `card assign <id> [--coding]` (stage 2b step 2, accepted 2026-11-02 — ISSUE-058) hands a `ready` card (it needs a non-empty `## 描述` section) to the current workspace's Team exactly like `team ask`; the Agent receives only the title, description and acceptance criteria as fenced, redacted data. The card moves to `in_progress` and records the task id; when the Team task finishes, the bridge (checking every 60 seconds and at startup — ISSUE-059, accepted 2026-11-02) moves a completed card to `done` and only logs a failed or cancelled task, leaving the card `in_progress` for you to decide. If you delete a card while its task is still running, the bridge stops writing to it and tells the originating thread to choose `card recreate <id>`, `team cancel <task-id>` or do nothing (ISSUE-060, accepted 2026-11-02); it never cancels the task or recreates the card by itself.

Isolated worktrees (stage 3b, accepted 2026-11-03 — ISSUE-062; cleanup after merge is implemented — see the PR notes below; closing a bridge-opened source workspace is a planned follow-up): `card assign <id> --worktree` creates a Herdr-native git worktree (branch `card/<card id>`, based on the repo's current HEAD, no fetch) in the repo of the thread's active Agent, starts the same kind of Agent in the new workspace, moves the thread's route there and starts the task. If that Agent is blocked (Claude Code asks whether to trust the new folder) the bridge does not confirm for you: the task is not started and the reply tells you where to look. The card also shows the worktree's state (active / removed / kept because of uncommitted changes) in its `## 異動專案` section and in `card show`; a free-text `## 決議` section (written by you or an Agent, never rewritten by the bridge) is shown by `card show` too. `card merge <id> [--method squash|merge|rebase]` (ISSUE-083, implemented 2026-11-04, **not yet accepted live**; the first time the bridge merges by itself) merges the card's open PR only when the project policy is L2, the latest review passed on exactly the PR's current head with no open finding of medium severity or above (a `low` note does not block, ISSUE-100), CI is fully green, the PR is clean and up to date, and it touches no sensitive path — otherwise it lists every unmet condition and does nothing; it merges only the checked head, never forces past branch protection, and never deploys or restarts. `card loop <id>` (ISSUE-082, implemented 2026-11-04, **not yet accepted live**) runs review → fix → push → review by itself until the review passes or a person is needed (3 reviews at most, 2 attempts per head; the bridge pushes only this card's branch to the existing PR, never merges, and never pushes a fix that touches sensitive paths); `card loop stop <id>` stops it between steps. `card fix <id> [--agent <kind>]` (ISSUE-081, implemented 2026-11-04, **not yet accepted live**) hands the open review findings to a fresh Agent in a new pane (the kind of the last author), which fixes them in the card's worktree with one commit; the findings become `fixed`, nothing is pushed (run `card pr`, then `card review` again), and the loop stops after 3 reviews. `card review <id> [--agent <kind>]` (ISSUE-078, implemented 2026-11-04, **not yet accepted live**) opens a fresh pane with a different Agent to review the card's open PR, writes the findings and a `review_verdict` to the card, and closes the pane; the reviewer is read-only by instruction plus a working-tree check, not by OS isolation. Auto-pick (H2, ISSUE-096, implemented 2026-11-05, **not yet accepted live**; the bridge scans once a minute and does nothing unless `policy.yml` has an `autopick:` block): a project listed under `autopick:` in `policy.yml` (with its repo path, plus an explicit level under `projects:`) gets its `ready` cards started by the bridge one at a time, going as far as the project's level allows (L0 commit, L1 pull request, L2 review → CI → merge). `card commit <id>` (ISSUE-092, implemented 2026-11-05, **not yet accepted live**; the first time the bridge commits by itself) commits the version of a `--coding` task that reached ready-to-integrate onto the card's branch — only the verified files, refused if the worktree changed after verification or the index already has something staged, never pushes — so that `card pr` has a commit to push. `card pr <id>` (ISSUE-064, main path accepted 2026-11-03; its reply also warns when the PR touches sensitive paths such as `.github/`, `AGENTS.md`, `package.json`, `scripts/`, `SPEC.md` — a reminder only for now, ISSUE-071, accepted 2026-11-04) pushes a `done` card's `card/<id>` branch to `origin` and opens a PR — only for projects whose policy is L1 or higher, only github.com, never forced, PR title = card title and body = card id plus structured facts (the card's description is not published); afterwards the bridge checks the PR every minute, writes the CI result to the card and tells the originating thread, and reports when the PR is merged or closed; when it is merged the bridge also logs `merged` on the card and removes the card's worktree (never forced — uncommitted changes keep it; the branch and the source repo's workspace stay) — ISSUE-065, main path accepted 2026-11-03. It uses your existing `gh`/ssh login. `card policy [project]` shows per-project automation levels (L0 no push / L1 open a PR / L2 auto-merge) read from `<config dir>/policy.yml` — outside the project repos on purpose, read-only, and for now only a viewer: nothing acts on the levels yet (ISSUE-063, accepted 2026-11-03; as a Herdr plugin the file is `~/.config/herdr/plugins/config/herdr-discord-bridge/policy.yml`, next to `config.json`). A missing, invalid or unsafe file means every project is L0. `card cleanup <id>` refuses while the card's latest task is still running (ISSUE-070), removes the worktree but never forces it (uncommitted changes keep it), never deletes the branch and never closes the source repo's workspace.

Inbound attachments: besides PNG/JPEG/WebP images, any other Discord file (≤ 10 MiB, up to four per message) is saved under the Agent cwd and its path is given to the Agent (ISSUE-039; pending live acceptance).

### Hooks on remote machines

Remote Agents use the parser unless the machine sets `hookSocket` (an absolute path on the remote). The bridge then keeps a second `ssh -R <hookSocket>:<local hook socket>` open (separate from the `-L` tunnel, so a failed forward never breaks remote control) and creates the remote directory with mode 0700. On the remote, install `scripts/remote/herdr-discord-hook.py` (Python 3 only, no Node) and register it as the CLI's `Stop` hook; for agy that is `~/.gemini/config/hooks.json`: `{ "herdr-discord-bridge": { "Stop": [{ "command": "/root/.local/bin/herdr-discord-hook.py --machine <id>", "timeout": 10, "type": "command" }] } }`. Claude/Codex-style `Stop` payloads are accepted too. The remote script reads the agy transcript on the remote, so no transcript file crosses the tunnel.


Card role history (2026-11-08, ISSUE-127; live acceptance pending): `card show <id>` lists the Lead, each Lead-planned Team assignment id and actual Worker, and reviewer/fixer rounds with agent kind and known model. Machine, profile and task/round facts remain in the ledger. Old cards are not backfilled; absent history displays `沒有角色紀錄`. Duplicate role events are skipped and write failures only log to console. No role summary is added to PR bodies or notifications. Runtime deployment and live bridge verification are pending.

`usage` or `usage <exact-pane-or-profile-id>` (Discord: `/herdr usage`) prints a plain-text usage snapshot for the selected authorized workspace, configured profiles, and unreachable configured machines. It shares `quota status` workspace authorization. All panes, including idle/done, are read passively; no commands or keys are sent. Codex's complete bottom status row (e.g. `5h 35% left · weekly 85% left`) is preserved; unsupported/unreadable sources show `unknown` with a reason. Profiles require a safely matching bound session. Columns include machine, target, kind, usage, source and fetch time; fetch time is the screen-read attempt, not provider freshness. No estimates, credentials, quota observations or failover actions. Other CLI passive adapters and real Discord/Herdr/CLI acceptance remain pending (ISSUE-128).

### Card role assignments (source implemented; live acceptance pending)

<!-- prettier-ignore -->
```yaml
roles: {implement: "local:claude:sonnet", reviewer: "local:agy", fixer: "local:claude"}
```

Six roles are supported: implement, diagnose, review, verify, reviewer, fixer.
Each quoted value is `machine:agent:model`; omitted dimensions retain the existing
selection/default (`":claude"`, `"::sonnet"`, `"local"`). Cards without `roles`
keep existing behavior. Cards with roles require `card assign --coding`.
Models must match an enabled configured profile of the same agent kind; its
modelFlag/args are used. This is an administrator allowlist, not a provider model
catalog. New launches reject resume/session binding/model override arguments.
CLI `--agent` / loop `--fix-agent` cannot conflict with a card agent assignment.
Each constrained assignment and each review/fix round starts a fresh session.

A remote agy reviewer's own bridge-managed checkout (only that directory) is pre-trusted: ISSUE-143; not accepted on real machines.

Machine delivery in this change is declaration, validation and enforced **local**
execution. Unknown machines are rejected; configured remote machines are rejected
before picking unless it is a `reviewer` on a machine that opted in with
`machines[].cardReview` (ISSUE-143, see above). Other cross-machine
card execution remains unsupported. Invalid declarations retain
queryable rejection diagnostics; malformed cards use a separate persistent
`.role-rejections` store, with retrying notifications through strictly validated
routes. `card show` exposes the reason/delivery status. `role_assigned` records
machine, agent, known model and per-dimension sources using the bounded v2 format.
See `docs/card-role-assignment.md` and ISSUE-138 in `docs/known-issues.md` for the
contract, retry semantics and three live acceptance cards still required after
merge/restart. Unit tests do not establish live acceptance.
