# Herdr Discord Bridge

Drive coding agents that are already running in Herdr panes from Discord. The
bridge uses Discord's outbound Gateway WebSocket and Herdr's local socket; it
does not expose a public HTTP endpoint and does not replace Herdr's PTY/runtime.

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

The complete local rebuild/restart flow is also available as a script:

```text
./scripts/rebuild-and-run.sh
```

It builds the checkout, closes existing Discord bridge panes, replaces the
installed plugin with a local link, and opens a fresh bridge pane. It does not
modify the plugin configuration or Discord token.

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
