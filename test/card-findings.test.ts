import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import {
  FINDINGS_HEADING,
  MAX_BATCH_FINDINGS,
  MAX_FINDINGS,
  SUMMARY_OMITTED,
  parseFindings,
  recordFindingBatch,
  setFindingStatus,
  summarizeFindings,
  type FindingBatch,
  type FindingInput,
} from "../src/card-findings.js";

const cat = (...parts: string[]): string => parts.join("");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const finding = (patch: Partial<FindingInput> = {}): FindingInput => ({
  severity: "high",
  path: "src/foo.ts",
  lineStart: 12,
  lineEnd: 20,
  summary: "缺少錯誤處理，null 時會丟例外",
  ...patch,
});

const batch = (patch: Partial<FindingBatch> = {}): FindingBatch => ({
  round: 1,
  scope: "whole",
  headSha: HEAD,
  verdict: "changes_requested",
  findings: [finding(), finding({ severity: "low", path: "docs/x.md", lineStart: undefined, lineEnd: undefined, summary: "路徑寫錯" })],
  ...patch,
});

const BODY = "# 標題\n\n## 描述\n內容\n";

function record(body: string, input: FindingBatch) {
  const result = recordFindingBatch(body, input);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

test("recording a batch creates the section at the end when the card has no log, with numbered finding lines", () => {
  const result = record(BODY, batch());
  assert.equal(result.changed, true);
  assert.deepEqual(result.ids, ["F1", "F2"]);
  assert.ok(result.body.startsWith(BODY.trimEnd()));
  assert.ok(result.body.includes(`\n${FINDINGS_HEADING}\n`));
  assert.ok(
    result.body.includes(
      "### 第 1 輪 · 整體 · head 0123456789ab · changes_requested",
    ),
  );
  assert.ok(
    result.body.includes(
      "- F1 | high | open | src/foo.ts:12-20 | 缺少錯誤處理，null 時會丟例外",
    ),
  );
  assert.ok(result.body.includes("- F2 | low | open | docs/x.md | 路徑寫錯"));
});

test("the section goes before the process log so the log stays last, and nothing else changes", () => {
  const withLog = `${BODY}\n## 異動專案\n\n### local:r\n\n- 機器：local\n\n## 流程紀錄\n\n- 2026-11-03T08:00:00Z | started | x | ev:a\n`;
  const result = record(withLog, batch());
  const section = result.body.indexOf(FINDINGS_HEADING);
  const log = result.body.indexOf("## 流程紀錄");
  assert.ok(section > 0 && section < log);
  assert.equal(
    result.body.replace(/\n## Review 發現\n[\s\S]*?(?=\n## 流程紀錄)/, ""),
    withLog,
  );
});

test("a single-commit batch is labelled with the commit, and a different scope in the same round is a different batch", () => {
  const first = record(BODY, batch());
  const second = record(
    first.body,
    batch({ scope: "89abcdef0123456789abcdef0123456789abcdef", verdict: "pass", findings: [] }),
  );
  assert.equal(second.changed, true);
  assert.ok(second.body.includes("### 第 1 輪 · commit 89abcdef0123 · head 0123456789ab · pass"));
  assert.equal(parseFindings(second.body).length, 2);
});

test("finding numbers continue across batches and are never reused", () => {
  const first = record(BODY, batch());
  const second = record(first.body, batch({ round: 2, findings: [finding({ summary: "第二輪新發現" })] }));
  assert.deepEqual(second.ids, ["F3"]);
  assert.ok(second.body.includes("- F3 | high | open | src/foo.ts:12-20 | 第二輪新發現"));
});

test("recording the same round and scope again is idempotent and rewrites nothing", () => {
  const first = record(BODY, batch());
  const again = record(first.body, batch({ findings: [finding({ summary: "不同內容，但同一批" })] }));
  assert.equal(again.changed, false);
  assert.equal(again.body, first.body);
  assert.deepEqual(again.ids, []);
});

test("a suspicious summary is replaced as a whole by the fixed message and counted, other fields stay", () => {
  const secret = cat("ghp_", "a".repeat(36));
  const result = record(
    BODY,
    batch({ findings: [finding({ summary: `token ${secret} 外洩` }), finding()] }),
  );
  assert.equal(result.omitted, 1);
  assert.ok(result.body.includes(`- F1 | high | open | src/foo.ts:12-20 | ${SUMMARY_OMITTED}`));
  assert.equal(result.body.includes(secret), false);
  assert.ok(result.body.includes("缺少錯誤處理"));
});

test("invalid input rejects the whole batch and the body is untouched", () => {
  const bad: Array<[string, FindingBatch]> = [
    ["severity", batch({ findings: [finding({ severity: "urgent" as never })] })],
    ["path with ..", batch({ findings: [finding({ path: "src/../etc/passwd" })] })],
    ["absolute path", batch({ findings: [finding({ path: "/etc/passwd" })] })],
    ["path with a space", batch({ findings: [finding({ path: "src/a b.ts" })] })],
    ["path with a colon", batch({ findings: [finding({ path: "src/a:b.ts" })] })],
    ["secret-looking path", batch({ findings: [finding({ path: cat("src/ghp_", "a".repeat(36), ".ts") })] })],
    ["empty summary", batch({ findings: [finding({ summary: "" })] })],
    ["summary over 200 characters", batch({ findings: [finding({ summary: "字".repeat(201) })] })],
    ["summary with a newline", batch({ findings: [finding({ summary: "a\nb" })] })],
    ["summary with a separator", batch({ findings: [finding({ summary: "a | b" })] })],
    ["line 0", batch({ findings: [finding({ lineStart: 0, lineEnd: 3 })] })],
    ["end before start", batch({ findings: [finding({ lineStart: 9, lineEnd: 3 })] })],
    ["round 0", batch({ round: 0 })],
    ["bad head sha", batch({ headSha: "xyz" })],
    ["bad scope", batch({ scope: "not-a-sha" })],
    ["bad verdict", batch({ verdict: "maybe" as never })],
    [`more than ${MAX_BATCH_FINDINGS} findings`, batch({ findings: Array.from({ length: MAX_BATCH_FINDINGS + 1 }, () => finding()) })],
  ];
  for (const [label, input] of bad) {
    const result = recordFindingBatch(BODY, input);
    assert.equal(result.ok, false, label);
  }
});

test("a summary of exactly 200 characters is accepted", () => {
  const result = record(BODY, batch({ findings: [finding({ summary: "字".repeat(200) })] }));
  assert.equal(result.changed, true);
});

test("a card cannot hold more than the total limit of findings", () => {
  let body = BODY;
  for (let round = 1; round <= 4; round++)
    body = record(body, batch({ round, findings: Array.from({ length: 25 }, () => finding()) })).body;
  assert.equal(parseFindings(body).flatMap((b) => b.findings).length, MAX_FINDINGS);
  const over = recordFindingBatch(body, batch({ round: 5, findings: [finding()] }));
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.error, /100/);
});

test("lines a person added to the section are kept and the text outside it is unchanged", () => {
  const first = record(`${BODY}\n## 決議\n人寫的決議\n`, batch());
  const edited = first.body.replace("- F2 |", "人加的備註\n- F2 |");
  const second = record(edited, batch({ round: 2, findings: [finding({ summary: "新" })] }));
  assert.ok(second.body.includes("人加的備註"));
  assert.ok(second.body.includes("## 決議\n人寫的決議"));
});

test("status moves forward only: open to fixed to resolved, or dismissed", () => {
  const { body } = record(BODY, batch());
  const fixed = setFindingStatus(body, "F1", "fixed");
  assert.ok(fixed.ok && fixed.changed);
  assert.ok(fixed.ok && fixed.body.includes("- F1 | high | fixed |"));
  const resolved = setFindingStatus(fixed.ok ? fixed.body : "", "F1", "resolved");
  assert.ok(resolved.ok && resolved.body.includes("- F1 | high | resolved |"));
  const direct = setFindingStatus(body, "F2", "resolved");
  assert.ok(direct.ok && direct.body.includes("- F2 | low | resolved |"));
  const dismissed = setFindingStatus(body, "F2", "dismissed");
  assert.ok(dismissed.ok && dismissed.body.includes("- F2 | low | dismissed |"));
});

test("a resolved or dismissed finding cannot move back, and fixed cannot reopen", () => {
  const { body } = record(BODY, batch());
  const resolved = setFindingStatus(body, "F1", "resolved");
  assert.equal(setFindingStatus(resolved.ok ? resolved.body : "", "F1", "open").ok, false);
  assert.equal(setFindingStatus(resolved.ok ? resolved.body : "", "F1", "fixed").ok, false);
  const dismissed = setFindingStatus(body, "F2", "dismissed");
  assert.equal(setFindingStatus(dismissed.ok ? dismissed.body : "", "F2", "resolved").ok, false);
  const fixed = setFindingStatus(body, "F1", "fixed");
  assert.equal(setFindingStatus(fixed.ok ? fixed.body : "", "F1", "open").ok, false);
});

test("setting the same status is a no-op, and an unknown or malformed id is rejected", () => {
  const { body } = record(BODY, batch());
  const same = setFindingStatus(body, "F1", "open");
  assert.ok(same.ok && !same.changed && same.body === body);
  assert.equal(setFindingStatus(body, "F9", "fixed").ok, false);
  assert.equal(setFindingStatus(body, "x1", "fixed").ok, false);
  assert.equal(setFindingStatus(BODY, "F1", "fixed").ok, false);
  assert.equal(setFindingStatus(body, "F1", "weird" as never).ok, false);
});

test("parseFindings reads back what was recorded, and a card without the section has none", () => {
  assert.deepEqual(parseFindings(BODY), []);
  const { body } = record(BODY, batch());
  const parsed = parseFindings(body);
  assert.equal(parsed.length, 1);
  assert.deepEqual(
    { round: parsed[0].round, scope: parsed[0].scope, headSha: parsed[0].headSha, verdict: parsed[0].verdict },
    { round: 1, scope: "whole", headSha: "0123456789ab", verdict: "changes_requested" },
  );
  assert.deepEqual(parsed[0].findings[0], {
    id: "F1",
    severity: "high",
    status: "open",
    path: "src/foo.ts",
    lineStart: 12,
    lineEnd: 20,
    summary: "缺少錯誤處理，null 時會丟例外",
  });
  assert.equal(parsed[0].findings[1].lineStart, undefined);
});

test("summarizeFindings counts by status and lists only open findings, capped", () => {
  let body = record(BODY, batch({ findings: Array.from({ length: 12 }, (_, i) => finding({ summary: `問題 ${i + 1}` })) })).body;
  const fixed = setFindingStatus(body, "F1", "fixed");
  body = fixed.ok ? fixed.body : body;
  const summary = summarizeFindings(body, 10);
  assert.equal(summary.total, 12);
  assert.deepEqual(summary.counts, { open: 11, fixed: 1, resolved: 0, dismissed: 0 });
  assert.equal(summary.open.length, 10);
  assert.equal(summary.open[0].id, "F2");
  assert.equal(summary.open[0].round, 1);
  assert.deepEqual(summarizeFindings(BODY).counts, { open: 0, fixed: 0, resolved: 0, dismissed: 0 });
});

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-findings-"));
  const store = new CardStore(root);
  const id = "REQ-20261104-findings";
  fs.writeFileSync(
    path.join(root, `${id}.md`),
    `---\nid: ${id}\ntype: requirement\nstatus: done\ntitle: 範例\nversion: 1\ncreated: 2026-11-01\nupdated: 2026-11-01\n---\n\n# 範例\n\n## 描述\n內容\n`,
  );
  return { store, id, root };
}

test("the store writes a batch, bumps updated, and does not rewrite the file when nothing changed", () => {
  const { store, id, root } = tempStore();
  const first = store.recordFindings(id, batch(), "2026-11-04");
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.deepEqual(first.ok && first.ids, ["F1", "F2"]);
  assert.equal(first.ok && first.card.updated, "2026-11-04");
  const file = path.join(root, `${id}.md`);
  const before = fs.statSync(file).mtimeMs;
  const again = store.recordFindings(id, batch(), "2026-11-05");
  assert.ok(again.ok && again.ids.length === 0);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(again.ok && again.card.updated, "2026-11-04");
});

test("the store changes a finding's status, and refuses invalid input without touching the card", () => {
  const { store, id, root } = tempStore();
  store.recordFindings(id, batch(), "2026-11-04");
  const moved = store.setFindingStatus(id, "F1", "fixed", "2026-11-04");
  assert.ok(moved.ok && moved.card.body.includes("- F1 | high | fixed |"));
  const file = path.join(root, `${id}.md`);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(store.setFindingStatus(id, "F1", "open", "2026-11-04").ok, false);
  assert.equal(store.recordFindings(id, batch({ round: 0 }), "2026-11-04").ok, false);
  assert.equal(store.recordFindings(id, batch(), "bad-date").ok, false);
  assert.equal(store.recordFindings("REQ-20261104-missing", batch(), "2026-11-04").ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});
