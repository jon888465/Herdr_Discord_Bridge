import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { commitVerifiedVersion } from "../src/card-commit.js";
import type { Card } from "../src/card.js";
import { measureDelivery } from "../src/card-delivery-precheck.js";
import { fetchReviewMaterial } from "../src/card-review-fetch.js";
import { reviewLimitError } from "../src/card-review-fetch.js";
import {
  captureCodingTree,
  versionFromBaseline,
} from "../src/coding-version.js";
import {
  cardPullRequestBaseHead,
  defaultExec,
  type Exec,
} from "../src/github.js";

const repoInfo = { owner: "owner", repo: "repo" };

function repository(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "precheck-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=test@example.com", ...args],
      { cwd, encoding: "utf8" },
    );
  const write = (file: string, contents: string | Buffer) =>
    writeFileSync(join(cwd, file), contents);
  git("init", "-q", "-b", "main");
  write("old.txt", "content to rename\n");
  write("delete.txt", "content to delete\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const head = () => git("rev-parse", "HEAD").trim();
  return { cwd, git, write, head };
}

test("ISSUE-187 measures the merge-base to a mixed delivery, counting both rename paths", async (t) => {
  const { cwd, git, write, head } = repository(t);
  git("branch", "card");
  write("base-only.txt", "new base content\n");
  git("add", ".");
  git("commit", "-qm", "advance PR base");
  const base = head();
  git("switch", "-q", "card");
  write("baseline-untracked.txt", "exclude existing untracked file\n");
  const baseline = captureCodingTree(cwd);
  git("rm", "-q", "delete.txt");
  git("commit", "-qm", "delivery deletion");
  git("mv", "old.txt", "renamed.txt");
  write("new.txt", "untracked delivery\n");
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const status = git("status", "--porcelain");
  const index = readFileSync(join(cwd, ".git", "index"));
  const measured = await measureDelivery(cwd, base, version);
  assert.deepEqual(measured.files, [
    "delete.txt",
    "new.txt",
    "old.txt",
    "renamed.txt",
  ]);
  assert.equal(measured.exceeded, undefined);
  assert.equal(head(), version.headSha);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assert.equal(git("status", "--porcelain"), status);
  git("add", "new.txt");
  const expected = git(
    "diff",
    "--cached",
    "--abbrev=7",
    "-M",
    baseline.headSha,
  );
  assert.match(expected, /rename from old.txt\nrename to renamed.txt/);
  assert.equal(measured.chars, expected.length);
});

test("ISSUE-187 measures the same unstaged rename that card commit delivers", async (t) => {
  const { cwd, git } = repository(t);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "test@example.com");
  const baseline = captureCodingTree(cwd);
  renameSync(join(cwd, "old.txt"), join(cwd, "renamed.txt"));
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const measured = await measureDelivery(cwd, baseline.headSha, version);
  const outcome = commitVerifiedVersion({
    card: { id: "REQ-20261123-precheck-diff-size", title: "Fixture" } as Card,
    worktreePath: cwd,
    branch: version.branch,
    task: {
      taskId: "task-fixture",
      state: "completed",
      coding: {
        stage: "ready-to-integrate",
        versionFingerprint: version.fingerprint,
        baseline,
        repository: cwd,
      },
    },
  });
  assert.deepEqual(measured.files, ["old.txt", "renamed.txt"]);
  assert.deepEqual(outcome.files, measured.files);
  assert.equal(
    measured.chars,
    git("diff", "--abbrev=7", "-M", baseline.headSha, outcome.sha).length,
  );
});

test("ISSUE-187 measures a new file even when version hashing hits its byte cap", async (t) => {
  const { cwd, write } = repository(t);
  const baseline = captureCodingTree(cwd);
  write("large.txt", Buffer.alloc(8_388_609, 97));
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  assert.equal(version.overflow, true);
  const measured = await measureDelivery(cwd, baseline.headSha, version);
  assert.deepEqual(measured.files, ["large.txt"]);
  assert.equal(measured.exceeded?.kind, "diff");
  assert.ok(measured.chars! > 8_388_609);
});

test("ISSUE-187 ignores local attributes and diff driver configuration", async (t) => {
  const { cwd, git, write, head } = repository(t);
  write(".gitattributes", "*.txt diff=local\n");
  git("add", ".gitattributes");
  git("commit", "-qm", "tracked diff attribute");
  const baseline = captureCodingTree(cwd);
  write("review-fixture-187.txt", "a".repeat(81_000) + "\n");
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const clean = await measureDelivery(cwd, head(), version);
  assert.equal(clean.chars, 81_164);
  assert.equal(clean.exceeded?.excess, 1_164);

  write(".gitattributes", "*.txt -diff\n");
  assert.deepEqual(await measureDelivery(cwd, head(), version), clean);
  write(".gitattributes", "*.txt diff=local\n");
  const config = join(cwd, ".git", "info", "attributes");
  writeFileSync(config, "review-fixture-187.txt -diff\n");
  // This is the old measurement, with only its index isolated.
  git("add", "review-fixture-187.txt");
  assert.equal(git("diff", "--cached", "--abbrev=7").length, 164);
  const index = readFileSync(join(cwd, ".git", "index"));
  assert.deepEqual(await measureDelivery(cwd, head(), version), clean);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assert.equal(readFileSync(config, "utf8"), "review-fixture-187.txt -diff\n");
  rmSync(config);
  git("config", "diff.local.binary", "true");
  git("config", "diff.suppressBlankEmpty", "true");
  assert.equal(git("diff", "--cached", "--abbrev=7").length, 164);
  assert.deepEqual(await measureDelivery(cwd, head(), version), clean);
});

test("ISSUE-187 applies delivered attributes to both snapshot content and patch", async (t) => {
  const { cwd, write, git, head } = repository(t);
  const baseline = captureCodingTree(cwd);
  write(".gitattributes", "lf.txt text eol=lf\nsemantic.bin -diff\n");
  write("lf.txt", "one\r\ntwo\r\n");
  write("semantic.bin", "a".repeat(81_000) + "\n");
  writeFileSync(join(cwd, ".git", "info", "attributes"), "semantic.bin diff\n");
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const measured = await measureDelivery(cwd, head(), version);
  assert.equal(measured.exceeded, undefined);
  rmSync(join(cwd, ".git", "info", "attributes"));
  git("add", ".");
  const patch = git("diff", "--cached", "--abbrev=7");
  assert.match(patch, /Binary files .*semantic\.bin differ/);
  assert.match(patch, /\+one\n\+two\n/);
  assert.equal(measured.chars, patch.length);
});

test("ISSUE-187 re-adds the worktree version with the source repo clean filter", async (t) => {
  const { cwd, git, head, write } = repository(t);
  git("config", "filter.delivery.clean", "sed s/raw/clean/g");
  git("config", "filter.delivery.required", "true");
  writeFileSync(
    join(cwd, ".git", "info", "attributes"),
    "old.txt filter=delivery\n",
  );
  const baseline = captureCodingTree(cwd);
  write("old.txt", "raw staged\n");
  git("add", "--", "old.txt");
  write("old.txt", "raw unstaged\n");
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const indexPath = join(cwd, ".git", "index");
  const index = readFileSync(indexPath);
  const looseObjects = git("count-objects", "-v");
  const measured = await measureDelivery(cwd, head(), version);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(git("count-objects", "-v"), looseObjects);
  assert.equal(readFileSync(join(cwd, "old.txt"), "utf8"), "raw unstaged\n");
  assert.equal(git("show", ":old.txt"), "clean staged\n");
  assert.equal(head(), baseline.headSha);
  git("add", "--", "old.txt");
  assert.equal(git("show", ":old.txt"), "clean unstaged\n");
  const patch = git("diff", "--cached", "--abbrev=7", head());
  assert.equal(measured.chars, patch.length);
});

test("ISSUE-187 malformed UTF-8 in the same patch has identical precheck and review counts", async (t) => {
  const { cwd, git, write, head } = repository(t);
  const base = head();
  const baseline = captureCodingTree(cwd);
  write(
    "invalid.txt",
    Buffer.concat([Buffer.alloc(81_000, 0xe9), Buffer.from("\n")]),
  );
  const version = versionFromBaseline(baseline, captureCodingTree(cwd));
  const measured = await measureDelivery(cwd, base, version);
  git("add", "invalid.txt");
  const { stdout: patch } = await defaultExec("git", [
    "-C",
    cwd,
    "diff",
    "--cached",
    "--abbrev=7",
    base,
  ]);
  assert.equal(patch.match(/\uFFFD/g)?.length, 81_000);
  assert.equal(measured.chars, patch.length);
  assert.deepEqual(measured.exceeded, {
    kind: "diff",
    actual: patch.length,
    limit: 80_000,
    excess: patch.length - 80_000,
  });
  const runner: Exec = async (_file, args) => {
    if (args[0] === "api") return { stdout: "invalid.txt\n" };
    if (args[1] === "diff") return { stdout: patch };
    return { stdout: JSON.stringify({ state: "OPEN", headRefOid: base }) };
  };
  await assert.rejects(fetchReviewMaterial(runner, repoInfo, 1), {
    message: reviewLimitError(measured.exceeded!),
  });
});

test("ISSUE-187 validates changed paths before reading patch", async (t) => {
  const { cwd, git, head } = repository(t);
  const base = head();
  renameSync(join(cwd, "old.txt"), join(cwd, "invalid\nname.txt"));
  git("add", "-A");
  git("commit", "-qm", "invalid path for review");
  await assert.rejects(
    measureDelivery(
      cwd,
      base,
      {
        headSha: head(),
        worktreePaths: [],
      },
      async () => assert.fail("patch must not be read"),
    ),
    /無法確認 PR 差異路徑/,
  );
});

for (const existing of [false, true]) {
  test(`ISSUE-187 resolves the ${existing ? "existing PR" : "default"} base head`, async () => {
    const sha = "a".repeat(40);
    const commands: string[][] = [];
    const runner: Exec = async (file, args) => {
      assert.equal(file, "gh");
      commands.push(args);
      if (args[1] === "list")
        return {
          stdout: JSON.stringify(
            existing
              ? [{ number: 1, url: "fixture", state: "OPEN", headRefOid: sha }]
              : [],
          ),
        };
      if (args[0] === "repo") return { stdout: "main\n" };
      if (args[1] === "view")
        return {
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: sha,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            baseRefName: "release/stable",
          }),
        };
      return { stdout: sha };
    };
    assert.equal(
      await cardPullRequestBaseHead(runner, repoInfo, "card/fixture"),
      sha,
    );
    assert.equal(
      commands.at(-1)?.[1],
      `repos/owner/repo/git/ref/heads/${existing ? "release/stable" : "main"}`,
    );
  });
}
