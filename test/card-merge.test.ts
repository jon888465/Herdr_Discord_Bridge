import test from "node:test";
import assert from "node:assert/strict";
import {
  checkMergeable,
  pickMergeMethod,
  type MergeFacts,
} from "../src/card-merge.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const good = (patch: Partial<MergeFacts> = {}): MergeFacts => ({
  level: "L2",
  cardStatus: "done",
  review: { verdict: "pass", headSha12: HEAD.slice(0, 12), round: 2, openFindings: 0 },
  pr: { state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  checks: "success",
  sensitivePaths: [],
  ...patch,
});

function reasons(facts: MergeFacts): string[] {
  const result = checkMergeable(facts);
  return result.ok ? [] : result.reasons;
}

test("a policy L2 project whose reviewed head is the PR's head, with green checks and no sensitive paths, may be merged", () => {
  assert.deepEqual(checkMergeable(good()), { ok: true });
});

test("anything below policy L2 is refused, and the reason says how to change it", () => {
  for (const level of ["L0", "L1"] as const) {
    const r = reasons(good({ level }));
    assert.equal(r.length, 1, level);
    assert.match(r[0], /L2/);
    assert.match(r[0], new RegExp(level));
  }
});

test("a card that is not done is refused", () => {
  const r = reasons(good({ cardStatus: "in_progress" }));
  assert.equal(r.length, 1);
  assert.match(r[0], /done/);
});

test("without a review that passed, nothing is merged", () => {
  for (const review of [
    { openFindings: 0 },
    { verdict: "changes_requested" as const, headSha12: HEAD.slice(0, 12), round: 1, openFindings: 1 },
    { verdict: "inconclusive" as const, headSha12: HEAD.slice(0, 12), round: 1, openFindings: 0 },
  ]) {
    const r = reasons(good({ review }));
    assert.ok(r.length >= 1, JSON.stringify(review));
    assert.match(r.join("\n"), /review/);
  }
});

test("a review that passed an older head does not count: the head that was reviewed must be the head that is merged", () => {
  const r = reasons(good({ review: { verdict: "pass", headSha12: "f".repeat(12), round: 2, openFindings: 0 } }));
  assert.equal(r.length, 1);
  assert.match(r[0], /head/);
  assert.match(r[0], /ffffffffffff/);
  assert.match(r[0], /0123456789ab/);
});

test("open findings block the merge even when the verdict is pass", () => {
  const r = reasons(good({ review: { verdict: "pass", headSha12: HEAD.slice(0, 12), round: 2, openFindings: 2 } }));
  assert.equal(r.length, 1);
  assert.match(r[0], /open/);
});

test("checks must all be green: pending, failed, cancelled, skipped or missing checks are each refused", () => {
  for (const checks of ["pending", "failure", "cancelled", "skipped", "none"] as const) {
    const r = reasons(good({ checks }));
    assert.equal(r.length, 1, checks);
    assert.match(r[0], /CI|檢查/);
  }
});

test("a PR that is closed, merged or a draft is refused", () => {
  assert.match(reasons(good({ pr: { ...good().pr, state: "MERGED" } })).join(), /已 merge|merge/);
  assert.match(reasons(good({ pr: { ...good().pr, state: "CLOSED" } })).join(), /關閉/);
  assert.match(reasons(good({ pr: { ...good().pr, isDraft: true } })).join(), /草稿|draft/i);
});

test("GitHub's own verdict on mergeability is respected: conflicts, behind, blocked, unknown and unstable are refused with what each means", () => {
  const cases: Array<[Partial<MergeFacts["pr"]>, RegExp]> = [
    [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, /衝突/],
    [{ mergeStateStatus: "BEHIND" }, /落後|同步/],
    [{ mergeStateStatus: "BLOCKED" }, /branch protection|擋住/],
    [{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, /稍後|還在計算/],
    [{ mergeStateStatus: "UNSTABLE" }, /UNSTABLE/],
  ];
  for (const [patch, expected] of cases) {
    const r = reasons(good({ pr: { ...good().pr, ...patch } }));
    assert.ok(r.length >= 1, JSON.stringify(patch));
    assert.match(r.join("\n"), expected, JSON.stringify(patch));
  }
});

test("sensitive paths are never merged automatically, and an unknown file list counts as sensitive", () => {
  const some = reasons(good({ sensitivePaths: ["SPEC.md", ".github/workflows/ci.yml"] }));
  assert.equal(some.length, 1);
  assert.match(some[0], /敏感路徑/);
  assert.match(some[0], /SPEC\.md/);
  assert.match(some[0], /人/);
  const unknown = reasons(good({ sensitivePaths: null }));
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /無法確認/);
});

test("every failing condition is reported at once, not just the first", () => {
  const r = reasons(
    good({
      level: "L1",
      cardStatus: "in_progress",
      checks: "failure",
      sensitivePaths: ["SPEC.md"],
      review: { verdict: "changes_requested", headSha12: "f".repeat(12), round: 1, openFindings: 1 },
    }),
  );
  assert.ok(r.length >= 5, r.join("\n"));
});

test("the merge method defaults to squash, and a requested one must be allowed by the repository", () => {
  assert.deepEqual(pickMergeMethod(undefined, ["merge", "squash", "rebase"]), { ok: true, method: "squash" });
  assert.deepEqual(pickMergeMethod("merge", ["merge", "squash"]), { ok: true, method: "merge" });
  assert.deepEqual(pickMergeMethod("rebase", ["rebase"]), { ok: true, method: "rebase" });
});

test("an unknown method, a method the repository forbids, or a repository that allows none, is refused", () => {
  assert.equal(pickMergeMethod("force", ["merge", "squash"]).ok, false);
  const forbidden = pickMergeMethod("rebase", ["merge", "squash"]);
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.ok ? "" : forbidden.error, /rebase/);
  const noDefault = pickMergeMethod(undefined, ["merge"]);
  assert.equal(noDefault.ok, false);
  assert.match(noDefault.ok ? "" : noDefault.error, /--method/);
  assert.equal(pickMergeMethod(undefined, []).ok, false);
});
