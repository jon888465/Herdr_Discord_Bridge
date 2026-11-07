// L2 的 merge 判斷（追蹤清單 G7，使用者 2026-11-04 決定先做手動 `card merge`）。純函式：給定事實，回答
// 「現在能不能合併」。原則是**什麼都不滿足就不 merge**：每一條都是獨立的拒絕條件，而且一次回報所有不成立的條件，
// 不是只回報第一個。事實由呼叫端在**這一刻**從 GitHub 與卡片重新讀取，不信開 PR 時的結果或索引。
//
// 條件：專案政策 L2；卡片 done；最新一輪整體 review 是 pass 且沒有 open 的 finding；**review 通過的 head 等於
// PR 現在的 head**（review 之後沒有新 commit）；CI 全部成功；PR 開著、不是草稿、GitHub 認為能合併且是最新；
// PR 沒有動到敏感路徑（查不到也算敏感）。

import type { ChecksConclusion, MergeMethod } from "./github.js";

export interface MergeFacts {
  level: "L0" | "L1" | "L2";
  cardStatus: string;
  /** 卡片有登記開著的 PR；in_progress 的卡片要有它才能 merge。 */
  prRegistered?: boolean;
  /** 卡片最新一輪整體 review（來自 `## Review 發現`）。 */
  review: {
    verdict?: "pass" | "changes_requested" | "inconclusive";
    /** 那一輪 review 的 head（前 12 位）。 */
    headSha12?: string;
    round?: number;
    openFindings: number;
  };
  /** PR 現在的狀態（剛從 GitHub 讀的）。 */
  pr: {
    state: "OPEN" | "MERGED" | "CLOSED";
    /** 完整 40 位。 */
    headSha: string;
    isDraft: boolean;
    mergeable: string;
    mergeStateStatus: string;
  };
  checks: ChecksConclusion;
  /** PR 現在動到的敏感路徑；`null`＝無法確認（當作敏感）。 */
  sensitivePaths: string[] | null;
}

export type MergeCheck = { ok: true } | { ok: false; reasons: string[] };

const CHECK_TEXT: Record<Exclude<ChecksConclusion, "success">, string> = {
  pending: "CI 還在跑（有檢查進行中），等全部完成且成功再 merge",
  failure: "CI 有檢查失敗",
  cancelled: "CI 有檢查被取消",
  skipped: "CI 的檢查全部被略過，沒有任何成功的檢查可以當依據",
  none: "這個 PR 沒有任何 CI 檢查，沒有成功的檢查可以當依據",
};

export function checkMergeable(facts: MergeFacts): MergeCheck {
  const reasons: string[] = [];
  const head12 = facts.pr.headSha.slice(0, 12);

  if (facts.level !== "L2")
    reasons.push(
      `專案政策是 ${facts.level}，只有 L2 才允許 bridge 自己 merge（政策檔由你手寫，bridge 不會改它；用 \`card policy\` 查看）`,
    );
  // ISSUE-123：人工接手的卡片停在 in_progress，PR 已登記即可；其他條件不變。
  if (
    facts.cardStatus !== "done" &&
    !(facts.cardStatus === "in_progress" && facts.prRegistered)
  )
    reasons.push(
      `卡片的狀態是 ${facts.cardStatus}，要是 done（或 in_progress 且已登記 PR）才能 merge`,
    );

  const { review } = facts;
  if (review.verdict === undefined)
    reasons.push("卡片還沒有 review 結果；請先 `card review`（或 `card loop`）");
  else if (review.verdict !== "pass")
    reasons.push(
      `最新一輪 review（第 ${review.round} 輪）是 ${review.verdict}，要 pass 才能 merge`,
    );
  else if (review.headSha12 !== head12)
    reasons.push(
      `review 通過的是 head ${review.headSha12}，但 PR 現在的 head 是 ${head12}（review 之後有新的 commit）；請重新 review`,
    );
  if (review.openFindings > 0)
    reasons.push(
      `還有 ${review.openFindings} 筆 open 的 finding（medium 以上；low 等級的備註不擋 merge）`,
    );

  if (facts.checks !== "success") reasons.push(CHECK_TEXT[facts.checks]);

  const { pr } = facts;
  if (pr.state === "MERGED") reasons.push("這個 PR 已經 merge 了");
  else if (pr.state === "CLOSED") reasons.push("這個 PR 已經關閉");
  else {
    if (pr.isDraft) reasons.push("這個 PR 是草稿（draft）");
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
      reasons.push("PR 與目標分支有衝突，要先解決");
    else if (pr.mergeStateStatus === "BEHIND")
      reasons.push(
        "PR 的分支落後目標分支，要先同步（Update branch）並讓 CI 在最新的 head 上重跑",
      );
    else if (pr.mergeStateStatus === "BLOCKED")
      reasons.push(
        "GitHub 回報這個 PR 被 branch protection 擋住（缺少必要的檢查或審查）",
      );
    else if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
      reasons.push("GitHub 還在計算這個 PR 能不能合併，請稍後再試");
    else if (pr.mergeStateStatus !== "CLEAN")
      reasons.push(
        `GitHub 回報的合併狀態是 ${pr.mergeStateStatus}，不是 CLEAN，不自動 merge`,
      );
  }

  if (facts.sensitivePaths === null)
    reasons.push("無法確認這個 PR 動到哪些檔案，當作動到敏感路徑，一律由人 merge");
  else if (facts.sensitivePaths.length > 0)
    reasons.push(
      `這個 PR 動到敏感路徑：${facts.sensitivePaths.join("、")}。這類 PR 一律由人 merge，不自動 merge`,
    );

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/**
 * 選合併方式：沒指定就用 squash（使用者 2026-11-04 照建議），但 repo 不允許時要明確指定 `--method`，
 * 不會偷偷換成別的方式；指定的方式必須是 repo 允許的。
 */
export function pickMergeMethod(
  requested: string | undefined,
  allowed: MergeMethod[],
): { ok: true; method: MergeMethod } | { ok: false; error: string } {
  if (allowed.length === 0)
    return { ok: false, error: "這個 repo 沒有允許任何合併方式" };
  const method = requested ?? "squash";
  if (!(METHODS as readonly string[]).includes(method))
    return {
      ok: false,
      error: `不認得的合併方式 "${method}"（可用：${METHODS.join("、")}）`,
    };
  if (!allowed.includes(method as MergeMethod))
    return {
      ok: false,
      error:
        requested === undefined
          ? `這個 repo 不允許預設的 squash（允許：${allowed.join("、")}），請用 --method 指定`
          : `這個 repo 不允許 ${method}（允許：${allowed.join("、")}）`,
    };
  return { ok: true, method: method as MergeMethod };
}
