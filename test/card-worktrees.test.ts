import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardWorktreeStore } from "../src/card-worktrees.js";

function file(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "card-worktrees-")),
    "state",
    "card-worktrees.json",
  );
}

const entry = {
  cardId: "REQ-20261103-one",
  workspaceId: "w9",
  sourceWorkspaceId: "w3",
  path: "/Users/example/.herdr/worktrees/repo/card-req-20261103-one",
  repoPath: "/Users/example/git_wk/repo",
  branch: "card/REQ-20261103-one",
};
const T1 = "2026-11-03T08:00:00Z";
const T2 = "2026-11-03T09:00:00Z";

test("a missing file is an empty store and nothing is created until something is recorded", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.activeWorkspaceIds(), []);
  assert.equal(store.active("REQ-20261103-one"), undefined);
  assert.equal(fs.existsSync(f), false);
});

test("a recorded worktree persists, is active, and is private", () => {
  const f = file();
  new CardWorktreeStore(f).record(entry, T1);
  const reopened = new CardWorktreeStore(f);
  assert.deepEqual(reopened.active("REQ-20261103-one"), {
    ...entry,
    createdAt: T1,
  });
  assert.deepEqual(reopened.activeWorkspaceIds(), ["w9"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  }
});

test("a card can have only one active worktree, and a second record is refused", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  store.record(entry, T1);
  const before = fs.readFileSync(f, "utf8");
  assert.throws(
    () => store.record({ ...entry, workspaceId: "w10" }, T2),
    /already has an active worktree/,
  );
  assert.equal(fs.readFileSync(f, "utf8"), before);
});

test("ISSUE-218: 重用的 workspace id，別張卡的過期紀錄（目錄已不存在）被標記移除；目錄還在就拒絕", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-wt-dir-"));
  store.record({ ...entry, path: dir }, T1);
  // 目錄還在：另一張卡不能用同一個 workspace id。
  assert.throws(
    () => store.record({ ...entry, cardId: "REQ-20261103-two", branch: "card/REQ-20261103-two" }, T2),
    /already recorded/,
  );
  // 目錄不見了：過期紀錄標記為已移除，新的記得進去，歷史保留。
  fs.rmSync(dir, { recursive: true });
  store.record({ ...entry, cardId: "REQ-20261103-two", branch: "card/REQ-20261103-two", path: `${dir}-two` }, T2);
  const all = store.list();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.removedAt, T2);
  assert.equal(all[1]?.removedAt, undefined);
  assert.deepEqual(store.activeWorkspaceIds(), ["w9"]);
  // 同一張卡自己的作用中紀錄永遠不會被當成過期。
  assert.throws(
    () => store.record({ ...entry, cardId: "REQ-20261103-two", branch: "card/REQ-20261103-two", path: `${dir}-three` }, T2),
    /already has an active worktree/,
  );
});

test("markRemoved ends the worktree, frees the card for a new one, and keeps the history", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  store.record(entry, T1);
  store.markRemoved("REQ-20261103-one", T2);
  assert.equal(store.active("REQ-20261103-one"), undefined);
  assert.deepEqual(store.activeWorkspaceIds(), []);
  assert.equal(store.list()[0].removedAt, T2);
  store.record({ ...entry, workspaceId: "w12" }, "2026-11-03T10:00:00Z");
  assert.deepEqual(
    new CardWorktreeStore(f)
      .list()
      .map((item) => [item.workspaceId, item.removedAt]),
    [
      ["w9", T2],
      ["w12", undefined],
    ],
  );
  assert.throws(
    () => store.markRemoved("REQ-20261103-none", T2),
    /no active worktree/,
  );
});

test("invalid entries are refused and nothing is written", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  const bad: Array<[string, Partial<typeof entry>]> = [
    ["cardId", { cardId: "../x" }],
    ["workspaceId", { workspaceId: "w 9" }],
    ["sourceWorkspaceId", { sourceWorkspaceId: "" }],
    ["path", { path: "relative/path" }],
    ["repoPath", { repoPath: "/repo\n" }],
    ["branch", { branch: "a b" }],
  ];
  for (const [field, patch] of bad)
    assert.throws(
      () => store.record({ ...entry, ...patch }, T1),
      new RegExp(field),
      field,
    );
  assert.throws(() => store.record(entry, "yesterday"), /time/);
  assert.equal(fs.existsSync(f), false);
});

test("a corrupt or tampered file is refused instead of being treated as empty", () => {
  const good = { ...entry, createdAt: T1 };
  for (const content of [
    "not json",
    JSON.stringify({ version: 2, worktrees: [] }),
    JSON.stringify({ version: 1, worktrees: [{ ...good, path: "rel" }] }),
    JSON.stringify({ version: 1, worktrees: [{ ...good, createdAt: "x" }] }),
    JSON.stringify({ version: 1, worktrees: [good, good] }),
  ]) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    assert.throws(
      () => new CardWorktreeStore(f),
      /card-worktrees/,
      content.slice(0, 60),
    );
  }
});

test("latest prefers the active worktree, else the most recent removed one, else nothing", () => {
  const store = new CardWorktreeStore(file());
  assert.equal(store.latest("REQ-20261103-one"), undefined);
  store.record(entry, T1);
  store.markRemoved("REQ-20261103-one", T2);
  assert.equal(store.latest("REQ-20261103-one")?.workspaceId, "w9");
  assert.equal(store.latest("REQ-20261103-one")?.removedAt, T2);
  store.record({ ...entry, workspaceId: "w12" }, "2026-11-03T10:00:00Z");
  assert.equal(store.latest("REQ-20261103-one")?.workspaceId, "w12");
  assert.equal(store.latest("REQ-20261103-one")?.removedAt, undefined);
});

test("ISSUE-221: bridge 開的 repo 主 workspace 標記：還有作用中的 worktree 就不交出，最後一個移除後交出一次，重載後仍保留標記", () => {
  const f = file();
  const store = new CardWorktreeStore(f);
  const repo = entry.repoPath;
  store.record(entry, T1);
  store.record({ ...entry, cardId: "REQ-20261103-two", workspaceId: "w10", branch: "card/REQ-20261103-two", path: `${entry.path}-two` }, T1);
  store.markRepoWorkspace(repo, "w8");
  assert.equal(store.releaseRepoWorkspace(repo), undefined, "還有作用中的 worktree");
  store.markRemoved(entry.cardId, T2);
  assert.equal(new CardWorktreeStore(f).releaseRepoWorkspace(repo), undefined, "還剩一個，重載後標記仍在但不交出");
  store.markRemoved("REQ-20261103-two", T2);
  const reloaded = new CardWorktreeStore(f);
  assert.equal(reloaded.releaseRepoWorkspace(repo), "w8");
  assert.equal(reloaded.releaseRepoWorkspace(repo), undefined, "只交出一次");
  assert.equal(new CardWorktreeStore(f).releaseRepoWorkspace(repo), undefined, "標記已清除並寫回檔案");
  // 沒標記過（使用者自己開的主 workspace）永遠不交出。
  assert.equal(new CardWorktreeStore(f).releaseRepoWorkspace("/Users/example/git_wk/other"), undefined);
});
