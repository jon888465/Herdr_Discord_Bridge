// 輪詢卡片開出的 PR：CI 結果寫進卡片並回報、PR 被 merge 或關閉時回報（追蹤清單 F3）。
//
// - 每個 head sha 的 CI 結果只回報一次（push 新的 commit 後會對新的 head 再回報）。
// - 先寫卡片事件、再標記已回報：中途當機時下一輪補回報，事件 id 去重不會重複記錄。
// - 讀 GitHub 失敗只回報問題、PR 維持追蹤中，不寫任何東西。
// - 卡片被刪除不影響回報（索引才是輪詢的依據）。
// - merge 只回報、不自動清理：merge 後清理屬 E11（尚未實作），回報裡提示 `card cleanup`。

import fs from "node:fs";
import { LEDGER_MAX_FILE_BYTES } from "./card.js";
import type { CardPullRequest, CardPullRequestStore } from "./card-prs.js";
import { CardStore } from "./card-store.js";
import {
  pullRequestChecks,
  pullRequestState,
  type ChecksConclusion,
  type Exec,
} from "./github.js";

export interface PrReport {
  kind: "ci" | "merged" | "closed";
  cardId: string;
  number: number;
  url: string;
  /** 要送到 thread 的訊息。 */
  text: string;
  origin?: CardPullRequest["origin"];
}

export interface PrSyncResult {
  reports: PrReport[];
  problems: string[];
}

const CI_TEXT: Record<
  Exclude<ChecksConclusion, "pending" | "none">,
  (pr: CardPullRequest, url: string) => string
> = {
  success: (pr) =>
    `✅ PR #${pr.number} 的 CI 通過（卡片 ${pr.cardId}）：${pr.url}\n可以 review 並 merge；merge 由你決定。`,
  failure: (pr, url) =>
    `❌ PR #${pr.number} 的 CI 失敗（卡片 ${pr.cardId}）：${url}\nPR：${pr.url}`,
  cancelled: (pr, url) =>
    `⚠️ PR #${pr.number} 的 CI 被取消（卡片 ${pr.cardId}）：${url}\nPR：${pr.url}`,
  skipped: (pr) =>
    `ℹ️ PR #${pr.number} 的 CI 全部略過（卡片 ${pr.cardId}）：${pr.url}`,
};

export async function syncPullRequests(options: {
  rootDir: string;
  prs: Pick<
    CardPullRequestStore,
    "open" | "markEnded" | "markCiReported" | "updateHead"
  >;
  exec: Exec;
  now: () => string;
}): Promise<PrSyncResult> {
  const result: PrSyncResult = { reports: [], problems: [] };
  const open = options.prs.open();
  if (open.length === 0) return result;
  const cards = fs.existsSync(options.rootDir)
    ? new CardStore(options.rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES })
    : undefined;

  for (const pr of open) {
    try {
      const [owner, name] = pr.repo.split("/");
      const repo = { owner, repo: name };
      const state = await pullRequestState(options.exec, repo, pr.number);
      if (state.state !== "OPEN") {
        options.prs.markEnded(pr.repo, pr.number, state.state, options.now());
        result.reports.push({
          kind: state.state === "MERGED" ? "merged" : "closed",
          cardId: pr.cardId,
          number: pr.number,
          url: pr.url,
          origin: pr.origin,
          text:
            state.state === "MERGED"
              ? `🎉 PR #${pr.number} 已 merge（卡片 ${pr.cardId}）：${pr.url}\n分支與 worktree 還在；要清理請 \`card cleanup ${pr.cardId}\`（merge 後自動清理尚未實作）。`
              : `PR #${pr.number} 已關閉、沒有 merge（卡片 ${pr.cardId}）：${pr.url}`,
        });
        continue;
      }
      if (state.headSha !== pr.headSha)
        options.prs.updateHead(pr.repo, pr.number, state.headSha);
      if (pr.ciReportedSha === state.headSha) continue;

      const checks = await pullRequestChecks(options.exec, repo, pr.number);
      if (checks.conclusion === "pending" || checks.conclusion === "none")
        continue;
      const url = checks.url ?? pr.url;
      cards?.recordEvent(pr.cardId, {
        event: "ci_result",
        conclusion: checks.conclusion,
        url,
        time: options.now(),
        eventId: `ci-${pr.number}-${state.headSha.slice(0, 12)}`,
      });
      options.prs.markCiReported(pr.repo, pr.number, state.headSha);
      result.reports.push({
        kind: "ci",
        cardId: pr.cardId,
        number: pr.number,
        url: pr.url,
        origin: pr.origin,
        text: CI_TEXT[checks.conclusion](pr, url),
      });
    } catch (error) {
      result.problems.push(
        `PR #${pr.number}：${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  return result;
}
