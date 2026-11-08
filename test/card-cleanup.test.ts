import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { recordCleanupOnCard } from "../src/card-cleanup.js";
import { CardStore } from "../src/card-store.js";

const ID = "REQ-20261103-work";
const card: Card = {
  id: ID,
  type: "requirement",
  status: "done",
  title: "t",
  version: 1,
  created: "2026-11-03",
  updated: "2026-11-03",
  body: "# t\n\n## 描述\nx\n",
};
const info = {
  workspaceId: "w9",
  path: "/Users/example/.herdr/worktrees/repo/card-req-20261103-work",
  branch: `card/${ID}`,
  repoPath: "/Users/example/git_wk/repo",
};
const now = () => "2026-11-03T09:00:00Z";

function store(): CardStore {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "card-cleanup-")),
    "cards",
  );
  const cards = new CardStore(root, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  cards.create(card);
  return cards;
}

test("a removed worktree is logged as cleanup_done and shown as removed on the card", () => {
  const cards = store();
  const recording = recordCleanupOnCard(
    cards,
    ID,
    { removed: true, ...info },
    now,
  );
  assert.deepEqual(recording, { exists: true });
  const log = cards.readLog(ID);
  assert.deepEqual(
    log.ok && log.entries.map((e) => [e.event, e.text, e.eventId]),
    [["cleanup_done", "清理完成：removed", "w9-cleanup-removed"]],
  );
  const read = cards.read(ID);
  assert.ok(
    read.ok && read.card.body.includes("- worktree 狀態：已清理（分支保留）"),
  );
});

test("a kept dirty worktree is logged as cleanup_pending and shown as kept", () => {
  const cards = store();
  recordCleanupOnCard(
    cards,
    ID,
    { removed: false, reason: "dirty_worktree", ...info },
    now,
  );
  const log = cards.readLog(ID);
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.eventId]), [
    ["cleanup_pending", "w9-cleanup-pending"],
  ]);
  const read = cards.read(ID);
  assert.ok(
    read.ok && read.card.body.includes("- worktree 狀態：保留（有未提交修改）"),
  );
});

test("recording the same result again changes nothing, and a missing card or store writes nothing", () => {
  const cards = store();
  const result = { removed: true as const, ...info };
  recordCleanupOnCard(cards, ID, result, now);
  const before = cards.read(ID);
  recordCleanupOnCard(cards, ID, result, now);
  const after = cards.read(ID);
  assert.equal(before.ok && after.ok && before.hash === after.hash, true);

  assert.deepEqual(
    recordCleanupOnCard(cards, "REQ-20261103-none", result, now),
    { exists: false },
  );
  assert.deepEqual(recordCleanupOnCard(undefined, ID, result, now), {
    exists: false,
  });
});
