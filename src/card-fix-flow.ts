// 一圈修正的流程（追蹤清單 F5 的 loop 手動版，使用者 2026-11-04 決定）：組提示 → 確認工作樹乾淨 → 開新 pane →
// 啟動新的作者 Agent（種類沿用最後一個作者的種類，可用 `--agent` 指定）→ 等就緒 → 送出並讀回覆 → 解析 →
// 確認有新 commit 且工作樹乾淨 → **一定**關閉這個 pane。所有外部動作都由呼叫端注入；**不寫卡片、不 push**。
//
// 與 review 不同：作者要修改工作樹，所以不是「指紋前後一致」，而是「HEAD 有新 commit、工作樹乾淨」；
// 動到敏感路徑只回報、不阻擋（這一版沒有自動 merge，人會看 PR）。
//
// 結果的分類：
// - 還沒開始就失敗（提示、種類、工作樹不乾淨、開 pane、Agent 啟動失敗）→ `ok: false`，沒有修正發生。
// - 修正開始後的任何問題（沒就緒、卡住、回覆不合格、沒有新 commit、工作樹不乾淨…）→ `ok: true` 但
//   `outcome.kind === "failed"` 並附原因；這一圈不採用，呼叫端不改任何 finding 的狀態。
// - 關閉 pane 失敗只回報，不改變結果。

import { createHash } from "node:crypto";
import { waitUntilReady } from "./agent-ready.js";
import type { AgentStartPort } from "./agent-start.js";
import type { Card } from "./card.js";
import { buildFixPrompt, parseFixReply, type OpenFinding } from "./card-fix.js";
import { closeReviewerPane, openReviewerPane } from "./review-pane.js";
import { sensitivePathsIn } from "./sensitive-paths.js";
import type { AgentRecord } from "./types.js";

export interface FixFlowDeps {
  panePort: AgentStartPort;
  startAgent(input: {
    paneId: string;
    kind: string;
    name: string;
  }): Promise<AgentRecord>;
  /** 送出提示並讀回覆（正式環境包 `runTeamTurn`）；逾時、身份改變等問題以丟錯誤表示。 */
  runTurn(
    agent: AgentRecord,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ state: "done" | "blocked"; text: string }>;
  /** HEAD 與工作樹是否乾淨。 */
  state(cwd: string): Promise<{ head: string; dirty: boolean }>;
  /** 兩個 commit 之間改動的路徑（含改名的新舊路徑）。 */
  changedFiles(cwd: string, from: string, to: string): Promise<string[]>;
  /** 等作者完成的上限，預設 15 分鐘。 */
  timeoutMs?: number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface FixFlowInput {
  card: Card;
  /** 最新一輪整體 review 的輪次。 */
  round: number;
  findings: OpenFinding[];
  /** 最後一個作者的 pane：新 pane 從它分割出來，種類預設沿用它。 */
  author: { agent?: string; paneId: string; workspaceId: string };
  worktreePath: string;
  /** 使用者用 `--agent` 指定的種類。 */
  requestedKind?: string;
}

export type FixOutcome =
  | {
      kind: "fixed";
      fixed: string[];
      skipped: Array<{ id: string; reason: string }>;
      headBefore: string;
      headAfter: string;
      files: string[];
      sensitivePaths: string[];
    }
  | {
      kind: "failed";
      reason: string;
      skipped: Array<{ id: string; reason: string }>;
    };

export type FixFlowResult =
  | {
      ok: false;
      stage: "prompt" | "kind" | "state" | "open" | "start";
      error: string;
      /** pane 已開但啟動失敗時，關閉 pane 的結果說明（關閉成功不附）。 */
      closeNote?: string;
    }
  | {
      ok: true;
      fixerKind: string;
      outcome: FixOutcome;
      closed: boolean;
      closeNote?: string;
    };

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/** 例如 `fix-a1b2c3-r1`：Herdr 只接受 1–32 字元的小寫名稱，雜湊取自完整卡片 id。 */
export function fixerAgentName(cardId: string, round: number): string {
  const hash = createHash("sha256").update(cardId).digest("hex").slice(0, 6);
  return `fix-${hash}-r${round}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export async function runCardFix(
  deps: FixFlowDeps,
  input: FixFlowInput,
): Promise<FixFlowResult> {
  const built = buildFixPrompt({
    card: input.card,
    findings: input.findings,
    round: input.round,
  });
  if (!built.ok) return { ok: false, stage: "prompt", error: built.error };

  const kind = input.requestedKind ?? input.author.agent;
  if (kind === undefined)
    return {
      ok: false,
      stage: "kind",
      error: "不知道最後一個作者的 Agent 種類，請用 --agent <種類> 指定",
    };
  if (!KIND.test(kind))
    return {
      ok: false,
      stage: "kind",
      error: `不合法的 Agent 種類 "${kind}"（只接受小寫英數與 _ -，最多 32 字元）`,
    };

  let before: { head: string; dirty: boolean };
  try {
    before = await deps.state(input.worktreePath);
  } catch (error) {
    return {
      ok: false,
      stage: "state",
      error: `無法讀取工作樹狀態，不開始修正：${message(error)}`,
    };
  }
  if (before.dirty)
    return {
      ok: false,
      stage: "state",
      error:
        "worktree 有未提交的修改，不開始修正（修正要在乾淨的工作樹上進行）；請先 commit 或處理",
    };

  let pane: { paneId: string; terminalId: string };
  try {
    pane = await openReviewerPane(deps.panePort, {
      basePaneId: input.author.paneId,
      workspaceId: input.author.workspaceId,
      cwd: input.worktreePath,
    });
  } catch (error) {
    return { ok: false, stage: "open", error: message(error) };
  }

  // 從這裡開始，pane 已經存在：不論發生什麼（含未預期的例外）都要關閉。
  let outcome: Outcome;
  let closed: { closed: boolean; note?: string } = { closed: false };
  try {
    outcome = await fixInPane(deps, input, {
      pane,
      kind,
      prompt: built.prompt,
      headBefore: before.head,
    });
  } finally {
    closed = await closeReviewerPane(deps.panePort, {
      paneId: pane.paneId,
      terminalId: pane.terminalId,
    });
  }
  const closeNote = closed.note;
  if (outcome.kind === "start-failed")
    return {
      ok: false,
      stage: "start",
      error: outcome.error,
      ...(closeNote ? { closeNote } : {}),
    };
  return {
    ok: true,
    fixerKind: kind,
    outcome: outcome.outcome,
    closed: closed.closed,
    ...(closeNote ? { closeNote } : {}),
  };
}

type Outcome =
  | { kind: "start-failed"; error: string }
  | { kind: "done"; outcome: FixOutcome };

const failed = (
  reason: string,
  skipped: Array<{ id: string; reason: string }> = [],
): Outcome => ({ kind: "done", outcome: { kind: "failed", reason, skipped } });

/** pane 已開之後的部分。內部的預期失敗都轉成 Outcome，不丟錯誤。 */
async function fixInPane(
  deps: FixFlowDeps,
  input: FixFlowInput,
  run: {
    pane: { paneId: string; terminalId: string };
    kind: string;
    prompt: string;
    headBefore: string;
  },
): Promise<Outcome> {
  let agent: AgentRecord;
  try {
    agent = await deps.startAgent({
      paneId: run.pane.paneId,
      kind: run.kind,
      name: fixerAgentName(input.card.id, input.round),
    });
  } catch (error) {
    return { kind: "start-failed", error: message(error) };
  }
  const ready = await waitUntilReady(deps, run.pane, agent);
  if (!ready.ok) return failed(ready.reason);
  agent = ready.agent;

  let text: string;
  try {
    const turn = await deps.runTurn(
      agent,
      run.prompt,
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (turn.state === "blocked")
      return failed("作者卡住了（blocked，可能在等人確認）");
    text = turn.text;
  } catch (error) {
    return failed(`作者沒有回覆：${message(error)}`);
  }
  const parsed = parseFixReply(
    text,
    input.findings.map((item) => item.id),
  );
  if (!parsed.ok) return failed(parsed.reason);

  let after: { head: string; dirty: boolean };
  try {
    after = await deps.state(input.worktreePath);
  } catch (error) {
    return failed(`修正之後無法讀取工作樹狀態：${message(error)}`, parsed.skipped);
  }
  if (after.dirty)
    return failed(
      "作者結束時工作樹還有未提交的修改，這一圈不採用；請到 worktree 檢查",
      parsed.skipped,
    );
  if (after.head === run.headBefore)
    return failed(
      parsed.fixed.length > 0
        ? "作者回報修好了，但 worktree 沒有新的 commit，這一圈不採用"
        : `作者把所有 finding 都略過了（${parsed.skipped.map((item) => `${item.id}：${item.reason}`).join("；")}），沒有修正`,
      parsed.skipped,
    );
  if (parsed.fixed.length === 0)
    return failed(
      "worktree 有新的 commit，但作者沒有宣告修好任何 finding，這一圈不採用；請到 worktree 檢查",
      parsed.skipped,
    );

  let files: string[];
  try {
    files = await deps.changedFiles(
      input.worktreePath,
      run.headBefore,
      after.head,
    );
  } catch (error) {
    return failed(`無法取得這次修正改動的檔案：${message(error)}`, parsed.skipped);
  }
  return {
    kind: "done",
    outcome: {
      kind: "fixed",
      fixed: parsed.fixed,
      skipped: parsed.skipped,
      headBefore: run.headBefore,
      headAfter: after.head,
      files,
      sensitivePaths: sensitivePathsIn(files),
    },
  };
}
