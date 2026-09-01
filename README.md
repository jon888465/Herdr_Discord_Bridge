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

```text
/herdr workspaces
/herdr use <workspace-id-or-label>
/herdr target <agent-name-or-pane-id>
/herdr current
/herdr agents
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr read <agent-name-or-pane-id>
/herdr status
/herdr wait <agent-name-or-pane-id>
/herdr cancel <agent-name-or-pane-id>
```

The workspace and target commands select and inspect routing. Workspace and pane IDs are
looked up from Herdr JSON responses; Discord users cannot provide arbitrary
filesystem paths. Thread routing overrides user routing, which overrides the
channel default. Existing agents are not moved or restarted when routing changes.

For a continuing one-to-one conversation, create a Discord thread and run
`/herdr target <agent-name-or-pane-id>` once. Subsequent ordinary messages in
that thread are sent only to the selected Herdr agent. The bridge requires an
explicit mention when `requireMention` is enabled. `/herdr assign <agent> ...`
remains available for one-shot prompts and always names the target explicitly.
Use one Discord thread per agent when several CLIs are being used in parallel;
the bridge does not broadcast a thread message to every agent.

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
