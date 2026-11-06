// 營運卡片內文的「Review 發現」區塊（追蹤清單 F8，ADR-0002 決定 12）：reviewer 發現的問題清單。
//
// 這是決定 9／11「bridge 不把 Agent 的自由文字寫進卡片」的一個**有界例外**：每筆只有結構化欄位加一行
// 最多 200 字的摘要，摘要過機敏檢查，命中就整段改成固定訊息；不收程式碼片段與長篇說明。
// 區塊由 bridge 管理（人加的行會保留）；和流程紀錄不同，它是「更新」而不是「只追加」（狀態會往前走），
// 而且不輪替——findings 是待辦，不能被移到旁檔。
//
// 格式：
//   ## Review 發現
//
//   ### 第 1 輪 · 整體 · head 0123456789ab · changes_requested
//   - F1 | high | open | src/foo.ts:12-20 | 缺少錯誤處理
//
// 這個檔案只有純函式（內文進、內文出）；寫入卡片檔由 CardStore 負責。

import { SHA } from "./card-fields.js";
import { redactSecrets } from "./redact.js";

export const FINDINGS_HEADING = "## Review 發現";
export const SEVERITIES = ["high", "medium", "low"] as const;
export const STATUSES = ["open", "fixed", "resolved", "dismissed"] as const;
export const VERDICTS = ["pass", "changes_requested", "inconclusive"] as const;
export const MAX_FINDINGS = 100;
export const MAX_BATCH_FINDINGS = 30;
export const MAX_SUMMARY_CHARS = 200;
export const SUMMARY_OMITTED = "（已省略：疑似含機敏資料）";

export type Severity = (typeof SEVERITIES)[number];
export type FindingStatus = (typeof STATUSES)[number];
export type Verdict = (typeof VERDICTS)[number];

export interface FindingInput {
  severity: Severity;
  /** repo 內的相對路徑（只含英數與 `._/@+-`，不含 `..`）。 */
  path: string;
  lineStart?: number;
  lineEnd?: number;
  summary: string;
}

export interface FindingBatch {
  round: number;
  /** `whole`＝整個需求的整體 review；否則是單一 commit 的 sha（7 到 40 位十六進位）。 */
  scope: string;
  headSha: string;
  verdict: Verdict;
  findings: FindingInput[];
}

export interface Finding {
  id: string;
  severity: Severity;
  status: FindingStatus;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  summary: string;
}

export interface ParsedBatch {
  round: number;
  /** `whole` 或 12 位的 commit sha。 */
  scope: string;
  headSha: string;
  verdict: Verdict;
  findings: Finding[];
}

export type RecordResult =
  | {
      ok: true;
      body: string;
      changed: boolean;
      /** 這次新增的 finding 編號。 */
      ids: string[];
      /** 因疑似機敏而整段省略摘要的筆數。 */
      omitted: number;
    }
  | { ok: false; error: string };

export type StatusResult =
  | { ok: true; body: string; changed: boolean }
  | { ok: false; error: string };

export interface FindingsSummary {
  total: number;
  counts: Record<FindingStatus, number>;
  open: Array<Finding & { round: number; scope: string }>;
}

const HEADING_LINE = /^## Review 發現[ \t]*$/;
const LOG_HEADING_LINE = /^## 流程紀錄[ \t]*$/;
const ANY_H2 = /^## /;
const BATCH_LINE =
  /^### 第 (\d+) 輪 · (整體|commit ([0-9a-f]{12})) · head ([0-9a-f]{12}) · (pass|changes_requested|inconclusive)[ \t]*$/;
const FINDING_LINE =
  /^- (F\d+) \| (high|medium|low) \| (open|fixed|resolved|dismissed) \| ([A-Za-z0-9._/@+-]{1,120})(?::(\d+)(?:-(\d+))?)? \| (.*)$/;
const PATH = /^[A-Za-z0-9._/@+-]{1,120}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const MAX_LINE = 1_000_000;

/** 狀態只能往前：open → fixed → resolved，或任何未結束的狀態 → dismissed。重審沒通過就在新一輪記新的 finding。 */
const NEXT: Record<FindingStatus, readonly FindingStatus[]> = {
  open: ["fixed", "resolved", "dismissed"],
  fixed: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function scopeKey(scope: string): string {
  return scope === "whole" ? "whole" : scope.slice(0, 12);
}

interface Checked {
  scope: string;
  headSha: string;
  lines: Array<Omit<Finding, "id" | "status">>;
  omitted: number;
}

function check(batch: FindingBatch): Checked | string {
  if (!batch || typeof batch !== "object") return "invalid batch";
  if (!isInteger(batch.round, 1, 1_000_000))
    return "invalid round (integer 1 to 1000000)";
  if (
    typeof batch.scope !== "string" ||
    !(batch.scope === "whole" || SHA.test(batch.scope))
  )
    return 'invalid scope ("whole" or a 7 to 40 character lowercase hex commit sha)';
  if (typeof batch.headSha !== "string" || !SHA.test(batch.headSha))
    return "invalid headSha (7 to 40 lowercase hex characters)";
  if (!(VERDICTS as readonly string[]).includes(batch.verdict))
    return `invalid verdict (one of ${VERDICTS.join(", ")})`;
  if (!Array.isArray(batch.findings)) return "invalid findings";
  if (batch.findings.length > MAX_BATCH_FINDINGS)
    return `a batch can hold at most ${MAX_BATCH_FINDINGS} findings`;

  const lines: Checked["lines"] = [];
  let omitted = 0;
  for (const [index, item] of batch.findings.entries()) {
    const label = `finding ${index + 1}`;
    if (!item || typeof item !== "object") return `${label}: invalid`;
    if (!(SEVERITIES as readonly string[]).includes(item.severity))
      return `${label}: invalid severity (one of ${SEVERITIES.join(", ")})`;
    if (
      typeof item.path !== "string" ||
      !PATH.test(item.path) ||
      item.path.startsWith("/") ||
      item.path.split("/").some((part) => part === ".." || part === "")
    )
      return `${label}: invalid path (a relative path of letters, digits and ._/@+-, no "..", at most 120 characters)`;
    if (redactSecrets(item.path) !== item.path)
      return `${label}: path looks like it contains a secret`;
    if (item.lineStart === undefined && item.lineEnd !== undefined)
      return `${label}: lineEnd needs lineStart`;
    if (item.lineStart !== undefined && !isInteger(item.lineStart, 1, MAX_LINE))
      return `${label}: invalid lineStart (integer 1 to ${MAX_LINE})`;
    if (item.lineEnd !== undefined) {
      if (!isInteger(item.lineEnd, 1, MAX_LINE))
        return `${label}: invalid lineEnd (integer 1 to ${MAX_LINE})`;
      if (item.lineEnd < (item.lineStart as number))
        return `${label}: lineEnd is before lineStart`;
    }
    if (typeof item.summary !== "string") return `${label}: invalid summary`;
    const length = Array.from(item.summary).length;
    if (length < 1 || length > MAX_SUMMARY_CHARS)
      return `${label}: invalid summary (1 to ${MAX_SUMMARY_CHARS} characters)`;
    if (CONTROL.test(item.summary))
      return `${label}: invalid summary (control characters, including newlines)`;
    if (item.summary.includes(" | "))
      return `${label}: invalid summary (must not contain " | ")`;
    let summary = item.summary;
    if (redactSecrets(summary) !== summary) {
      summary = SUMMARY_OMITTED;
      omitted++;
    }
    lines.push({
      severity: item.severity,
      path: item.path,
      ...(item.lineStart !== undefined ? { lineStart: item.lineStart } : {}),
      ...(item.lineEnd !== undefined ? { lineEnd: item.lineEnd } : {}),
      summary,
    });
  }
  return {
    scope: scopeKey(batch.scope),
    headSha: batch.headSha.slice(0, 12),
    lines,
    omitted,
  };
}

function locate(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => HEADING_LINE.test(line));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (ANY_H2.test(lines[i])) {
      end = i;
      break;
    }
  return { start, end };
}

function formatLocation(item: {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}): string {
  if (item.lineStart === undefined) return item.path;
  return item.lineEnd === undefined
    ? `${item.path}:${item.lineStart}`
    : `${item.path}:${item.lineStart}-${item.lineEnd}`;
}

function parseLine(line: string): Finding | undefined {
  const match = FINDING_LINE.exec(line);
  if (!match) return undefined;
  return {
    id: match[1],
    severity: match[2] as Severity,
    status: match[3] as FindingStatus,
    path: match[4],
    ...(match[5] !== undefined ? { lineStart: Number(match[5]) } : {}),
    ...(match[6] !== undefined ? { lineEnd: Number(match[6]) } : {}),
    summary: match[7],
  };
}

/** 讀出區塊裡所有批次與 finding；沒有區塊就是空陣列。人加的其他行會被略過。 */
export function parseFindings(body: string): ParsedBatch[] {
  const lines = body.split("\n");
  const range = locate(lines);
  if (!range) return [];
  const batches: ParsedBatch[] = [];
  let current: ParsedBatch | undefined;
  for (const line of lines.slice(range.start + 1, range.end)) {
    const heading = BATCH_LINE.exec(line);
    if (heading) {
      current = {
        round: Number(heading[1]),
        scope: heading[3] ?? "whole",
        headSha: heading[4],
        verdict: heading[5] as Verdict,
        findings: [],
      };
      batches.push(current);
      continue;
    }
    const parsed = current ? parseLine(line) : undefined;
    if (current && parsed) current.findings.push(parsed);
  }
  return batches;
}

/**
 * 記一批 findings。同一輪同一範圍（整體或同一個 commit）已經記過就什麼都不做（冪等，先寫的為準）；
 * 輸入不合格或超過上限就整批拒絕、內文不動。區塊建在流程紀錄之前（沒有流程紀錄就建在最後），其他內文逐字不變。
 */
export function recordFindingBatch(
  body: string,
  batch: FindingBatch,
): RecordResult {
  const checked = check(batch);
  if (typeof checked === "string") return { ok: false, error: checked };

  const existing = parseFindings(body);
  if (
    existing.some(
      (item) => item.round === batch.round && item.scope === checked.scope,
    )
  )
    return { ok: true, body, changed: false, ids: [], omitted: 0 };

  const lines = body.split("\n");
  const range = locate(lines);
  const numbers = (range ? lines.slice(range.start + 1, range.end) : [])
    .map((line) => /^- F(\d+) \|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const total = numbers.length;
  if (total + checked.lines.length > MAX_FINDINGS)
    return {
      ok: false,
      error: `a card can hold at most ${MAX_FINDINGS} findings (it has ${total})`,
    };
  let next = Math.max(0, ...numbers) + 1;

  const ids: string[] = [];
  const block = [
    `### 第 ${batch.round} 輪 · ${checked.scope === "whole" ? "整體" : `commit ${checked.scope}`} · head ${checked.headSha} · ${batch.verdict}`,
  ];
  for (const item of checked.lines) {
    const id = `F${next++}`;
    ids.push(id);
    block.push(
      `- ${id} | ${item.severity} | open | ${formatLocation(item)} | ${item.summary}`,
    );
  }
  block.push("");

  if (range) {
    let insertAt = range.end;
    while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === "")
      insertAt--;
    return {
      ok: true,
      changed: true,
      ids,
      omitted: checked.omitted,
      body: [
        ...lines.slice(0, insertAt),
        "",
        ...block,
        ...lines.slice(range.end),
      ].join("\n"),
    };
  }

  const section = [FINDINGS_HEADING, "", ...block];
  const logAt = lines.findIndex((line) => LOG_HEADING_LINE.test(line));
  if (logAt >= 0)
    return {
      ok: true,
      changed: true,
      ids,
      omitted: checked.omitted,
      body: [...lines.slice(0, logAt), ...section, ...lines.slice(logAt)].join(
        "\n",
      ),
    };
  const base = body.replace(/\n+$/, "");
  return {
    ok: true,
    changed: true,
    ids,
    omitted: checked.omitted,
    body: `${base === "" ? "" : `${base}\n\n`}${section.join("\n")}`,
  };
}

/** 改一筆 finding 的狀態。只能往前；同一個狀態是 no-op；找不到編號就拒絕。 */
export function setFindingStatus(
  body: string,
  id: string,
  status: FindingStatus,
): StatusResult {
  if (typeof id !== "string" || !/^F\d+$/.test(id))
    return { ok: false, error: "invalid finding id (F followed by digits)" };
  if (!(STATUSES as readonly string[]).includes(status))
    return {
      ok: false,
      error: `invalid status (one of ${STATUSES.join(", ")})`,
    };
  const lines = body.split("\n");
  const range = locate(lines);
  if (!range) return { ok: false, error: `finding ${id} not found` };
  for (let i = range.start + 1; i < range.end; i++) {
    const parsed = parseLine(lines[i]);
    if (!parsed || parsed.id !== id) continue;
    if (parsed.status === status) return { ok: true, body, changed: false };
    if (!NEXT[parsed.status].includes(status))
      return {
        ok: false,
        error: `finding ${id} cannot move from ${parsed.status} to ${status}`,
      };
    const edited = [...lines];
    edited[i] = lines[i].replace(
      ` | ${parsed.severity} | ${parsed.status} | `,
      ` | ${parsed.severity} | ${status} | `,
    );
    return { ok: true, body: edited.join("\n"), changed: true };
  }
  return { ok: false, error: `finding ${id} not found` };
}

/** 各狀態的數量，以及最前面幾筆 `open` 的 finding（`card show` 用）。 */
/**
 * 會擋 merge 的 open finding 數：medium 與 high。`low` 等級的 open finding 是 reviewer 的備註
 * （例如「可另案更新」），留在卡片上但不擋 merge（ISSUE-100，使用者 2026-11-06 決定）。
 */
export function blockingOpenFindings(body: string): number {
  return summarizeFindings(body, Number.MAX_SAFE_INTEGER).open.filter(
    (item) => item.severity !== "low",
  ).length;
}

export function summarizeFindings(body: string, openLimit = 10): FindingsSummary {
  const counts: Record<FindingStatus, number> = {
    open: 0,
    fixed: 0,
    resolved: 0,
    dismissed: 0,
  };
  const open: FindingsSummary["open"] = [];
  let total = 0;
  for (const batch of parseFindings(body))
    for (const item of batch.findings) {
      total++;
      counts[item.status]++;
      if (item.status === "open" && open.length < openLimit)
        open.push({ ...item, round: batch.round, scope: batch.scope });
    }
  return { total, counts, open };
}
