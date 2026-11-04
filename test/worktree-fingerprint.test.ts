import test from "node:test";
import assert from "node:assert/strict";
import type { Exec } from "../src/github.js";
import {
  changedFilesBetween,
  worktreeFingerprint,
  worktreeState,
} from "../src/worktree-fingerprint.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function fake(head: string | Error, status: string | Error) {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options?.cwd });
    const joined = args.join(" ");
    const reply = joined.includes("rev-parse") ? head : status;
    if (reply instanceof Error) throw reply;
    return { stdout: reply };
  };
  return { exec, calls };
}

test("the fingerprint combines the HEAD commit and the porcelain status, read in the given directory", async () => {
  const { exec, calls } = fake(`${HEAD}\n`, " M src/a.ts\n?? new.txt\n");
  const print = await worktreeFingerprint(exec, "/wt");
  assert.ok(print.includes(HEAD));
  assert.ok(print.includes("M src/a.ts"));
  assert.ok(print.includes("new.txt"));
  assert.deepEqual(
    calls.map((call) => [call.file, call.args.join(" "), call.cwd]),
    [
      ["git", "rev-parse HEAD", "/wt"],
      ["git", "status --porcelain", "/wt"],
    ],
  );
});

test("the same tree gives the same fingerprint, and a new commit, an edited file or a new file each change it", async () => {
  const clean = await worktreeFingerprint(fake(`${HEAD}\n`, "").exec, "/wt");
  assert.equal(clean, await worktreeFingerprint(fake(`${HEAD}\n`, "").exec, "/wt"));
  const commit = await worktreeFingerprint(fake("f".repeat(40) + "\n", "").exec, "/wt");
  const edited = await worktreeFingerprint(fake(`${HEAD}\n`, " M src/a.ts\n").exec, "/wt");
  const added = await worktreeFingerprint(fake(`${HEAD}\n`, "?? x\n").exec, "/wt");
  assert.equal(new Set([clean, commit, edited, added]).size, 4);
});

test("only read-only git commands are used", async () => {
  const { exec, calls } = fake(`${HEAD}\n`, "");
  await worktreeFingerprint(exec, "/wt");
  for (const call of calls) {
    assert.equal(call.file, "git");
    assert.match(call.args.join(" "), /^(rev-parse HEAD|status --porcelain)$/);
  }
});

test("a git failure or an unreadable HEAD is an error, not an empty fingerprint", async () => {
  await assert.rejects(worktreeFingerprint(fake(new Error("not a repo"), "").exec, "/wt"), /not a repo/);
  await assert.rejects(worktreeFingerprint(fake(`${HEAD}\n`, new Error("status failed")).exec, "/wt"), /status failed/);
  await assert.rejects(worktreeFingerprint(fake("\n", "").exec, "/wt"), /HEAD/);
});

test("a relative or empty directory is refused", async () => {
  const { exec, calls } = fake(`${HEAD}\n`, "");
  await assert.rejects(worktreeFingerprint(exec, "relative/dir"), /absolute|絕對/);
  await assert.rejects(worktreeFingerprint(exec, ""), /absolute|絕對/);
  assert.equal(calls.length, 0);
});

test("worktreeState reports the HEAD commit and whether the tree has uncommitted changes, with read-only commands", async () => {
  const calls: string[] = [];
  const make = (head: string, status: string): Exec => async (file, args, options) => {
    calls.push(`${file} ${args.join(" ")} @${options?.cwd}`);
    return { stdout: args.join(" ").includes("rev-parse") ? head : status };
  };
  const clean = await worktreeState(make(`${HEAD}\n`, ""), "/wt");
  assert.deepEqual(clean, { head: HEAD, dirty: false });
  const dirty = await worktreeState(make(`${HEAD}\n`, " M a.ts\n"), "/wt");
  assert.deepEqual(dirty, { head: HEAD, dirty: true });
  assert.deepEqual(calls.slice(0, 2), ["git rev-parse HEAD @/wt", "git status --porcelain @/wt"]);
  await assert.rejects(worktreeState(make("\n", ""), "/wt"), /HEAD/);
  await assert.rejects(worktreeState(make(`${HEAD}\n`, ""), "relative"), /absolute|絕對/);
});

test("changedFilesBetween lists the paths changed between two commits, counting both sides of a rename", async () => {
  const calls: string[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push(`${file} ${args.join(" ")} @${options?.cwd}`);
    return { stdout: "src/a.ts\nsrc/old.ts\nsrc/new.ts\n\n" };
  };
  const files = await changedFilesBetween(exec, "/wt", HEAD, "f".repeat(40));
  assert.deepEqual(files, ["src/a.ts", "src/old.ts", "src/new.ts"]);
  assert.equal(calls[0], `git diff --name-only --no-renames ${HEAD} ${"f".repeat(40)} @/wt`);
});

test("changedFilesBetween refuses anything that is not a plain commit sha, so no option can be injected", async () => {
  const exec: Exec = async () => ({ stdout: "" });
  for (const bad of ["--output=/tmp/x", "HEAD", "", "abc", "g".repeat(40)])
    await assert.rejects(changedFilesBetween(exec, "/wt", bad, HEAD), /sha/, bad);
  await assert.rejects(changedFilesBetween(exec, "relative", HEAD, HEAD), /absolute|絕對/);
});
