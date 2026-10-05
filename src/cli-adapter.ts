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

/** Only the latest nonempty user block can establish this prompt's scope. */
function claudePromptTail(prompt: string, output: string): string | undefined {
  const lines = stripAnsi(output).replace(/\r/g, "").split("\n");
  let start = -1;
  let echoed = "";
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^ ?[❯>] (.+)$/.exec(lines[i]!);
    if (!match) continue;
    start = i;
    echoed = match[1]!;
    end = i + 1;
    while (
      end < lines.length &&
      (lines[end]!.startsWith("  ") || !lines[end]!.trim())
    ) {
      // Tool output and the input status area are not multiline user text.
      if (/^\s*[⎿⏵]/.test(lines[end]!)) break;
      echoed += "\n" + lines[end]!.slice(2);
      end++;
    }
    i = end - 1;
  }
  const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
  if (start < 0) return;
  // A terminal wrap may split a Chinese phrase or an English word without a
  // space. Only displayed row boundaries are optional whitespace; keep the
  // characters and spaces within each row intact.
  const rows = echoed.split("\n").map(normalized).filter(Boolean);
  const escaped = rows.map((row) => row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (
    !new RegExp("^" + escaped.join("\\s*") + "$", "u").test(normalized(prompt))
  )
    return;
  return lines.slice(end).join("\n");
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
    const tail = claudePromptTail(prompt, output);
    // A visible different user turn must never be bypassed by baseline diffing.
    const hasUser = /^ ?[❯>] .+/m.test(stripAnsi(output));
    if (tail === undefined && hasUser) return "";
    const text = claudeResponseText(
      tail ?? (baseline.trim() ? outputSinceBaseline(baseline, output) : ""),
    );
    const old = claudeResponseText(
      claudePromptTail(prompt, baseline) ?? baseline,
    );
    return text && text !== old ? text : "";
  }
}

export function normalizeTerminalResponse(
  agentKind: string | undefined,
  output: string,
): string {
  const kind = (agentKind || "").toLowerCase();
  if (kind.includes("claude")) return claudeResponseText(output);
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
