import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardAssignmentStore } from "../src/card-assignments.js";

function file(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "card-assignments-")),
    "state",
    "card-assignments.json",
  );
}

const first = {
  taskId: "task-a",
  cardId: "REQ-20261102-one",
  type: "requirement",
};
const second = { taskId: "task-b", cardId: "TKT-20261102-two", type: "ticket" };

test("a missing file is an empty store and nothing is created until something is recorded", () => {
  const f = file();
  const store = new CardAssignmentStore(f);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(f), false);
});

test("recorded assignments persist across instances and are readable per card", () => {
  const f = file();
  const store = new CardAssignmentStore(f);
  store.record(first, "2026-11-02T08:00:00Z");
  store.record(second, "2026-11-02T08:05:00Z");
  store.record({ ...first, taskId: "task-c" }, "2026-11-02T09:00:00Z");
  const reopened = new CardAssignmentStore(f);
  assert.deepEqual(
    reopened.list().map((a) => a.taskId),
    ["task-a", "task-b", "task-c"],
  );
  assert.deepEqual(
    reopened.forCard("REQ-20261102-one").map((a) => a.taskId),
    ["task-a", "task-c"],
  );
  assert.equal(reopened.list()[0].assignedAt, "2026-11-02T08:00:00Z");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  }
});

test("recording the same task again changes nothing", () => {
  const f = file();
  const store = new CardAssignmentStore(f);
  store.record(first, "2026-11-02T08:00:00Z");
  const before = fs.readFileSync(f, "utf8");
  store.record(first, "2026-11-02T10:00:00Z");
  assert.equal(fs.readFileSync(f, "utf8"), before);
  assert.equal(store.list().length, 1);
});

test("markNotified records the time once and is idempotent", () => {
  const f = file();
  const store = new CardAssignmentStore(f);
  store.record(first, "2026-11-02T08:00:00Z");
  store.markNotified("task-a", "2026-11-02T08:30:00Z");
  store.markNotified("task-a", "2026-11-02T09:30:00Z");
  assert.equal(
    new CardAssignmentStore(f).list()[0].notifiedAt,
    "2026-11-02T08:30:00Z",
  );
  assert.throws(
    () => store.markNotified("task-none", "2026-11-02T09:30:00Z"),
    /task-none/,
  );
});

test("invalid ids and types are refused and nothing is written", () => {
  const f = file();
  const store = new CardAssignmentStore(f);
  assert.throws(
    () => store.record({ ...first, cardId: "../x" }, "2026-11-02T08:00:00Z"),
    /cardId/,
  );
  assert.throws(
    () => store.record({ ...first, taskId: "a b" }, "2026-11-02T08:00:00Z"),
    /taskId/,
  );
  assert.throws(
    () => store.record({ ...first, type: "other" }, "2026-11-02T08:00:00Z"),
    /type/,
  );
  assert.throws(() => store.record(first, "yesterday"), /time/);
  assert.equal(fs.existsSync(f), false);
});

test("a corrupt or tampered file is refused instead of being treated as empty", () => {
  for (const content of [
    "not json",
    JSON.stringify({ version: 2, assignments: [] }),
    JSON.stringify({
      version: 1,
      assignments: [
        {
          taskId: "a b",
          cardId: "REQ-20261102-one",
          type: "requirement",
          assignedAt: "2026-11-02T08:00:00Z",
        },
      ],
    }),
    JSON.stringify({
      version: 1,
      assignments: [{ ...first, assignedAt: "x" }],
    }),
    JSON.stringify({
      version: 1,
      assignments: [
        { ...first, assignedAt: "2026-11-02T08:00:00Z" },
        { ...first, assignedAt: "2026-11-02T08:00:00Z" },
      ],
    }),
  ]) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    assert.throws(
      () => new CardAssignmentStore(f),
      /card-assignments/,
      content,
    );
  }
});
