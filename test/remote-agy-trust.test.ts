import test, { type TestContext } from "node:test";
import { ok, deepEqual as eq, equal, rejects, match, fail } from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStartPort } from "../src/agent-start.js";
import { validateProfiles } from "../src/agent-pool.js";
import type { ReviewFlowDeps } from "../src/card-review-flow.js";
import { TRUST_READ_SCRIPT, TRUST_WRITE_SCRIPT, editRemoteAgyTrust } from "../src/remote-agy-trust.js";
import { REMOVE_SCRIPT, RemoteFailure, cardHash, reviewOnRemote, type RemoteExec, type RemoteReviewDeps } from "../src/remote-checkout.js";
import type { AgentRecord } from "../src/types.js";

const ROOT = "/home/agy/r";
const HASH = cardHash("REQ-1");
const NAME = `acme__repo__${HASH}`;
const DIR = `${ROOT}/${NAME}`;
const MARKER = `hdb-card-review-checkout:v1:${HASH}`;
const SETTINGS = '{\n  "trustedWorkspaces": [\n    "/root/workspace"\n  ],\n  "theme": "SCREEN_SECRET"\n}\n';
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const READ = ["sh", "-c", TRUST_READ_SCRIPT, "sh"];
const IN = { root: ROOT, dir: DIR, cardHash: HASH };

type Fault = { error: Error; landed: boolean };
function pod(o: { writeCode?: (mode: string) => number; read?: () => { code: number; stdout: string }; settings?: string; fault?: (mode: string) => Fault | undefined } = {}) {
  const state = { settings: o.settings ?? SETTINGS, calls: [] as string[][] };
  const exec: RemoteExec = async (argv) => {
    state.calls.push(argv);
    if (argv[2] === TRUST_READ_SCRIPT) return o.read?.() ?? { code: 0, stdout: `${sha(state.settings)}\n${state.settings}` };
    const fault = o.fault?.(argv[8]!);
    const code = fault ? 0 : (o.writeCode?.(argv[8]!) ?? 0);
    if (!code && (!fault || fault.landed)) state.settings = Buffer.from(argv[10]!, "base64").toString("utf8");
    if (fault) throw fault.error;
    return { code, stdout: "" };
  };
  return { state, exec };
}

test("ssh argv is fixed; values never enter the script text", async () => {
  const p = pod();
  equal(await editRemoteAgyTrust(p.exec, { root: `${ROOT}/`, dir: DIR, cardHash: HASH }, true), true);
  const added = p.state.settings;
  eq(p.state.calls, [READ, ["sh", "-c", TRUST_WRITE_SCRIPT, "sh", ROOT, DIR, NAME, MARKER, "add", sha(SETTINGS), Buffer.from(added).toString("base64")]]);
  eq(JSON.parse(added).trustedWorkspaces, ["/root/workspace", DIR]);
  equal(await editRemoteAgyTrust(p.exec, IN, true), false);
  equal(await editRemoteAgyTrust(p.exec, IN, false), true);
  equal(p.state.settings, SETTINGS);
  eq(p.state.calls.at(-1)!.slice(0, 9), ["sh", "-c", TRUST_WRITE_SCRIPT, "sh", ROOT, DIR, NAME, MARKER, "remove"]);
  for (const script of [TRUST_READ_SCRIPT, TRUST_WRITE_SCRIPT])
    for (const value of [ROOT, NAME, HASH, MARKER, "/root/workspace", "SCREEN_SECRET", "agy-pod"]) ok(!script.includes(value), value);
  ok(TRUST_WRITE_SCRIPT.includes('"$3/.git/hdb-card-review"') && !/[\u0000-\u001F]/.test(TRUST_WRITE_SCRIPT + TRUST_READ_SCRIPT));
});

test("unsafe values are refused before a remote call", async () => {
  for (const input of [{ ...IN, dir: `${ROOT}/../etc` }, { ...IN, dir: `${ROOT}/a b` }, { ...IN, dir: `${DIR}/sub` }, { ...IN, root: "relative", dir: "relative/x" }, { ...IN, cardHash: "$(id)" }]) {
    const p = pod();
    await rejects(editRemoteAgyTrust(p.exec, input, true), RemoteFailure, JSON.stringify(input));
    eq(p.state.calls, []);
  }
});

test("bad read never writes; a changed file is reread", async () => {
  for (const read of [
    () => ({ code: 0, stdout: SETTINGS.slice(0, 20) }),
    () => ({ code: 0, stdout: `${sha(SETTINGS)}\n${SETTINGS.slice(1)}` }),
    () => ({ code: 16, stdout: "" }),
    () => ({ code: 0, stdout: `${sha("{}")}\n{}` }),
  ]) {
    const p = pod({ read });
    await rejects(editRemoteAgyTrust(p.exec, IN, true), RemoteFailure);
    eq(p.state.calls, [READ]);
  }
  let changed = 1;
  const retry = pod({ writeCode: () => (changed-- > 0 ? 15 : 0) });
  equal(await editRemoteAgyTrust(retry.exec, IN, true), true);
  equal(retry.state.calls.length, 4);
  for (const [code, label] of [[14, "既有目錄 marker 不符"], [17, "寫入 agy 設定檔失敗"]] as const)
    await rejects(editRemoteAgyTrust(pod({ writeCode: () => code }).exec, IN, true), (e: unknown) => e instanceof RemoteFailure && e.label === label);
  await rejects(editRemoteAgyTrust(pod({ writeCode: () => 15 }).exec, IN, true), /agy 設定檔一直在變/);
});

const writeAdd = (exec: RemoteExec, root: string, dir: string, marker = MARKER, hash = sha(SETTINGS)) =>
  exec(["sh", "-c", TRUST_WRITE_SCRIPT, "sh", root, dir, dir.slice(root.length + 1), marker, "add", hash, Buffer.from("{}").toString("base64")], 15_000);

async function shPod(t: TestContext, names = [NAME]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agy-trust-sh-")));
  const [home, root] = [join(base, "home"), join(base, "root")];
  const dir = join(root, names[0]!);
  const file = join(home, ".gemini/antigravity-cli/settings.json");
  await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
  for (const n of names) {
    await mkdir(join(root, n, ".git"), { recursive: true });
    await writeFile(join(root, n, ".git/hdb-card-review"), MARKER);
  }
  await writeFile(file, SETTINGS, { mode: 0o640 });
  const exec: RemoteExec = (argv) => new Promise((resolve) => execFile(argv[0]!, argv.slice(1), { env: { ...process.env, HOME: home } }, (e, stdout) => resolve({ code: e ? Number(e.code) : 0, stdout })));
  const ok = !(await exec(["sh", "-c", "command -v sha256sum && command -v base64"], 5000)).code;
  if (!ok) t.skip("no sha256sum/base64");
  return { base, home, root, dir, file, exec, ok };
}

test("real sh: backups, mode, restore; symlink/marker/race refused", async (t) => {
  const { base, home, root, dir, file, exec, ok: usable } = await shPod(t);
  if (!usable) return;
  const input = { root, dir, cardHash: HASH };
  for (let i = 0; i < 4; i++) {
    equal(await editRemoteAgyTrust(exec, input, true), true);
    match(await readFile(file, "utf8"), new RegExp(`"${dir}"\\n  \\],`));
    equal((await stat(file)).mode & 0o777, 0o640);
    equal(await editRemoteAgyTrust(exec, input, false), true);
    equal(await readFile(file, "utf8"), SETTINGS);
  }
  const backups = await readdir(join(root, ".hdb-agy-settings-backups"));
  ok(backups.length <= 5 && backups.length > 0);
  for (const b of backups) equal((await stat(join(root, ".hdb-agy-settings-backups", b))).mode & 0o777, 0o600);
  ok(!(await readdir(join(home, ".gemini/antigravity-cli"))).some((n) => n !== "settings.json"));
  const write = (r: string, d: string, marker?: string, hash?: string) => writeAdd(exec, r, d, marker, hash);
  await symlink(root, join(base, "root-link"));
  equal((await write(join(base, "root-link"), join(base, "root-link", NAME))).code, 11);
  await symlink(dir, join(root, "acme__repo__alias"));
  equal((await write(root, join(root, "acme__repo__alias"))).code, 12);
  equal((await write(root, dir, `${MARKER}x`)).code, 14);
  equal((await write(root, join(root, "acme__repo__missing"))).code, 13);
  equal((await write(root, dir, MARKER, sha("other"))).code, 15);
  await writeFile(join(base, "real.json"), SETTINGS);
  await rm(file);
  await symlink(join(base, "real.json"), file);
  equal((await write(root, dir)).code, 16);
  equal((await exec(READ, 5000)).code, 16);
  equal(await readFile(join(base, "real.json"), "utf8"), SETTINGS);
});

const profiles = validateProfiles([
  { id: "agy", kind: "agy", model: "gemini", modelFlag: "--model", capabilities: ["review"] },
  { id: "opus", kind: "claude", model: "opus" },
]);
const agent = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ pane_id: "pod:w3:p2", terminal_id: "pod:t", workspace_id: "pod:w3", tab_id: "", agent: "agy", agent_status: "idle", machine: "pod", ...patch });

function harness(o: { listing?: AgentRecord[][]; turn?: () => Promise<{ state: "done"; text: string }>; writeCode?: (mode: string) => number; statusThrows?: number; kind?: "agy" | "claude"; settings?: string; fault?: (mode: string) => Fault | undefined } = {}) {
  const log: string[] = [];
  const p = pod({ writeCode: o.writeCode, settings: o.settings, fault: o.fault });
  let statusCalls = 0;
  let cloned = false;
  const exec: RemoteExec = async (argv, ms) => {
    const [cmd, flag, script] = argv;
    if (script === TRUST_READ_SCRIPT || script === TRUST_WRITE_SCRIPT) {
      const r = await p.exec(argv, ms).catch((e: unknown) => {
        if (script === TRUST_WRITE_SCRIPT) log.push(`trust:${argv[8]}:throw`);
        throw e;
      });
      if (script === TRUST_WRITE_SCRIPT) log.push(`trust:${argv[8]}${r.code ? ":fail" : ""}`);
      return r;
    }
    if (script === REMOVE_SCRIPT) log.push("rm");
    if (argv.includes("clone")) cloned = true;
    if (argv.includes("status") && ++statusCalls === o.statusThrows) throw new RemoteFailure("逾時", "x", true);
    const code = cmd === "test" ? Number(flag === "-L" || !cloned || argv[2] !== DIR) : 0;
    return { code, stdout: cmd === "realpath" ? `${argv[2]}\n` : cmd === "cat" ? MARKER : argv.includes("rev-parse") ? "0".repeat(40) : "" };
  };
  const listing = [...(o.listing ?? [[agent({ agent: o.kind ?? "agy" })]])];
  const port: AgentStartPort = {
    request: async (method) =>
      ({
        "pane.layout": { layout: { panes: [{ pane_id: "pod:w3:p1", rect: { width: 200, height: 40 } }] } },
        "pane.split": { pane: { pane_id: "pod:w3:p2", workspace_id: "pod:w3", terminal_id: "pod:t" } },
        "pane.get": { pane: { terminal_id: "pod:t" } },
      })[method] ?? { read: { text: "Do you trust this folder? SCREEN_SECRET" } },
    listAgentsWithWorkspaceNames: async () => (listing.length > 1 ? listing.shift()! : listing[0]!),
  };
  const remote: RemoteReviewDeps = {
    machine: () => ({ id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } }), exec: () => exec, originUrl: async () => "git@github.com:acme/repo.git", createWorkspace: async () => ({ workspaceId: "pod:w3", paneId: "pod:w3:p1" }), closeWorkspace: async () => void log.push("close"), closeWorkspaceLabeled: async () => 1, panePort: () => port, startAgent: async (input) => (log.push(`start:${input.kind}`), agent({ agent_status: "working", agent: input.kind })),
  };
  const recorded: unknown[] = [];
  const local = async () => fail("local") as never;
  const flow: ReviewFlowDeps = {
    panePort: {} as never, startAgent: local, fingerprint: local, runTurn: async () => (o.turn ? o.turn() : { state: "done", text: JSON.stringify({ verdict: "pass", criteria: [{ index: 1, status: "met" }], findings: [] }) }), recordRoleStrict: (identity) => void recorded.push(identity), readyTimeoutMs: 200, readyPollMs: 2, timeoutMs: 200,
  };
  const card = { id: "REQ-1", type: "requirement", status: "done", title: "t", version: 1, created: "", updated: "", body: "# x\n\n## 描述\nd\n\n## 驗收條件\n- ok\n", roles: { reviewer: { machine: "pod", agent: o.kind ?? "agy" } } } as never;
  const run = () => reviewOnRemote(remote, flow, "pod", {
    card, round: 1, scope: "whole", pr: { number: 7, headSha: "0".repeat(40) }, material: { files: ["x.ts"], diff: "diff --git a/x.ts b/x.ts\n+x\n" },
    author: { agent: "claude", paneId: "w1:p1", workspaceId: "w1" }, worktreePath: "/l", launch: profiles[o.kind === "claude" ? 1 : 0]!, prRepo: "acme/repo", localWorktree: "/l",
  });
  return { run, log, p, recorded };
}

async function quietly<T>(t: TestContext, body: () => Promise<T>) {
  const lines: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void lines.push(a.join(" ")));
  t.mock.method(console, "log", () => {});
  const out = await body().then((r) => JSON.stringify(r), (e: unknown) => String(e));
  return { lines: lines.join("\n"), out };
}

test("trust added before start, removed before rm", async (t) => {
  const cases: Array<[string, Parameters<typeof harness>[0], RegExp]> = [
    ["success", {}, /"verdict":"pass"/],
    ["reviewer failure", { turn: async () => ({ state: "done", text: "not json" }) }, /inconclusive/],
    ["thrown", { listing: [[agent()], [agent({ workspace_id: "pod:w9" })]] }, /身分不符/],
    // runTurn 自己計時，逾時以丟錯表示（flow 轉成「reviewer 沒有回覆」）。
    ["timeout", { turn: async () => { throw new Error("turn timed out"); } }, /reviewer 沒有回覆/],
    ["uncertain", { statusThrows: 2 }, /cleanup_pending：directory/],
  ];
  for (const [name, o, expected] of cases) {
    const h = harness(o);
    const { out } = await quietly(t, h.run);
    match(out, expected, name);
    eq(h.log.filter((l) => l !== "close"), ["trust:add", "start:agy", "trust:remove", ...(name === "uncertain" ? [] : ["rm"])], name);
    equal(h.p.state.settings, SETTINGS, name);
    ok(!/SCREEN_SECRET|Do you trust|\/home\/agy|cleanup_pending：trust/.test(out + JSON.stringify(h.recorded)), name);
  }
});

test("paneKept keeps trust; removal failure is pending; add failure changes nothing", async (t) => {
  const kept = harness({ listing: [[agent({ agent_status: "blocked" })]] });
  const k = await quietly(t, kept.run);
  match(k.out, /"paneKept":true/);
  eq(kept.log, ["trust:add", "start:agy"]);
  const failing = harness({ writeCode: (mode) => (mode === "remove" ? 17 : 0) });
  const f = await quietly(t, failing.run);
  match(f.out, /"closeNote":"[^"]*cleanup_pending：trust"/);
  ok(!f.out.includes(ROOT) && f.lines.includes(`cleanup_pending trust ${DIR}`));
  eq(failing.log.slice(-2), ["trust:remove:fail", "rm"]);
  const refused = harness({ writeCode: () => 14 });
  const r = await quietly(t, refused.run);
  match(r.out, /"verdict":"pass"/);
  ok(!/cleanup_pending/.test(r.out) && r.lines.includes(`agy trust not added ${DIR}`));
  eq(refused.log.filter((l) => l !== "close"), ["trust:add:fail", "start:agy", "rm"]);
});

test("a non-agy reviewer never touches agy settings", async (t) => {
  const h = harness({ kind: "claude" });
  match((await quietly(t, h.run)).out, /"verdict":"pass"/);
  eq([h.p.state.calls, h.log.filter((l) => l !== "close")], [[], ["start:claude", "rm"]]);
});

const fault = (error: Error, landed = true) => (mode: string) => (mode === "add" ? { error, landed } : undefined);
const timeout = (code: number) => fault(new RemoteFailure("逾時", `exit ${code}`));
const trusted = (h: ReturnType<typeof harness>) => h.log.filter((l) => l.startsWith("trust"));
const EXISTING = SETTINGS.replace('"/root/workspace"', `"/root/workspace", "${DIR}"`);
const PENDING = `cleanup_pending trust ${DIR}: 信任寫入狀態不明，請人工確認`;
const BLOCKED = [[agent({ agent_status: "blocked" })]];
const cancelled = () => Object.assign(new Error("cancelled"), { name: "AbortError" });

test("F2: pre-existing trust is never removed", async (t) => {
  for (const o of [{}, { turn: async () => ({ state: "done" as const, text: "not json" }) }, { turn: async () => { throw new Error("turn timed out"); } }, { listing: BLOCKED }]) {
    const h = harness({ ...o, settings: EXISTING });
    ok(!/cleanup_pending：trust/.test((await quietly(t, h.run)).out));
    eq([trusted(h), h.p.state.settings, h.log.includes("rm")], [[], EXISTING, !o.listing]);
  }
});

test("F3: timeout 124/137 on the write is uncertain", async (t) => {
  for (const code of [124, 137]) {
    const mv = harness({ fault: timeout(code) });
    match((await quietly(t, mv.run)).out, /cleanup_pending：trust/);
    eq([trusted(mv), mv.p.state.settings, mv.log.includes("start:agy")], [["trust:add:throw", "trust:remove"], SETTINGS, false]);
    const stuck = await quietly(t, harness({ fault: timeout(code), writeCode: (mode) => (mode === "remove" ? 17 : 0) }).run);
    ok(/cleanup_pending：trust/.test(stuck.out) && stuck.lines.includes(`cleanup_pending trust ${DIR}`));
  }
});

for (const [name, error, landed] of [["F4: a disconnect", new RemoteFailure("連線失敗", "ssh 255", true), false], ["F8: a cancel", cancelled(), true]] as const)
  test(`${name} during an undetermined trust write records pending`, async (t) => {
    const h = harness({ fault: fault(error, landed) });
    const { out, lines } = await quietly(t, h.run);
    match(out, /"ok":false.*cleanup_pending：trust、directory/);
    ok(lines.includes(PENDING));
    ok(h.p.state.calls.filter((c) => c[2] === TRUST_READ_SCRIPT).length >= 2);
    eq([h.log.includes("start:agy"), h.log.includes("rm"), h.p.state.settings], [false, false, SETTINGS]);
  });

test("F8: cancel after trust added removes it", async (t) => {
  const h = harness({ turn: async () => { throw cancelled(); } });
  const { out } = await quietly(t, h.run);
  ok(/沒有回覆/.test(out) && !/cleanup_pending/.test(out));
  eq([h.log.filter((l) => l !== "close"), h.p.state.settings], [["trust:add", "start:agy", "trust:remove", "rm"], SETTINGS]);
});

test("F6: a kept pane keeps trust and records pending", async (t) => {
  const kept = harness({ listing: BLOCKED });
  const k = await quietly(t, kept.run);
  match(k.out, /cleanup_pending：trust".*"paneKept":true/);
  ok(k.lines.includes(`cleanup_pending trust ${DIR}: pane 保留中`) && !k.out.includes(ROOT));
  eq([trusted(kept), JSON.parse(kept.p.state.settings).trustedWorkspaces], [["trust:add"], ["/root/workspace", DIR]]);
});

const lockDir = (root: string) => join(root, ".hdb-agy-settings-backups/lock");
const lockGone = async (root: string) => ok(!(await readdir(join(root, ".hdb-agy-settings-backups"))).includes("lock"));

test("F7: concurrent writers keep both entries", async (t) => {
  const names = [NAME, `acme__repo__${"b".repeat(10)}`];
  const { root, file, exec, ok: usable } = await shPod(t, names);
  if (!usable) return;
  await Promise.all(names.map((n) => editRemoteAgyTrust(exec, { root, dir: join(root, n), cardHash: HASH }, true)));
  eq((JSON.parse(await readFile(file, "utf8")).trustedWorkspaces as string[]).slice(1).sort(), names.map((n) => join(root, n)).sort());
  await lockGone(root);
});

test("F7: a fresh lock is kept and times out without writing; a stale lock is reclaimed", async (t) => {
  const { root, dir, file, exec, ok: usable } = await shPod(t);
  if (!usable) return;
  await mkdir(lockDir(root), { recursive: true });
  equal((await writeAdd(exec, root, dir)).code, 19);
  ok((await stat(lockDir(root))).isDirectory());
  equal(await readFile(file, "utf8"), SETTINGS);
  await rejects(editRemoteAgyTrust(exec, { root, dir, cardHash: HASH }, true), (e: unknown) => e instanceof RemoteFailure && e.label === "取得 agy 設定檔鎖逾時" && !e.uncertain);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lockDir(root), old, old);
  equal((await writeAdd(exec, root, dir)).code, 0);
  equal(await readFile(file, "utf8"), "{}");
  await lockGone(root);
});
