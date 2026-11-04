// `card review` 的純函式部分（追蹤清單 F5 階段 3d）：下一輪的輪次與回覆文字。
// 指令本身（讀卡片、呼叫流程、寫入卡片）在 `card-command.ts`。

import { parseFindings } from "./card-findings.js";
import type { ReviewFlowResult } from "./card-review-flow.js";

/** 注入的流程（`reviewPullRequest`）的回傳：這次 review 的 PR 與流程結果。 */
export interface ReviewRun {
  pr: { number: number; url: string; headSha: string };
  result: ReviewFlowResult;
}

const SHOWN_FINDINGS = 5;
const STATUS_MARK = { met: "✓", unmet: "✗", unknown: "?" } as const;

/** 整個 PR 的下一輪：已記錄的「整體」批次的最大輪次加一；單一 commit 的批次不計。 */
export function nextReviewRound(body: string): number {
  const rounds = parseFindings(body)
    .filter((batch) => batch.scope === "whole")
    .map((batch) => batch.round);
  return Math.max(0, ...rounds) + 1;
}

/**
 * 回覆文字。`recorded` 是寫入卡片的結果（編號、被省略的摘要數）；`undefined` 表示沒有寫入卡片
 * （寫入失敗或沒有可寫的內容），回覆會明說。
 */
export function formatReviewReply(
  cardId: string,
  run: ReviewRun,
  recorded: { ids: string[]; omitted: number } | undefined,
): string {
  const result = run.result;
  if (!result.ok) return `review 沒有進行（${result.stage}）：${result.error}`;
  const { batch } = result;
  const lines = [
    `review 完成：${cardId} · PR #${run.pr.number}（head ${run.pr.headSha.slice(0, 12)}）· 第 ${batch.round} 輪`,
    run.pr.url,
    `判定：${batch.verdict}`,
    `reviewer：${result.reviewerKind}（${result.sameKind ? "與作者同種類，獨立的只有 session，不是判斷能力" : "與作者不同種類"}）`,
  ];
  if (result.inconclusiveReason)
    lines.push(`inconclusive 的原因：${result.inconclusiveReason}`);
  if (result.downgraded) lines.push(`降級：${result.downgraded}`);

  if (result.criteria.length > 0) {
    lines.push("", "驗收條件：");
    for (const item of result.criteria)
      lines.push(
        `${item.index}. ${STATUS_MARK[item.status]} ${item.criterion}${item.note ? `（${item.note}）` : ""}`,
      );
  }

  if (batch.findings.length > 0) {
    lines.push("", `Findings（共 ${batch.findings.length} 筆）：`);
    batch.findings.slice(0, SHOWN_FINDINGS).forEach((finding, index) => {
      const where =
        finding.lineStart === undefined
          ? finding.path
          : finding.lineEnd === undefined
            ? `${finding.path}:${finding.lineStart}`
            : `${finding.path}:${finding.lineStart}-${finding.lineEnd}`;
      const id = recorded?.ids[index] ?? `#${index + 1}`;
      lines.push(`- ${id} · ${finding.severity} · ${where} · ${finding.summary}`);
    });
    if (batch.findings.length > SHOWN_FINDINGS)
      lines.push(`…還有 ${batch.findings.length - SHOWN_FINDINGS} 筆`);
  }
  if (recorded) {
    lines.push(
      "",
      `已寫入卡片（\`card show ${cardId}\` 可看 Review 發現與流程紀錄）。`,
    );
    if (recorded.omitted > 0)
      lines.push(
        `⚠️ 有 ${recorded.omitted} 筆摘要疑似含機敏資料，已整段省略。`,
      );
  } else lines.push("", "⚠️ 這次的結果沒有寫入卡片。");

  if (result.closed) lines.push("reviewer 的 pane 已關閉。");
  else
    lines.push(
      `⚠️ reviewer 的 pane 未能關閉${result.closeNote ? `：${result.closeNote}` : ""}；請手動關閉它。`,
    );
  return lines.join("\n");
}
