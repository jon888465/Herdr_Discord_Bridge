// `card merge` 的前提檢查與組裝（追蹤清單 G7，使用者 2026-11-04 決定先做手動版）。所有外部東西（政策、索引、GitHub）
// 都由呼叫端注入。**順序是安全的一部分：** 先查前提 → 在「這一刻」重新從 GitHub 與卡片讀所有事實 →
// `checkMergeable` 把所有不成立的條件一次列出並拒絕 → 選合併方式 → 最後才合併，而且只合併剛才檢查過的那個 head
// （`--match-head-commit`）。合併是最後一步、只做一次。

import path from "node:path";
import type { Card } from "./card.js";
import { blockingOpenFindings, parseFindings } from "./card-findings.js";
import { checkMergeable, pickMergeMethod } from "./card-merge.js";
import { projectName } from "./card-projects.js";
import type { CardPullRequest } from "./card-prs.js";
import type { CardWorktree } from "./card-worktrees.js";
import type {
  ChecksSummary,
  MergeMethod,
  PullRequestMergeState,
} from "./github.js";
import { levelFor, type LoadedPolicy } from "./policy.js";
import { sensitivePathsIn } from "./sensitive-paths.js";

type Repo = { owner: string; repo: string };

/** GitHub 還在計算能不能合併時，最多讀這麼多次、每次間隔多久（總共約 27 秒）。 */
const MERGEABILITY_READS = 10;
const MERGEABILITY_INTERVAL_MS = 3000;
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MergeWiringDeps {
  /** 等待用；測試可注入。 */
  sleep?: (ms: number) => Promise<void>;
  /** 只用來知道卡片屬於哪個專案（worktree 清掉之後仍可用）。 */
  worktrees: { latest(cardId: string): CardWorktree | undefined };
  prs: { forCard(cardId: string): CardPullRequest[] };
  policy(): LoadedPolicy;
  github: {
    mergeState(repo: Repo, number: number): Promise<PullRequestMergeState>;
    checks(repo: Repo, number: number): Promise<ChecksSummary>;
    files(
      repo: Repo,
      number: number,
    ): Promise<{ files: string[]; complete: boolean }>;
    allowedMethods(repo: Repo): Promise<MergeMethod[]>;
    merge(
      repo: Repo,
      input: { number: number; method: MergeMethod; headSha: string },
    ): Promise<void>;
  };
}

export interface MergeRun {
  /** `headSha` 是合併的那個 head（剛從 GitHub 讀的，不是索引裡的）。 */
  pr: { number: number; url: string; headSha: string };
  method: MergeMethod;
}

/** 唯讀：這一刻這張卡開著的 PR 的 CI 結果（`card loop --merge` 等 CI 用）；沒有開著的 PR 就丟錯誤。 */
export async function readCardChecks(
  deps: Pick<MergeWiringDeps, "prs"> & {
    github: Pick<MergeWiringDeps["github"], "checks">;
  },
  card: Card,
): Promise<ChecksSummary> {
  const tracked = deps.prs
    .forCard(card.id)
    .filter((item) => item.state === "OPEN")
    .at(-1);
  if (!tracked)
    throw new Error(
      `卡片 ${card.id} 沒有開著的 PR；請先 \`card pr ${card.id}\``,
    );
  const [owner, name] = tracked.repo.split("/");
  return deps.github.checks({ owner, repo: name }, tracked.number);
}

export async function mergeCardPullRequest(
  deps: MergeWiringDeps,
  card: Card,
  options: { method?: string },
): Promise<MergeRun> {
  const entry = deps.worktrees.latest(card.id);
  if (!entry)
    throw new Error(
      `卡片 ${card.id} 沒有 worktree 紀錄，無法判斷它屬於哪個專案（要由 \`card assign ${card.id} --worktree\` 建立過）`,
    );
  const project = projectName("local", path.basename(entry.repoPath));
  if (!project) throw new Error("無法由 repo 目錄名組出專案名稱");
  const level = levelFor(deps.policy().policy, project);

  const tracked = deps.prs
    .forCard(card.id)
    .filter((item) => item.state === "OPEN")
    .at(-1);
  if (!tracked)
    throw new Error(
      `卡片 ${card.id} 沒有開著的 PR；請先 \`card pr ${card.id}\``,
    );
  const [owner, name] = tracked.repo.split("/");
  const repo: Repo = { owner, repo: name };

  // 事實一律在這一刻重新讀取，不信索引或開 PR 時的結果。
  // ISSUE-100：GitHub 剛收到 push 或剛開 PR 時 mergeable 會是 UNKNOWN，過幾秒就算好；
  // 有上限地等一下再讀，不要把這個暫時狀態當成拒絕理由。
  let state = await deps.github.mergeState(repo, tracked.number);
  for (
    let attempt = 1;
    attempt < MERGEABILITY_READS &&
    (state.mergeable === "UNKNOWN" || state.mergeStateStatus === "UNKNOWN");
    attempt++
  ) {
    await (deps.sleep ?? defaultSleep)(MERGEABILITY_INTERVAL_MS);
    state = await deps.github.mergeState(repo, tracked.number);
  }
  const checks = await deps.github.checks(repo, tracked.number);
  const listed = await deps.github.files(repo, tracked.number);

  const whole = parseFindings(card.body).filter(
    (batch) => batch.scope === "whole",
  );
  const latest = whole.length
    ? whole.reduce((a, b) => (b.round > a.round ? b : a))
    : undefined;

  const verdict = checkMergeable({
    level,
    cardStatus: card.status,
    review: {
      ...(latest
        ? {
            verdict: latest.verdict,
            headSha12: latest.headSha,
            round: latest.round,
          }
        : {}),
      openFindings: blockingOpenFindings(card.body),
    },
    pr: {
      state: state.state,
      headSha: state.headSha,
      isDraft: state.isDraft,
      mergeable: state.mergeable,
      mergeStateStatus: state.mergeStateStatus,
    },
    checks: checks.conclusion,
    sensitivePaths: listed.complete ? sensitivePathsIn(listed.files) : null,
  });
  if (!verdict.ok)
    throw new Error(
      `不 merge PR #${tracked.number}（${verdict.reasons.length} 項條件不成立）：\n${verdict.reasons.map((reason) => `- ${reason}`).join("\n")}`,
    );

  const picked = pickMergeMethod(
    options.method,
    await deps.github.allowedMethods(repo),
  );
  if (!picked.ok) throw new Error(picked.error);

  await deps.github.merge(repo, {
    number: tracked.number,
    method: picked.method,
    headSha: state.headSha,
  });
  return {
    pr: { number: tracked.number, url: tracked.url, headSha: state.headSha },
    method: picked.method,
  };
}
