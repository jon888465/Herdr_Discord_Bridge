import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCodingRoster,
  autoEnableCodingProfiles,
  leadGateFor,
} from "../src/coding-roster.js";

test("a coding task with no Worker is refused up front, naming the reason and the way out", () => {
  assert.throws(
    () => assertCodingRoster(true, 0),
    (error: Error) =>
      /--coding/.test(error.message) &&
      /Worker/.test(error.message) &&
      /不帶 --coding/.test(error.message),
  );
});

test("a coding task with at least one Worker or profile is allowed", () => {
  assert.doesNotThrow(() => assertCodingRoster(true, 1));
  assert.doesNotThrow(() => assertCodingRoster(true, 3));
});

test("a task that is not a coding task never needs a Worker", () => {
  assert.doesNotThrow(() => assertCodingRoster(false, 0));
});

// E14：沒有指定 Worker 時自動啟用 claude／codex profile；agy 只有 capabilities 宣告 implementation／review 才加入
// （ISSUE-107，選用）；pi 仍排除（`--coding` 還沒在它驗過）。
function fakePool(
  profiles: Array<{ id: string; kind: string; capabilities?: string[] }>,
) {
  const selected: string[] = [];
  return {
    pool: {
      profiles,
      select: (_workspace: string, id: string, enabled: boolean) => {
        if (enabled) selected.push(id);
      },
    },
    selected,
  };
}

test("with no Worker specified, claude and codex profiles are enabled for the Lead to assign; agy and pi are left out", () => {
  const { pool, selected } = fakePool([
    { id: "helper", kind: "codex" },
    { id: "reviewer", kind: "codex" },
    { id: "claude", kind: "claude" },
    { id: "agy", kind: "agy" },
    { id: "pi", kind: "pi" },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", pool), [
    "helper",
    "reviewer",
    "claude",
  ]);
  assert.deepEqual(selected, ["helper", "reviewer", "claude"]);
});

test("fewer than two usable profiles enable nothing, so the task is still refused", () => {
  for (const profiles of [
    [],
    [{ id: "claude", kind: "claude" }],
    [
      { id: "claude", kind: "claude" },
      { id: "agy", kind: "agy" },
      { id: "pi", kind: "pi" },
    ],
  ]) {
    const { pool, selected } = fakePool(profiles);
    assert.deepEqual(autoEnableCodingProfiles("w9", pool), []);
    assert.deepEqual(selected, []);
  }
});

const base = [
  { id: "helper", kind: "codex" },
  { id: "claude", kind: "claude" },
];

test("agy without capabilities or with analysis only is not added (default unchanged)", () => {
  for (const agy of [
    { id: "agy", kind: "agy" },
    { id: "agy", kind: "agy", capabilities: [] },
    { id: "agy", kind: "agy", capabilities: ["analysis"] },
  ]) {
    const { pool, selected } = fakePool([...base, agy]);
    assert.deepEqual(autoEnableCodingProfiles("w9", pool), [
      "helper",
      "claude",
    ]);
    assert.deepEqual(selected, ["helper", "claude"]);
  }
});

test("agy declaring implementation, review or both is added alongside claude/codex in profile order", () => {
  for (const capabilities of [
    ["implementation"],
    ["review"],
    ["analysis", "implementation", "review"],
  ]) {
    const { pool, selected } = fakePool([
      { id: "agy", kind: "agy", capabilities },
      ...base,
    ]);
    assert.deepEqual(autoEnableCodingProfiles("w9", pool), [
      "agy",
      "helper",
      "claude",
    ]);
    assert.deepEqual(selected, ["agy", "helper", "claude"]);
  }
});

test("an opted-in agy counts toward the two-profile minimum", () => {
  const { pool, selected } = fakePool([
    { id: "claude", kind: "claude" },
    { id: "agy", kind: "agy", capabilities: ["review"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", pool), ["claude", "agy"]);
  assert.deepEqual(selected, ["claude", "agy"]);
  const alone = fakePool([
    { id: "agy", kind: "agy", capabilities: ["implementation"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", alone.pool), []);
  assert.deepEqual(alone.selected, []);
});

test("capabilities never opt in other kinds such as pi", () => {
  const { pool, selected } = fakePool([
    ...base,
    { id: "pi", kind: "pi", capabilities: ["implementation", "review"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", pool), ["helper", "claude"]);
  assert.deepEqual(selected, ["helper", "claude"]);
});

test("the no-Worker error says agy is opt-in via capabilities and pi is unverified", () => {
  assert.throws(
    () => assertCodingRoster(true, 0),
    (error: Error) =>
      /agy/.test(error.message) &&
      /implementation/.test(error.message) &&
      /review/.test(error.message) &&
      /pi/.test(error.message) &&
      /已有程式支援/.test(error.message) &&
      /實機驗收尚未完成/.test(error.message) &&
      !/第 2、3 部分尚未完成/.test(error.message),
  );
});

// autopick Lead 的開放條件（REQ-20261109-codex-lead-agy，使用者選項 2）：agy、pi 要有宣告 implementation 的 profile。
test("claude and codex Leads need no declaration; agy and pi need a profile of the same kind with the implementation capability", () => {
  const gate = leadGateFor([
    { kind: "agy", capabilities: ["analysis"] },
    { kind: "pi", capabilities: ["implementation"] },
    { kind: "codex" },
  ]);
  assert.equal(gate("claude"), undefined);
  assert.equal(gate("codex"), undefined);
  assert.equal(gate("pi"), undefined);
  assert.match(gate("agy") ?? "", /agy.*implementation/);
  assert.match(leadGateFor([])("pi") ?? "", /pi.*implementation/);
});

test("a profile of another kind, or only review, does not open agy", () => {
  assert.match(
    leadGateFor([{ kind: "pi", capabilities: ["implementation"] }])("agy") ??
      "",
    /agy/,
  );
  assert.match(
    leadGateFor([{ kind: "agy", capabilities: ["review"] }])("agy") ?? "",
    /agy/,
  );
});
