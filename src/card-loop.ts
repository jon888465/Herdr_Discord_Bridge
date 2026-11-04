// 自動 loop（追蹤清單 F5-loop，使用者 2026-11-04 決定：`card loop <id>` 只做手動觸發、push 自動、
// 「每次審查最多 2 輪」＝同一個 head 的 review 最多試 2 次）：review → fix → push → review …，
// 直到 `pass`，或遇到任何需要人的情況就**停下來、退回人工**。這裡只有狀態機；review、fix、push、讀卡片、
// 回報都由呼叫端注入，所以可以單獨測試。
//
// 停止條件（一律退回人工，不再自動往下）：
// - review 輪次到上限（預設 3，使用者 2026-11-04 由 5 改為 3）還沒通過；
// - 同一個 head 的 review 連續 inconclusive 兩次；
// - review、fix 或 push 丟出錯誤（前提不符、Agent 啟動失敗、卡在啟動提示、PR 已關閉或 merge…）；
// - 一圈修正失敗（沒有新 commit、回覆不合格、留下未提交修改…）；
// - 修正動到敏感路徑：commit 留在 worktree、**不 push**（F6，沒有第二個身分的替代保護）；
// - 使用者要求停止（只在步驟之間生效，不會打斷進行中的步驟）。
// 每一步的結果都即時回報；回報失敗不會中斷 loop。

import { MAX_LOOP_ROUNDS } from "./card-fix.js";

export type LoopVerdict = "pass" | "changes_requested" | "inconclusive";

/** 卡片目前的 review 狀況（來自卡片內文的 `## Review 發現`）。 */
export interface LoopView {
  /** 最新一輪整體 review 的輪次；還沒 review 過是 0。 */
  latestRound: number;
  latestVerdict?: LoopVerdict;
  /** 目前 open 的 finding 數。 */
  openFindings: number;
}

export interface LoopSteps {
  view(): LoopView;
  /** 做一次 review 並寫進卡片；前提不符等問題以丟錯誤表示。 */
  review(): Promise<{ text: string; verdict: LoopVerdict }>;
  /** 把 open 的 findings 交給新作者修一圈（成功時 commit 在 worktree、finding 標 fixed）；沒開始以丟錯誤表示。 */
  fix(): Promise<
    | { kind: "fixed"; text: string; sensitivePaths: string[] }
    | { kind: "failed"; text: string }
  >;
  /** 把新 commit push 到既有的 PR。 */
  push(): Promise<{ text: string }>;
  stopRequested(): boolean;
  notify(text: string): Promise<void>;
}

export type LoopStopStep =
  | "cancel"
  | "limit"
  | "review"
  | "inconclusive"
  | "fix"
  | "sensitive"
  | "push";

export type LoopResult =
  | { status: "passed"; steps: number }
  | { status: "stopped"; step: LoopStopStep; reason: string; steps: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export async function runLoop(
  steps: LoopSteps,
  options: { maxRounds?: number; maxAttemptsPerHead?: number } = {},
): Promise<LoopResult> {
  const maxRounds = options.maxRounds ?? MAX_LOOP_ROUNDS;
  const maxAttempts = options.maxAttemptsPerHead ?? 2;
  let count = 0;
  // push 之後的新 head 一定要先 review，即使還有 open 的 finding（作者可能略過了一筆）。
  let needsReview = false;
  let inconclusiveStreak = steps.view().latestVerdict === "inconclusive" ? 1 : 0;

  const say = async (text: string): Promise<void> => {
    try {
      await steps.notify(text);
    } catch {
      /* 回報失敗不中斷 loop。 */
    }
  };
  const stop = (step: LoopStopStep, reason: string): LoopResult => ({
    status: "stopped",
    step,
    reason,
    steps: count,
  });
  const limit = (round: number): LoopResult =>
    stop(
      "limit",
      `已經 review 到第 ${round} 輪（總上限 ${maxRounds} 次）仍未通過，退回人工處理；bridge 不會再自動 review 或修正`,
    );
  const cancelled = (note = ""): LoopResult =>
    stop("cancel", `使用者要求停止（在步驟之間生效）${note}`);

  // 安全閥：即使狀態機有疏漏也不會無限執行。
  const safety = (maxRounds + 2) * 4 + maxAttempts;
  for (let turn = 0; turn < safety; turn++) {
    if (steps.stopRequested()) return cancelled();
    const view = steps.view();
    if (!needsReview && view.latestVerdict === "pass")
      return { status: "passed", steps: count };

    const fixNext =
      !needsReview &&
      view.latestVerdict === "changes_requested" &&
      view.openFindings > 0;

    if (fixNext) {
      if (view.latestRound >= maxRounds) return limit(view.latestRound);
      let fixed: Awaited<ReturnType<LoopSteps["fix"]>>;
      try {
        fixed = await steps.fix();
        count++;
      } catch (error) {
        return stop("fix", `修正沒有進行：${message(error)}`);
      }
      await say(fixed.text);
      if (fixed.kind === "failed")
        return stop(
          "fix",
          "這一圈修正沒有被採用（原因見上方回報）；沒有 push，請人處理",
        );
      if (fixed.sensitivePaths.length > 0)
        return stop(
          "sensitive",
          `修正動到敏感路徑：${fixed.sensitivePaths.join("、")}。新 commit 留在 worktree、沒有 push，請人檢查後再 \`card pr\``,
        );
      if (steps.stopRequested())
        return cancelled("；修正已 commit 在 worktree、還沒 push");
      try {
        const pushed = await steps.push();
        count++;
        await say(pushed.text);
      } catch (error) {
        return stop(
          "push",
          `push 失敗（fix 的 commit 還在 worktree，沒有推出去）：${message(error)}`,
        );
      }
      needsReview = true;
      inconclusiveStreak = 0;
      continue;
    }

    if (view.latestRound >= maxRounds) return limit(view.latestRound);
    let reviewed: Awaited<ReturnType<LoopSteps["review"]>>;
    try {
      reviewed = await steps.review();
      count++;
    } catch (error) {
      return stop("review", `review 沒有進行：${message(error)}`);
    }
    await say(reviewed.text);
    needsReview = false;
    if (reviewed.verdict === "pass") return { status: "passed", steps: count };
    if (reviewed.verdict === "inconclusive") {
      inconclusiveStreak++;
      if (inconclusiveStreak >= maxAttempts)
        return stop(
          "inconclusive",
          `同一個 head 的 review 連續 ${inconclusiveStreak} 次 inconclusive（沒有可修的結論），退回人工處理`,
        );
      continue;
    }
    inconclusiveStreak = 0;
  }
  return stop("limit", "超過步驟上限，退回人工處理");
}
