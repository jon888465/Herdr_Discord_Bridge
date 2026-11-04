import test from "node:test";
import assert from "node:assert/strict";
import { recordFindingBatch } from "../src/card-findings.js";
import {
  formatReviewReply,
  nextReviewRound,
  type ReviewRun,
} from "../src/card-review-command.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BODY = "# x\n\n## 描述\n內容\n";

const withBatch = (body: string, round: number, scope = "whole") => {
  const result = recordFindingBatch(body, {
    round,
    scope,
    headSha: HEAD,
    verdict: "changes_requested",
    findings: [{ severity: "low", path: "src/a.ts", summary: "x" }],
  });
  assert.ok(result.ok);
  return result.ok ? result.body : body;
};

test("the first review of a card is round 1, and the next round follows the highest whole-PR round", () => {
  assert.equal(nextReviewRound(BODY), 1);
  const one = withBatch(BODY, 1);
  assert.equal(nextReviewRound(one), 2);
  assert.equal(nextReviewRound(withBatch(one, 2)), 3);
});

test("rounds of single-commit batches do not advance the whole-PR round", () => {
  const body = withBatch(BODY, 5, "89abcdef0123456789abcdef0123456789abcdef");
  assert.equal(nextReviewRound(body), 1);
});

const ok = (patch: Record<string, unknown> = {}): ReviewRun => ({
  pr: { number: 42, url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42", headSha: HEAD },
  result: {
    ok: true,
    batch: {
      round: 2,
      scope: "whole",
      headSha: HEAD,
      verdict: "changes_requested",
      findings: [
        { severity: "high", path: "src/export.ts", lineStart: 3, lineEnd: 9, summary: "缺少錯誤處理" },
        { severity: "low", path: "test/export.test.ts", summary: "命名" },
      ],
    },
    criteria: [
      { index: 1, criterion: "可以下載 CSV", status: "unmet", note: "沒有下載按鈕" },
      { index: 2, criterion: "欄位順序固定", status: "met" },
      { index: 3, criterion: "空資料時回傳空檔案", status: "unknown" },
    ],
    reviewerKind: "codex",
    sameKind: false,
    omitted: 0,
    closed: true,
    ...patch,
  },
});

test("the reply names the PR with its full URL, the head, the round, the verdict and the reviewer", () => {
  const text = formatReviewReply("REQ-20261104-export", ok(), { ids: ["F1", "F2"], omitted: 0 });
  assert.match(text, /https:\/\/github\.com\/jon888465\/Herdr_Discord_Bridge\/pull\/42/);
  assert.match(text, /REQ-20261104-export/);
  assert.match(text, /#42/);
  assert.match(text, /0123456789ab/);
  assert.match(text, /第 2 輪/);
  assert.match(text, /changes_requested/);
  assert.match(text, /codex/);
  assert.match(text, /不同種類/);
});

test("a reviewer of the author's own kind is flagged, saying only the session is independent", () => {
  const text = formatReviewReply("REQ-20261104-export", ok({ sameKind: true }), { ids: [], omitted: 0 });
  assert.match(text, /同種類/);
  assert.match(text, /session/);
});

test("every acceptance criterion gets its own line with its status and note", () => {
  const text = formatReviewReply("REQ-20261104-export", ok(), { ids: ["F1", "F2"], omitted: 0 });
  assert.match(text, /1\. ✗ 可以下載 CSV.*沒有下載按鈕/);
  assert.match(text, /2\. ✓ 欄位順序固定/);
  assert.match(text, /3\. \? 空資料時回傳空檔案/);
});

test("findings are listed with their numbers, severity and location, and the card is said to hold them", () => {
  const text = formatReviewReply("REQ-20261104-export", ok(), { ids: ["F1", "F2"], omitted: 0 });
  assert.match(text, /F1 · high · src\/export\.ts:3-9 · 缺少錯誤處理/);
  assert.match(text, /F2 · low · test\/export\.test\.ts · 命名/);
  assert.match(text, /card show REQ-20261104-export/);
});

test("only the first five findings are listed, with a count of the rest", () => {
  const many = ok();
  if (many.result.ok)
    many.result.batch.findings = Array.from({ length: 8 }, (_, i) => ({
      severity: "low" as const,
      path: "src/a.ts",
      summary: `問題 ${i + 1}`,
    }));
  const text = formatReviewReply("REQ-20261104-export", many, {
    ids: Array.from({ length: 8 }, (_, i) => `F${i + 1}`),
    omitted: 0,
  });
  assert.match(text, /問題 5/);
  assert.equal(text.includes("問題 6"), false);
  assert.match(text, /還有 3 筆/);
});

test("a downgrade, an inconclusive reason and omitted summaries are each stated", () => {
  const down = formatReviewReply("REQ-20261104-export", ok({ downgraded: "回報 pass，但有未達成條件" }), { ids: [], omitted: 2 });
  assert.match(down, /降級/);
  assert.match(down, /未達成條件/);
  assert.match(down, /2 筆.*省略|省略.*2/);
  const inc = formatReviewReply(
    "REQ-20261104-export",
    ok({ inconclusiveReason: "reviewer 沒有就緒（狀態 blocked）" }),
    { ids: [], omitted: 0 },
  );
  assert.match(inc, /inconclusive/);
  assert.match(inc, /沒有就緒/);
});

test("the reply says whether the reviewer pane was closed, and warns with the reason when it was not", () => {
  assert.match(formatReviewReply("REQ-20261104-export", ok(), undefined), /已關閉/);
  const stuck = formatReviewReply("REQ-20261104-export", ok({ closed: false, closeNote: "關閉 pane 失敗：refused" }), undefined);
  assert.match(stuck, /⚠️/);
  assert.match(stuck, /未能關閉|沒有關閉/);
  assert.match(stuck, /refused/);
  assert.match(stuck, /手動/);
});

test("a result that was not written to the card says so", () => {
  const text = formatReviewReply("REQ-20261104-export", ok(), undefined);
  assert.match(text, /沒有寫入卡片|未寫入/);
});
