import { createHash } from "node:crypto";
import { agentDisplayName } from "./cli-adapter.js";
import type { AgentRecord } from "./types.js";
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
  | ({ event: "role_assigned" } & RoleIdentity)
  | { event: "assigned"; machine: string; agent: string }
  | {
      event: "worktree_created";
      machine: string;
      path: string;
      branch: string;
      baseSha: string;
    }
  | {
      event: "agy_worktree_trust";
      path: string;
      action: "add" | "remove";
      result: "added" | "removed" | "unchanged" | "error" | "remote";
    }
  | { event: "started"; taskId: string }
  | { event: "completed"; taskId: string }
  | {
      event: "review_verdict";
      role: string;
      verdict: (typeof VERDICTS)[number];
      round: number;
    }
  | {
      /** `card commit`：bridge 把通過 review 與驗證的版本 commit 到卡片的分支（不 push）。 */
      event: "committed";
      taskId: string;
      branch: string;
      headSha: string;
    }
  | {
      /** `card fix`（F5 的 loop 手動版）：某一圈修正完成，幾筆 finding 標為 fixed、幾筆略過。 */
      event: "fix_applied";
      round: number;
      fixed: number;
      skipped: number;
      headSha: string;
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
  | {
      /** 啟動時自動跳過 CLI 的已知更新提示（只限更新提示）。 */
      event: "update_prompt_skipped";
      cli: string;
      paneId: string;
      key: string;
    }
  | { event: "cleanup_pending"; reason: (typeof CLEANUP_PENDING)[number] }
);

/** Only explicit identity facts; never session history, prompts or output. */
export interface RoleIdentity {
  role: string;
  agent: string;
  machine: string;
  model?: string;
  profileId?: string;
  taskId?: string;
  round?: number;
}

const ROLE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,79}$/;

export function roleIdentity(
  role: string,
  actor: AgentRecord,
  scope: { taskId?: string; round?: number },
): RoleIdentity {
  return {
    role,
    agent: agentDisplayName({ kind: actor.agent ?? "", role: "agent" }).split(
      "·",
    )[0]!,
    machine: typeof actor.machine === "string" ? actor.machine : "local",
    ...(typeof actor.model === "string" ? { model: actor.model } : {}),
    ...(typeof actor.profileId === "string"
      ? { profileId: actor.profileId }
      : {}),
    ...scope,
  };
}

/**
 * profile Worker 的身分：profile id 一律記；model 只在 bridge 用這個 profile 啟動新 session
 * （continuity 為 `new-session`，啟動時帶了 profile 的 model）時才採用設定值。
 * 重用或綁定的既有 session 沒有啟動或確認 model 的證據，所以不記；Agent 自己回報的 model 永遠優先。
 */
export function withProfileIdentity(
  agent: AgentRecord,
  profile: { id: string; model?: string } | undefined,
  continuity: string,
): AgentRecord {
  if (!profile) return agent;
  return {
    ...agent,
    profileId: profile.id,
    ...(!agent.model && profile.model && continuity === "new-session"
      ? { model: profile.model }
      : {}),
  };
}

/** Stable across replay/restart of the same actor. The assignment id is the role for Team work. */
export function roleEvent(identity: RoleIdentity, time: string): CardEvent {
  const eventId =
    "role-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          identity.taskId ?? null,
          identity.role,
          identity.round ?? null,
          // 同一輪換另一個執行者是新的事實；同一個執行者重送／重啟才去重。
          identity.agent,
          identity.machine,
          identity.profileId ?? null,
          identity.model ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 48);
  return { ...identity, event: "role_assigned", time, eventId };
}

/** A ledger failure must never alter the work result or notification text. */
export function recordRoleSafely(write: () => { ok: boolean } | void): void {
  try {
    const result = write();
    if (result && typeof result === "object" && !result.ok)
      console.error("Role ledger write rejected");
  } catch {
    console.error("Role ledger write failed");
  }
}

/** Read only our validated role template; old/unknown entries are not inferred. */
export function roleSummary(entries: LogEntry[]): string {
  return (
    entries
      .filter((e) => e.event === "role_assigned")
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .flatMap((e) => {
        const match =
          /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})(（第 [0-9]+ 輪）)?：([A-Za-z0-9._-]{1,40})(（[A-Za-z0-9][A-Za-z0-9_./:+-]{0,79}）)?；machine=/.exec(
            e.text,
          );
        return match
          ? [
              `${match[1] === "lead" ? "Lead" : match[1]}${match[2] ?? ""}：${match[3]}${match[4] ?? ""}`,
            ]
          : [];
      })
      .join(" · ") || "沒有角色紀錄"
  );
}

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
    case "role_assigned": {
      const role = text(fields, "role", ROLE, "assignment id or role, max 64");
      const agent = text(fields, "agent", AGENT, "agent kind");
      const machine = text(fields, "machine", MACHINE, "machine id");
      const model =
        fields.model === undefined
          ? ""
          : `（${text(fields, "model", MODEL, "model id, max 80")}）`;
      const profile =
        fields.profileId === undefined
          ? ""
          : `；profile=${text(fields, "profileId", AGENT, "profile id")}`;
      const task =
        fields.taskId === undefined
          ? ""
          : `；task=${text(fields, "taskId", TASK_ID, "task id")}`;
      const round =
        fields.round === undefined
          ? ""
          : `（第 ${integer(fields, "round", 1, 1_000_000)} 輪）`;
      if (!task && !round) bad("scope", "task id or round");
      return {
        text: `${role}${round}：${agent}${model}；machine=${machine}${profile}${task}`,
        suspicious: false,
      };
    }
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
    case "agy_worktree_trust":
      return {
        text: `agy trust ${oneOf(fields, "action", ["add", "remove"])} ${oneOf(fields, "result", ["added", "removed", "unchanged", "error", "remote"])} ${absolutePath(fields, "path")}`,
        suspicious: false,
      };
    case "started":
      return {
        text: `開始執行 task ${text(fields, "taskId", TASK_ID, "letters, digits, . _ -")}`,
        suspicious: false,
      };
    case "completed":
      return {
        text: `task ${text(fields, "taskId", TASK_ID, "letters, digits, . _ -")} 完成`,
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
    case "committed": {
      const branch = text(
        fields,
        "branch",
        BRANCH,
        "letters, digits, . _ / -, at most 80",
      );
      const head = sha12(fields, "headSha");
      return {
        text: `commit 分支 ${branch}，head ${head}（task ${text(fields, "taskId", TASK_ID, "task id")}）`,
        suspicious: false,
      };
    }
    case "fix_applied": {
      const round = integer(fields, "round", 1, 1_000_000);
      const fixed = integer(fields, "fixed", 0, 1_000_000);
      const skipped = integer(fields, "skipped", 0, 1_000_000);
      const head = sha12(fields, "headSha");
      return {
        text: `修正 第 ${round} 圈：${fixed} 筆標為 fixed、${skipped} 筆略過，head ${head}`,
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
    case "update_prompt_skipped": {
      const cli = text(fields, "cli", AGENT, "agent kind");
      const pane = text(fields, "paneId", /^[A-Za-z0-9:._-]{1,40}$/, "pane id");
      const key = text(fields, "key", /^[A-Za-z0-9]{1,8}$/, "key");
      return {
        text: `已自動跳過 ${cli} 的更新提示（pane ${pane}、按鍵 ${key}）`,
        suspicious: false,
      };
    }
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
