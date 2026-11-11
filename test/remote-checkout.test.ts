import test, { type TestContext } from "node:test";
import assert, { ok, deepEqual as eq, equal, throws, rejects, match } from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrHub, validateMachines } from "../src/machines.js";
import { BLOCKED_AT_START } from "../src/agent-ready.js";
import * as rc from "../src/remote-checkout.js";

const { RemoteFailure } = rc;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const URL = "https://github.com/acme/repo.git";
const ROOT = "/home/agy/r";
const DIR = `${ROOT}/acme__repo__x`;
const GIT = ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.hooksPath=/dev/null"];
const HASH = "0a1b2c3d4e";
const MARKER = `hdb-card-review-checkout:v1:${HASH}`;
const PROBE = ["timeout", "-k", "1", "5", "true"];
const WRITE_MARKER = ["sh", "-c", 'printf %s "$1" > "$2"', "sh", MARKER, `${DIR}/.git/hdb-card-review`];
const REPO = [DIR, `${DIR}/.git`];
const input = { root: ROOT, dir: DIR, owner: "acme", repo: "repo", prNumber: 7, headSha: HEAD, cardHash: HASH };
const label = (l: string) => (e: unknown) => e instanceof RemoteFailure && e.label === l;

type FakeOptions = { exists?: string[]; origin?: string; head?: string; failOn?: string; throwOn?: string; marker?: string | null; probe?: number; links?: string[]; realMap?: Record<string, string>; realpath?: (path: string) => { code: number; stdout: string }; dirty?: string };

function fake(o: FakeOptions = {}) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const exec: rc.RemoteExec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "sh" && argv[2] === rc.REMOVE_SCRIPT) {
      const [, , , , base, dir, , marker] = argv as string[];
      const code = o.realMap?.[base!] ? 11 : o.links?.includes(dir!) ? 12 : o.exists && !o.exists.includes(dir!) ? 0 : o.realMap?.[dir!] ? 12 : o.marker === null ? 13 : (o.marker ?? MARKER) !== marker ? 14 : -1;
      if (code < 0) removed.push(dir!);
      return { code: Math.max(code, 0), stdout: "" };
    }
    const j = argv.join(" ");
    if (o.throwOn && j.includes(o.throwOn)) throw new RemoteFailure("逾時", "x", true);
    if (o.failOn && j.includes(o.failOn)) return { code: 128, stdout: "" };
    if (argv[0] === "timeout") return { code: o.probe ?? 0, stdout: "" };
    if (argv[0] === "cat") return o.marker === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${o.marker ?? MARKER}\n` };
    if (argv[0] === "realpath") return o.realpath ? o.realpath(argv[2]!) : { code: 0, stdout: `${o.realMap?.[argv[2]!] ?? argv[2]}\n` };
    if (argv[0] === "test" && argv[1] === "-L") return { code: o.links?.includes(argv[2]!) ? 0 : 1, stdout: "" };
    if (argv[0] === "test") return { code: o.exists?.includes(argv[2]!) ? 0 : 1, stdout: "" };
    if (argv.includes("status")) return { code: 0, stdout: o.dirty ?? "" };
    return { code: 0, stdout: j.includes("get-url") ? (o.origin ?? URL) : j.includes("rev-parse") ? `${o.head ?? HEAD}\n` : "" };
  };
  return { exec, calls, removed };
}
async function prepare(o: FakeOptions, patch = {}) {
  const f = fake(o);
  let owned = false;
  const error = await rc.prepareRemoteCheckout(f.exec, { ...input, ...patch }, () => (owned = true)).catch((e: unknown) => e as InstanceType<typeof RemoteFailure>);
  return { ...f, owned, error: error || undefined };
}

test("argument and path validation: .., . segments, control chars, spaces, newlines, leading -", () => {
  for (const bad of ["a/../b", "..", "/root/.", "/./.", "a\u0001b", "a\u007fb", "a b", "a\tb", "a\nb", "-oProxyCommand=x", "--upload-pack=x", "/a/-x", "", "a;b", "a$(b)", "a'b"])
    throws(() => rc.assertRemoteValue("v", bad), label("參數不合法"));
  equal(rc.assertRemoteValue("v", "/a/.b/c.d"), "/a/.b/c.d");
  match(rc.remoteCheckoutDir(`${ROOT}/`, "acme", "repo", "REQ-1"), /^\/home\/agy\/r\/acme__repo__[0-9a-f]{10}$/);
  equal(rc.remoteCheckoutDir(`${ROOT}/`, "acme", "repo", "REQ-1"), rc.remoteCheckoutDir(ROOT, "acme", "repo", "REQ-1"));
  for (const [root, owner] of [["relative", "acme"], [ROOT, "ac me"], ["/a/../b", "acme"], ["/root/.", "acme"]] as const) throws(() => rc.remoteCheckoutDir(root, owner, "repo", "x"));
  const base = { id: "pod", ssh: "pod", socket: "/r/h.sock" };
  eq(validateMachines([base]), [base]);
  eq(validateMachines([{ ...base, cardReview: { root: `${ROOT}/`, kinds: ["agy"] } }])[0]?.cardReview, { root: ROOT, kinds: ["agy"] });
  throws(() => validateMachines([{ ...base, cardReview: [] }]), /cardReview/);
  for (const cardReview of [null, { root: "rel/x" }, { root: "/" }, { root: "/tmp" }, { root: "/./." }, { root: "/root/." }, { root: "/a/../b" }, { root: "/a b/c" }, { root: "/a/-x" }, { root: "/a/b\nc" }, { root: "/a/b\u0000c" }, { kinds: [] }, { kinds: ["bash"] }, { kinds: ["agy", "agy"] }, { ssh: "x" }])
    throws(() => validateMachines([{ ...base, cardReview: cardReview && { root: ROOT, kinds: ["agy"], ...cardReview } }]), /cardReview/);
});

test("only github.com origins parse", () => {
  for (const url of [URL, "https://github.com/acme/repo", "git@github.com:acme/repo.git", "ssh://git@github.com/acme/repo.git"]) eq(rc.githubOriginRepo(url), { owner: "acme", repo: "repo" });
  for (const url of ["http://github.com/acme/repo", "https://gitlab.com/acme/repo", "https://github.com.evil.io/acme/repo", "https://t@github.com/acme/repo", "https://github.com/acme/../repo", `${URL}\nx`, "https://github.com/acme/.h", `${URL} extra`, "/tmp/repo"])
    equal(rc.githubOriginRepo(url), undefined);
});

test("missing project: owned, fixed-argument clone, PR head fetch, detached checkout, sha verified", async () => {
  const r = await prepare({});
  ok(!r.error && r.owned);
  eq(r.calls, [
    PROBE,
    ["realpath", "--", ROOT],
    ["test", "-L", DIR],
    ["test", "-e", DIR],
    [...GIT, "clone", "--no-checkout", "--no-tags", "--no-recurse-submodules", "--quiet", "--", URL, DIR],
    WRITE_MARKER,
    [...GIT, "-C", DIR, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "--force", "origin", "refs/pull/7/head:refs/remotes/hdb/pr-7"],
    [...GIT, "-C", DIR, "checkout", "--quiet", "--detach", "refs/remotes/hdb/pr-7"],
    [...GIT, "-C", DIR, "rev-parse", "HEAD"],
  ]);
});

test("existing repo needs a matching marker and origin; no marker, wrong marker, other origin or non-repo dir is refused, not owned, untouched", async () => {
  const same = await prepare({ exists: REPO });
  ok(!same.error && same.owned && !same.calls.some((a) => a.includes("clone")));
  const bare = await prepare({ exists: REPO, marker: null });
  ok(label("既有目錄沒有 bridge marker")(bare.error) && !bare.owned && !bare.calls.some((a) => a.includes("remote") || a.includes("fetch") || a.includes("clone")));
  const wrong = await prepare({ exists: REPO, marker: "hdb-card-review-checkout:v1:ffffffffff" });
  ok(label("既有目錄 marker 不符")(wrong.error) && !wrong.owned && !wrong.calls.some((a) => a.includes("fetch")));
  const foreign = await prepare({ exists: REPO, marker: "something else" });
  ok(label("既有目錄 marker 不符")(foreign.error) && !foreign.owned);
  const other = await prepare({ exists: REPO, origin: "https://github.com/evil/repo.git" });
  ok(label("既有目錄 origin 不符")(other.error) && !other.owned && !other.calls.some((a) => a.includes("fetch")));
  const plain = await prepare({ exists: [DIR] });
  ok(label("既有目錄不是 repo")(plain.error) && !plain.owned && !plain.calls.some((a) => a.includes("clone")));
  for (const r of [bare, wrong, foreign, other, plain]) ok(!r.removed.length);
});

test("remote without GNU timeout fails first with a fixed label, not as clone failure (exit 127 and busybox usage error 1)", async () => {
  for (const probe of [127, 1]) {
    const r = await prepare({ probe });
    ok(label("遠端缺少 timeout")(r.error) && !r.error!.uncertain && !r.owned);
    eq(r.calls, [PROBE]);
  }
  const dir = await mkdtemp(join(tmpdir(), "hdb-notimeout-"));
  try {
    for (const code of [127, 1]) {
      const file = join(dir, `ssh${code}`);
      await writeFile(file, `#!/bin/sh\necho 'timeout: not found' >&2\nexit ${code}\n`);
      await chmod(file, 0o700);
      const exec = rc.sshRemoteExec({ id: "pod", ssh: "pod", socket: "/s" }, file);
      await rejects(rc.prepareRemoteCheckout(exec, input, () => assert.fail("not owned")), (e: unknown) => label("遠端缺少 timeout")(e) && !/not found/.test(String(e)));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sha mismatch, timeout, git exit and bad PR input fail with fixed labels", async () => {
  ok(label("HEAD 與 PR head 不符")((await prepare({ head: "f".repeat(40) })).error));
  const t = await prepare({ throwOn: "fetch" });
  ok(label("逾時")(t.error) && t.error!.uncertain && t.owned);
  ok(label("clone 失敗")((await prepare({ failOn: "clone" })).error));
  for (const patch of [{ prNumber: 0 }, { prNumber: 1.5 }, { headSha: "HEAD" }, { headSha: `${HEAD}\n` }, { dir: `${ROOT}/../e` }, { dir: `${ROOT}/a b` }, { dir: "-rf" }]) {
    const r = await prepare({}, patch);
    ok(label("參數不合法")(r.error) && !r.calls.length);
  }
});

test("fingerprint is read-only; cleanup removes only a direct child of root", async () => {
  const f = fake();
  equal(await rc.remoteFingerprint(f.exec, DIR), `${HEAD}\n`);
  eq(f.calls.map((a) => a.slice(GIT.length + 2)), [["rev-parse", "HEAD"], ["status", "--porcelain"]]);
  const owned = fake({ exists: REPO });
  await rc.removeRemoteCheckout(owned.exec, ROOT, DIR, HASH);
  eq(owned.calls, [["sh", "-c", rc.REMOVE_SCRIPT, "sh", ROOT, DIR, "acme__repo__x", MARKER]]);
  eq(owned.removed, [DIR]);
  ok(!/[\n]/.test(rc.REMOVE_SCRIPT) && ![ROOT, DIR, "acme", HASH, MARKER].some((v) => rc.REMOVE_SCRIPT.includes(v)));
  for (const dir of [ROOT, `${ROOT}/`, "/home/agy", `${ROOT}/a/b`, `${ROOT}/../x`, `${ROOT}x/y`, `${ROOT}/.git`, `${ROOT}/.`]) {
    const spy = fake();
    await rejects(rc.removeRemoteCheckout(spy.exec, ROOT, dir, HASH));
    equal(spy.calls.length, 0);
  }
  for (const [o, wanted] of [[{ marker: null }, "既有目錄沒有 bridge marker"], [{ marker: "hdb-card-review-checkout:v1:ffffffffff" }, "既有目錄 marker 不符"], [{ realMap: { [ROOT]: "/srv/x" } }, "root 是符號連結或在符號連結之下"], [{ links: [DIR] }, "既有目錄是符號連結"], [{ realMap: { [DIR]: "/o" } }, "既有目錄是符號連結"]] as [FakeOptions, string][]) {
    const spy = fake({ exists: REPO, ...o });
    await rejects(rc.removeRemoteCheckout(spy.exec, ROOT, DIR, HASH), label(wanted));
    ok(!spy.removed.length && spy.calls.length === 1);
  }
  const gone = fake({ exists: [] });
  await rc.removeRemoteCheckout(gone.exec, ROOT, DIR, HASH);
  ok(!gone.removed.length);
});

test("ssh: forwarding off, remote timeout wraps argv, 124 clean timeout, 255/local timer uncertain, no stderr in label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdb-ssh-"));
  try {
    const sh = async (name: string, body: string) => {
      const file = join(dir, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o700);
      return file;
    };
    const m = { id: "pod", ssh: "pod", socket: "/s" };
    const echo = await sh("echo", `printf '%s\\n' "$@" > ${dir}/args; exit 3`);
    eq(await rc.sshRemoteExec(m, echo)(["git", "/it's"], 2500), { code: 3, stdout: "" });
    const args = (await readFile(`${dir}/args`, "utf8")).trimEnd().split("\n");
    eq(args, [...rc.SSH_OPTIONS, "pod", "'timeout' '-k' '10' '3' 'git' '/it'\\''s'"]);
    for (const o of ["ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "BatchMode=yes"]) ok(args.includes(o));
    const fails = (l: string, uncertain: boolean) => (e: unknown) => label(l)(e) && (e as { uncertain: boolean }).uncertain === uncertain && !/secret/.test(String(e));
    await rejects(rc.sshRemoteExec(m, await sh("t", "exit 124"))(["true"], 2000), fails("逾時", false));
    await rejects(rc.sshRemoteExec(m, await sh("d", "echo secret >&2; exit 255"))(["true"], 2000), fails("連線失敗", true));
    await rejects(rc.sshRemoteExec(m, await sh("s", "sleep 5"), 0)(["true"], 50), fails("逾時", true));
    await rejects(rc.sshRemoteExec(m, echo)(["a\nb"], 2000), fails("參數不合法", false));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub requestOn stays on that machine; a down remote fails instead of returning cache", async () => {
  const hub = new HerdrHub([{ id: "pod", ssh: "pod", socket: "/s" }], "/nonexistent/l.sock", 100, 10, () => undefined, () => "/nonexistent/t.sock");
  await rejects(hub.requestOn("other", "agent.list"), /unknown machine/);
  await rejects(hub.requestOn("pod", "workspace.close", { workspace_id: "w1" }), /non-pod ID/);
  await rejects(hub.freshAgentsOn("pod"));
  equal(hub.machineConfig("pod")?.ssh, "pod");
});

function reviewHarness(o: { exec: rc.RemoteExec; closeFails?: boolean; createFails?: boolean; labeled?: (label: string) => Promise<number> }) {
  const closed: string[] = [];
  const sleeps: number[] = [];
  const created: string[] = [];
  const remote: rc.RemoteReviewDeps = {
    machine: () => ({ id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } }),
    exec: () => o.exec,
    originUrl: async () => "git@github.com:acme/repo.git\n",
    createWorkspace: async (_m, _cwd, label) => {
      created.push(label);
      if (o.createFails) throw new Error("pod stderr SECRET");
      return { workspaceId: "pod:w3", paneId: "pod:w3:p1" };
    },
    closeWorkspace: async (_m, id) => void closed.push(id),
    closeWorkspaceLabeled: async (_m, l) => {
      closed.push(l);
      if (o.closeFails) throw new Error("close failed SECRET");
      return o.labeled ? o.labeled(l) : 1;
    },
    sleep: async (ms) => void sleeps.push(ms),
    panePort: () => ({}) as never,
    startAgent: async () => assert.fail("no agent"),
  };
  const card = { id: "REQ-1", type: "requirement", status: "done", title: "SECRET", version: 1, created: "", updated: "", body: "# x\n\n## 描述\nSECRET\n\n## 驗收條件\n- ok\n", roles: { reviewer: { machine: "pod", agent: "agy" } } };
  const run = (deps: rc.RemoteReviewDeps = remote) =>
    rc.reviewOnRemote(deps, {} as never, "pod", {
      card, round: 1, scope: "whole", pr: { number: 7, headSha: HEAD }, material: { files: ["x.ts"], diff: "diff --git a/x.ts b/x.ts\n+x\n" },
      author: { agent: "claude", paneId: "w1:p1", workspaceId: "w1" }, worktreePath: "/l", prRepo: "acme/repo", localWorktree: "/l",
      launch: { id: "agy", kind: "agy", model: "gemini", modelFlag: "--model", capabilities: ["review"] },
    } as never);
  return { run, closed, created, sleeps, remote };
}

/** clone 之後目錄才存在。 */
function existsAfterClone(exec: rc.RemoteExec, dir: string): rc.RemoteExec {
  let cloned = false;
  return async (argv, ms) => {
    if (argv.includes("clone")) cloned = true;
    return cloned && argv[0] === "test" && argv[1] === "-e" && argv[2] === dir ? { code: 0, stdout: "" } : exec(argv, ms);
  };
}

async function captured<T>(t: TestContext, body: () => Promise<T>) {
  const lines: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void lines.push(a.join(" ")));
  const error = await body().then(() => undefined, (e: unknown) => String(e));
  return { lines: lines.join("\n"), error: error ?? "" };
}

test("cleanup_pending: uncertain timeout keeps the directory; console names the full path, the record only has the fixed label", async (t) => {
  const dir = rc.remoteCheckoutDir(ROOT, "acme", "repo", "REQ-1");
  const f = fake({ throwOn: "fetch" });
  const h = reviewHarness({ exec: f.exec });
  const { lines, error } = await captured(t, () => h.run());
  match(error, /遠端 review 失敗：逾時.*cleanup_pending：directory/);
  ok(lines.includes(`cleanup_pending directory ${dir}`));
  ok(!f.removed.length);
  for (const hidden of [dir, "pod", "SECRET", "REQ-1"]) ok(!error.includes(hidden), hidden);
});

test("cleanup_pending: workspace close failure logs workspace id and label to console only; marker-less directory is never deleted", async (t) => {
  const dir = rc.remoteCheckoutDir(ROOT, "acme", "repo", "REQ-1");
  const f = fake({ marker: null });
  const exec = existsAfterClone(f.exec, dir);
  const h = reviewHarness({ exec, createFails: true, closeFails: true });
  const { lines, error } = await captured(t, () => h.run());
  match(error, /遠端 review 失敗：workspace 失敗.*cleanup_pending：workspace、directory/);
  const label = h.created[0]!;
  match(label, /^review-[0-9a-f]{10}-[0-9a-f]{8}$/);
  ok(lines.includes(`cleanup_pending workspace ${label} label ${label}`));
  ok(lines.includes(`cleanup_pending directory ${dir}`));
  ok(!f.removed.length);
  for (const hidden of [dir, label, "pod:w3", "SECRET"]) ok(!error.includes(hidden), hidden);
});

const DIR1 = rc.remoteCheckoutDir(ROOT, "acme", "repo", "REQ-1");
const MARKER1 = `hdb-card-review-checkout:v1:${rc.cardHash("REQ-1")}`;
const untouched = (calls: string[][]) => !calls.some((a) => ["cat", "clone", "fetch", "checkout", "sh"].includes(a[0]!) || a.some((x) => ["clone", "fetch", "checkout"].includes(x)));

test("symlinks and bad realpath output are refused before marker, reuse or rm", async () => {
  const cases: [string, FakeOptions, string][] = [
    ["root", { realMap: { [ROOT]: "/srv/real" } }, "root 是符號連結或在符號連結之下"],
    ["ancestor", { exists: REPO, realMap: { [ROOT]: "/mnt/home/agy/r", [DIR]: "/mnt/home/agy/r/acme__repo__x" } }, "root 是符號連結或在符號連結之下"],
    ["dir", { exists: REPO, links: [DIR] }, "既有目錄是符號連結"],
    ["dangling dir", { links: [DIR] }, "既有目錄是符號連結"],
    ["dir elsewhere", { exists: REPO, realMap: { [DIR]: "/other/place" } }, "既有目錄是符號連結"],
    [".git", { exists: REPO, links: [`${DIR}/.git`] }, "既有目錄是符號連結"],
    ["fails", { realpath: () => ({ code: 1, stdout: "" }) }, "路徑驗證失敗"],
    ["two lines", { realpath: () => ({ code: 0, stdout: `${ROOT}\n/x\n` }) }, "路徑驗證失敗"],
    ["relative", { realpath: () => ({ code: 0, stdout: "r\n" }) }, "路徑驗證失敗"],
    ["control char", { realpath: () => ({ code: 0, stdout: `${ROOT}\u0001\n` }) }, "路徑驗證失敗"],
  ];
  for (const [name, o, wanted] of cases) {
    const r = await prepare(o);
    ok(label(wanted)(r.error) && !r.owned && untouched(r.calls), `prepare: ${name}`);
    if (wanted === "路徑驗證失敗" || name === ".git") continue;
    const spy = fake({ marker: MARKER, ...o });
    await rejects(rc.removeRemoteCheckout(spy.exec, ROOT, DIR, HASH), label(wanted), `remove: ${name}`);
    ok(!spy.removed.length, `remove: ${name}`);
  }
});

test("uncertain fingerprint failure keeps the directory; a certain one removes it", async (t) => {
  const run = async (throwOn: string | undefined, failOn: string | undefined) => {
    const f = fake({ marker: MARKER1, throwOn, failOn });
    const h = reviewHarness({ exec: existsAfterClone(f.exec, DIR1) });
    const captured_ = await captured(t, async () => h.run());
    return { f, h, ...captured_ };
  };
  const uncertain = await run("status", undefined);
  ok(uncertain.lines.includes(`cleanup_pending directory ${DIR1}`));
  ok(!uncertain.f.removed.length);
  ok(uncertain.h.closed.includes("pod:w3")); // workspace 仍然關閉
  const certain = await run(undefined, "status");
  ok(certain.f.removed.length === 1 && !certain.lines.includes(`cleanup_pending directory ${DIR1}`));
});

test("fixed result text: only known labels pass, the rest is unclassified", () => {
  equal(rc.fixedResultText("reviewer 沒有回覆：pod secret"), "reviewer 沒有回覆");
  for (const sample of ["agent.start failed on agy-pod: permission denied", "machine pod unreachable", "pod：stderr SECRET", "reviewer 沒有回覆 pod", "stderr: /root/hdb-card-review/x", ""]) {
    equal(rc.fixedResultText(sample), rc.UNCLASSIFIED);
    ok(!/pod|SECRET|stderr|\/root/.test(rc.fixedResultText(sample)));
  }
});

test("results never carry machine id or stderr; details only reach the console", async (t) => {
  const f = fake({ marker: MARKER1, throwOn: "status" });
  const h = reviewHarness({ exec: existsAfterClone(f.exec, DIR1) });
  let result: unknown;
  const { lines } = await captured(t, async () => (result = await h.run()));
  const text = JSON.stringify(result);
  match(text, /無法取得工作樹指紋，不開始 review/);
  ok(!/pod|SECRET|stderr|REQ-1|\/home\/agy/.test(text), text);
  ok(/error:/.test(lines));
});

test("create timeout re-checks the labelled workspace 3 times, 2 s apart", async (t) => {
  const f = fake({ marker: MARKER1 });
  let calls = 0;
  const h = reviewHarness({ exec: existsAfterClone(f.exec, DIR1), createFails: true, labeled: async () => (++calls < 2 ? 0 : 1) });
  const second = await captured(t, () => h.run());
  equal(h.closed.length, 2);
  eq(h.sleeps, [2000]);
  ok(!/cleanup_pending/.test(second.error) && f.removed.length === 1);
  const none = reviewHarness({ exec: existsAfterClone(fake({ marker: MARKER1 }).exec, DIR1), createFails: true, labeled: async () => 0 });
  const r = await captured(t, () => none.run());
  equal(none.closed.length, 3);
  eq(none.sleeps, [2000, 2000]);
  match(r.error, /cleanup_pending：workspace/);
  ok(r.lines.includes(`cleanup_pending workspace ${none.created[0]} label ${none.created[0]}`) && r.lines.includes("remote review pod:") && r.lines.includes("重查 3 次都沒有找到"));
  ok(!r.error.includes(none.created[0]!) && !/pod/.test(r.error));
  let fourth = 0;
  const late = reviewHarness({ exec: existsAfterClone(fake({ marker: MARKER1 }).exec, DIR1), createFails: true, labeled: async () => (++fourth < 4 ? 0 : 1) });
  match((await captured(t, () => late.run())).error, /cleanup_pending：workspace/);
  eq([late.closed.length, fourth], [3, 3]);
  const broken = reviewHarness({ exec: existsAfterClone(fake({ marker: MARKER1 }).exec, DIR1), createFails: true, closeFails: true });
  match((await captured(t, () => broken.run())).error, /cleanup_pending：workspace/);
  equal(broken.closed.length, 3);
  const labels = [h.created[0], none.created[0], broken.created[0]]; // 每次執行唯一
  ok(new Set(labels).size === 3 && labels.every((l) => new RegExp(`^review-${rc.cardHash("REQ-1")}-[0-9a-f]{8}$`).test(l!)));
});

test("fake hub: a workspace listed only on the second query is closed on the retry", async (t) => {
  let lists = 0;
  const closes: string[] = [];
  const holder: { label?: string } = {};
  const hub = {
    request: async () => ({}),
    requestOn: async (_m: string, method: string, p?: Record<string, unknown>) =>
      method === "workspace.close" ? void closes.push(String(p?.workspace_id)) : { workspaces: ++lists < 2 ? [] : [{ workspace_id: "pod:w9", label: `pod:${holder.label}` }] },
    freshAgentsOn: async () => [],
    machineConfig: () => undefined,
  };
  const h = reviewHarness({ exec: existsAfterClone(fake({ marker: MARKER1 }).exec, DIR1), createFails: true });
  let sleeps = 0;
  const remote: rc.RemoteReviewDeps = { ...h.remote, closeWorkspaceLabeled: rc.remoteReviewDeps(hub as never).closeWorkspaceLabeled, sleep: async () => void sleeps++ };
  h.created.push = (l: string) => ((holder.label = l), 1);
  await captured(t, () => h.run(remote));
  eq([lists, closes, sleeps], [2, ["pod:w9"], 1]);
});

test("reuse needs a clean work tree: refused, kept as cleanup_pending, never reset or cleaned", async (t) => {
  for (const dirty of [" M src/x.ts\n", "?? new.txt\n"]) {
    const r = await prepare({ exists: REPO, dirty });
    ok(label("既有目錄工作樹不乾淨")(r.error) && r.error!.uncertain && r.owned);
    ok(r.calls.some((a) => a.includes("status") && a.includes("--untracked-files=all")));
    ok(!r.removed.length && !r.calls.some((a) => ["reset", "clean", "checkout", "fetch", "clone"].some((w) => a.includes(w))));
  }
  const clean = await prepare({ exists: REPO });
  ok(!clean.error && clean.calls.some((a) => a.includes("fetch")));
  const f = fake({ exists: [DIR1, `${DIR1}/.git`], marker: MARKER1, dirty: " M a.ts\n" });
  const h = reviewHarness({ exec: f.exec });
  const { lines, error } = await captured(t, () => h.run());
  match(error, /遠端 review 失敗：既有目錄工作樹不乾淨（cleanup_pending：directory）/);
  ok(lines.includes(`cleanup_pending directory ${DIR1}`) && !error.includes(DIR1));
  ok(!f.removed.length && !f.calls.some((a) => a.includes("reset") || a.includes("clean")));
});

test("the removal script, run for real, refuses symlinked root, ancestor and dir", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hdb-rm-")));
  const local: rc.RemoteExec = (argv) => new Promise((done) => execFile(argv[0]!, argv.slice(1), (e, stdout) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout })));
  const repo = async (dir: string, marker = MARKER) => (await mkdir(join(dir, ".git"), { recursive: true }), writeFile(join(dir, ".git", "hdb-card-review"), marker));
  const exists = (path: string) => readFile(join(path, ".git", "hdb-card-review")).then(() => true, () => false);
  try {
    const root = join(base, "r");
    await repo(join(root, "acme__repo__x"));
    await repo(join(base, "outside"));
    await symlink(root, join(base, "link"));
    await symlink(base, join(base, "up"));
    await symlink(join(base, "outside"), join(root, "evil"));
    await repo(join(root, "nomark"), "other");
    await rm(join(root, "nomark", ".git", "hdb-card-review"));
    await repo(join(root, "wrong"), "hdb-card-review-checkout:v1:ffffffffff");
    const refuse = async (r: string, name: string, wanted: string) => rejects(rc.removeRemoteCheckout(local, r, `${r}/${name}`, HASH), label(wanted));
    await refuse(join(base, "link"), "acme__repo__x", "root 是符號連結或在符號連結之下");
    await refuse(join(base, "up", "r"), "acme__repo__x", "root 是符號連結或在符號連結之下");
    await refuse(root, "evil", "既有目錄是符號連結");
    await refuse(root, "nomark", "既有目錄沒有 bridge marker");
    await refuse(root, "wrong", "既有目錄 marker 不符");
    ok((await exists(join(root, "acme__repo__x"))) && (await exists(join(base, "outside"))) && (await exists(join(root, "wrong"))));
    await rc.removeRemoteCheckout(local, root, join(root, "acme__repo__x"), HASH);
    ok(!(await exists(join(root, "acme__repo__x"))) && (await exists(join(base, "outside"))));
    await rc.removeRemoteCheckout(local, root, join(root, "acme__repo__x"), HASH);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("whitelist: every entry passes; BLOCKED_AT_START keeps the manual-handling reason", () => {
  for (const entry of rc.RESULT_WHITELIST) {
    const sample = typeof entry === "string" ? entry : entry.sample;
    equal(rc.fixedResultText(sample), sample);
    equal(rc.fixedResultText(`${sample}：pod stderr SECRET`), sample.includes("：") ? rc.UNCLASSIFIED : sample);
  }
  const produced = [BLOCKED_AT_START, "reviewer 卡在啟動提示，已保留 pane 供人處理", "reviewer 卡住了（blocked，可能在等人確認）", "reviewer 在 30 秒內沒有就緒（狀態 working）", "等待 reviewer 就緒時，它的 pane 不見了（消失或被換掉）"];
  for (const text of produced) equal(rc.fixedResultText(text), text);
  match(BLOCKED_AT_START, /常見原因：.*請先.*處理一次/);
});
