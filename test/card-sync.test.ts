import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { CardStore } from "../src/card-store.js";
import type { CardAssignment } from "../src/card-assignments.js";
import {
  syncCards,
  taskSourceFrom,
  type TaskSource,
} from "../src/card-sync.js";
import { TeamTaskStore } from "../src/team-task-store.js";
import type { AgentRecord } from "../src/types.js";

const cat = (...parts: string[]): string => parts.join("");

interface FakeTask {
  state: string;
  detail?: string;
  finishedAt?: string;
  /** 這個任務的 journal：第幾筆事件開始是目前的終止狀態。 */
  terminalSequence?: number;
}

function setup(tasks: Record<string, FakeTask> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "card-sync-"));
  const rootDir = path.join(base, "cards");
  const store = new CardStore(rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const source: TaskSource = {
    get(taskId) {
      const task = tasks[taskId];
      if (!task) return undefined;
      return {
        state: task.state,
        detail: task.detail,
        finishedAt: task.finishedAt,
        terminalSequence: task.terminalSequence,
      };
    },
  };
  const run = (assignments: CardAssignment[] = []) =>
    syncCards({
      rootDir,
      tasks: source,
      assignments: { list: () => assignments },
      now: () => "2026-11-02T09:00:00Z",
    });
  return { rootDir, store, tasks, run };
}

const card = (id: string, patch: Partial<Card> = {}): Card => ({
  id,
  type: "requirement",
  status: "in_progress",
  title: `標題 ${id}`,
  version: 1,
  created: "2026-11-01",
  updated: "2026-11-01",
  tasks: ["task-a"],
  body: `# 標題 ${id}\n\n## 描述\n內容\n`,
  ...patch,
});

const ID = "REQ-20261102-sync";
const finished = { finishedAt: "2026-11-02T08:30:15.123Z" };

function logOf(store: CardStore, id = ID) {
  const log = store.readLog(id);
  assert.equal(log.ok, true);
  return log.ok
    ? log.entries.map((e) => [e.time, e.event, e.text, e.eventId])
    : [];
}

test("a completed task moves the card to done and logs completed with the finish time", () => {
  const { store, run } = setup({
    "task-a": { state: "completed", terminalSequence: 7, ...finished },
  });
  store.create(card(ID));
  const result = run();
  assert.deepEqual(result.updated, [ID]);
  const read = store.read(ID);
  assert.equal(read.ok && read.card.status, "done");
  assert.equal(read.ok && read.card.updated, "2026-11-02");
  assert.deepEqual(logOf(store), [
    ["2026-11-02T08:30:15Z", "completed", "task task-a 完成", "task-a-7"],
  ]);
});

test("a targeted sync updates only the requested card", () => {
  const { rootDir, store } = setup();
  store.create(card(ID));
  const other = "REQ-20261102-other";
  store.create(card(other));
  const result = syncCards({
    rootDir,
    cardId: ID,
    tasks: {
      get: () => ({ state: "completed", terminalSequence: 7, ...finished }),
    },
    now: () => "2026-11-02T09:00:00Z",
  });
  assert.deepEqual(result.updated, [ID]);
  const selected = store.read(ID);
  const untouched = store.read(other);
  assert.equal(selected.ok && selected.card.status, "done");
  assert.equal(untouched.ok && untouched.card.status, "in_progress");
  assert.deepEqual(logOf(store, other), []);
});

test("a running task changes nothing and does not rewrite the file", () => {
  for (const state of [
    "planning",
    "running",
    "blocked",
    "synthesizing",
    "cancelling",
  ]) {
    const { rootDir, store, run } = setup({ "task-a": { state } });
    store.create(card(ID));
    const file = path.join(rootDir, `${ID}.md`);
    const before = fs.readFileSync(file, "utf8");
    assert.deepEqual(run().updated, [], state);
    assert.equal(fs.readFileSync(file, "utf8"), before, state);
  }
});

test("a failed task keeps the card in progress and logs the failure with its reason", () => {
  const { store, run } = setup({
    "task-a": {
      state: "failed",
      detail: "Lead pane exited",
      terminalSequence: 4,
      ...finished,
    },
  });
  store.create(card(ID));
  run();
  const read = store.read(ID);
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.deepEqual(logOf(store), [
    [
      "2026-11-02T08:30:15Z",
      "failed",
      "失敗：task_failed；原因：Lead pane exited",
      "task-a-4",
    ],
  ]);
});

test("a failure detail that looks like a secret is omitted from the card", () => {
  const { store, run } = setup({
    "task-a": {
      state: "failed",
      detail: cat("token=", "ghp_", "c".repeat(36)),
      terminalSequence: 4,
      ...finished,
    },
  });
  store.create(card(ID));
  run();
  const text = logOf(store)[0][2];
  assert.match(text, /內容已省略/);
  assert.equal(text.includes("ghp_"), false);
});

test("a cancelled task keeps the card in progress and logs the cancellation", () => {
  const { store, run } = setup({
    "task-a": { state: "cancelled", terminalSequence: 3, ...finished },
  });
  store.create(card(ID));
  run();
  const read = store.read(ID);
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.deepEqual(logOf(store), [
    ["2026-11-02T08:30:15Z", "cancelled", "已取消（user）", "task-a-3"],
  ]);
});

test("running the sync again changes nothing", () => {
  const { rootDir, store, run } = setup({
    "task-a": { state: "completed", terminalSequence: 7, ...finished },
  });
  store.create(card(ID));
  run();
  const file = path.join(rootDir, `${ID}.md`);
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(run().updated, []);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("only the latest task decides done; earlier finished tasks are logged", () => {
  const first = setup({
    "task-a": {
      state: "failed",
      detail: "boom",
      terminalSequence: 2,
      ...finished,
    },
    "task-b": { state: "completed", terminalSequence: 9, ...finished },
  });
  first.store.create(card(ID, { tasks: ["task-a", "task-b"] }));
  first.run();
  const done = first.store.read(ID);
  assert.equal(done.ok && done.card.status, "done");
  assert.deepEqual(
    logOf(first.store).map((e) => e[3]),
    ["task-a-2", "task-b-9"],
  );

  const second = setup({
    "task-a": { state: "completed", terminalSequence: 5, ...finished },
    "task-b": { state: "running" },
  });
  second.store.create(card(ID, { tasks: ["task-a", "task-b"] }));
  second.run();
  const open = second.store.read(ID);
  assert.equal(open.ok && open.card.status, "in_progress");
  assert.deepEqual(
    logOf(second.store).map((e) => e[3]),
    ["task-a-5"],
  );
});

test("cards that are not in progress, have no tasks, or point at an unknown task are left alone", () => {
  const { rootDir, store, run } = setup({
    "task-a": { state: "completed", terminalSequence: 7, ...finished },
  });
  store.create(card("REQ-20261102-draft", { status: "draft" }));
  store.create(card("REQ-20261102-ready", { status: "ready" }));
  store.create(card("REQ-20261102-notasks", { tasks: undefined }));
  store.create(card("REQ-20261102-unknown", { tasks: ["task-zzz"] }));
  const before = fs
    .readdirSync(rootDir)
    .map((f) => [f, fs.readFileSync(path.join(rootDir, f), "utf8")]);
  assert.deepEqual(run().updated, []);
  const after = fs
    .readdirSync(rootDir)
    .map((f) => [f, fs.readFileSync(path.join(rootDir, f), "utf8")]);
  assert.deepEqual(after, before);
});

test("a broken card file does not stop the others from syncing", () => {
  const { rootDir, store, run } = setup({
    "task-a": { state: "completed", terminalSequence: 7, ...finished },
  });
  store.create(card(ID));
  fs.writeFileSync(path.join(rootDir, "REQ-20261102-broken.md"), "not a card");
  const result = run();
  assert.deepEqual(result.updated, [ID]);
  assert.equal(store.read(ID).ok, true);
});

test("a missing or unsafe cards directory is reported without throwing or creating it", () => {
  const { rootDir, run } = setup();
  assert.deepEqual(run(), { updated: [], problems: [], missing: [] });
  assert.equal(fs.existsSync(rootDir), false);

  if (process.platform === "win32") return;
  fs.mkdirSync(rootDir, { mode: 0o700 });
  fs.chmodSync(rootDir, 0o755);
  const result = run();
  assert.deepEqual(result.updated, []);
  assert.match(result.problems.join("\n"), /chmod 700/);
});

const lead: AgentRecord = {
  pane_id: "w1:p1",
  terminal_id: "lead",
  workspace_id: "w1",
  tab_id: "t1",
  agent: "claude",
  agent_status: "idle",
};

function realJournal(): TeamTaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-sync-journal-"));
  return new TeamTaskStore(path.join(dir, "tasks"));
}

test("taskSourceFrom reports the sequence at which the real journal first reached the final state", () => {
  const journal = realJournal();
  journal.create({ taskId: "task-real", prompt: "p", lead, workers: [] });
  journal.update("task-real", "step", (t) => {
    t.state = "running";
  });
  journal.update("task-real", "step", (t) => {
    t.state = "synthesizing";
  });
  const source = taskSourceFrom(journal);
  const running = source.get("task-real");
  assert.equal(running?.state, "synthesizing");
  assert.equal(running?.terminalSequence, undefined);
  journal.update("task-real", "step", (t) => {
    t.state = "completed";
  });
  journal.update("task-real", "later_note", (t) => {
    t.detail = "note";
  });
  const done = source.get("task-real");
  assert.equal(done?.state, "completed");
  assert.equal(done?.terminalSequence, 4);
  assert.equal(typeof done?.finishedAt, "string");
  assert.equal(source.get("task-missing"), undefined);
});

test("the real journal and the sync work together: a failed task is logged once and the card stays open", () => {
  const journal = realJournal();
  journal.create({ taskId: "task-a", prompt: "p", lead, workers: [] });
  journal.update("task-a", "x", (t) => {
    t.state = "failed";
    t.detail = "Lead pane exited";
  });
  const { rootDir, store } = setup();
  store.create(card(ID));
  const options = {
    rootDir,
    tasks: taskSourceFrom(journal),
    now: () => "2026-11-02T09:00:00Z",
  };
  assert.deepEqual(syncCards(options).updated, [ID]);
  assert.deepEqual(syncCards(options).updated, []);
  const read = store.read(ID);
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.deepEqual(
    logOf(store).map((e) => [e[1], e[3]]),
    [["failed", "task-a-2"]],
  );
});

const assigned = (patch: Partial<CardAssignment> = {}): CardAssignment => ({
  taskId: "task-a",
  cardId: ID,
  type: "requirement",
  assignedAt: "2026-11-02T08:00:00Z",
  ...patch,
});

test("a running task whose card was deleted is reported as missing, and nothing is written", () => {
  for (const state of [
    "planning",
    "running",
    "blocked",
    "synthesizing",
    "cancelling",
  ]) {
    const { rootDir, run } = setup({ "task-a": { state } });
    fs.mkdirSync(rootDir, { mode: 0o700 });
    const result = run([assigned()]);
    assert.deepEqual(
      result.missing,
      [{ taskId: "task-a", cardId: ID, state }],
      state,
    );
    assert.deepEqual(fs.readdirSync(rootDir), [], state);
  }
});

test("a deleted card is not reported when the task is over, unknown, already notified or the card exists", () => {
  const cases: Array<
    [string, Record<string, FakeTask>, CardAssignment, boolean]
  > = [
    [
      "completed task",
      { "task-a": { state: "completed", terminalSequence: 1 } },
      assigned(),
      false,
    ],
    [
      "failed task",
      { "task-a": { state: "failed", terminalSequence: 1 } },
      assigned(),
      false,
    ],
    [
      "cancelled task",
      { "task-a": { state: "cancelled", terminalSequence: 1 } },
      assigned(),
      false,
    ],
    ["unknown task", {}, assigned(), false],
    [
      "already notified",
      { "task-a": { state: "running" } },
      assigned({ notifiedAt: "2026-11-02T08:30:00Z" }),
      false,
    ],
    ["card present", { "task-a": { state: "running" } }, assigned(), true],
  ];
  for (const [name, tasks, assignment, createCard] of cases) {
    const { rootDir, store, run } = setup(tasks);
    fs.mkdirSync(rootDir, { mode: 0o700 });
    if (createCard) store.create(card(ID));
    assert.deepEqual(run([assignment]).missing, [], name);
  }
});

test("a card file that exists but cannot be read is not treated as deleted", () => {
  const { rootDir, run } = setup({ "task-a": { state: "running" } });
  fs.mkdirSync(rootDir, { mode: 0o700 });
  fs.writeFileSync(path.join(rootDir, `${ID}.md`), "not a card");
  assert.deepEqual(run([assigned()]).missing, []);
});

test("without a cards directory every running assignment is missing, and several are listed in order", () => {
  const { run } = setup({
    "task-a": { state: "running" },
    "task-b": { state: "planning" },
  });
  const result = run([
    assigned(),
    assigned({ taskId: "task-b", cardId: "TKT-20261102-two", type: "ticket" }),
  ]);
  assert.deepEqual(
    result.missing.map((m) => m.taskId),
    ["task-a", "task-b"],
  );
});

import { missingCardMessage } from "../src/card-sync.js";

test("the missing-card message names the card and task, states what the bridge will not do, and lists the three options", () => {
  const text = missingCardMessage({
    taskId: "task-a",
    cardId: ID,
    state: "running",
  });
  assert.match(text, /REQ-20261102-sync/);
  assert.match(text, /task-a/);
  assert.match(text, /running/);
  assert.match(text, /不會自動取消/);
  assert.match(text, /`card recreate REQ-20261102-sync`/);
  assert.match(text, /`team cancel task-a`/);
  assert.match(text, /不處理/);
});

test("a broken assignment index disables deleted-card detection but not the task result sync", () => {
  const { rootDir, store } = setup();
  store.create(card(ID));
  const result = syncCards({
    rootDir,
    tasks: {
      get: () => ({ state: "completed", terminalSequence: 7, ...finished }),
    },
    assignments: {
      list: () => {
        throw new Error("card-assignments file is not valid JSON");
      },
    },
    now: () => "2026-11-02T09:00:00Z",
  });
  assert.deepEqual(result.updated, [ID]);
  assert.deepEqual(result.missing, []);
  assert.match(result.problems.join("\n"), /刪除偵測停用.*not valid JSON/);
});
