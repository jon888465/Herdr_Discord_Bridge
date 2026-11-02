// 營運卡片「流程紀錄」的事件模板（ADR-0002 決定 11，方案 C）。
//
// 紀錄預設只含 bridge 自己產生、有型別的事實，說明文字由固定模板組出。唯一的自由文字是
// failed 事件的短原因。任何欄位疑似含機敏內容時，整筆說明改成固定訊息，事件本身仍照常記錄。

import {
  validateLogEntry,
  MAX_LOG_TEXT_CHARS,
  type LogEntry,
} from "./card-ledger.js";
import { redactSecrets } from "./redact.js";
import {
  absolutePath,
  AGENT,
  bad,
  BRANCH,
  FieldError,
  integer,
  MACHINE,
  oneOf,
  SNAKE,
  TASK_ID,
  text,
  sha12,
  url,
  type Fields,
} from "./card-fields.js";

export const OMITTED_TEXT = "內容已省略：疑似含機敏資料";
/** 自由文字（失敗原因）的上限，字元數。 */
export const MAX_REASON_CHARS = 200;

const VERDICTS = ["pass", "changes_requested", "inconclusive"] as const;
const CI_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "skipped",
  "action_required",
] as const;
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const BLOCK_REASONS = [
  "question",
  "quota",
  "connection",
  "dirty_worktree",
] as const;
const CLEANUP_PENDING = ["dirty_worktree", "unreachable", "error"] as const;

export type CardEvent = { time: string; eventId: string } & (
  | { event: "assigned"; machine: string; agent: string }
  | {
      event: "worktree_created";
      machine: string;
      path: string;
      branch: string;
      baseSha: string;
    }
  | { event: "started"; taskId: string }
  | {
      event: "review_verdict";
      role: string;
      verdict: (typeof VERDICTS)[number];
      round: number;
    }
  | {
      event: "verify_result";
      result: "pass" | "fail";
      passed: number;
      failed: number;
    }
  | { event: "pr_opened"; url: string; number: number; headSha: string }
  | {
      event: "ci_result";
      conclusion: (typeof CI_CONCLUSIONS)[number];
      url: string;
    }
  | { event: "merged"; sha: string; method: (typeof MERGE_METHODS)[number] }
  | { event: "blocked"; reason: (typeof BLOCK_REASONS)[number] }
  | { event: "resumed" }
  | { event: "failed"; code: string; reason?: string }
  | { event: "cancelled"; by: "user" | "bridge" }
  | { event: "cleanup_done"; result: "removed" | "kept" }
  | { event: "cleanup_pending"; reason: (typeof CLEANUP_PENDING)[number] }
);

export type BuildResult =
  | { ok: true; entry: LogEntry; omitted: boolean }
  | { ok: false; error: string };

/** 失敗原因：正規化空白、機敏檢查（在截斷之前）、再截斷。回傳空字串表示沒有原因。 */
function failureReason(fields: Fields): { text: string; suspicious: boolean } {
  const value = fields.reason;
  if (value === undefined) return { text: "", suspicious: false };
  if (typeof value !== "string") bad("reason", "string");
  const normalised = value.replace(/[\u0000-\u001F\u007F\s]+/g, " ").trim();
  const suspicious = redactSecrets(normalised) !== normalised;
  const chars = Array.from(normalised);
  const bounded =
    chars.length > MAX_REASON_CHARS
      ? `${chars.slice(0, MAX_REASON_CHARS - 1).join("")}…`
      : normalised;
  return { text: bounded, suspicious };
}

function render(fields: Fields): { text: string; suspicious: boolean } {
  switch (fields.event) {
    case "assigned":
      return {
        text: `指派給 ${text(fields, "agent", AGENT, "letters, digits, . _ -")}（${text(fields, "machine", MACHINE, "machine id")}）`,
        suspicious: false,
      };
    case "worktree_created": {
      const machine = text(fields, "machine", MACHINE, "machine id");
      const path = absolutePath(fields, "path");
      const branch = text(
        fields,
        "branch",
        BRANCH,
        "letters, digits, . _ / -, at most 80",
      );
      const base = sha12(fields, "baseSha");
      return {
        text: `建立 worktree ${machine}:${path} 分支 ${branch} 基準 ${base}`,
        suspicious: false,
      };
    }
    case "started":
      return {
        text: `開始執行 task ${text(fields, "taskId", TASK_ID, "letters, digits, . _ -")}`,
        suspicious: false,
      };
    case "review_verdict": {
      const role = text(
        fields,
        "role",
        SNAKE,
        "lowercase letters, digits, underscore",
      );
      const verdict = oneOf(fields, "verdict", VERDICTS);
      const round = integer(fields, "round", 1, 1_000_000);
      return {
        text: `review ${role} 第 ${round} 輪：${verdict}`,
        suspicious: false,
      };
    }
    case "verify_result": {
      const result = oneOf(fields, "result", ["pass", "fail"] as const);
      const passed = integer(fields, "passed", 0, 1_000_000);
      const failed = integer(fields, "failed", 0, 1_000_000);
      return {
        text: `驗證 ${result}：通過 ${passed}／失敗 ${failed}`,
        suspicious: false,
      };
    }
    case "pr_opened": {
      const number = integer(fields, "number", 1, 9_999_999);
      const head = sha12(fields, "headSha");
      const link = url(fields, "url");
      return { text: `PR #${number} ${head} ${link}`, suspicious: false };
    }
    case "ci_result": {
      const conclusion = oneOf(fields, "conclusion", CI_CONCLUSIONS);
      return {
        text: `CI ${conclusion} ${url(fields, "url")}`,
        suspicious: false,
      };
    }
    case "merged": {
      const sha = sha12(fields, "sha");
      const method = oneOf(fields, "method", MERGE_METHODS);
      return { text: `已合併 ${sha}（${method}）`, suspicious: false };
    }
    case "blocked":
      return {
        text: `被擋住：${oneOf(fields, "reason", BLOCK_REASONS)}`,
        suspicious: false,
      };
    case "resumed":
      return { text: "已恢復", suspicious: false };
    case "failed": {
      const code = text(
        fields,
        "code",
        SNAKE,
        "lowercase letters, digits, underscore",
      );
      const reason = failureReason(fields);
      return {
        text: reason.text
          ? `失敗：${code}；原因：${reason.text}`
          : `失敗：${code}`,
        suspicious: reason.suspicious,
      };
    }
    case "cancelled":
      return {
        text: `已取消（${oneOf(fields, "by", ["user", "bridge"] as const)}）`,
        suspicious: false,
      };
    case "cleanup_done":
      return {
        text: `清理完成：${oneOf(fields, "result", ["removed", "kept"] as const)}`,
        suspicious: false,
      };
    case "cleanup_pending":
      return {
        text: `清理待處理：${oneOf(fields, "reason", CLEANUP_PENDING)}`,
        suspicious: false,
      };
    default:
      throw new FieldError(`unknown event "${String(fields.event)}"`);
  }
}

/** 把有型別的事件轉成一行紀錄。欄位不合格回傳錯誤；疑似機敏則整筆說明改為固定訊息。 */
export function buildLogEntry(event: CardEvent): BuildResult {
  const fields = event as unknown as Fields;
  try {
    const header = {
      time: fields.time as string,
      event: fields.event as string,
      eventId: fields.eventId as string,
    };
    const headerProblem = validateLogEntry({ ...header, text: "x" });
    if (headerProblem) return { ok: false, error: headerProblem };

    const rendered = render(fields);
    const omitted =
      rendered.suspicious || redactSecrets(rendered.text) !== rendered.text;
    const entry: LogEntry = {
      ...header,
      text: omitted ? OMITTED_TEXT : rendered.text,
    };
    const problem = validateLogEntry(entry);
    if (problem)
      return { ok: false, error: `${problem} (limit ${MAX_LOG_TEXT_CHARS})` };
    return { ok: true, entry, omitted };
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, error: error.message };
    throw error;
  }
}
