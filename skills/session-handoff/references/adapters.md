# Source adapters and receiving harnesses

Read only the relevant section. These are recovery procedures, not installed
runtime integrations. Check the installed CLI's help before version-dependent
commands. Source and destination may be any two rows below; every destination
follows SKILL.md in its own current session.

| Harness                    | Preferred source evidence                                     | Fallback                                             | As destination                         |
| -------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| Claude Code                | Exact local transcript or native export                       | Checkpoint/artifacts                                 | Read this skill and selected source    |
| Codex CLI                  | Exact local rollout transcript                                | Checkpoint/artifacts                                 | Same                                   |
| GitHub Copilot CLI         | Exact session files or local Markdown export                  | Checkpoint/artifacts                                 | Same                                   |
| Antigravity CLI (`agy`)    | Available readable history/export for identified conversation | Checkpoint/artifacts; native decoding not guaranteed | Same                                   |
| OpenCode                   | Local native JSON session export                              | Checkpoint/artifacts                                 | Same                                   |
| Gemini CLI / other harness | Discovered documented local history/export                    | Checkpoint/artifacts                                 | Same, if file/tool access is available |

## Common selection and reading

Use session metadata/catalogs to narrow by exact ID and workspace before reading
content. For a supplied name, show only matching IDs, titles, cwd and dates if
ambiguous. Never use a `--last`/`--continue` shortcut as identity verification.
Respect configured storage roots; a default path is a discovery hint, not proof.
Do not print entire raw JSONL files: select public message/tool fields, omit
reasoning types, and redact secrets before showing/exporting text. Unknown
schemas need inspection of keys/types first; never stringify every record as a
fallback. Report missing/partial records and retained coverage.

Use native local export when it can run without inference. If export requires
an interactive source, prefer reading its accessible local records after quota
exhaustion. No source model turn is required by the protocol. Do not alter native
session storage, import databases, publish share links, or install a converter.

## Claude Code

Default transcript hint: `~/.claude/projects/<project>/<session-id>.jsonl`.
`CLAUDE_CONFIG_DIR` and project-directory configuration can change it. Prefer
the known `transcript_path` or exact session metadata over reconstructing the
encoded project directory. Locate the requested title within that project only.
Read public user/assistant text and tool-use/result blocks; omit thinking blocks.
Internal JSONL schemas vary. A source still available interactively can use its
documented `/export` to produce a local readable transcript; check syntax in that
version. `claude --resume` is same-harness continuation, not cross-CLI export.

Source: [Claude Code sessions](https://code.claude.com/docs/en/sessions).

## Codex CLI

Local discovery hint: `${CODEX_HOME:-~/.codex}/sessions`, with archived history
potentially in `archived_sessions` under the same root. Match exact session ID
and `session_meta` cwd rather than the newest rollout filename. Missing archives
are normal. `history.jsonl`, if present, is not proof of a full conversation.
Read public user/assistant message and tool-call/result records; exclude
reasoning items, encrypted payloads and analysis-channel messages. Deduplicate
equivalent event/response representations using available IDs. Record compaction
gaps. Local layouts are version-dependent discovery hints, not a stable API.
`codex resume` is native continuation, not a way to import another provider's log.

Source: [Codex CLI](https://developers.openai.com/codex/cli/features/).
The local `sessions` hint was also checked against this project's Codex capture
implementation on 2026-09-18; verify the actual source machine's storage root.

## GitHub Copilot CLI

Default local session data lives in `~/.copilot/session-state/`; honor configured
home overrides supported by the installed version. Resolve the exact session
directory and inspect metadata before reading public transcript events. Search
indexes/session-store summaries may contain only a subset; they are not the full
transcript. If the source TUI is available, `/share file <local-path>` produces a
Markdown export. Use that explicit local form: bare `/share` can publish a link.
No new source inference or remote sharing is needed for takeover.

Sources: [session storage](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle),
[local export](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle).

## Gemini Antigravity / AGY

Identify the executable first: `agy` (Antigravity CLI) and `gemini` (Gemini CLI)
are different products. Do not point AGY recovery at Gemini CLI history merely
because both use Gemini models.

`agy --help` supports `--conversation <ID>` for native continuation; `/resume`
offers a session picker. Neither is a documented cross-harness transcript export.
The documented `~/.gemini/antigravity-cli/cache/last_conversations.json` maps cwd
to a recent ID; it is only an identity hint, not conversation content, and does
not resolve arbitrary named sessions. Do not select its ID without verification.

Use an explicit readable local transcript/export or history interface supplied
by the installed AGY version, checking its actual capabilities first. Do not
invent an export command or decode undocumented binary/private service state.
If no readable history is accessible, recover from HANDOFF.md, task artifacts,
and explicitly identified visible conversation excerpts. Mark recovery partial.
Preparing a checkpoint while AGY can still run is therefore especially useful.

As destination, AGY reads the same skill/packet and performs the same verification;
it does not require importing a Claude/Codex session into Antigravity storage.

Sources: [AGY resume and cache](https://antigravity.google/docs/cli/commands/resume),
[Antigravity skills](https://antigravity.google/docs/skills).
Local `agy --help` checked 2026-09-18: conversation resume and print output formats
exist; no general transcript-export subcommand was advertised. Print output
format is not evidence of a historical export API.

## OpenCode

Check `opencode session --help` and the installed export help. Use
`opencode session list` to identify a session by ID/title/project; verify cwd.
Some versions use `opencode export <ID>`, newer documentation uses
`opencode session export <ID>`. Choose the form actually supported. Capture JSON
to a local file; use `--sanitize` if supported, then still select public fields
and inspect for secrets. Never omit the ID and implicitly export a different
session. Do not assume older JSON storage paths remain valid across SQLite-based
versions. Cross-CLI recovery reads the export; native `import` is unnecessary.

Sources: [CLI export](https://opencode.ai/docs/cli/),
[v2 commands](https://opencode.ai/v2/docs/cli/commands/).

## Gemini CLI and other harnesses

Inspect the actual product/version's help or official docs for read-only history
listing and local export. Select using exact ID plus workspace. Apply the same
public-record filtering and evidence reconciliation. If storage is inaccessible
or undocumented, use the portable packet instead of claiming native support.
No provider-specific automatic quota switch is implied.
