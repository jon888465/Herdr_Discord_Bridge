import test from "node:test";
import assert from "node:assert/strict";
import type { FixFlowResult } from "../src/card-fix-flow.js";
import { formatFixReply } from "../src/card-fix-command.js";

type Ok = Extract<FixFlowResult, { ok: true }>;

const fixed = (patch: Record<string, unknown> = {}, extra: Partial<Ok> = {}): Ok => ({
  ok: true,
  fixerKind: "claude",
  closed: true,
  outcome: {
    kind: "fixed",
    fixed: ["F1", "F2"],
    skipped: [],
    headBefore: "a".repeat(40),
    headAfter: "b".repeat(40),
    files: ["src/export.ts", "test/export.test.ts"],
    sensitivePaths: [],
    ...patch,
  } as Ok["outcome"],
  ...extra,
});

test("a fixed round names the card, the round, the new author, the findings marked fixed and the old and new head", () => {
  const text = formatFixReply("REQ-20261104-export", 1, fixed(), ["F1", "F2"]);
  assert.match(text, /REQ-20261104-export/);
  assert.match(text, /第 1 圈/);
  assert.match(text, /claude/);
  assert.match(text, /已標為 fixed：F1、F2/);
  assert.match(text, /aaaaaaaaaaaa → bbbbbbbbbbbb/);
  assert.match(text, /src\/export\.ts、test\/export\.test\.ts/);
});

test("the next steps are to push the new commit with card pr and then review again", () => {
  const text = formatFixReply("REQ-20261104-export", 1, fixed(), ["F1", "F2"]);
  assert.match(text, /card pr REQ-20261104-export/);
  assert.match(text, /card review REQ-20261104-export/);
  assert.match(text, /第 2 輪/);
});

test("skipped findings are listed with their reasons and stay open", () => {
  const text = formatFixReply(
    "REQ-20261104-export",
    1,
    fixed({ fixed: ["F1"], skipped: [{ id: "F2", reason: "需要人決定" }] }),
    ["F1"],
  );
  assert.match(text, /略過.*F2.*需要人決定/s);
  assert.match(text, /仍是 open/);
});

test("only the first eight changed files are listed, with a count of the rest", () => {
  const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
  const text = formatFixReply("REQ-20261104-export", 1, fixed({ files }), ["F1", "F2"]);
  assert.match(text, /src\/f7\.ts/);
  assert.equal(text.includes("src/f8.ts"), false);
  assert.match(text, /等 11 個/);
});

test("sensitive paths in the fix are called out for extra care", () => {
  const text = formatFixReply("REQ-20261104-export", 1, fixed({ sensitivePaths: ["SPEC.md", ".github/workflows/ci.yml"] }), ["F1", "F2"]);
  assert.match(text, /⚠️.*敏感路徑.*SPEC\.md/s);
  assert.match(text, /請特別審查/);
});

test("a failed round says it was not adopted, why, and that no finding was changed", () => {
  const text = formatFixReply(
    "REQ-20261104-export",
    1,
    {
      ok: true,
      fixerKind: "claude",
      closed: true,
      outcome: { kind: "failed", reason: "作者回報修好了，但 worktree 沒有新的 commit", skipped: [{ id: "F2", reason: "需要人決定" }] },
    },
    undefined,
  );
  assert.match(text, /沒有被採用/);
  assert.match(text, /沒有新的 commit/);
  assert.match(text, /沒有改動任何 finding/);
  assert.match(text, /F2.*需要人決定/s);
  assert.equal(text.includes("card pr REQ-20261104-export"), false);
});

test("the reply says whether the author's pane was closed, and warns with the reason when it was not", () => {
  assert.match(formatFixReply("REQ-20261104-export", 1, fixed(), ["F1", "F2"]), /已關閉/);
  const stuck = formatFixReply("REQ-20261104-export", 1, fixed({}, { closed: false, closeNote: "關閉 pane 失敗：refused" }), ["F1", "F2"]);
  assert.match(stuck, /⚠️/);
  assert.match(stuck, /未能關閉/);
  assert.match(stuck, /refused/);
  assert.match(stuck, /手動/);
});

test("a fixed round whose result could not be written to the card says so", () => {
  assert.match(formatFixReply("REQ-20261104-export", 1, fixed(), undefined), /沒有寫入卡片/);
});
