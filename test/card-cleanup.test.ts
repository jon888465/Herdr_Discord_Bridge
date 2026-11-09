import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { closeAutopickLead, recordCleanupOnCard } from "../src/card-cleanup.js";
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

const roots = new WeakMap<CardStore, string>();
function store(): CardStore {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "card-cleanup-")),
    "cards",
  );
  const cards = new CardStore(root, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  cards.create(card);
  roots.set(cards, root);
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

// Fresh CardStore instances model a bridge restart: no LeadHandle is available.
for (const status of ["done", "cancelled", "ready", "in_progress"]) {
  test(`persisted Lead cleanup gates ${status} and only closes the recorded Lead`, async () => {
    const cards = store();
    const read = cards.read(ID);
    assert.ok(read.ok);
    assert.ok(cards.update(ID, read.hash, (c) => ({ ...c, status })).ok);
    assert.ok(
      cards.recordAutopickWorkspace(ID, "wLead", `autopick-claude-${ID}`).ok,
    );
    const restarted = new CardStore(roots.get(cards)!);
    const closed: unknown[] = [];
    const port = {
      listWorkspaces: async () => [
        { workspace_id: "wWorker", label: `card-${ID}` },
        { workspace_id: "wReviewer", label: "reviewer" },
        { workspace_id: "wUser", label: "personal" },
        { workspace_id: "wLead", label: `autopick-claude-${ID}` },
      ],
      request: async (_method: string, params?: Record<string, unknown>) => {
        closed.push(params);
      },
    };
    await closeAutopickLead(restarted, ID, port);
    assert.equal(closed.length, ["done", "cancelled"].includes(status) ? 1 : 0);
    closed.length = 0;
    await closeAutopickLead(restarted, ID, port, true);
    assert.deepEqual(
      closed,
      status === "in_progress" ? [] : [{ workspace_id: "wLead" }],
    );
  });
}

for (const scenario of [
  "missing",
  "mismatch",
  "close failure",
  "lookup failure",
  "invalid record",
]) {
  test(`Lead ${scenario} only logs and preserves cleanup result`, async () => {
    const cards = store();
    assert.ok(
      cards.recordAutopickWorkspace(
        ID,
        "wLead",
        scenario === "invalid record" ? "personal" : `autopick-claude-${ID}`,
      ).ok,
    );
    const logs: string[] = [];
    let closes = 0;
    const result = { removed: true as const, ...info };
    const before = recordCleanupOnCard(cards, ID, result, now);
    await closeAutopickLead(
      cards,
      ID,
      {
        listWorkspaces: async () => {
          if (scenario === "lookup failure") throw new Error("offline");
          return scenario === "missing"
            ? []
            : [
                {
                  workspace_id: "wLead",
                  label:
                    scenario === "mismatch"
                      ? "personal"
                      : `autopick-claude-${ID}`,
                },
              ];
        },
        request: async () => {
          closes++;
          throw new Error("close failed");
        },
      },
      true,
      (message) => logs.push(message),
    );
    assert.equal(logs.length, 1);
    assert.equal(closes, scenario === "close failure" ? 1 : 0);
    assert.deepEqual(recordCleanupOnCard(cards, ID, result, now), before);
  });
}

for (const kind of ["claude", "codex", "agy", "pi"] as const) {
  for (const scenario of ["valid", "renamed", "wrong-card"] as const) {
    test(`${kind} cleanup requires persisted and current labels for this card: ${scenario}`, async () => {
      const cards = store();
      const label = `autopick-${kind}-${scenario === "wrong-card" ? "REQ-other" : ID}`;
      assert.ok(cards.recordAutopickWorkspace(ID, "wLead", label).ok);
      const closed: unknown[] = [];
      await closeAutopickLead(
        new CardStore(roots.get(cards)!),
        ID,
        {
          listWorkspaces: async () => [
            {
              workspace_id: "wLead",
              label: scenario === "renamed" ? "personal" : label,
            },
          ],
          request: async (_method, params) => {
            closed.push(params);
          },
        },
        false,
        () => {},
      );
      assert.deepEqual(
        closed,
        scenario === "valid" ? [{ workspace_id: "wLead" }] : [],
      );
    });
  }
}
