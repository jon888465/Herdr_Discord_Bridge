import { stripAnsi } from "./format.js";

export interface CliOutputAdapter {
  modelCommand(model: string): string;
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
    return outputSinceBaseline(baseline, normalizedOutput);
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

/** Claude's two-column message gutter is presentation, not body indentation. */
function claudeResponseText(output: string): string {
  const body: string[] = [];
  let inMessage = false;
  let inCode = false;
  let messageStart = 0;
  for (const line of stripAnsi(output).replace(/\r/g, "").split("\n")) {
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
function stripClaudeInputBox(output: string): string {
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

const codexAdapter = new MarkerCliAdapter(["› ", "❯ "]);
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

function adapterFor(agentKind: string | undefined): CliOutputAdapter {
  const kind = (agentKind || "").toLowerCase();
  if (kind === "grok") return grokAdapter;
  if (kind === "pi") return piAdapter;
  if (kind.includes("claude")) return claudeAdapter;
  if (kind.includes("opencode")) return opencodeAdapter;
  if (kind.includes("antigravity") || kind === "agy") return antigravityAdapter;
  if (kind.includes("codex")) return codexAdapter;
  return genericAdapter;
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
