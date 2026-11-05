import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCodingRoster,
  autoEnableCodingProfiles,
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

// E14：沒有指定 Worker 時自動啟用 claude／codex profile，agy、pi 先排除（`--coding` 還沒在它們身上驗過）。
function fakePool(profiles: Array<{ id: string; kind: string }>) {
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
