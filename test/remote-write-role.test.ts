import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProfiles } from "../src/agent-pool.js";
import { REMOVE_SCRIPT, type RemoteExec } from "../src/remote-checkout.js";
import { startRemoteRole, type RemoteRoleDeps } from "../src/remote-snapshot.js";
import type { RemoteFetch } from "../src/remote-write-result.js";
import { localGit } from "../src/remote-snapshot.js";

const ROOT = "/home/pod/r";
const profile = validateProfiles([{ id: "claude", kind: "claude", model: "opus" }])[0]!;
const podAgent = { pane_id: "pod:w3:p1", terminal_id: "pod:t", workspace_id: "pod:w3", tab_id: "", agent: "claude", agent_status: "idle" };
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@invalid" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, ...ID } }).trim();
const fixed = (label: RegExp) => (e: unknown) => label.test(String(e)) && /^Error: 遠端角色失敗：/.test(String(e)) && !/SECRET|\/home\/pod/.test(String(e));

type Opts = { write?: boolean; noFetch?: boolean; dirty?: boolean; digests?: string[] };

/** 本機 repo（真的 git）；「pod 目錄」是它的 clone，結果取回的指令改在這個目錄跑，其餘 pod 指令用假的。 */
function harness(o: Opts = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hdb-wrole-")));
  const [local, pod] = [`${base}/local`, `${base}/pod`];
  execFileSync("git", ["init", "--quiet", local]);
  fs.writeFileSync(`${local}/a.txt`, "alpha\n");
  git(local, "add", "-A");
  git(local, "commit", "--quiet", "-m", "base");
  execFileSync("git", ["clone", "--quiet", local, pod]);
  const tree = git(local, "rev-parse", "HEAD^{tree}");
  const log: string[] = [];
  const digests = [...(o.digests ?? ["d0"])];
  let exists = false;
  const runLocal = (argv: string[]) => {
    try {
      return { code: 0, stdout: execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", env: { ...process.env, ...ID } }) };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, stdout: "" };
    }
  };
  const exec: RemoteExec = async (argv) => {
    if (argv[2] === REMOVE_SCRIPT) return (log.push("rm"), { code: 0, stdout: "" });
    if (argv[0] === "sh" && /hdb-result/.test(argv[2] ?? "")) return runLocal(["sh", "-c", argv[2]!, "sh", pod, ...argv.slice(5)]);
    if (argv.join(" ").includes("mkdir --")) exists = true;
    return { code: argv[0] === "test" ? (argv[1] === "-e" && exists ? 0 : 1) : 0, stdout: argv[0] === "realpath" ? `${argv[2]}\n` : argv.join(" ").endsWith("rev-parse HEAD") ? "1".repeat(40) : argv.join(" ").endsWith("{tree}") ? `${"1".repeat(40)}\n${tree}\n` : "" };
  };
  const fetch: RemoteFetch = async (argv) => {
    const file = argv[2]!.replace(/^.*\/\.git\//, `${pod}/.git/`);
    try {
      return { code: 0, data: execFileSync("cat", ["--", file]), truncated: false };
    } catch {
      return { code: 1, data: Buffer.alloc(0), truncated: false };
    }
  };
  const deps: RemoteRoleDeps = {
    machine: (id) => (id === "pod" ? { id, ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["claude"], ...(o.write === false ? {} : { write: true }) } } : undefined),
    exec: () => exec,
    ...(o.noFetch ? {} : { fetch: () => fetch }),
    localGit,
    originUrl: async () => "git@github.com:acme/repo.git\n",
    createWorkspace: async () => ({ workspaceId: "pod:w3", paneId: "pod:w3:p1" }),
    closeWorkspace: async (_m, id) => void log.push(`close:${id}`),
    closeWorkspaceLabeled: async () => 1,
    sleep: async () => {},
    panePort: () => ({ request: async () => ({}), listAgentsWithWorkspaceNames: async () => [podAgent] }),
    startAgent: async () => podAgent,
    snapshot: () => ({ sha: "1".repeat(40), tree: o.dirty ? "2".repeat(40) : tree, ref: "refs/hdb-snapshot/0123456789abcdef", bundle: "/tmp/b", bytes: 1, digest: "d0", dispose: () => void log.push("dispose") }),
    treeDigest: () => digests.shift() ?? "d0",
  };
  return {
    local,
    pod,
    log,
    headBefore: git(local, "rev-parse", "HEAD"),
    start: (role = "implement") => startRemoteRole(deps, { machineId: "pod", role, key: "t/a", cwd: local, profile, name: "n" }),
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("implement：遠端改動取回後由 bridge 在本機 commit，之後清理", async () => {
  const h = harness();
  try {
    const role = await h.start();
    fs.writeFileSync(`${h.pod}/a.txt`, "alpha\nremote edit\n");
    fs.writeFileSync(`${h.pod}/new.txt`, "from pod\n");
    await role.afterTurn();
    assert.equal(git(h.local, "rev-parse", "HEAD~1"), h.headBefore);
    assert.equal(git(h.local, "log", "-1", "--format=%s"), "hdb remote implement (pod)");
    assert.equal(fs.readFileSync(`${h.local}/new.txt`, "utf8"), "from pod\n");
    assert.equal(git(h.local, "status", "--porcelain"), "");
    await role.cleanup("completed");
    assert.deepEqual(h.log.filter((l) => l === "rm" || l.startsWith("close:")), ["close:pod:w3", "rm"]);
  } finally {
    h.done();
  }
});

test("implement：machine 沒開放 write、沒有取回通道、本機工作樹不乾淨，都在派工前就拒絕", async () => {
  for (const [opts, label] of [
    [{ write: false }, /implement 不可用（machine 沒有開放寫入）/],
    [{ noFetch: true }, /implement 不可用（沒有取回通道）/],
    [{ dirty: true }, /本機工作樹不乾淨，遠端寫入角色不派工/],
  ] as const) {
    const h = harness(opts);
    try {
      await assert.rejects(h.start(), fixed(label));
      assert.ok(!h.log.some((l) => l.startsWith("close:") && opts.dirty === undefined), "沒有開 workspace");
      assert.equal(git(h.local, "rev-parse", "HEAD"), h.headBefore);
    } finally {
      h.done();
    }
  }
});

test("implement：本機工作樹在遠端工作期間被改動，結果不採用，本機不動", async () => {
  const h = harness({ digests: ["d1"] });
  try {
    const role = await h.start();
    fs.writeFileSync(`${h.pod}/a.txt`, "remote\n");
    await assert.rejects(role.afterTurn(), fixed(/快照已作廢/));
    assert.equal(git(h.local, "rev-parse", "HEAD"), h.headBefore);
    assert.equal(fs.readFileSync(`${h.local}/a.txt`, "utf8"), "alpha\n");
  } finally {
    h.done();
  }
});

test("implement：遠端產物違規（符號連結）或沒有任何改動，不採用，本機還原", async () => {
  for (const [edit, label] of [
    [(pod: string) => fs.symlinkSync("/etc/passwd", `${pod}/link`), /遠端改動不被接受/],
    [() => undefined, /遠端沒有產生任何改動/],
  ] as const) {
    const h = harness();
    try {
      const role = await h.start();
      edit(h.pod);
      await assert.rejects(role.afterTurn(), fixed(label));
      assert.equal(git(h.local, "rev-parse", "HEAD"), h.headBefore);
      assert.equal(git(h.local, "status", "--porcelain"), "");
    } finally {
      h.done();
    }
  }
});

test("唯讀角色行為不變：review 不需要 write 與取回通道", async () => {
  const h = harness({ write: false, noFetch: true });
  try {
    const role = await h.start("review");
    assert.ok(role);
    await role.cleanup("completed");
  } finally {
    h.done();
  }
});
