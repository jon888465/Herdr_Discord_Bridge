import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RemoteExec } from "../src/remote-checkout.js";
import { RemoteFailure } from "../src/remote-checkout.js";
import { localGit } from "../src/remote-snapshot.js";
import {
  applyRemoteResult,
  assertCleanBase,
  fetchRemoteResult,
  parseRawDiff,
  resultViolation,
  type RemoteFetch,
} from "../src/remote-write-result.js";

const ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@invalid",
};
const env = { ...process.env, ...ID };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();

/** 本機 repo（已有一個 commit）與它的 clone（扮演遠端目錄）；exec／fetch 直接在本機執行指令。 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hdb-wr-"));
  const local = path.join(root, "local");
  const remote = path.join(root, "remote");
  fs.mkdirSync(path.join(local, "dir"), { recursive: true });
  execFileSync("git", ["init", "--quiet", local], { env });
  fs.writeFileSync(path.join(local, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(local, "dir", "b.txt"), "bravo\n");
  fs.writeFileSync(path.join(local, "gone.txt"), "delete me\n");
  git(local, "add", "-A");
  git(local, "commit", "--quiet", "-m", "base");
  execFileSync("git", ["clone", "--quiet", local, remote], { env });
  const exec: RemoteExec = async (argv) => {
    try {
      const stdout = execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", env });
      return { code: 0, stdout };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, stdout: "" };
    }
  };
  const fetch: RemoteFetch = async (argv) => {
    try {
      return { code: 0, data: execFileSync(argv[0]!, argv.slice(1), { env }), truncated: false };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, data: Buffer.alloc(0), truncated: false };
    }
  };
  const baseTree = git(local, "rev-parse", "HEAD^{tree}");
  return { root, local, remote, exec, fetch, baseTree, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 遠端 agent 的典型修改：改檔、新增（含二進位）、刪除。 */
function agentEdits(remote: string): void {
  fs.writeFileSync(path.join(remote, "a.txt"), "alpha\nchanged\n");
  fs.writeFileSync(path.join(remote, "new.txt"), "brand new\n");
  fs.writeFileSync(path.join(remote, "blob.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  fs.rmSync(path.join(remote, "gone.txt"));
}

test("正常回傳：取回、套用、tree 相符、本機 commit，遠端暫時檔被清掉", async () => {
  const t = setup();
  try {
    agentEdits(t.remote);
    const result = await fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree });
    assert.ok(!fs.existsSync(path.join(t.remote, ".git", "hdb-result-index")), "暫時 index 已刪除");
    const headBefore = git(t.local, "rev-parse", "HEAD");
    const applied = applyRemoteResult(localGit(t.local), {
      patch: result.patch,
      expectedTree: result.tree,
      message: "hdb remote implement",
    });
    assert.equal(applied.headBefore, headBefore);
    assert.equal(git(t.local, "rev-parse", "HEAD~1"), headBefore, "commit 的 parent 是派工前的 HEAD");
    assert.equal(git(t.local, "rev-parse", "HEAD^{tree}"), result.tree);
    assert.deepEqual([...applied.files].sort(), ["a.txt", "blob.bin", "gone.txt", "new.txt"]);
    assert.equal(git(t.local, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(t.local, "a.txt"), "utf8"), "alpha\nchanged\n");
    assert.deepEqual([...fs.readFileSync(path.join(t.local, "blob.bin"))], [0, 1, 2, 255, 254, 0, 7]);
    assert.ok(!fs.existsSync(path.join(t.local, "gone.txt")));
    assert.equal(git(t.local, "log", "-1", "--format=%an"), "hdb-remote");
  } finally {
    t.cleanup();
  }
});

test("patch 被改動：tree 不符，還原到派工前的 HEAD", async () => {
  const t = setup();
  try {
    agentEdits(t.remote);
    const result = await fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree });
    const tampered = Buffer.from(result.patch.toString("latin1").replace("+changed", "+chonged"), "latin1");
    assert.notDeepEqual(tampered, result.patch, "確實改到了");
    const headBefore = git(t.local, "rev-parse", "HEAD");
    assert.throws(
      () => applyRemoteResult(localGit(t.local), { patch: tampered, expectedTree: result.tree, message: "m" }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "遠端改動與回報的 tree 不符",
    );
    assert.equal(git(t.local, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(t.local, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(t.local, "a.txt"), "utf8"), "alpha\n");
    assert.ok(fs.existsSync(path.join(t.local, "gone.txt")), "刪除也被還原");
    assert.ok(!fs.existsSync(path.join(t.local, "new.txt")), "新增也被還原");
  } finally {
    t.cleanup();
  }
});

test("符號連結與 .gitmodules 被拒絕並還原", async () => {
  for (const [name, edit] of [
    ["符號連結", (remote: string) => fs.symlinkSync("/etc/passwd", path.join(remote, "link"))],
    [".gitmodules", (remote: string) => fs.writeFileSync(path.join(remote, ".gitmodules"), "[submodule \"x\"]\n")],
  ] as const) {
    const t = setup();
    try {
      edit(t.remote);
      const result = await fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree });
      const headBefore = git(t.local, "rev-parse", "HEAD");
      assert.throws(
        () => applyRemoteResult(localGit(t.local), { patch: result.patch, expectedTree: result.tree, message: "m" }),
        (error: unknown) => error instanceof RemoteFailure && error.label === "遠端改動不被接受",
        name,
      );
      assert.equal(git(t.local, "rev-parse", "HEAD"), headBefore, name);
      assert.equal(git(t.local, "status", "--porcelain"), "", name);
    } finally {
      t.cleanup();
    }
  }
});

test("檔案數超過上限被拒絕並還原", async () => {
  const t = setup();
  try {
    agentEdits(t.remote);
    const result = await fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree });
    const headBefore = git(t.local, "rev-parse", "HEAD");
    assert.throws(
      () => applyRemoteResult(localGit(t.local), { patch: result.patch, expectedTree: result.tree, message: "m", maxFiles: 2 }),
      (error: unknown) => error instanceof RemoteFailure && /檔案數超過上限/.test(error.detail),
    );
    assert.equal(git(t.local, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(t.local, "status", "--porcelain"), "");
  } finally {
    t.cleanup();
  }
});

test("沒有任何改動：不採用", async () => {
  const t = setup();
  try {
    const result = await fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree });
    assert.equal(result.patch.length, 0);
    assert.throws(
      () => applyRemoteResult(localGit(t.local), { patch: result.patch, expectedTree: result.tree, message: "m" }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "遠端沒有產生任何改動",
    );
  } finally {
    t.cleanup();
  }
});

test("取回：超過大小上限、被截斷、讀取失敗、輸出格式不對都不採用", async () => {
  const t = setup();
  try {
    agentEdits(t.remote);
    await assert.rejects(
      fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: t.baseTree, maxBytes: 10 }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "遠端改動超過大小上限",
    );
    const truncated: RemoteFetch = async (argv, ms, max) => ({ ...(await t.fetch(argv, ms, max)), truncated: true });
    await assert.rejects(
      fetchRemoteResult(t.exec, truncated, { dir: t.remote, baseTree: t.baseTree }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "取回結果失敗：patch 不完整",
    );
    const failing: RemoteFetch = async () => ({ code: 1, data: Buffer.alloc(0), truncated: false });
    await assert.rejects(
      fetchRemoteResult(t.exec, failing, { dir: t.remote, baseTree: t.baseTree }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "取回結果失敗：讀取 patch",
    );
    const garbage: RemoteExec = async () => ({ code: 0, stdout: "not a sha\n" });
    await assert.rejects(
      fetchRemoteResult(garbage, t.fetch, { dir: t.remote, baseTree: t.baseTree }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "取回結果失敗：遠端 tree",
    );
    await assert.rejects(
      fetchRemoteResult(t.exec, t.fetch, { dir: t.remote, baseTree: "xyz" }),
      (error: unknown) => error instanceof RemoteFailure && error.label === "參數不合法",
    );
  } finally {
    t.cleanup();
  }
});

test("路徑與模式檢查（純函式）", () => {
  const entry = (p: string, newMode = "100644", oldMode = "100644") => ({ oldMode, newMode, status: "M", path: p });
  assert.equal(resultViolation([entry("src/a.ts"), entry("docs/x.md")]), undefined);
  for (const bad of ["/abs", "../up", "a/../b", "a//b", ".git/config", "x/.GIT/hooks/p", "a\\b", ".gitmodules", ""])
    assert.ok(resultViolation([entry(bad)]), bad);
  assert.ok(resultViolation([entry("l", "120000")]));
  assert.ok(resultViolation([entry("s", "160000")]));
  assert.ok(resultViolation([entry("s", "100644", "160000")]));
  assert.equal(resultViolation([entry("sub/.gitmodules")]), undefined, "只有根目錄的 .gitmodules 會被 git 採用");
  assert.ok(resultViolation([entry("a"), entry("b")], 1));
});

test("parseRawDiff 解析與格式錯誤", () => {
  const sha = "a".repeat(40);
  const ok = `:100644 100644 ${sha} ${sha} M\0a.txt\0:000000 100644 ${"0".repeat(40)} ${sha} A\0dir/new.txt\0`;
  assert.deepEqual(parseRawDiff(ok), [
    { oldMode: "100644", newMode: "100644", status: "M", path: "a.txt" },
    { oldMode: "000000", newMode: "100644", status: "A", path: "dir/new.txt" },
  ]);
  assert.deepEqual(parseRawDiff(""), []);
  assert.throws(() => parseRawDiff("garbage\0a.txt\0"), RemoteFailure);
});

test("assertCleanBase：快照 tree 必須等於 HEAD tree（含未追蹤檔都乾淨）", () => {
  const t = setup();
  try {
    assert.doesNotThrow(() => assertCleanBase(localGit(t.local), t.baseTree));
    assert.throws(
      () => assertCleanBase(localGit(t.local), "b".repeat(40)),
      (error: unknown) => error instanceof RemoteFailure && error.label === "本機工作樹不乾淨，遠端寫入角色不派工",
    );
  } finally {
    t.cleanup();
  }
});
