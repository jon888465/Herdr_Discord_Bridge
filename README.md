# Herdr Discord Bridge

Drive coding agents that are already running in Herdr panes from Discord. The
bridge uses Discord's outbound Gateway WebSocket and Herdr's local socket; it
does not expose a public HTTP endpoint and does not replace Herdr's PTY/runtime.

## Install as a Herdr plugin

```text
herdr plugin install jon888465/Herdr_Discord_Bridge
herdr plugin config-dir herdr-discord-bridge
cp config.example.jsonc <config-dir>/config.json
herdr plugin pane open herdr-discord-bridge/bridge
```

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
/herdr agents
/herdr status
/herdr current
/herdr use <agent-name-or-pane-id>
/herdr ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr read <agent-name-or-pane-id>
/herdr wait <agent-name-or-pane-id>
/herdr cancel <agent-name-or-pane-id>
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask <prompt>
```

When `requireMention` is enabled, mention the bot for both forms, for example
`@bridge agents` or `@bridge /herdr agents`. In a mapped thread, a message
whose first word is not a known command remains a direct prompt to the active
Agent.

`/herdr use <agent>` switches the active Agent for the current Discord thread
without moving or restarting any Herdr pane. `/herdr ask <agent> ...` sends a
one-shot prompt to an explicitly named Agent without switching the active
Agent. Agent, workspace, and pane IDs are looked up from Herdr JSON responses;
Discord users cannot provide arbitrary filesystem paths.

For a continuing one-to-one conversation, create a Discord thread and run
`/herdr use <agent-name-or-pane-id>` once. Subsequent ordinary messages in
that thread are sent only to the active Agent. The bridge requires an explicit
mention when `requireMention` is enabled. Each thread stores its active Agent
and can retain additional independent Agent mappings with `team add`; those
mappings are not automatically given the thread's full history.

`/herdr team ask ...` deliberately sends only the supplied prompt to each
participant. It does not copy the Discord thread or terminal history. Use
`/herdr handoff <from> <to>` when a CLI reaches a token/context limit. Handoff
reads only a bounded recent output window (`handoffLines` and
`handoffMaxChars`), redacts common credential formats, posts a concise bounded
summary, and sends that summary to the destination Agent.

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
