import test from "node:test";
import assert, { ok, deepEqual as eq, equal, throws, rejects, match } from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrHub, validateMachines } from "../src/machines.js";
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
const input = { dir: DIR, owner: "acme", repo: "repo", prNumber: 7, headSha: HEAD, cardHash: HASH };
const label = (l: string) => (e: unknown) => e instanceof RemoteFailure && e.label === l;

function fake(o: { exists?: string[]; origin?: string; head?: string; failOn?: string; throwOn?: string; marker?: string | null; probe?: number } = {}) {
  const calls: string[][] = [];
  const exec: rc.RemoteExec = async (argv) => {
    calls.push(argv);
    const j = argv.join(" ");
    if (o.throwOn && j.includes(o.throwOn)) throw new RemoteFailure("逾時", "x", true);
    if (o.failOn && j.includes(o.failOn)) return { code: 128, stdout: "" };
    if (argv[0] === "timeout") return { code: o.probe ?? 0, stdout: "" };
    if (argv[0] === "cat") return o.marker === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${o.marker ?? MARKER}\n` };
    if (argv[0] === "test") return { code: o.exists?.includes(argv[2]!) ? 0 : 1, stdout: "" };
    return { code: 0, stdout: j.includes("get-url") ? (o.origin ?? URL) : j.includes("rev-parse") ? `${o.head ?? HEAD}\n` : "" };
  };
  return { exec, calls };
}
async function prepare(o: Parameters<typeof fake>[0], patch = {}) {
  const f = fake(o);
  let owned = false;
  const error = await rc.prepareRemoteCheckout(f.exec, { ...input, ...patch }, () => (owned = true)).catch((e: unknown) => e as InstanceType<typeof RemoteFailure>);
  return { ...f, owned, error: error || undefined };
}

test("argument and path validation: .., . segments, control chars, spaces, newlines, leading -", () => {
  for (const bad of ["a/../b", "/root/.", "/./.", "a\u0001b", "a b", "a\nb", "-oProxyCommand=x", "/a/-x", "", "a;b"])
    throws(() => rc.assertRemoteValue("v", bad), label("參數不合法"));
  equal(rc.assertRemoteValue("v", "/a/.b/c.d"), "/a/.b/c.d");
  match(rc.remoteCheckoutDir(`${ROOT}/`, "acme", "repo", "REQ-1"), /^\/home\/agy\/r\/acme__repo__[0-9a-f]{10}$/);
  for (const root of ["relative", "/a/../b", "/root/."]) throws(() => rc.remoteCheckoutDir(root, "acme", "repo", "x"));
  const base = { id: "pod", ssh: "pod", socket: "/r/h.sock" };
  eq(validateMachines([base]), [base]);
  eq(validateMachines([{ ...base, cardReview: { root: `${ROOT}/`, kinds: ["agy"] } }])[0]?.cardReview, { root: ROOT, kinds: ["agy"] });
  for (const cardReview of [null, { root: "rel/x" }, { root: "/" }, { root: "/tmp" }, { root: "/./." }, { root: "/root/." }, { root: "/a/../b" }, { root: "/a b/c" }, { root: "/a/-x" }, { kinds: [] }, { kinds: ["bash"] }, { kinds: ["agy", "agy"] }, { ssh: "x" }])
    throws(() => validateMachines([{ ...base, cardReview: cardReview && { root: ROOT, kinds: ["agy"], ...cardReview } }]), /cardReview/);
});

test("only github.com origins parse", () => {
  for (const url of [URL, "https://github.com/acme/repo", "git@github.com:acme/repo.git", "ssh://git@github.com/acme/repo.git"]) eq(rc.githubOriginRepo(url), { owner: "acme", repo: "repo" });
  for (const url of ["http://github.com/acme/repo", "https://gitlab.com/acme/repo", "https://github.com.evil.io/acme/repo", "https://t@github.com/acme/repo", "https://github.com/acme/../repo", `${URL}\nx`, "https://github.com/acme/.h", "/tmp/repo"])
    equal(rc.githubOriginRepo(url), undefined);
});

test("missing project: owned, fixed-argument clone, PR head fetch, detached checkout, sha verified", async () => {
  const r = await prepare({});
  ok(!r.error && r.owned);
  eq(r.calls, [
    PROBE,
    ["test", "-e", `${DIR}/.git`],
    ["test", "-e", DIR],
    [...GIT, "clone", "--no-checkout", "--no-tags", "--no-recurse-submodules", "--quiet", "--", URL, DIR],
    WRITE_MARKER,
    [...GIT, "-C", DIR, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "--force", "origin", "refs/pull/7/head:refs/remotes/hdb/pr-7"],
    [...GIT, "-C", DIR, "checkout", "--quiet", "--detach", "refs/remotes/hdb/pr-7"],
    [...GIT, "-C", DIR, "rev-parse", "HEAD"],
  ]);
});

test("existing repo needs a matching marker and origin; no marker, wrong marker, other origin or non-repo dir is refused, not owned, untouched", async () => {
  const same = await prepare({ exists: [`${DIR}/.git`] });
  ok(!same.error && same.owned && !same.calls.some((a) => a.includes("clone")));
  const bare = await prepare({ exists: [`${DIR}/.git`], marker: null });
  ok(label("既有目錄沒有 bridge marker")(bare.error) && !bare.owned && !bare.calls.some((a) => a.includes("remote") || a.includes("fetch") || a.includes("clone") || a.includes("rm")));
  const wrong = await prepare({ exists: [`${DIR}/.git`], marker: "hdb-card-review-checkout:v1:ffffffffff" });
  ok(label("既有目錄 marker 不符")(wrong.error) && !wrong.owned && !wrong.calls.some((a) => a.includes("fetch")));
  const foreign = await prepare({ exists: [`${DIR}/.git`], marker: "something else" });
  ok(label("既有目錄 marker 不符")(foreign.error) && !foreign.owned);
  const other = await prepare({ exists: [`${DIR}/.git`], origin: "https://github.com/evil/repo.git" });
  ok(label("既有目錄 origin 不符")(other.error) && !other.owned && !other.calls.some((a) => a.includes("fetch")));
  const plain = await prepare({ exists: [DIR] });
  ok(label("既有目錄不是 repo")(plain.error) && !plain.owned && !plain.calls.some((a) => a.includes("clone")));
  for (const r of [bare, wrong, foreign, other, plain]) ok(!r.calls.some((a) => a[0] === "rm" || a.includes("rm")));
});

test("remote without GNU timeout fails first with a fixed label, not as clone failure (exit 127 and busybox usage error 1)", async () => {
  for (const probe of [127, 1]) {
    const r = await prepare({ probe });
    ok(label("遠端缺少 timeout")(r.error) && !r.error!.uncertain && !r.owned);
    eq(r.calls, [PROBE]);
  }
  // 經 ssh 包裝時，缺 timeout 的遠端 shell 回 127／busybox 回 1：兩者都走同一個標籤。
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
  for (const patch of [{ prNumber: 0 }, { headSha: "HEAD" }, { dir: `${ROOT}/../e` }, { dir: "-rf" }]) {
    const r = await prepare({}, patch);
    ok(label("參數不合法")(r.error) && !r.calls.length);
  }
});

test("fingerprint is read-only; cleanup removes only a direct child of root", async () => {
  const f = fake();
  equal(await rc.remoteFingerprint(f.exec, DIR), `${HEAD}\n`);
  eq(f.calls.map((a) => a.slice(GIT.length + 2)), [["rev-parse", "HEAD"], ["status", "--porcelain"]]);
  const owned = fake({ exists: [DIR] });
  await rc.removeRemoteCheckout(owned.exec, ROOT, DIR, HASH);
  eq(owned.calls.slice(-3), [["test", "-e", DIR], ["cat", "--", `${DIR}/.git/hdb-card-review`], ["rm", "-rf", "--", DIR]]);
  for (const dir of [ROOT, "/home/agy", `${ROOT}/a/b`, `${ROOT}/../x`, `${ROOT}x/y`, `${ROOT}/.git`, `${ROOT}/.`]) {
    const spy = fake();
    await rejects(rc.removeRemoteCheckout(spy.exec, ROOT, dir, HASH));
    equal(spy.calls.length, 0);
  }
  // 沒有 marker、marker 不符：拒絕且不刪；目錄已不存在：視為已清理。
  for (const [marker, wanted] of [[null, "既有目錄沒有 bridge marker"], ["hdb-card-review-checkout:v1:ffffffffff", "既有目錄 marker 不符"]] as const) {
    const spy = fake({ exists: [DIR], marker });
    await rejects(rc.removeRemoteCheckout(spy.exec, ROOT, DIR, HASH), label(wanted));
    ok(!spy.calls.some((a) => a[0] === "rm"));
  }
  const gone = fake();
  await rc.removeRemoteCheckout(gone.exec, ROOT, DIR, HASH);
  ok(!gone.calls.some((a) => a[0] === "rm" || a[0] === "cat"));
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

// reviewOnRemote 在進入 review flow 之前的失敗路徑（flow 與本機 Agent 在這裡都不會被呼叫）。
function reviewHarness(o: { exec: rc.RemoteExec; closeFails?: boolean; createFails?: boolean }) {
  const closed: string[] = [];
  const remote: rc.RemoteReviewDeps = {
    machine: () => ({ id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } }),
    exec: () => o.exec,
    originUrl: async () => "git@github.com:acme/repo.git\n",
    createWorkspace: async () => {
      if (o.createFails) throw new Error("pod stderr SECRET");
      return { workspaceId: "pod:w3", paneId: "pod:w3:p1" };
    },
    closeWorkspace: async (_m, id) => void closed.push(id),
    closeWorkspaceLabeled: async (_m, l) => {
      closed.push(l);
      if (o.closeFails) throw new Error("close failed SECRET");
    },
    panePort: () => assert.fail("no pane"),
    startAgent: async () => assert.fail("no agent"),
  };
  const run = () =>
    rc.reviewOnRemote(remote, {} as never, "pod", { card: { id: "REQ-1", title: "SECRET", roles: {} }, pr: { number: 7, headSha: HEAD }, prRepo: "acme/repo", localWorktree: "/l" } as never);
  return { run, closed };
}

/** clone 之後目錄才存在（模擬剛建立的 checkout）。 */
function existsAfterClone(exec: rc.RemoteExec, dir: string): rc.RemoteExec {
  let cloned = false;
  return async (argv, ms) => {
    if (argv.includes("clone")) cloned = true;
    return cloned && argv[0] === "test" && argv[2] === dir ? { code: 0, stdout: "" } : exec(argv, ms);
  };
}

async function captured<T>(t: { mock: { method: (o: object, m: "error", f: (...a: unknown[]) => void) => unknown } }, body: () => Promise<T>) {
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
  ok(!f.calls.some((a) => a[0] === "rm"));
  for (const hidden of [dir, "pod", "SECRET", "REQ-1"]) ok(!error.includes(hidden), hidden);
});

test("cleanup_pending: workspace close failure logs workspace id and label to console only; marker-less directory is never deleted", async (t) => {
  const dir = rc.remoteCheckoutDir(ROOT, "acme", "repo", "REQ-1");
  const label = `review-${dir.slice(-10)}`;
  // 沒有 marker 的目錄（例如別人的 repo 剛好同路徑）：清理拒絕，不刪，目錄 pending。
  const f = fake({ marker: null });
  const exec = existsAfterClone(f.exec, dir);
  const h = reviewHarness({ exec, createFails: true, closeFails: true });
  const { lines, error } = await captured(t, () => h.run());
  match(error, /遠端 review 失敗：workspace 失敗.*cleanup_pending：workspace、directory/);
  ok(lines.includes(`cleanup_pending workspace ${label} label ${label}`));
  ok(lines.includes(`cleanup_pending directory ${dir}`));
  ok(!f.calls.some((a) => a[0] === "rm"));
  for (const hidden of [dir, label, "pod:w3", "SECRET"]) ok(!error.includes(hidden), hidden);
  // 對照：有 marker 時正常清掉目錄，只剩 workspace pending。
  const ok2 = fake({ marker: `hdb-card-review-checkout:v1:${rc.cardHash("REQ-1")}` });
  const h2 = reviewHarness({ exec: existsAfterClone(ok2.exec, dir), createFails: true, closeFails: true });
  const second = await captured(t, () => h2.run());
  equal(second.error, "Error: 遠端 review 失敗：workspace 失敗（cleanup_pending：workspace）");
});
