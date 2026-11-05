import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitVerifiedVersion,
  type CommitTaskView,
} from "../src/card-commit.js";
import type { Card } from "../src/card.js";
import {
  captureCodingBaseline,
  captureCodingTree,
  versionFromBaseline,
} from "../src/coding-version.js";

const BRANCH = "card/REQ-20261105-commit";
const card = {
  id: "REQ-20261105-commit",
  title: "驗收用：card commit",
} as Card;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** 一個在卡片分支上、有一個原本就未追蹤的檔案（baseline 的一部分）、再新增一個已驗證檔案的 repo。 */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "card-commit-"));
  git(repo, ["init", "-b", BRANCH]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(repo, "preexisting.txt"), "was already here\n");
  const baseline = captureCodingBaseline(repo);
  writeFileSync(join(repo, "feature.txt"), "ok\n");
  const version = versionFromBaseline(baseline, captureCodingTree(repo));
  const task: CommitTaskView = {
    taskId: "task-1",
    state: "completed",
    coding: {
      stage: "ready-to-integrate",
      versionFingerprint: version.fingerprint,
      baseline,
      repository: repo,
    },
  };
  const run = (over: Partial<CommitTaskView> = {}, branch = BRANCH) =>
    commitVerifiedVersion({
      card,
      branch,
      worktreePath: repo,
      task: { ...task, ...over },
    });
  return {
    repo,
    task,
    run,
    close: () => rmSync(repo, { recursive: true, force: true }),
  };
}

test("a verified version is committed on the card branch: only its files, nothing else, no push", () => {
  const f = fixture();
  try {
    const out = f.run();
    assert.deepEqual(out.files, ["feature.txt"]);
    assert.equal(out.branch, BRANCH);
    assert.equal(out.sha, git(f.repo, ["rev-parse", "HEAD"]).trim());
    const message = git(f.repo, ["log", "-1", "--format=%B"]);
    assert.match(message, /驗收用：card commit/);
    assert.match(message, /REQ-20261105-commit/);
    assert.match(message, /task-1/);
    // 原本就存在的未追蹤檔不會被帶進 commit，也不會消失
    assert.deepEqual(
      git(f.repo, ["show", "--name-only", "--format=", "HEAD"])
        .trim()
        .split("\n"),
      ["feature.txt"],
    );
    assert.equal(
      git(f.repo, ["status", "--porcelain"]).trim(),
      "?? preexisting.txt",
    );
  } finally {
    f.close();
  }
});

test("a task that has not passed review and verification is refused", () => {
  const f = fixture();
  try {
    assert.throws(() => f.run({ state: "failed" }), /還沒通過/);
    assert.throws(
      () =>
        f.run({
          coding: { ...f.task.coding!, stage: "verify" },
        }),
      /只有 ready-to-integrate/,
    );
    assert.throws(() => f.run({ coding: undefined }), /不是 --coding 任務/);
    assert.throws(
      () =>
        commitVerifiedVersion({
          card,
          branch: BRANCH,
          worktreePath: f.repo,
          task: undefined,
        }),
      /沒有 task/,
    );
    assert.equal(git(f.repo, ["rev-list", "--count", "HEAD"]).trim(), "1");
  } finally {
    f.close();
  }
});

test("content changed after verification is refused instead of committing an unverified version", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "feature.txt"), "changed after review\n");
    assert.throws(() => f.run(), /驗證之後被改動/);
    assert.equal(git(f.repo, ["rev-list", "--count", "HEAD"]).trim(), "1");
  } finally {
    f.close();
  }
});

test("the worktree must be on the card branch and the task must belong to this worktree", () => {
  const f = fixture();
  try {
    assert.throws(() => f.run({}, "card/REQ-20261105-other"), /不是卡片的分支/);
    assert.throws(
      () =>
        f.run({
          coding: { ...f.task.coding!, repository: tmpdir() },
        }),
      /不是這張卡的 worktree/,
    );
  } finally {
    f.close();
  }
});

test("something already staged is never mixed into the commit", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "unrelated.txt"), "staged by someone else\n");
    git(f.repo, ["add", "unrelated.txt"]);
    // 暫存區變了，版本指紋也不同；兩種拒絕理由擇一都可以，重點是沒有 commit。
    assert.throws(() => f.run(), /暫存區原本就有東西|驗證之後被改動/);
    assert.equal(git(f.repo, ["rev-list", "--count", "HEAD"]).trim(), "1");
  } finally {
    f.close();
  }
});

test("a version that is already committed is not committed twice", () => {
  const f = fixture();
  try {
    f.run();
    assert.throws(() => f.run(), /驗證之後被改動|已經 commit|沒有任何要提交/);
    assert.equal(git(f.repo, ["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    f.close();
  }
});
