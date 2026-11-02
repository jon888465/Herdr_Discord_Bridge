import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLogEntry,
  OMITTED_TEXT,
  type CardEvent,
} from "../src/card-events.js";
import { validateLogEntry } from "../src/card-ledger.js";

const base = { time: "2026-11-02T08:15:00Z", eventId: "ev0001" };
const cat = (...parts: string[]): string => parts.join("");

const templates: Array<[CardEvent, string]> = [
  [
    { ...base, event: "assigned", machine: "local", agent: "codex-builder" },
    "指派給 codex-builder（local）",
  ],
  [
    {
      ...base,
      event: "worktree_created",
      machine: "agy-pod",
      path: "/root/.herdr/worktrees/repo/card-1",
      branch: "card/REQ-20261102-example",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    },
    "建立 worktree agy-pod:/root/.herdr/worktrees/repo/card-1 分支 card/REQ-20261102-example 基準 0123456789ab",
  ],
  [{ ...base, event: "started", taskId: "task-42" }, "開始執行 task task-42"],
  [
    {
      ...base,
      event: "review_verdict",
      role: "reviewer",
      verdict: "changes_requested",
      round: 2,
    },
    "review reviewer 第 2 輪：changes_requested",
  ],
  [
    { ...base, event: "verify_result", result: "pass", passed: 120, failed: 0 },
    "驗證 pass：通過 120／失敗 0",
  ],
  [
    {
      ...base,
      event: "pr_opened",
      url: "https://github.com/o/r/pull/9",
      number: 9,
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    },
    "PR #9 abcdef123456 https://github.com/o/r/pull/9",
  ],
  [
    {
      ...base,
      event: "ci_result",
      conclusion: "success",
      url: "https://github.com/o/r/actions/runs/123",
    },
    "CI success https://github.com/o/r/actions/runs/123",
  ],
  [
    {
      ...base,
      event: "merged",
      sha: "fedcba9876543210fedcba9876543210fedcba98",
      method: "squash",
    },
    "已合併 fedcba987654（squash）",
  ],
  [{ ...base, event: "blocked", reason: "quota" }, "被擋住：quota"],
  [{ ...base, event: "resumed" }, "已恢復"],
  [{ ...base, event: "failed", code: "ci_red" }, "失敗：ci_red"],
  [
    {
      ...base,
      event: "failed",
      code: "push_rejected",
      reason: "non-fast-forward",
    },
    "失敗：push_rejected；原因：non-fast-forward",
  ],
  [{ ...base, event: "cancelled", by: "user" }, "已取消（user）"],
  [{ ...base, event: "cleanup_done", result: "removed" }, "清理完成：removed"],
  [
    { ...base, event: "cleanup_pending", reason: "dirty_worktree" },
    "清理待處理：dirty_worktree",
  ],
];

for (const [event, text] of templates) {
  test(`${event.event} is rendered from its fixed template`, () => {
    const result = buildLogEntry(event);
    assert.deepEqual(result, {
      ok: true,
      omitted: false,
      entry: {
        time: base.time,
        event: event.event,
        eventId: base.eventId,
        text,
      },
    });
  });
}

const reject = (event: unknown, field: RegExp, label: string) => {
  const result = buildLogEntry(event as CardEvent);
  assert.equal(result.ok, false, label);
  if (!result.ok) assert.match(result.error, field, label);
};

test("fields that do not match their pattern are rejected, naming the field", () => {
  const wt = {
    ...base,
    event: "worktree_created",
    machine: "agy-pod",
    path: "/work/tree",
    branch: "card/x",
    baseSha: "0123456789abcdef",
  };
  reject({ ...wt, machine: "bad machine" }, /machine/, "machine space");
  reject({ ...wt, machine: "" }, /machine/, "machine empty");
  reject({ ...wt, path: "relative/path" }, /path/, "relative path");
  reject({ ...wt, path: "/a | b" }, /path/, "path separator");
  reject({ ...wt, path: "/a\nb" }, /path/, "path newline");
  reject({ ...wt, path: "/" + "a".repeat(120) }, /path/, "path too long");
  reject({ ...wt, branch: "has space" }, /branch/, "branch space");
  reject({ ...wt, branch: "a;b" }, /branch/, "branch punctuation");
  reject({ ...wt, branch: "a".repeat(81) }, /branch/, "branch too long");
  reject({ ...wt, baseSha: "XYZ" }, /baseSha/, "sha not hex");
  reject({ ...wt, baseSha: "abc" }, /baseSha/, "sha too short");

  const pr = {
    ...base,
    event: "pr_opened",
    url: "https://github.com/o/r/pull/9",
    number: 9,
    headSha: "abcdef1",
  };
  reject({ ...pr, url: "ftp://example.invalid/x" }, /url/, "url scheme");
  reject({ ...pr, url: "https://example.invalid/a b" }, /url/, "url space");
  reject(
    { ...pr, url: "https://e.invalid/" + "a".repeat(140) },
    /url/,
    "url long",
  );
  reject({ ...pr, number: 0 }, /number/, "number zero");
  reject({ ...pr, number: 1.5 }, /number/, "number fraction");
  reject({ ...pr, number: Number.NaN }, /number/, "number NaN");

  reject({ ...base, event: "started", taskId: "a b" }, /taskId/, "taskId");
  reject(
    { ...base, event: "assigned", machine: "m", agent: "a b" },
    /agent/,
    "agent",
  );
  reject(
    {
      ...base,
      event: "review_verdict",
      role: "Reviewer",
      verdict: "pass",
      round: 1,
    },
    /role/,
    "role",
  );
  reject(
    { ...base, event: "review_verdict", role: "r", verdict: "maybe", round: 1 },
    /verdict/,
    "verdict",
  );
  reject(
    { ...base, event: "review_verdict", role: "r", verdict: "pass", round: 0 },
    /round/,
    "round",
  );
  reject(
    { ...base, event: "verify_result", result: "pass", passed: -1, failed: 0 },
    /passed/,
    "passed",
  );
  reject(
    { ...base, event: "blocked", reason: "bored" },
    /reason/,
    "blocked reason",
  );
  reject({ ...base, event: "cancelled", by: "robot" }, /by/, "cancelled by");
  reject({ ...base, event: "failed", code: "Bad Code" }, /code/, "failed code");
  reject(
    { ...base, event: "failed", code: "x", reason: 5 },
    /reason/,
    "reason type",
  );
  reject({ ...base, event: "nonsense" }, /event/, "unknown event");
  reject({ ...base, event: "started" }, /taskId/, "missing field");
});

test("time and event id are validated like every log entry", () => {
  reject({ ...base, time: "yesterday", event: "resumed" }, /time/, "time");
  reject(
    { ...base, eventId: "has space", event: "resumed" },
    /eventId/,
    "eventId",
  );
});

test("every event stays within 300 characters when its fields are at their maximum", () => {
  const sha = "a".repeat(40);
  const url = "https://e.invalid/" + "p".repeat(132);
  assert.equal(url.length, 150);
  const longest: CardEvent[] = [
    {
      ...base,
      event: "assigned",
      machine: "m".repeat(32),
      agent: "a".repeat(40),
    },
    {
      ...base,
      event: "worktree_created",
      machine: "m".repeat(32),
      path: "/" + "p".repeat(119),
      branch: "b".repeat(80),
      baseSha: sha,
    },
    { ...base, event: "started", taskId: "t".repeat(64) },
    {
      ...base,
      event: "review_verdict",
      role: "r".repeat(32),
      verdict: "changes_requested",
      round: 1000000,
    },
    {
      ...base,
      event: "verify_result",
      result: "fail",
      passed: 1000000,
      failed: 1000000,
    },
    { ...base, event: "pr_opened", url, number: 9999999, headSha: sha },
    { ...base, event: "ci_result", conclusion: "action_required", url },
    { ...base, event: "merged", sha, method: "squash" },
    {
      ...base,
      event: "failed",
      code: "c".repeat(32),
      reason: "字".repeat(200),
    },
  ];
  for (const event of longest) {
    const result = buildLogEntry(event);
    assert.equal(result.ok, true, event.event);
    if (!result.ok) continue;
    assert.ok(Array.from(result.entry.text).length <= 300, event.event);
    assert.equal(validateLogEntry(result.entry), null, event.event);
    assert.equal(result.omitted, false, event.event);
  }
});

test("a suspected secret in one field replaces the whole text with the fixed message and keeps the event", () => {
  const token = cat("gh", "p_", "FAKEFAKEFAKE0123456789ABCD");
  const result = buildLogEntry({
    ...base,
    event: "worktree_created",
    machine: "agy-pod",
    path: "/work/tree",
    branch: token,
    baseSha: "0123456789abcdef",
  });
  assert.deepEqual(result, {
    ok: true,
    omitted: true,
    entry: {
      time: base.time,
      event: "worktree_created",
      eventId: base.eventId,
      text: OMITTED_TEXT,
    },
  });
  assert.equal(OMITTED_TEXT, "內容已省略：疑似含機敏資料");
});

test("credentials and secret-looking query parameters in a URL are scrubbed and the event is still written", () => {
  const result = buildLogEntry({
    ...base,
    event: "pr_opened",
    url: "https://user:pw@github.com/o/r/pull/9?access_token=XYZ&page=2",
    number: 9,
    headSha: "abcdef1234567890",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.omitted, false);
  assert.equal(
    result.entry.text,
    "PR #9 abcdef123456 https://[redacted]@github.com/o/r/pull/9?access_token=[redacted]&page=2",
  );
  assert.equal(result.entry.text.includes("pw"), false);
  assert.equal(result.entry.text.includes("XYZ"), false);
});

test("a failure reason is normalised, bounded to 200 characters and checked before it is truncated", () => {
  const withReason = (reason: string) =>
    buildLogEntry({ ...base, event: "failed", code: "push_rejected", reason });
  const text = (reason: string) => {
    const r = withReason(reason);
    return r.ok ? r.entry.text : r.error;
  };

  assert.equal(
    text("line1\n\tline2   spaced "),
    "失敗：push_rejected；原因：line1 line2 spaced",
  );
  assert.equal(
    text("git push rejected (non-fast-forward)"),
    "失敗：push_rejected；原因：git push rejected (non-fast-forward)",
  );
  assert.equal(text("   \n  "), "失敗：push_rejected");
  assert.equal(text(""), "失敗：push_rejected");

  const exact = "字".repeat(200);
  assert.equal(text(exact), `失敗：push_rejected；原因：${exact}`);
  assert.equal(
    text(exact + "字"),
    `失敗：push_rejected；原因：${"字".repeat(199)}…`,
  );

  // 機敏檢查必須在截斷之前：這個 token 被截斷點切斷後就比對不到了。
  const split = "x".repeat(195) + " " + cat("gh", "p_", "A".repeat(30));
  const omitted = withReason(split);
  assert.equal(omitted.ok && omitted.omitted, true);
  assert.equal(omitted.ok && omitted.entry.text, OMITTED_TEXT);
  assert.equal(
    withReason("token: abc123").ok &&
      (withReason("token: abc123") as { omitted: boolean }).omitted,
    true,
  );
});
