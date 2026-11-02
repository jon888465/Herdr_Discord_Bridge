// 營運卡片內文的「流程紀錄」區塊（ADR-0002）：bridge 只追加、不改其他內容。

export interface LogEntry {
  /** UTC，格式 YYYY-MM-DDTHH:MM:SSZ。 */
  time: string;
  /** 事件名，小寫英數與底線，例如 started、pr_opened。 */
  event: string;
  /** 單行說明。 */
  text: string;
  /** 事件 id；同一個 id 重複追加不會產生重複的紀錄行。 */
  eventId: string;
}

export type AppendResult =
  { ok: true; body: string; added: number } | { ok: false; error: string };

export const LOG_HEADING = "## 流程紀錄";

/** 暫定的單筆說明長度上限。正式的長度與機敏內容規則在 ADR-0002 未決 4、8。 */
export const MAX_LOG_TEXT_CHARS = 1000;

const HEADING_LINE = /^## 流程紀錄[ \t]*$/;
const ANY_H2 = /^## /;
const EVENT = /^[a-z][a-z0-9_]{0,31}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ID_AT_END = / \| ev:([A-Za-z0-9_-]{1,64})\s*$/;

function validTime(value: string): boolean {
  if (!TIME.test(value)) return false;
  const date = new Date(value);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().replace(".000Z", "Z") === value
  );
}

function validateEntry(entry: LogEntry): string | null {
  if (typeof entry.time !== "string" || !validTime(entry.time))
    return "invalid time (expected YYYY-MM-DDTHH:MM:SSZ)";
  if (typeof entry.event !== "string" || !EVENT.test(entry.event))
    return "invalid event (lowercase letters, digits, underscore; max 32)";
  if (typeof entry.eventId !== "string" || !EVENT_ID.test(entry.eventId))
    return "invalid eventId (letters, digits, - and _; max 64)";
  if (typeof entry.text !== "string") return "invalid text";
  const length = Array.from(entry.text).length;
  if (length < 1 || length > MAX_LOG_TEXT_CHARS)
    return `invalid text (1 to ${MAX_LOG_TEXT_CHARS} characters)`;
  if (/[\u0000-\u001F\u007F]/.test(entry.text))
    return "invalid text (control characters, including newlines)";
  if (entry.text.includes(" | "))
    return 'invalid text (must not contain " | ")';
  return null;
}

function formatLine(entry: LogEntry): string {
  return `- ${entry.time} | ${entry.event} | ${entry.text} | ev:${entry.eventId}`;
}

/**
 * 把紀錄追加到內文的「## 流程紀錄」區塊；沒有就在內文最後建立。
 * 區塊以外的文字逐字不變。全部欄位先驗證，有一筆不合格就整批拒絕。
 * 事件 id 只與該區塊內的既有紀錄比對，重複的略過。
 */
export function appendLogEntries(
  body: string,
  entries: LogEntry[],
): AppendResult {
  for (const [index, entry] of entries.entries()) {
    const problem = validateEntry(entry);
    if (problem) return { ok: false, error: `entry ${index}: ${problem}` };
  }

  const lines = body.split("\n");
  const heading = lines.findIndex((line) => HEADING_LINE.test(line));
  let end = lines.length;
  const seen = new Set<string>();
  if (heading >= 0) {
    for (let i = heading + 1; i < lines.length; i++) {
      if (ANY_H2.test(lines[i])) {
        end = i;
        break;
      }
    }
    for (let i = heading + 1; i < end; i++) {
      const match = lines[i].startsWith("- ") ? ID_AT_END.exec(lines[i]) : null;
      if (match) seen.add(match[1]);
    }
  }

  const fresh: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.eventId)) continue;
    seen.add(entry.eventId);
    fresh.push(formatLine(entry));
  }
  if (fresh.length === 0) return { ok: true, body, added: 0 };

  if (heading < 0) {
    const base = body.replace(/\n+$/, "");
    const prefix = base === "" ? "" : `${base}\n\n`;
    return {
      ok: true,
      added: fresh.length,
      body: `${prefix}${LOG_HEADING}\n\n${fresh.join("\n")}\n`,
    };
  }

  let lastContent = heading;
  for (let i = heading + 1; i < end; i++) {
    if (lines[i].trim() !== "") lastContent = i;
  }
  const insertion = lastContent === heading ? ["", ...fresh] : fresh;
  lines.splice(lastContent + 1, 0, ...insertion);
  return { ok: true, added: fresh.length, body: lines.join("\n") };
}
