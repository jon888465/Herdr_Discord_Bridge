// `card fix` 的回覆文字（追蹤清單 F5 的 loop 手動版）。指令本身（讀卡片、呼叫流程、寫入卡片）在 `card-command.ts`。

import type { FixFlowResult } from "./card-fix-flow.js";

const SHOWN_FILES = 8;

/**
 * `marked` 是這一圈實際標為 fixed 的 finding 編號；`undefined` 表示沒有寫入卡片（寫入失敗），回覆會明說。
 * 失敗的一圈（`outcome.kind === "failed"`）不改任何 finding 的狀態。
 */
export function formatFixReply(
  cardId: string,
  round: number,
  result: Extract<FixFlowResult, { ok: true }>,
  marked: string[] | undefined,
): string {
  const outcome = result.outcome;
  const closing = result.closed
    ? "作者的 pane 已關閉。"
    : result.paneKept
      ? `作者的 pane 已保留${result.closeNote ? `（${result.closeNote}）` : ""}；請到 pane 處理提示後自行關閉。`
      : `⚠️ 作者的 pane 未能關閉${result.closeNote ? `：${result.closeNote}` : ""}；請手動關閉它。`;
  const skippedLines = (skipped: Array<{ id: string; reason: string }>) =>
    skipped.length > 0
      ? [
          `略過（仍是 open）：${skipped.map((item) => `${item.id}（${item.reason}）`).join("；")}`,
        ]
      : [];

  if (outcome.kind === "failed")
    return [
      `修正：${cardId} · 第 ${round} 圈，這一圈沒有被採用`,
      `新作者（新開的 pane）：${result.fixerKind}`,
      `原因：${outcome.reason}`,
      ...(outcome.skipped.length > 0
        ? [
            `作者略過：${outcome.skipped.map((item) => `${item.id}（${item.reason}）`).join("；")}`,
          ]
        : []),
      "沒有改動任何 finding 的狀態，卡片的 findings 維持原樣。",
      closing,
    ].join("\n");

  const files =
    outcome.files.length > SHOWN_FILES
      ? `${outcome.files.slice(0, SHOWN_FILES).join("、")} 等 ${outcome.files.length} 個`
      : outcome.files.join("、");
  const lines = [
    `修正完成：${cardId} · 第 ${round} 圈（針對第 ${round} 輪 review 的 findings）`,
    `新作者（新開的 pane）：${result.fixerKind}`,
    `已標為 fixed：${outcome.fixed.join("、")}`,
    ...skippedLines(outcome.skipped),
    `新 commit：${outcome.headBefore.slice(0, 12)} → ${outcome.headAfter.slice(0, 12)}`,
    `改動的檔案：${files}`,
  ];
  if (outcome.sensitivePaths.length > 0)
    lines.push(
      `⚠️ 這次修正動到敏感路徑：${outcome.sensitivePaths.join("、")}。請特別審查。`,
    );
  if (!marked) lines.push("⚠️ 這次的結果沒有寫入卡片（finding 的狀態沒有改）。");
  lines.push(
    "",
    `下一步：\`card pr ${cardId}\` 把新 commit push 到既有的 PR，再 \`card review ${cardId}\`（第 ${round + 1} 輪）。`,
    closing,
  );
  return lines.join("\n");
}
