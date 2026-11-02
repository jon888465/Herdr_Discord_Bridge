import test from "node:test";
import assert from "node:assert/strict";
import { appendLogEntries, type LogEntry } from "../src/card-ledger.js";

const e1: LogEntry = {
  time: "2026-11-02T08:15:00Z",
  event: "started",
  text: "建立 worktree",
  eventId: "3f2a9c",
};
const e2: LogEntry = {
  time: "2026-11-02T09:00:00Z",
  event: "pr_opened",
  text: "PR https://github.com/o/r/pull/9",
  eventId: "a1b2c3",
};
const line1 = "- 2026-11-02T08:15:00Z | started | 建立 worktree | ev:3f2a9c";
const line2 =
  "- 2026-11-02T09:00:00Z | pr_opened | PR https://github.com/o/r/pull/9 | ev:a1b2c3";

test("a body without the log section gets it at the end", () => {
  assert.deepEqual(appendLogEntries("# 標題\n\n## 描述\n內容\n", [e1]), {
    ok: true,
    added: 1,
    body: `# 標題\n\n## 描述\n內容\n\n## 流程紀錄\n\n${line1}\n`,
  });
});

test("a body that does not end with a newline still gets a clean section", () => {
  assert.deepEqual(appendLogEntries("# 標題\n內容", [e1]), {
    ok: true,
    added: 1,
    body: `# 標題\n內容\n\n## 流程紀錄\n\n${line1}\n`,
  });
});

test("entries go inside an existing section, in order, before the next heading", () => {
  const body = `# T\n\n## 流程紀錄\n\n${line1}\n\n## 待確認\n- a\n`;
  assert.deepEqual(appendLogEntries(body, [e2]), {
    ok: true,
    added: 1,
    body: `# T\n\n## 流程紀錄\n\n${line1}\n${line2}\n\n## 待確認\n- a\n`,
  });
  const two = appendLogEntries("# T\n", [e1, e2]);
  assert.deepEqual(two, {
    ok: true,
    added: 2,
    body: `# T\n\n## 流程紀錄\n\n${line1}\n${line2}\n`,
  });
});

test("an existing section at the end of the body is extended without disturbing the rest", () => {
  const body = `# T\n\n## 描述\n人寫的內容 | 含分隔符\n\n## 流程紀錄\n\n${line1}\n`;
  const result = appendLogEntries(body, [e2]);
  assert.deepEqual(result, {
    ok: true,
    added: 1,
    body: `# T\n\n## 描述\n人寫的內容 | 含分隔符\n\n## 流程紀錄\n\n${line1}\n${line2}\n`,
  });
});

test("an entry whose event id is already in the section, or repeated in the input, is skipped", () => {
  const body = `# T\n\n## 流程紀錄\n\n${line1}\n`;
  assert.deepEqual(appendLogEntries(body, [e1, e2, e2]), {
    ok: true,
    added: 1,
    body: `${body}${line2}\n`,
  });
  assert.deepEqual(appendLogEntries(body, [e1]), {
    ok: true,
    added: 0,
    body,
  });
});

test("an event id mentioned outside the log section does not suppress an append", () => {
  const body = "# T\n\n## 描述\n之前提到過 ev:3f2a9c 這個字串\n";
  const result = appendLogEntries(body, [e1]);
  assert.equal(result.ok && result.added, 1);
  assert.equal(result.ok && result.body, `${body}\n## 流程紀錄\n\n${line1}\n`);
});

test("a heading that only starts with the section title is not the section", () => {
  const body = "# T\n\n## 流程紀錄備註\n人寫的\n";
  assert.deepEqual(appendLogEntries(body, [e1]), {
    ok: true,
    added: 1,
    body: `${body}\n## 流程紀錄\n\n${line1}\n`,
  });
});

test("invalid entries are rejected with the field name and nothing is changed", () => {
  const bad: Array<[string, Partial<LogEntry>]> = [
    ["time", { time: "2026-11-02 08:15:00" }],
    ["time", { time: "2026-11-02T08:15:00+08:00" }],
    ["time", { time: "2026-13-02T08:15:00Z" }],
    ["event", { event: "Started" }],
    ["event", { event: "two words" }],
    ["event", { event: "" }],
    ["event", { event: "x".repeat(33) }],
    ["text", { text: "line1\nline2" }],
    ["text", { text: "a | b" }],
    ["text", { text: "tab\there" }],
    ["text", { text: "" }],
    ["text", { text: "a".repeat(1001) }],
    ["eventId", { eventId: "" }],
    ["eventId", { eventId: "has space" }],
    ["eventId", { eventId: "a|b" }],
    ["eventId", { eventId: "x".repeat(65) }],
  ];
  for (const [field, patch] of bad) {
    const result = appendLogEntries("# T\n", [e1, { ...e2, ...patch }]);
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok)
      assert.match(result.error, new RegExp(field), JSON.stringify(patch));
  }
});
