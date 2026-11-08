import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "./format.js";

export interface CliOutputAdapter {
  modelCommand(model: string): string;
  parseUsage?(screen: string): string | undefined;
  /** 啟動參數的推理強度；沒有已確認的參數就不實作（拒絕，不猜）。 */
  levelArgs?(level: string): string[];
  extractLatestResponse(
    prompt: string,
    output: string,
    baseline: string,
  ): string;
}

class MarkerCliAdapter implements CliOutputAdapter {
  constructor(
    private readonly markers: readonly string[],
    private readonly modelCommandPrefix = "/model",
    readonly levelArgs?: (level: string) => string[],
  ) {}

  modelCommand(model: string): string {
    return this.modelCommandPrefix + " " + model;
  }

  extractLatestResponse(
    prompt: string,
    output: string,
    baseline: string,
  ): string {
    const normalizedOutput = stripAnsi(output).replace(/\r/g, "");
    const candidates = this.markers.map((marker) => `${marker}${prompt}`);
    const markerIndex = Math.max(
      ...candidates.map((marker) => normalizedOutput.lastIndexOf(marker)),
    );
    if (markerIndex >= 0) {
      const marker =
        candidates.find((item) =>
          normalizedOutput.slice(markerIndex).startsWith(item),
        ) || "";
      return stripCliChrome(
        normalizedOutput.slice(markerIndex + marker.length),
      );
    }
    const echoed = this.extractAfterEchoedFirstLine(prompt, normalizedOutput);
    if (echoed !== undefined) return echoed;
    return outputSinceBaseline(baseline, normalizedOutput);
  }

  /**
   * 多行 prompt 回顯時，CLI（如 agy）會縮排續行或插入分隔線，整段比對失敗；
   * 改以第一行定位，並略過縮排後的 prompt 續行與壓縮分隔線（ISSUE-038）。
   */
  private extractAfterEchoedFirstLine(
    prompt: string,
    output: string,
  ): string | undefined {
    const promptLines = stripAnsi(prompt)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const first = promptLines[0]?.slice(0, 80);
    if (!first || promptLines.length < 2) return undefined;
    const lines = output.split("\n");
    let at = -1;
    lines.forEach((line, i) => {
      if (this.markers.some((m) => line.startsWith(`${m}${first}`))) at = i;
    });
    if (at < 0) return undefined;
    const known = new Set(promptLines);
    let i = at + 1;
    while (
      i < lines.length &&
      (!lines[i]!.trim() ||
        known.has(lines[i]!.trim()) ||
        /^\s*─+[^─\n]*─+\s*$/.test(lines[i]!))
    )
      i += 1;
    return stripCliChrome(lines.slice(i).join("\n"));
  }
}

/** Grok 1.0.46 renders assistant messages in square boxes, unlike its rounded input. */
function grokResponses(output: string): string[] {
  const responses: string[] = [];
  let body: string[] | undefined;
  for (const line of stripAnsi(output).replace(/\r/g, "").split("\n")) {
    if (/^\s*┌[ ─]*┐\s*$/.test(line)) {
      body = [];
    } else if (body && /^\s*└[ ─]*┘\s*$/.test(line)) {
      responses.push(body.join("\n").trim());
      body = undefined;
    } else if (body) {
      const row = /^\s*│   (.*)│\s*$/.exec(line);
      if (!row) {
        body = undefined;
        continue;
      }
      let text = row[1]!.trimEnd();
      // The first row has a right-aligned UI clock, sometimes inside a wrapped marker.
      if (body.length === 0)
        text = text.replace(/ {2,}\d{1,2}:\d{2} (?:AM|PM)$/, "").trimEnd();
      body.push(text);
    }
  }
  // Later turns may render without a box. Require a visible user-message
  // boundary and the completed-turn footer; never parse the rounded input box.
  const lines = stripAnsi(output)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/ +█\s*$/, ""));
  let promptStart = -1;
  for (let i = 0; i < lines.length; i += 1)
    if (/^ {5}❯ /.test(lines[i]!)) promptStart = i;
  if (promptStart >= 0) {
    const tail = lines.slice(promptStart + 1);
    const separator = tail.findIndex((line) => !line.trim());
    const finish = tail.findIndex((line) => /^ {5}Worked for /.test(line));
    if (separator >= 0 && finish > separator) {
      const answer = tail.slice(separator + 1, finish);
      while (
        answer.length &&
        (!answer[0]!.trim() || /^ {5}◆ Thought for /.test(answer[0]!))
      )
        answer.shift();
      while (answer.length && !answer.at(-1)!.trim()) answer.pop();
      if (
        answer.length &&
        answer.every((line) => !line.trim() || /^ {5}/.test(line))
      ) {
        const body = answer.map((line) => line.slice(5).trimEnd());
        body[0] = body[0]!
          .replace(/ {2,}\d{1,2}:\d{2} (?:AM|PM)$/, "")
          .trimEnd();
        responses.push(body.join("\n").trim());
      }
    }
  }
  return responses;
}

const CLAUDE_BANNER = /^\s*Update available!/;
/** 回合結束且使用者離開一段時間後，Claude 會在回合尾巴下方補一行 `※ recap: …`（ISSUE-044）。 */
const CLAUDE_RECAP = /^\s*※ /;
const CLAUDE_TURN_FOOTER = /^\s*[✻✽✶✳✢·] \S+ for (?:\d+h )?(?:\d+m )?\d+s\b/;

/**
 * Claude 回合結束後會在回覆下方印出 `✻ <動詞> for <時間>`。畫面上最後一個內容列
 * （略過更新提示與輸入框）若不是它，回覆可能仍在串流，不能當成最終回覆（ISSUE-040）。
 */
export function claudeTurnComplete(raw: string): boolean {
  const lines = stripAnsi(stripClaudeInputBox(raw))
    .replace(/\r/g, "")
    .split("\n")
    .filter(
      (line) =>
        line.trim() && !CLAUDE_BANNER.test(line) && !CLAUDE_RECAP.test(line),
    );
  const last = lines.at(-1);
  return last !== undefined && CLAUDE_TURN_FOOTER.test(last);
}

/** Claude's two-column message gutter is presentation, not body indentation. */
function claudeResponseText(output: string): string {
  const body: string[] = [];
  let inMessage = false;
  let inCode = false;
  let messageStart = 0;
  for (const line of stripAnsi(output).replace(/\r/g, "").split("\n")) {
    if (!inCode && CLAUDE_BANNER.test(line)) continue;
    if (!inCode && /^(?: ?[❯>](?: |$)|[─━]{8,}|[✻✽✶✳✢·] )/.test(line)) {
      inMessage = false;
      continue;
    }
    const first = /^ ?[⏺●] (.*)$/.exec(line);
    if (!inCode && first) {
      while (body.length && !body.at(-1)!.trim()) body.pop();
      messageStart = body.length;
      if (body.length) body.push("");
      body.push(first[1]!);
      inMessage = true;
      inCode = first[1]!.startsWith("```");
    } else if (inMessage) {
      if (!inCode && /^\s*⎿/.test(line)) {
        // A tool heading may echo the nonce too; discard the whole tool block.
        body.length = messageStart;
        inMessage = false;
        continue;
      }
      if (!line.trim()) {
        body.push("");
      } else if (line.startsWith("  ")) {
        const text = line.slice(2);
        body.push(text);
        if (/^```/.test(text)) inCode = !inCode;
      } else {
        inMessage = false;
        inCode = false;
      }
    }
  }
  return body.join("\n").trim();
}

/**
 * Claude's bottom input box (rule, "❯ draft", rule, status line) holds whatever
 * the user has typed next. It is not a conversation turn, so drop it before
 * looking for the echoed prompt.
 */
export function stripClaudeInputBox(output: string): string {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n");
  const isRule = (line: string) => /^[─━]{8,}\s*$/.test(line);
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (isRule(lines[i]!)) {
      bottom = i;
      break;
    }
  if (bottom < 0) return output;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--)
    if (isRule(lines[i]!)) {
      top = i;
      break;
    }
  // The live input box puts a no-break space after the prompt glyph.
  if (top < 0 || !/^ ?[❯>](?:[  ]|$)/.test(lines[top + 1] ?? "")) return output;
  return lines.slice(0, top).join("\n");
}

/** Only the latest nonempty user block can establish this prompt's scope. */
function claudePromptTail(prompt: string, output: string): string | undefined {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n");
  let start = -1;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^ ?[❯>] (.+)$/.test(lines[i]!)) continue;
    start = i;
    end = i + 1;
    while (
      end < lines.length &&
      (lines[end]!.startsWith("  ") || !lines[end]!.trim())
    ) {
      // Tool output and the input status area are not multiline user text.
      if (/^\s*[⎿⏵]/.test(lines[end]!)) break;
      end++;
    }
    i = end - 1;
  }
  // Claude 把貼上的附圖路徑換成 [Image #n] 並省略該路徑行；兩側都去除再比對。
  const normalized = (text: string) =>
    text
      .replace(/\[Image #\d+\]/g, "")
      .replace(
        /^\s*"[^"\n]*\.herdr-discord-bridge\/attachments\/[^"\n]*"\s*$/gm,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
  if (start < 0) return;
  // A terminal wrap may split a Chinese phrase or an English word without a
  // space. Only displayed row boundaries are optional whitespace; keep the
  // characters and spaces within each row intact.
  const wanted = normalized(prompt);
  // Indented lines after the echo may be a tool summary (e.g. "Ran 1 shell
  // command") rather than user text, so accept the longest prefix that matches.
  for (let last = end; last > start; last--) {
    const echoed = lines
      .slice(start, last)
      .map((line, index) =>
        index === 0 ? line.replace(/^ ?[❯>] /, "") : line.slice(2),
      );
    const rows = echoed.map(normalized).filter(Boolean);
    const escaped = rows.map((row) =>
      row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    if (new RegExp("^" + escaped.join("\\s*") + "$", "u").test(wanted))
      return lines.slice(last).join("\n");
  }
  return;
}

/** A clipped screen can start mid-message; restore the "⏺ " marker its first line lost. */
function restoreClippedClaudeMessage(output: string): string {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (
    first < 0 ||
    !lines[first]!.startsWith("  ") ||
    /^\s*[⎿⏵]/.test(lines[first]!)
  )
    return lines.join("\n");
  lines[first] = "⏺ " + lines[first]!.slice(2);
  return lines.join("\n");
}

class ClaudeCliAdapter implements CliOutputAdapter {
  modelCommand(model: string): string {
    return "/model " + model;
  }

  levelArgs(level: string): string[] {
    return ["--effort", level];
  }

  extractLatestResponse(
    prompt: string,
    output: string,
    baseline: string,
  ): string {
    const live = stripClaudeInputBox(output);
    const hadInputBox = live !== output;
    output = live;
    const tail = claudePromptTail(prompt, output);
    // A visible different user turn must never be bypassed by baseline diffing.
    const hasUser = /^ ?[❯>] .+/m.test(stripAnsi(output));
    if (tail === undefined && hasUser) return "";
    let source = tail;
    if (source === undefined && baseline.trim())
      source = outputSinceBaseline(baseline, output);
    // A long answer scrolls its own prompt echo and first lines out of a
    // visible-only read of the live screen. With no user turn on screen and
    // a screen that differs from the baseline, the visible text is the answer.
    if (
      !source?.trim() &&
      hadInputBox &&
      stripAnsi(output).trim() !== stripAnsi(baseline).trim()
    )
      source = restoreClippedClaudeMessage(output);
    const text = claudeResponseText(source ?? "");
    const old = claudeResponseText(
      claudePromptTail(prompt, baseline) ?? baseline,
    );
    return text && text !== old ? text : "";
  }
}

/**
 * pi (https://pi.dev) 的 TUI 沒有 user／assistant 前綴符號：兩者都只縮排一個
 * 空白（user 以背景色區分，純文字讀取看不到）。底部依序是輸入框（上下兩條
 * 分隔線）與頁尾狀態列；工具區塊以 ` $ cmd` 之類標題開頭，以 ` Took <時間>` 結尾。
 */
const piRule = (line: string) => /^[─━]{8,}\s*$/.test(line);

function piLines(output: string): string[] {
  return stripAnsi(output).replace(/\r/g, "").split("\n");
}

/** 去除底部輸入框與頁尾狀態列（含其中尚未送出的草稿）。 */
function stripPiInputBox(output: string): string {
  const lines = piLines(output);
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (piRule(lines[i]!)) {
      bottom = i;
      break;
    }
  if (bottom < 0) return output;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--)
    if (piRule(lines[i]!)) {
      top = i;
      break;
    }
  // 輸入框之下只可能是頁尾（路徑、用量、extension status），不是對話內容。
  return lines.slice(0, top < 0 ? bottom : top).join("\n");
}

/** 單列：移除 pi 的一欄 gutter。 */
const piUngutter = (line: string) =>
  line.startsWith(" ") ? line.slice(1) : line;

const PI_TOOL_HEADER = /^ (?:\$ |(?:read|write|edit|grep|find|ls) \S)/;
const PI_SPINNER = /^\s*[⠁-⣿]\s+\S.*$/u;

/** 移除 spinner 與已完成的工具區塊；回答本文維持原有縮排。 */
function piResponseText(source: string): string {
  const lines = piLines(source);
  const body: string[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inCode && PI_SPINNER.test(line)) continue;
    const afterBlank = i === 0 || !lines[i - 1]!.trim();
    if (!inCode && afterBlank && PI_TOOL_HEADER.test(line)) {
      const took = lines.findIndex(
        (item, index) => index > i && /^ Took \S/.test(item),
      );
      // 沒有 Took 結尾（仍在執行或格式不同）時只丟標題列，不冒險吞掉回答。
      if (took >= 0) i = took;
      continue;
    }
    const text = piUngutter(line);
    if (/^```/.test(text.trimStart())) inCode = !inCode;
    body.push(text.trimEnd());
  }
  return body
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 找出最後一次出現的 prompt 回顯，回傳其後的文字。 */
function piPromptTail(prompt: string, output: string): string | undefined {
  const lines = piLines(output);
  const compact = (text: string) => text.replace(/\s+/g, " ").trim();
  const wanted = compact(prompt);
  if (!wanted) return;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let found: number | undefined;
  for (let start = 0; start < lines.length; start++) {
    const first = compact(lines[start]!);
    if (!first || !wanted.startsWith(first)) continue;
    const rows: string[] = [];
    for (let end = start; end < lines.length && end < start + 200; end++) {
      const row = compact(lines[end]!);
      if (row) rows.push(escape(row));
      // 軟折行可能切在英文單字或中文詞中間，只在顯示列邊界容許空白。
      const joined = rows.join("\\s*");
      if (new RegExp("^" + joined + "$", "u").test(wanted)) {
        found = end + 1;
        break;
      }
      if (!new RegExp("^" + joined, "u").test(wanted)) break;
    }
  }
  return found === undefined ? undefined : lines.slice(found).join("\n");
}

class PiCliAdapter implements CliOutputAdapter {
  modelCommand(model: string): string {
    return "/model " + model;
  }

  extractLatestResponse(
    prompt: string,
    output: string,
    baseline: string,
  ): string {
    const live = stripPiInputBox(output);
    const tail = piPromptTail(prompt, live);
    let source = tail;
    // 看不到 prompt 回顯時，只接受相對非空 baseline 的新增內容。
    if (source === undefined && baseline.trim())
      source = outputSinceBaseline(stripPiInputBox(baseline), live);
    const text = piResponseText(source ?? "");
    const oldBase = stripPiInputBox(baseline);
    const old = piResponseText(piPromptTail(prompt, oldBase) ?? oldBase);
    return text && text !== old ? text : "";
  }
}

export function normalizeTerminalResponse(
  agentKind: string | undefined,
  output: string,
): string {
  const kind = (agentKind || "").toLowerCase();
  if (kind.includes("claude")) return claudeResponseText(output);
  if (kind === "pi") return piResponseText(stripPiInputBox(output));
  return kind === "grok" ? grokResponses(output).join("\n\n") : output;
}

class GrokCliAdapter implements CliOutputAdapter {
  modelCommand(model: string): string {
    return "/model " + model;
  }

  extractLatestResponse(
    _prompt: string,
    output: string,
    baseline: string,
  ): string {
    const responses = grokResponses(output);
    const latest = responses.at(-1);
    // Redraws and disappearing UI chrome must not replay a previous answer.
    if (!latest || grokResponses(baseline).includes(latest)) return "";
    return latest;
  }
}

const grokAdapter = new GrokCliAdapter();
const claudeAdapter = new ClaudeCliAdapter();
const piAdapter = new PiCliAdapter();

class CodexCliAdapter extends MarkerCliAdapter {
  parseUsage(screen: string): string | undefined {
    // Only a complete bottom status row; never echo arbitrary conversation text.
    const bottom = stripAnsi(screen)
      .replace(/\r/g, "")
      .trimEnd()
      .split("\n")
      .at(-1)
      ?.trim();
    return bottom &&
      /^(?:\d+h) (?:100|[0-9]{1,2})% left · weekly (?:100|[0-9]{1,2})% left$/.test(
        bottom,
      )
      ? bottom
      : undefined;
  }
}

export function usageKind(kind: string | undefined): string {
  const identified = identifyCli(kind);
  return identified.adapter === genericAdapter ? "unknown" : identified.kind;
}

export function passiveUsage(
  kind: string | undefined,
  screen: string,
): string | undefined {
  try {
    return adapterFor(kind).parseUsage?.(screen);
  } catch {
    return undefined;
  }
}

const codexAdapter = new CodexCliAdapter(["› ", "❯ "], "/model", (level) => [
  "-c",
  `model_reasoning_effort=${level}`,
]);
const antigravityAdapter = new MarkerCliAdapter(["> "]);
const opencodeAdapter = new MarkerCliAdapter(["> "]);
const genericAdapter = new MarkerCliAdapter([
  "› ",
  "❯ ",
  "> ",
  "user: ",
  "User: ",
  "You: ",
]);

export function modelOptionsFor(agentKind: string | undefined): string[] {
  const kind = (agentKind || "").toLowerCase();
  if (kind.includes("claude")) return ["sonnet", "opus", "haiku"];
  if (kind.includes("codex"))
    return [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ];
  if (kind.includes("antigravity") || kind === "agy")
    return ["gemini-3.6-flash", "gemini-3.7-flash", "claude-opus-4.6"];
  return [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4-mini",
  ];
}

export function modelCommandFor(
  agentKind: string | undefined,
  model: string,
): string {
  return adapterFor(agentKind).modelCommand(model);
}

export function latestAgentResponse(
  agentKind: string | undefined,
  prompt: string,
  output: string,
  baseline: string,
): string {
  return adapterFor(agentKind).extractLatestResponse(prompt, output, baseline);
}

/**
 * 畫面上最後一次出現本次 prompt 之後，若又出現其他使用者輸入列（如 `❯ 其他內容`），
 * 代表對話已前進（使用者直接在 pane 輸入），舊 prompt 的 rewatch 不應再擷取。
 */
export function conversationMovedPast(prompt: string, output: string): boolean {
  const key = stripAnsi(prompt).trim().split("\n")[0].slice(0, 40);
  if (!key) return false;
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n");
  let last = -1;
  lines.forEach((line, i) => {
    if (/^\s*[❯›>]\s/.test(line) && line.includes(key)) last = i;
  });
  if (last < 0) return false;
  return lines
    .slice(last + 1)
    .some((line) => /^\s*[❯›>]\s+\S/.test(line) && !line.includes(key));
}

/** 只檢查格式（不得以 `-` 開頭）；有效值由 CLI 自己回應，不寫死清單。 */
const LEVEL_FORMAT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;

export function levelArgsFor(
  agentKind: string,
  level: string,
): { ok: true; args: string[] } | { ok: false; reason: string } {
  if (!LEVEL_FORMAT.test(level))
    return {
      ok: false,
      reason: `不合法的 level "${level.slice(0, 40)}"（只接受英數字與 - _，不得以 - 開頭，≤32 字元）`,
    };
  const adapter = adapterFor(agentKind);
  if (!adapter.levelArgs)
    return {
      ok: false,
      reason: `${agentKind} 沒有已確認的推理強度（level）參數，不猜`,
    };
  return { ok: true, args: adapter.levelArgs(level) };
}

export interface GitDirs {
  gitDir: string;
  commonDir: string;
}
export type GitDirResolver = (cwd: string) => GitDirs | undefined;

/** 在 cwd 執行 `git rev-parse`；任何失敗都回 undefined（呼叫端不加參數）。 */
const defaultGitDirResolver: GitDirResolver = (cwd) => {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--git-dir", "--git-common-dir"],
      { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter(Boolean);
    if (out.length !== 2) return undefined;
    return {
      gitDir: path.resolve(cwd, out[0]!),
      commonDir: path.resolve(cwd, out[1]!),
    };
  } catch {
    return undefined;
  }
};

/**
 * ISSUE-115：codex 的 workspace-write 沙箱只能寫 cwd；linked worktree 的 index／HEAD 在
 * `<主 repo>/.git/worktrees/<名稱>/`，在沙箱外，`git add` 等寫入會被擋。
 * 只有「codex、cwd 是 linked worktree、git 目錄 realpath 直接位於主 repo `.git/worktrees/` 底下」時，
 * 回傳 `--add-dir <該 git 目錄>`（只這一個目錄）。其他情況一律回空陣列，啟動參數維持不變。
 * 不放寬 approval／sandbox，也不加其他路徑。所有 codex 啟動入口都要經過這個函式。
 */
export function extraLaunchArgsFor(
  agentKind: string | undefined,
  cwd: string | undefined,
  resolve: GitDirResolver = defaultGitDirResolver,
): string[] {
  if (identifyCli(agentKind).kind !== "codex" || !cwd) return [];
  try {
    const dirs = resolve(cwd);
    if (!dirs) return [];
    const gitDir = fs.realpathSync(dirs.gitDir);
    const worktrees = path.join(fs.realpathSync(dirs.commonDir), "worktrees");
    if (path.dirname(gitDir) !== worktrees) return [];
    return ["--add-dir", gitDir];
  } catch {
    return [];
  }
}

export const CODEX_ADD_DIR_IGNORED =
  "codex 忽略了 --add-dir：--add-dir 被忽略，有效沙箱不是 workspace-write；bridge 不會改用更寬鬆的模式、不會退回成沒有該參數的啟動，也不會替人確認提示。請檢查 codex 的 sandbox 設定";

/** codex 因有效權限不允許額外可寫目錄而拒絕 `--add-dir` 時印出的訊息。 */
export function detectIgnoredAddDir(text: string): boolean {
  return (
    /Ignoring --add-dir/i.test(text) ||
    /do not allow additional writable roots/i.test(text)
  );
}

function identifyCli(agentKind: string | undefined): {
  kind: string;
  adapter: CliOutputAdapter;
} {
  const kind = (agentKind || "").toLowerCase();
  if (kind === "grok") return { kind: "grok", adapter: grokAdapter };
  if (kind === "pi") return { kind: "pi", adapter: piAdapter };
  if (kind.includes("claude"))
    return { kind: "claude", adapter: claudeAdapter };
  if (kind.includes("opencode"))
    return { kind: "opencode", adapter: opencodeAdapter };
  if (kind.includes("antigravity") || kind === "agy")
    return { kind: "agy", adapter: antigravityAdapter };
  if (kind.includes("codex")) return { kind: "codex", adapter: codexAdapter };
  return { kind, adapter: genericAdapter };
}

function adapterFor(agentKind: string | undefined): CliOutputAdapter {
  return identifyCli(agentKind).adapter;
}

/** Display-only names; identity and cleanup must continue to use IDs. */
export function agentDisplayName(input: {
  kind: string;
  role: "autopick" | "reviewer" | "worker" | "agent";
  cardId?: string;
  model?: string;
}): string {
  const kind = identifyCli(input.kind).kind;
  if (input.role === "autopick")
    return `autopick-${kind}-${input.cardId ?? ""}`.slice(0, 60);
  return `${kind}·${input.role}${input.model ? `·${input.model}` : ""}`;
}

function stripCliChrome(value: string): string {
  return value
    .split("\n")
    .filter(
      (line) =>
        !/^\s*gpt-[^\s]+\s+\S+\s+·\s+.+$/.test(line) &&
        !/^\s*[─-]{8,}\s*$/.test(line) &&
        !/^\s*\? for shortcuts\s*$/.test(line),
    )
    .join("\n")
    .trim();
}

function outputSinceBaseline(baseline: string, output: string): string {
  const normalizedBaseline = stripAnsi(baseline).replace(/\r/g, "");
  const normalizedOutput = stripAnsi(output).replace(/\r/g, "");
  if (!normalizedOutput.trim()) return "";
  if (!normalizedBaseline.trim()) return normalizedOutput.trim();
  if (normalizedOutput === normalizedBaseline) return "";
  if (normalizedOutput.startsWith(normalizedBaseline))
    return stripCliChrome(normalizedOutput.slice(normalizedBaseline.length));

  const baselineLines = normalizedBaseline.split("\n");
  const outputLines = normalizedOutput.split("\n");
  const maxOverlap = Math.min(baselineLines.length, outputLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (
      baselineLines.slice(-overlap).join("\n") ===
      outputLines.slice(0, overlap).join("\n")
    )
      return stripCliChrome(outputLines.slice(overlap).join("\n"));
  }
  return "";
}

/**
 * 判斷畫面是否「實質上沒變」：忽略行尾空白／不換行空白，並（Claude）排除輸入框與其下的狀態列。
 * 輸入框游標閃爍會讓 `❯` 與 `❯\u00a0` 交替出現，原始比較會誤以為畫面一直在變（ISSUE-044）。
 */
export function stableScreen(agent: string | undefined, raw: string): string {
  const text = (agent || "").toLowerCase().includes("claude")
    ? stripClaudeInputBox(raw)
    : raw;
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\u00a0\s]+$/u, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
