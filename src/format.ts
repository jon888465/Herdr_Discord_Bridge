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

/**
 * 每則訊息開頭的 Agent 識別：單行、不畫框（Discord 的程式碼區塊本身已有底色）。
 * 遠端 machine 的 ID 帶 `<machine>:` 前綴（pane 為 `m:w2:p1`），機器名只由 Pane 欄位呈現；
 * WK 欄位去掉重複的前綴；Pane 保留完整 ID，方便直接複製給指令使用。
 */
export function agentHeader(
  agentName: string,
  workspaceId: string,
  paneId: string,
  agentKind?: string,
  workspaceName?: string,
): string {
  const name = headerField(agentName, 24);
  // 先清理再比較，避免 ANSI／換行讓同名的 kind 被當成不同。
  const kindClean = agentKind ? headerField(agentKind, 24) : "";
  const kind = kindClean && kindClean !== name ? ` · ${kindClean}` : "";
  const pane = headerField(paneId, 60);
  const machine = pane.split(":").length >= 3 ? pane.split(":")[0] : "";
  const bare = (value: string) =>
    machine && value.startsWith(`${machine}:`)
      ? value.slice(machine.length + 1)
      : value;
  const wk = bare(headerField(workspaceId, 24));
  const wkName = workspaceName ? bare(headerField(workspaceName, 20)) : "";
  // 每個欄位各自限長，長名稱不會把最後的 Pane 擠出視窗（手機版程式碼區塊不換行）。
  return codeBlock(
    [
      `🤖 ${name}${kind}`,
      `WK: ${wk}${wkName && wkName !== wk ? ` · ${wkName}` : ""}`,
      `Pane: ${pane}`,
    ].join(" │ "),
  );
}

/** 去 ANSI／換行、把欄位分隔符換掉，並以字元（非 UTF-16 單元）截斷，避免切壞 emoji。 */
function headerField(value: string, max: number): string {
  const clean = cleanBoxValue(value).replace(/│/g, "|").trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean;
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
