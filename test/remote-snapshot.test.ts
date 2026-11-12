import test from "node:test";
import { ok, deepEqual as eq, equal, rejects, throws } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateProfiles } from "../src/agent-pool.js";
import { REMOVE_SCRIPT, RemoteFailure, assertRemoteValue, type RemoteExec } from "../src/remote-checkout.js";
import { MAX_BUNDLE_BYTES as MAX, createLocalSnapshot, localGit, prepareRemoteSnapshot, startRemoteRole, type RemoteRoleDeps } from "../src/remote-snapshot.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
const failure = (label: string) => (e: unknown) => e instanceof RemoteFailure && e.label === label;

/** origin 一個 commit；卡片分支有未 push 的 commit、staged／unstaged、未追蹤與 ignored 檔案。 */
function repo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hdb-snap-")));
  const w = `${base}/w`;
  const put = (f: string, t: string) => fs.appendFileSync(`${w}/${f}`, t);
  git(base, "init", "-q", "--bare", "o.git");
  git(base, "clone", "-q", "o.git", "w");
  put("a.txt", "a\n");
  put(".gitignore", "secret.env\n");
  git(w, "add", "-A");
  git(w, "commit", "-qm", "base");
  git(w, "push", "-q", "origin", "HEAD");
  git(w, "checkout", "-qb", "card/x");
  put("local.txt", "unpushed\n");
  git(w, "add", "local.txt");
  git(w, "commit", "-qm", "unpushed");
  put("a.txt", "staged\n");
  git(w, "add", "a.txt");
  put("a.txt", "unstaged\n");
  put("new.txt", "untracked\n");
  put("secret.env", "TOKEN\n");
  const state = () => [git(w, "rev-parse", "HEAD"), git(w, "symbolic-ref", "HEAD"), fs.readFileSync(`${w}/.git/index`).toString("hex"), git(w, "status", "--porcelain"), git(w, "for-each-ref")];
  return { base, w, state, before: state(), done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("local snapshot: branch/HEAD/index/refs untouched, untracked in, ignored out, deterministic, temp removed, no push; limits refuse and clean", () => {
  const { base, w, state, before, done } = repo();
  const calls: string[][] = [];
  const snap = createLocalSnapshot(w, (a, e) => (calls.push(a), localGit(w)(a, e)));
  eq(state(), before);
  eq(git(w, "ls-tree", "-r", "--name-only", snap.sha).trim().split("\n"), [".gitignore", "a.txt", "local.txt", "new.txt"]);
  eq([git(w, "show", `${snap.sha}:a.txt`), git(w, "rev-parse", `${snap.sha}^{tree}`, `${snap.sha}^`)], ["a\nstaged\nunstaged\n", `${snap.tree}\n${before[0]}`]);
  ok(git(w, "bundle", "list-heads", snap.bundle).startsWith(`${snap.sha} ${snap.ref}`) && snap.bytes <= MAX);
  snap.dispose();
  ok(!fs.existsSync(path.dirname(snap.bundle)) && calls.every((a) => !a.includes("push")));
  const again = createLocalSnapshot(w);
  again.dispose();
  equal(again.sha, snap.sha);
  const bundles: string[] = [];
  throws(() => createLocalSnapshot(w, (a, e) => (a[0] === "bundle" && bundles.push(a[2]!), localGit(w)(a, e)), 10), failure("快照 bundle 超過大小上限"));
  ok(!fs.existsSync(path.dirname(bundles[0]!)));
  let n = 0;
  throws(() => createLocalSnapshot(w, undefined, undefined, () => String(n++)), failure("快照已作廢"));
  throws(() => createLocalSnapshot(`${base}/missing`), failure("快照建立失敗"));
  eq(state(), before);
  done();
});

test("pod side (local git as pod): fixed transfer argv, HEAD/tree equal snapshot, no push; existing dir and sha mismatch refused; bad values refused first", async () => {
  const { base, w, done } = repo();
  fs.mkdirSync(`${base}/pod`);
  const snap = createLocalSnapshot(w);
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const exec: RemoteExec = async (argv, _ms, stdin) => {
    calls.push({ argv, ...(stdin ? { stdin } : {}) });
    if (argv[0] === "timeout") return { code: 0, stdout: "" };
    if (argv[0] === "realpath") return fs.existsSync(argv[2]!) ? { code: 0, stdout: `${fs.realpathSync(argv[2]!)}\n` } : { code: 1, stdout: "" };
    const run = argv.map((a) => (a === "https://github.com/acme/repo.git" ? `${base}/o.git` : a === "protocol.allow=never" ? "protocol.allow=always" : a));
    const r = spawnSync(run[0]!, run.slice(1), { input: stdin ? fs.readFileSync(stdin) : undefined, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout };
  };
  const input = { root: `${base}/pod`, dir: `${base}/pod/acme__repo__0123456789`, owner: "acme", repo: "repo", cardHash: "0123456789", snapshot: snap };
  await prepareRemoteSnapshot(exec, input, () => {});
  equal(git(input.dir, "rev-parse", "HEAD").trim(), snap.sha);
  ok(fs.existsSync(`${input.dir}/new.txt`) && !fs.existsSync(`${input.dir}/secret.env`) && !fs.existsSync(`${input.dir}/.git/hdb-snapshot.bundle`));
  eq(calls.filter((c) => c.stdin), [{ argv: ["sh", "-c", 'head -c "$2" > "$1"', "sh", `${input.dir}/.git/hdb-snapshot.bundle`, String(MAX + 1)], stdin: snap.bundle }]);
  ok(calls.every((c) => !c.argv.includes("push") && (c.argv[0] !== "git" || c.argv.slice(1, 5).join() === "-c,protocol.allow=never,-c,protocol.https.allow=always")));
  await rejects(prepareRemoteSnapshot(exec, input, () => {}), failure("快照目錄已存在"));
  await rejects(prepareRemoteSnapshot(exec, { ...input, dir: `${input.dir}9`, snapshot: { ...snap, sha: "0".repeat(40) } }, () => {}), failure("HEAD 與快照 sha 不符"));
  snap.dispose();
  done();
  for (const bad of ["/r/../x", "/r/a\u0007", "/r/a b", "/r/a\nb", "/r/-x", "-x", "/r/./x"]) throws(() => assertRemoteValue("dir", bad), failure("參數不合法"));
  calls.length = 0;
  const s = { sha: "a".repeat(40), tree: "b".repeat(40), ref: "refs/hdb-snapshot/0123456789abcdef", bundle: "/tmp/x" };
  for (const patch of [{ dir: "/r/a b" }, { snapshot: { ...s, ref: "refs/heads/-x" } }, { snapshot: { ...s, sha: "HEAD" } }])
    await rejects(prepareRemoteSnapshot(exec, { ...input, root: "/r", dir: "/r/x", snapshot: s, ...patch }, () => {}), failure("參數不合法"));
  eq(calls, []);
});

const ROOT = "/home/pod/r";
const [SHA, TREE] = ["1".repeat(40), "2".repeat(40)];
const profile = validateProfiles([{ id: "claude", kind: "claude", model: "opus" }])[0]!;
const podAgent = { pane_id: "pod:w3:p1", terminal_id: "pod:t", workspace_id: "pod:w3", tab_id: "", agent: "claude", agent_status: "idle" };
type Opts = { failOn?: string; cutOn?: string; status?: string[]; digests?: string[]; toolchain?: boolean; abortOn?: string; wsFails?: boolean; found?: number[] };

/** fake pod：failOn 回 exit 1，cutOn 斷線（uncertain），abortOn 觸發取消。 */
function harness(o: Opts = {}) {
  const ac = new AbortController();
  const [log, found, status, digests] = [[] as string[], [...(o.found ?? [1])], [...(o.status ?? ["", ""])], [...(o.digests ?? ["d0"])]];
  let exists = false;
  const exec: RemoteExec = async (argv, _ms, stdin) => {
    const j = argv.join(" ");
    if (o.cutOn && j.includes(o.cutOn)) throw new RemoteFailure("連線失敗", "ssh SECRET /home/pod", true);
    if (o.abortOn && j.includes(o.abortOn)) ac.abort();
    if (argv[2] === REMOVE_SCRIPT) return (log.push("rm"), { code: 0, stdout: "" });
    if (stdin) log.push("send");
    if (o.failOn && j.includes(o.failOn)) return { code: 1, stdout: "SECRET" };
    if (j.includes("mkdir --")) (log.push("mkdir"), (exists = true));
    const out = argv[0] === "realpath" ? `${argv[2]}\n` : j.endsWith("{tree}") ? `${SHA}\n${TREE}\n` : j.endsWith("rev-parse HEAD") ? SHA : j.endsWith("porcelain") ? (status.shift() ?? "") : "";
    return { code: argv[0] === "test" ? (argv[1] === "-e" && exists ? 0 : 1) : 0, stdout: out };
  };
  const deps: RemoteRoleDeps = {
    machine: (id) => (id === "pod" ? { id, ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["claude"], ...(o.toolchain ? { toolchain: true } : {}) } } : undefined),
    exec: () => exec,
    originUrl: async () => "git@github.com:acme/repo.git\n",
    createWorkspace: async (m, cwd, label) => {
      log.push(`create:${m}:${cwd.startsWith(`${ROOT}/acme__repo__`)}:${/^task-[0-9a-f]{10}-[0-9a-f]{8}$/.test(label)}`);
      if (o.wsFails) throw new Error("SECRET");
      return { workspaceId: "pod:w3", paneId: "pod:w3:p1" };
    },
    closeWorkspace: async (_m, id) => void log.push(`close:${id}`),
    closeWorkspaceLabeled: async () => (log.push("closeLabeled"), found.shift() ?? 0),
    sleep: async () => {},
    panePort: () => ({ request: async () => ({}), listAgentsWithWorkspaceNames: async () => [podAgent] }),
    startAgent: async (i) => (log.push(`start:${i.paneId}:${i.args?.join(" ")}`), podAgent),
    snapshot: () => ({ sha: SHA, tree: TREE, ref: "refs/hdb-snapshot/0123456789abcdef", bundle: "/tmp/b", bytes: 1, digest: "d0", dispose: () => void log.push("dispose") }),
    treeDigest: () => digests.shift() ?? "d0",
  };
  return { log, start: (role = "review", p = profile) => startRemoteRole(deps, { machineId: "pod", role, key: "t/a", cwd: "/local/w", profile: p, name: "n", signal: ac.signal }) };
}
const fixed = (label: RegExp) => (e: unknown) => label.test(String(e)) && /^Error: 遠端角色失敗：/.test(String(e)) && !/SECRET|\/home|\/local|acme/.test(String(e));
const OK_LOG = ["mkdir", "send", "dispose", "create:pod:true:true", "start:pod:w3:p1:--model opus", "close:pod:w3", "rm"];

test("remote role: completion, cancellation, timeout and dispatch failure close and remove; blocked retains; verify needs toolchain", async () => {
  for (const reason of ["completed", "uncertain", "timeout", "before_dispatch_failure", "blocked"] as const) {
    const h = harness();
    const s = await h.start();
    eq([s.agent.machine, s.agent.model, s.continuity], ["pod", "opus", "new-session"]);
    await s.afterTurn();
    await s.cleanup(reason);
    await s.cleanup(reason);
    eq(h.log, reason === "blocked" ? OK_LOG.slice(0, 5) : OK_LOG);
  }
  await rejects(harness().start("verify"), fixed(/verify 不可用/));
  await (await harness({ toolchain: true }).start("verify")).cleanup();
});

test("remote role failures: fixed labels, snapshot disposed, no local start, pod dir removed when certain, kept when uncertain", async () => {
  const cases: Array<[Opts, RegExp, string[] | ((log: string[]) => boolean), string?]> = [
    [{ failOn: "fetch --no-tags --quiet /home" }, /fetch 失敗$/, ["mkdir", "send", "dispose", "rm"]],
    [{ failOn: "origin" }, /clone 失敗$/, ["mkdir", "dispose", "rm"]],
    [{ failOn: "mkdir --" }, /marker 寫入失敗$/, ["dispose"]],
    [{ cutOn: "bundle verify" }, /連線失敗（cleanup_pending：directory）$/, ["mkdir", "send", "dispose"]],
    [{ cutOn: "porcelain" }, /連線失敗/, (l) => !l.includes("rm") && l.includes("close:pod:w3")],
    [{ abortOn: "remote add" }, /已取消$/, ["mkdir", "dispose", "rm"]],
    [{ wsFails: true, found: [0, 1] }, /準備失敗$/, (l) => l.slice(-3).join() === "closeLabeled,closeLabeled,rm"],
    [{ wsFails: true, found: [0, 0, 0] }, /準備失敗（cleanup_pending：workspace、directory）$/, (l) => !l.includes("rm")],
    [{}, /profile 不可續接既有 session/, [], "resume"],
  ];
  for (const [o, label, expected, resume] of cases) {
    const h = harness(o);
    await rejects(h.start("review", resume ? { ...profile, args: ["--resume"] } : profile), fixed(label));
    ok(typeof expected === "function" ? expected(h.log) : JSON.stringify(h.log) === JSON.stringify(expected), `${label}: ${h.log}`);
  }
});

test("remote role read-only and version binding: pod change or later local change invalidates the result", async () => {
  await rejects((await harness({ status: ["", " M a.txt\n"] }).start()).afterTurn(), fixed(/被改動/));
  await rejects((await harness({ digests: ["d1"] }).start()).afterTurn(), fixed(/快照已作廢/));
});
