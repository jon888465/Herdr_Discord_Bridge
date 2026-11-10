import { hasAgentSession, sameAgentSession } from "./response-stream.js";
import type { AgentProfile } from "./agent-pool.js";
import {
  assertFreshProfile,
  assertRoleMatches,
  roleMetadata,
} from "./card-role-assignment.js";
import { assertReadyIdentity } from "./card-role-session.js";
import {
  roleIdentity,
  recordRoleSafely,
  type RoleIdentity,
} from "./card-events.js";
// 一次 review 的完整流程（追蹤清單 F5 階段 3c-2，使用者 2026-11-04 決定）：組提示 → 開新 pane → 啟動 Agent →
// 送出並讀回覆 → 解析 → 工作樹指紋檢查 → **一定**關閉這個 pane。所有外部動作（Herdr、Agent、git）都由呼叫端注入，
// 這一層只管順序與失敗時的處理；**不寫卡片、不讀 GitHub**，結果回傳給呼叫者（3d 的 `card review` 負責寫入）。
//
// 結果的分類：
// - 還沒開始就失敗（提示組不出來、種類不合法、指紋讀不到、pane 開不起來、Agent 啟動失敗）→ `ok: false`，
//   沒有 review 發生；Agent 啟動失敗時不自動換種類（使用者 2026-11-04）。
// - review 開始後的任何問題（reviewer 沒就緒、逾時或卡住、回覆不合格、工作樹被改動）→ `ok: true` 但判定是
//   `inconclusive`、沒有 findings，並附原因（使用者 2026-11-04：blocked 記 inconclusive 並仍然關閉）。
// - 關閉 pane 失敗只回報（`closed: false`），不改變 review 結果。
// reviewer 唯讀是提示約束加工作樹指紋檢查，不是作業系統層的隔離；指紋只抓得到檔案被改與 commit 被新增，
// 抓不到只改了被 gitignore 的檔案。

import { createHash } from "node:crypto";
import type { AgentStartPort } from "./agent-start.js";
import type { Card } from "./card.js";
import type { FindingBatch } from "./card-findings.js";
import {
  buildReviewPrompt,
  inconclusiveBatch,
  parseReviewReply,
  type CriterionResult,
} from "./card-review.js";
import {
  chooseReviewerKind,
  closeReviewerPane,
  openReviewerPane,
} from "./review-pane.js";
import {
  BLOCKED_AT_START,
  waitUntilReady,
  type UpdateSkip,
} from "./agent-ready.js";
import type { AgentRecord } from "./types.js";

export interface ReviewFlowDeps {
  onRoleAssigned?: (identity: RoleIdentity) => void;
  recordRoleStrict?: (identity: RoleIdentity) => void | Promise<void>;
  /** pane.layout／split／get／close 與 Agent 清單。 */
  panePort: AgentStartPort;
  startAgent(input: {
    paneId: string;
    kind: string;
    name: string;
    cwd?: string;
    args?: string[];
  }): Promise<AgentRecord>;
  /** 送出提示並讀回覆（正式環境包 `runTeamTurn`）；逾時、身份改變等問題以丟錯誤表示。 */
  runTurn(
    agent: AgentRecord,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ state: "done" | "blocked"; text: string }>;
  /** 工作樹指紋（HEAD 加 `git status --porcelain`）；review 前後各取一次，不同就判 inconclusive。 */
  fingerprint(cwd: string): Promise<string>;
  /** 等 reviewer 回覆的上限，預設 10 分鐘。 */
  timeoutMs?: number;
  /** 啟動後等 reviewer 變成 idle 的上限（預設 30 秒）與輪詢間隔（預設 1 秒）。 */
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface ReviewFlowInput {
  card: Card;
  /** 第幾輪（從 1 開始）。 */
  round: number;
  /** `whole` 或單一 commit 的 sha。 */
  scope: string;
  pr: { number: number; headSha: string };
  material: { files: string[]; diff: string };
  /** 作者的 pane；新 pane 從它分割出來。 */
  author: {
    agent?: string;
    paneId: string;
    workspaceId: string;
    session?: AgentRecord["agent_session"];
  };
  /** 卡片的 worktree；reviewer 在這裡啟動。 */
  worktreePath: string;
  /** 使用者用 `--agent` 指定的種類。 */
  requestedKind?: string;
  launch?: AgentProfile;
}

export type ReviewFlowResult =
  | {
      ok: false;
      stage: "prompt" | "kind" | "fingerprint" | "open" | "start";
      error: string;
      /** pane 已開但啟動失敗時，關閉 pane 的結果說明（關閉成功不附）。 */
      closeNote?: string;
    }
  | {
      ok: true;
      batch: FindingBatch;
      criteria: CriterionResult[];
      reviewerKind: string;
      /** reviewer 是否與作者同種類（此時獨立的只有 session，不是判斷能力）。 */
      sameKind: boolean;
      /** 判定被迫是 inconclusive 的原因（沒就緒、逾時、回覆不合格、工作樹被改動…）。 */
      inconclusiveReason?: string;
      /** reviewer 宣稱的判定被降級的原因。 */
      downgraded?: string;
      omitted: number;
      closed: boolean;
      closeNote?: string;
      /** 啟動時卡在信任／權限等提示，pane 刻意保留給人處理（不是關閉失敗）。 */
      paneKept?: true;
      /** 啟動時自動跳過了已知的更新提示（卡片流程紀錄要記）。 */
      updateSkip?: UpdateSkip;
    };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REPLY_LINES = 200;

/** 例如 `review-a1b2c3-r1`：Herdr 只接受 1–32 字元的小寫名稱，雜湊取自完整卡片 id。 */
export function reviewerAgentName(cardId: string, round: number): string {
  const hash = createHash("sha256").update(cardId).digest("hex").slice(0, 6);
  return `review-${hash}-r${round}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export async function runCardReview(
  deps: ReviewFlowDeps,
  input: ReviewFlowInput,
): Promise<ReviewFlowResult> {
  if (input.launch) assertFreshProfile(input.launch);
  const built = buildReviewPrompt({
    card: input.card,
    round: input.round,
    scope: input.scope,
    pr: input.pr,
    files: input.material.files,
    diff: input.material.diff,
  });
  if (!built.ok) return { ok: false, stage: "prompt", error: built.error };

  const chosen = chooseReviewerKind({
    authorKind: input.author.agent,
    requested: input.launch?.kind ?? input.requestedKind,
  });
  if (!chosen.ok) return { ok: false, stage: "kind", error: chosen.error };

  let before: string;
  try {
    before = await deps.fingerprint(input.worktreePath);
  } catch (error) {
    return {
      ok: false,
      stage: "fingerprint",
      error: `無法取得工作樹指紋，不開始 review：${message(error)}`,
    };
  }

  let pane: { paneId: string; terminalId: string };
  try {
    pane = await openReviewerPane(deps.panePort, {
      basePaneId: input.author.paneId,
      workspaceId: input.author.workspaceId,
      cwd: input.worktreePath,
      kind: chosen.kind,
    });
  } catch (error) {
    return { ok: false, stage: "open", error: message(error) };
  }

  const finish = {
    reviewerKind: chosen.kind,
    sameKind: chosen.sameKind,
  };
  const context = {
    round: input.round,
    scope: input.scope,
    headSha: input.pr.headSha,
  };
  const skipped: { value?: UpdateSkip } = {};
  const inconclusive = (
    reason: string,
    closed: { closed: boolean; note?: string; kept?: true },
  ): ReviewFlowResult => ({
    ok: true,
    batch: inconclusiveBatch(context),
    criteria: [],
    ...finish,
    inconclusiveReason: reason,
    omitted: 0,
    closed: closed.closed,
    ...(closed.note ? { closeNote: closed.note } : {}),
    ...(closed.kept ? { paneKept: true as const } : {}),
    ...(skipped.value ? { updateSkip: skipped.value } : {}),
  });

  // 從這裡開始，pane 已經存在：不論發生什麼（含未預期的例外）都要關閉。
  // 例外：啟動時 blocked（BLOCKED_AT_START）要保留 pane 給人處理信任／權限提示。
  let outcome: Outcome | undefined;
  let closed: { closed: boolean; note?: string } = { closed: false };
  let keepPane = false;
  let thrown: unknown;
  try {
    outcome = await reviewInPane(deps, input, {
      pane,
      kind: chosen.kind,
      prompt: built.prompt,
      criteria: built.criteria,
      before,
      context,
      skipped,
    });
    keepPane = outcome.kind === "inconclusive" && outcome.keepPane === true;
  } catch (error) {
    thrown = error;
  } finally {
    if (!keepPane)
      closed = await closeReviewerPane(deps.panePort, {
        paneId: pane.paneId,
        terminalId: pane.terminalId,
      });
  }
  if (thrown !== undefined) {
    if (
      closed.note &&
      thrown instanceof Error &&
      !thrown.message.includes(closed.note)
    )
      thrown.message = `${thrown.message}（${closed.note}）`;
    throw thrown;
  }
  outcome = outcome!;
  const closeNote = keepPane
    ? "reviewer 卡在啟動提示，已保留 pane 供人處理"
    : closed.note;
  if (outcome.kind === "failed")
    return {
      ok: false,
      stage: "start",
      error: outcome.error,
      ...(closeNote ? { closeNote } : {}),
    };
  if (outcome.kind === "inconclusive")
    return inconclusive(
      outcome.reason,
      keepPane ? { closed: false, note: closeNote, kept: true } : closed,
    );
  return {
    ok: true,
    batch: outcome.parsed.batch,
    criteria: outcome.parsed.criteria,
    ...finish,
    ...(outcome.parsed.downgraded
      ? { downgraded: outcome.parsed.downgraded }
      : {}),
    omitted: outcome.parsed.omitted,
    closed: closed.closed,
    ...(closeNote ? { closeNote } : {}),
    ...(skipped.value ? { updateSkip: skipped.value } : {}),
  };
}

type Outcome =
  | { kind: "failed"; error: string }
  | { kind: "inconclusive"; reason: string; keepPane?: true }
  | {
      kind: "parsed";
      parsed: Extract<ReturnType<typeof parseReviewReply>, { ok: true }>;
    };

/** pane 已開之後的部分：啟動、送出、解析、指紋檢查。內部的預期失敗都轉成 Outcome，不丟錯誤。 */
async function reviewInPane(
  deps: ReviewFlowDeps,
  input: ReviewFlowInput,
  run: {
    pane: { paneId: string; terminalId: string };
    kind: string;
    prompt: string;
    criteria: string[];
    before: string;
    context: { round: number; scope: string; headSha: string };
    skipped: { value?: UpdateSkip };
  },
): Promise<Outcome> {
  let agent: AgentRecord;
  try {
    agent = await deps.startAgent({
      paneId: run.pane.paneId,
      kind: run.kind,
      name: reviewerAgentName(input.card.id, input.round),
      cwd: input.worktreePath,
      ...(input.launch
        ? {
            args: [
              ...(input.launch.args ?? []),
              ...(input.launch.model
                ? [input.launch.modelFlag!, input.launch.model]
                : []),
            ],
          }
        : {}),
    });
  } catch (error) {
    return { kind: "failed", error: message(error) };
  }
  if (!input.card.roles)
    recordRoleSafely(() =>
      deps.onRoleAssigned?.(
        roleIdentity("reviewer", agent, { round: input.round }),
      ),
    );
  const ready = await waitUntilReady(deps, run.pane, agent);
  if (ready.updateSkip) run.skipped.value = ready.updateSkip;
  if (!ready.ok)
    return {
      kind: "inconclusive",
      reason: ready.reason,
      ...(ready.reason === BLOCKED_AT_START ? { keepPane: true as const } : {}),
    };
  if (input.card.roles) {
    const started = agent;
    const live = (await deps.panePort.listAgentsWithWorkspaceNames()).find(
      (a) => a.pane_id === started.pane_id,
    );
    if (!live) throw new Error("卡片角色就緒後 pane 已不存在");
    ready.agent = live;
    if (
      hasAgentSession(input.author.session) &&
      sameAgentSession(input.author.session, live.agent_session)
    )
      throw new Error("卡片角色不可使用作者同一 session");
    assertReadyIdentity(
      started,
      ready.agent,
      run.kind,
      input.author.workspaceId,
    );
    if (input.launch) assertFreshProfile(input.launch);
    if (
      ready.agent.model &&
      input.launch?.model &&
      ready.agent.model !== input.launch.model
    )
      throw new Error("卡片角色實際 model 與啟動指定不符");
    const actual = {
      ...ready.agent,
      ...(input.launch?.model ? { model: input.launch.model } : {}),
    };
    const constraint = input.card.roles.reviewer;
    if (constraint) assertRoleMatches("reviewer", constraint, actual);
    if (!deps.recordRoleStrict)
      throw new Error("卡片角色紀錄介面不存在，未派工");
    await deps.recordRoleStrict({
      ...roleIdentity("reviewer", actual, { round: input.round }),
      ...roleMetadata(
        "reviewer",
        constraint,
        actual,
        input.requestedKind ? "CLI" : "default",
        input.launch?.model ? "launch" : actual.model ? "observed" : "unknown",
      ),
    });
  }
  agent = {
    ...ready.agent,
    ...(input.launch?.model ? { model: input.launch.model } : {}),
  };

  let outcome: Outcome;
  try {
    const turn = await deps.runTurn(
      agent,
      run.prompt,
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (turn.state === "blocked")
      outcome = {
        kind: "inconclusive",
        reason: "reviewer 卡住了（blocked，可能在等人確認）",
      };
    else {
      const parsed = parseReviewReply(turn.text, {
        ...run.context,
        files: input.material.files,
        criteria: run.criteria,
      });
      outcome = parsed.ok
        ? { kind: "parsed", parsed }
        : { kind: "inconclusive", reason: parsed.reason };
    }
  } catch (error) {
    outcome = {
      kind: "inconclusive",
      reason: `reviewer 沒有回覆：${message(error)}`,
    };
  }

  // 工作樹指紋：reviewer 應該唯讀；被改動就整份不採用。
  try {
    const after = await deps.fingerprint(input.worktreePath);
    if (after !== run.before)
      return {
        kind: "inconclusive",
        reason:
          "reviewer 改動了工作樹（review 前後的指紋不同），整份 review 不採用",
      };
  } catch (error) {
    return {
      kind: "inconclusive",
      reason: `review 之後無法確認工作樹沒被改動：${message(error)}`,
    };
  }
  return outcome;
}
