import test, { type TestContext } from "node:test";
import { ok, deepEqual as eq, equal, rejects, match, fail } from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

/** pod 上的設定檔放在記憶體；寫入腳本照 argv 解碼。 */
type Fault = { error: RemoteFailure; landed: boolean };
function pod(o: { writeCode?: (mode: string) => number; read?: () => { code: number; stdout: string }; settings?: string; fault?: (mode: string) => Fault | undefined } = {}) {
  const state = { settings: o.settings ?? SETTINGS, calls: [] as string[][] };
  const exec: RemoteExec = async (argv) => {
    state.calls.push(argv);
    if (argv[2] === TRUST_READ_SCRIPT) return o.read?.() ?? { code: 0, stdout: `${sha(state.settings)}\n${state.settings}` };
    const fault = o.fault?.(argv[8]!);
    if (fault) {
      if (fault.landed) state.settings = Buffer.from(argv[10]!, "base64").toString("utf8");
      throw fault.error;
    }
    const code = o.writeCode?.(argv[8]!) ?? 0;
    if (!code) state.settings = Buffer.from(argv[10]!, "base64").toString("utf8");
    return { code, stdout: "" };
  };
  return { state, exec };
}

test("ssh argv is fixed and compared element by element; values never enter the script text", async () => {
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

test("unsafe values, a dir outside root and a bad hash are refused before a remote call", async () => {
  for (const input of [
    { root: ROOT, dir: `${ROOT}/../etc`, cardHash: HASH },
    { root: ROOT, dir: `${ROOT}/a b`, cardHash: HASH },
    { root: ROOT, dir: `${DIR}/sub`, cardHash: HASH },
    { root: "relative", dir: "relative/x", cardHash: HASH },
    { root: ROOT, dir: DIR, cardHash: "$(id)" },
  ]) {
    const p = pod();
    await rejects(editRemoteAgyTrust(p.exec, input, true), RemoteFailure, JSON.stringify(input));
    eq(p.state.calls, []);
  }
});

test("bad read, refusal or malformed file never writes; a changed file is reread", async () => {
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

test("real sh, fake HOME: backups 600 ≤5, mode kept, byte-for-byte restore; symlink/marker/race refused", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agy-trust-sh-")));
  const home = join(base, "home");
  const root = join(base, "root");
  const dir = join(root, NAME);
  const file = join(home, ".gemini/antigravity-cli/settings.json");
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
  await writeFile(join(dir, ".git/hdb-card-review"), MARKER);
  await writeFile(file, SETTINGS, { mode: 0o640 });
  const exec: RemoteExec = (argv) =>
    new Promise((resolve) => execFile(argv[0]!, argv.slice(1), { env: { ...process.env, HOME: home } }, (e, stdout) => resolve({ code: e ? Number(e.code) : 0, stdout })));
  if ((await exec(["sh", "-c", "command -v sha256sum && command -v base64"], 5000)).code) return t.skip("no sha256sum/base64");
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
  const write = (r: string, d: string, marker = MARKER, hash = sha(SETTINGS)) =>
    exec(["sh", "-c", TRUST_WRITE_SCRIPT, "sh", r, d, d.slice(r.length + 1), marker, "add", hash, Buffer.from("{}").toString("base64")], 5000);
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

// reviewOnRemote 的信任生命週期：只看 trust／start／rm 的順序與結果字串。
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
    machine: () => ({ id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } }),
    exec: () => exec,
    originUrl: async () => "git@github.com:acme/repo.git",
    createWorkspace: async () => ({ workspaceId: "pod:w3", paneId: "pod:w3:p1" }),
    closeWorkspace: async () => void log.push("close"),
    closeWorkspaceLabeled: async () => 1,
    panePort: () => port,
    startAgent: async (input) => (log.push(`start:${input.kind}`), agent({ agent_status: "working", agent: input.kind })),
  };
  const recorded: unknown[] = [];
  const local = async () => fail("local") as never;
  const flow: ReviewFlowDeps = {
    panePort: {} as never,
    startAgent: local,
    fingerprint: local,
    runTurn: async () => (o.turn ? o.turn() : { state: "done", text: JSON.stringify({ verdict: "pass", criteria: [{ index: 1, status: "met" }], findings: [] }) }),
    recordRoleStrict: (identity) => void recorded.push(identity),
    readyTimeoutMs: 200, readyPollMs: 2, timeoutMs: 200,
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

test("agy trust: added before start, removed before rm on success, failure, throw, timeout, uncertain", async (t) => {
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

test("paneKept keeps trust; removal failure is cleanup_pending：trust; add failure changes nothing", async (t) => {
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

test("a reviewer that is not agy never touches the agy settings", async (t) => {
  const h = harness({ kind: "claude" });
  match((await quietly(t, h.run)).out, /"verdict":"pass"/);
  eq([h.p.state.calls, h.log.filter((l) => l !== "close")], [[], ["start:claude", "rm"]]);
});

const fault = (code: number, uncertain = false, landed = true) => (mode: string) => (mode === "add" ? { error: new RemoteFailure("逾時", `exit ${code}`, uncertain), landed } : undefined);
const trusted = (h: ReturnType<typeof harness>) => h.log.filter((l) => l.startsWith("trust"));

test("F2: a trust entry that already existed is never removed, on success, failure and timeout", async (t) => {
  const settings = SETTINGS.replace('"/root/workspace"', `"/root/workspace", "${DIR}"`);
  for (const turn of [undefined, async () => ({ state: "done" as const, text: "not json" }), async () => { throw new Error("turn timed out"); }]) {
    const h = harness({ turn, settings });
    ok(!/cleanup_pending：trust/.test((await quietly(t, h.run)).out));
    eq([trusted(h), h.p.state.settings, h.log.includes("rm")], [[], settings, true]);
  }
});

test("F3: remote timeout 124/137 on the trust write is uncertain: cleanup tries to remove, a failed removal is cleanup_pending：trust", async (t) => {
  for (const code of [124, 137]) {
    const mv = harness({ fault: fault(code) });
    match((await quietly(t, mv.run)).out, /cleanup_pending：trust/, `${code}`);
    eq([trusted(mv), mv.p.state.settings, mv.log.includes("start:agy")], [["trust:add:throw", "trust:remove"], SETTINGS, false], `${code}`);
    const stuck = harness({ fault: fault(code), writeCode: (mode) => (mode === "remove" ? 17 : 0) });
    const failed = await quietly(t, stuck.run);
    ok(/cleanup_pending：trust/.test(failed.out) && failed.lines.includes(`cleanup_pending trust ${DIR}`), `${code}`);
  }
});

test("F4: an uncertain trust write (disconnect) never starts the reviewer and is never treated as cleanly cleaned", async (t) => {
  const h = harness({ fault: fault(255, true, false) });
  const { out, lines } = await quietly(t, h.run);
  match(out, /"ok":false.*cleanup_pending：trust、directory/);
  ok(lines.includes(`cleanup_pending trust ${DIR}: 信任寫入狀態不明，已嘗試移除，請人工確認 agy 設定檔`));
  ok(h.p.state.calls.filter((c) => c[2] === TRUST_READ_SCRIPT).length >= 2, "cleanup reread the settings to attempt removal");
  ok(!h.log.includes("start:agy") && !h.log.includes("rm"), "no reviewer; directory kept while the write may still run");
});
