import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCodingRoster,
  autoEnableCodingProfiles,
  leadGateFor,
  needsFreshCodingProfileSession,
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

// E14：沒有指定 Worker 時自動啟用 claude／codex／pi profile；agy 只有 capabilities 宣告 implementation／review 才加入。
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

test("with no Worker specified, claude, codex and pi profiles are enabled; agy remains opt-in", () => {
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
    "pi",
  ]);
  assert.deepEqual(selected, ["helper", "reviewer", "claude", "pi"]);
});

test("no eligible profiles enables nothing, while one eligible profile is sufficient", () => {
  const empty = fakePool([
    { id: "agy", kind: "agy", capabilities: ["analysis"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", empty.pool), []);
  assert.deepEqual(empty.selected, []);

  for (const profile of [
    { id: "codex", kind: "codex" },
    { id: "pi", kind: "pi" },
    { id: "agy", kind: "agy", capabilities: ["review"] },
  ]) {
    const { pool, selected } = fakePool([profile]);
    assert.deepEqual(autoEnableCodingProfiles("w9", pool), [profile.id]);
    assert.deepEqual(selected, [profile.id]);
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

test("an opted-in agy can be the only coding profile", () => {
  const { pool, selected } = fakePool([
    { id: "claude", kind: "claude" },
    { id: "agy", kind: "agy", capabilities: ["review"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", pool), ["claude", "agy"]);
  assert.deepEqual(selected, ["claude", "agy"]);
  const alone = fakePool([
    { id: "agy", kind: "agy", capabilities: ["implementation"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", alone.pool), ["agy"]);
  assert.deepEqual(alone.selected, ["agy"]);
});

test("pi is automatically eligible regardless of capabilities", () => {
  const { pool, selected } = fakePool([
    { id: "pi", kind: "pi" },
    { id: "pi-impl", kind: "pi", capabilities: ["implementation"] },
  ]);
  assert.deepEqual(autoEnableCodingProfiles("w9", pool), ["pi", "pi-impl"]);
  assert.deepEqual(selected, ["pi", "pi-impl"]);
});

test("the no-Worker error names pi and the single-profile fresh-session behavior", () => {
  assert.throws(
    () => assertCodingRoster(true, 0),
    (error: Error) =>
      /agy/.test(error.message) &&
      /implementation/.test(error.message) &&
      /review/.test(error.message) &&
      /pi/.test(error.message) &&
      /單一 profile/.test(error.message) &&
      /fresh session/.test(error.message),
  );
});

test("a lone coding profile uses fresh sessions; non-coding or multi-worker rosters do not", () => {
  assert.equal(
    needsFreshCodingProfileSession(true, [{ pane_id: "profile:pi" }]),
    true,
  );
  assert.equal(
    needsFreshCodingProfileSession(false, [{ pane_id: "profile:pi" }]),
    false,
  );
  assert.equal(
    needsFreshCodingProfileSession(true, [
      { pane_id: "profile:pi" },
      { pane_id: "profile:codex" },
    ]),
    false,
  );
  assert.equal(
    needsFreshCodingProfileSession(true, [{ pane_id: "w1:p2" }]),
    false,
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
