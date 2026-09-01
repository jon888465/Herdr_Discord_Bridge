const ANSI_ESCAPE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function splitDiscordText(value: string, maxLength = 1900): string[] {
  const clean = stripAnsi(value).trim();
  if (!clean) return ["(no output)"];
  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.5))
      cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < 1) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function codeBlock(value: string, language = "text"): string {
  return "```" + language + "\n" + value.replace(/```/g, "``\u200b`") + "\n```";
}

export function agentHeader(
  agentName: string,
  workspaceId: string,
  paneId: string,
  agentKind?: string,
): string {
  const kind = agentKind && agentKind !== agentName ? ` · ${agentKind}` : "";
  const rows = [
    boxRow(`🤖 ${cleanBoxValue(agentName)}${cleanBoxValue(kind)}`),
    boxRow(`Workspace: ${cleanBoxValue(workspaceId)}`),
    boxRow(`Pane: ${cleanBoxValue(paneId)}`),
  ];
  return codeBlock(
    [
      "┌─────────────────────────────┐",
      ...rows,
      "└─────────────────────────────┘",
    ].join("\n"),
  );
}

function boxRow(value: string): string {
  const clipped = value.slice(0, 27);
  return `│ ${clipped.padEnd(27, " ")} │`;
}

function cleanBoxValue(value: string): string {
  return stripAnsi(value).replace(/[\r\n]/g, " ");
}

export function statusEmoji(status: string): string {
  switch (status) {
    case "working":
      return "🟡";
    case "blocked":
      return "🔴";
    case "done":
      return "🟢";
    case "idle":
      return "⚪";
    default:
      return "⚫";
  }
}
