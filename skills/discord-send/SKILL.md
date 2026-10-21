---
name: discord-send
description: Sends a message, URL or file from a Herdr-hosted coding agent to its mapped Discord thread through the Herdr Discord Bridge. Use when the user says to send, post or forward something to Discord (傳給 discord、貼到 discord、把網址／檔案傳到 discord, e.g. a temporary tunnel URL, report or image) while talking to you in Herdr or Discord.
---

# Send to Discord via the bridge

Run the `herdr-discord-send` command with Bash. It asks the running bridge (which
owns the Discord bot) to post to the Discord thread mapped to this pane, using
`$HERDR_PANE_ID` to identify you. Do not call Discord yourself or look for tokens.

```bash
herdr-discord-send "訊息或完整網址"
herdr-discord-send --file /path/to/report.pdf
herdr-discord-send --file ./a.png "附上說明"
printf '%s\n' "多行內容" | herdr-discord-send --stdin
```

- Write URLs as full plain text (`https://example.com/path`).
- Files: regular, non-empty, at most 8 MiB, at most 10 per call, and under this
  agent's working directory (`.env*`, `.git`, `.ssh` and key files are refused).
  Create generated files there first, for example `.herdr-discord-bridge/outbox/`.
- Text is limited to 8000 characters. Never include secrets or tokens.

**Discord DM conversations work too.** If the pane has no mapped thread, the bridge
sends back to the Discord conversation (for example the DM) that most recently
prompted this agent, within the last 12 hours. The error "no mapped Discord thread
and no recent Discord conversation" therefore means nobody has prompted this pane
from Discord recently; in that case put the full plain-text URLs in your normal reply
instead of treating it as a hard failure.

The command prints the result and exits non-zero on failure. Report that result
to the user as is: "pane has no mapped Discord thread" and "bridge is not
running" are real failures, not something to retry blindly or claim as sent.

## Fallback when the command is missing

If `herdr-discord-send` is not installed, print markers in your reply instead;
the bridge relays them once you become idle. Each on its own line:

```text
[[discord-send]]
訊息或完整網址
[[/discord-send]]
[[discord-attach: /absolute/path/to/file]]
```
