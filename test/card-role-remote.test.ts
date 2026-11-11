import test from "node:test";
import { ok, deepEqual as eq, equal, throws, rejects, match } from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { AgentStartPort } from "../src/agent-start.js";
import { validateProfiles } from "../src/agent-pool.js";
import { preflightRoles, remoteReviewerCandidates, validateRoleSnapshot, type RoleContext } from "../src/card-role-assignment.js";
import { buildLogEntry, roleEvent } from "../src/card-events.js";
import { notificationReason } from "../src/card-notify.js";
import { reviewCardPullRequest } from "../src/card-review-wiring.js";
import type { ReviewFlowDeps } from "../src/card-review-flow.js";
import { REMOVE_SCRIPT, RemoteFailure, cardHash, remoteReviewDeps, reviewOnRemote, type RemoteExec, type RemoteReviewDeps } from "../src/remote-checkout.js";
import { planningInstruction } from "../src/team-orchestration.js";
import { cardRoleContext, liveAgentList, remoteReviewInjection } from "../src/main.js";
import { HerdrHub } from "../src/machines.js";
import type { AgentRecord } from "../src/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "/home/agy/r";
const profiles = validateProfiles([{ id: "opus", kind: "claude", model: "opus" }, { id: "agy", kind: "agy", model: "gemini", modelFlag: "--model", capabilities: ["review"] }]);
const remoteMachines = [{ id: "pod", kinds: ["agy"] }];
const context: RoleContext = { machineIds: ["pod"], profiles, remoteMachines };
const closed = { machineIds: ["pod"], profiles };
const machine = { id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } };
const reviewerRole = { reviewer: { machine: "pod", agent: "agy" } };

test("preflight: remote reviewer allowed on an opened machine and frozen; other roles and closed machines rejected", () => {
  const snapshot = preflightRoles({ implement: { machine: "local", agent: "claude", model: "opus" }, ...reviewerRole }, context);
  eq([snapshot.candidates.reviewer?.map((p) => p.id), snapshot.remoteMachines], [["agy"], remoteMachines]);
  eq(preflightRoles({ reviewer: { machine: "pod" } }, context).candidates.reviewer?.map((p) => p.kind), ["agy"]);
  for (const role of ["implement", "fixer", "diagnose", "review", "verify"])
    throws(() => preflightRoles({ [role]: { machine: "pod", agent: "agy" } }, context), /^(implement|fixer)$/.test(role) ? /remote 寫入尚未支援/ : /remote 目前只支援 reviewer/);
  for (const [ctx, reviewer] of [[closed, reviewerRole.reviewer], [context, { machine: "pod", agent: "claude" }]] as const)
    throws(() => preflightRoles({ reviewer }, ctx), (e: unknown) => /machine 未開放卡片 review/.test(String(e)) && !/卡片流程尚未支援/.test(String(e)));
  throws(() => preflightRoles({ reviewer: { machine: "nope" } }, context), /不存在 machine nope/);
});

test("frozen snapshot re-validation: dropped or tampered remoteMachines rejected; local snapshots unchanged", () => {
  const snapshot = preflightRoles(reviewerRole, context);
  validateRoleSnapshot(structuredClone(snapshot));
  for (const remote of [undefined, [{ id: "pod", kinds: ["bash"] }], [{ id: "local", kinds: ["agy"] }], [{ id: "pod", kinds: ["agy"], root: "/" }], [], [...remoteMachines, { id: "other", kinds: ["agy"] }]])
    throws(() => validateRoleSnapshot({ ...snapshot, remoteMachines: remote } as never));
  const local = preflightRoles({ reviewer: { agent: "agy" } }, context);
  ok(!("remoteMachines" in local));
  validateRoleSnapshot(local);
});

test("notifications carry fixed labels; v2 record allows remote machine only for reviewer within 300", () => {
  for (const label of ["implement：remote 寫入尚未支援", "diagnose：remote 目前只支援 reviewer", "reviewer：machine 未開放卡片 review"])
    equal(notificationReason({ event: "failed", text: `失敗：autopick_stopped；原因：卡片角色指定無效：${label}：machine pod（x）；SECRET`, time: "", eventId: "x" }), `卡片角色指定無效：${label}`);
  const identity = { role: "reviewer", agent: "agy", machine: "a".repeat(32), model: "m".repeat(80), taskId: "t".repeat(64), round: 1_000_000, source: "card" as const, selectionSources: { machine: "card", agent: "card", model: "card" } as const, modelEvidence: "launch" as const };
  const built = buildLogEntry(roleEvent(identity, "2026-11-11T00:00:00Z"));
  ok(built.ok && Array.from(built.entry.text).length <= 300 && /machine=a{32}/.test(built.entry.text));
  equal(buildLogEntry(roleEvent({ ...identity, role: "implement" }, "2026-11-11T00:00:00Z")).ok, false);
});

test("Lead roster lists remote reviewers with machine; without remote config context and prompt are unchanged", () => {
  const candidates = remoteReviewerCandidates(context);
  eq(candidates, [{ machine: "pod", kind: "agy", profileId: "agy", model: "gemini" }]);
  eq(remoteReviewerCandidates(closed), []);
  ok(!("remoteMachines" in cardRoleContext({ config: { machines: [{ id: "pod" }], agentProfiles: profiles } })));
  eq(cardRoleContext({ config: { machines: [machine], agentProfiles: profiles } }).remoteMachines, remoteMachines);
  const base = { taskId: "t", prompt: "p", lead: { pane_id: "w1:p1", agent: "codex" } as AgentRecord, workers: [], coding: true };
  const plain = planningInstruction(base);
  ok(!/Remote card reviewer/.test(plain) && planningInstruction({ ...base, remoteReviewers: [] }) === plain);
  match(planningInstruction({ ...base, remoteReviewers: candidates }), /Remote card reviewer candidates.*"machine":"pod".*"kind":"agy"/);
  match(planningInstruction({ ...base, roleSnapshot: preflightRoles(reviewerRole, context) }), /runs on machine pod/);
  match(planningInstruction({ ...base, roleSnapshot: preflightRoles({ implement: { agent: "claude" } }, context) }), /Role candidates \(machine=local/);
});

const card: Card = { id: "REQ-1", type: "requirement", status: "done", title: "SECRET", version: 1, created: "", updated: "", body: "# x\n\n## 描述\nSECRET\n\n## 驗收條件\n- ok\n", roles: reviewerRole };
const agent = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ pane_id: "pod:w3:p2", terminal_id: "pod:t", workspace_id: "pod:w3", tab_id: "", agent: "agy", agent_status: "idle", machine: "pod", ...patch });
const fixed = (label: string) => (e: unknown) => String(e).includes(`遠端 review 失敗：${label}`) && !/pod|secret|SECRET/.test(String(e));
const tail = ["close:pod:w3", "exec:rm"];

function harness(o: { origin?: string; head?: string; throwOn?: string; listing?: Array<AgentRecord[] | Error>; closeFails?: boolean; ws?: () => { workspaceId: string; paneId: string } } = {}) {
  const log: string[] = [];
  const local: string[] = [];
  const recorded: unknown[] = [];
  const hash = cardHash("REQ-1");
  const dir = `${ROOT}/acme__repo__${hash}`;
  let cloned = false;
  const exec: RemoteExec = async (argv) => {
    const j = argv.join(" ");
    // timeout 檢查、目錄／marker 檢查與 marker 寫入是前置作業，不進流程 log。
    const removal = argv[0] === "sh" && argv[2] === REMOVE_SCRIPT;
    if (removal && cloned) log.push("exec:rm");
    if (!removal && !["timeout", "test", "cat", "sh", "realpath"].includes(argv[0]!)) log.push(`exec:${["clone", "fetch"].find((a) => argv.includes(a)) ?? "git"}`);
    if (argv.includes("clone")) cloned = true;
    if (removal) return { code: 0, stdout: "" };
    if (o.throwOn && j.includes(o.throwOn)) throw new RemoteFailure("逾時", "pod secret", true);
    if (argv[0] === "realpath") return { code: 0, stdout: `${argv[2]}\n` };
    if (argv[0] === "test" && argv[1] === "-L") return { code: 1, stdout: "" };
    if (argv[0] === "cat") return { code: 0, stdout: `hdb-card-review-checkout:v1:${hash}\n` };
    if (argv[0] === "test") return { code: cloned && argv[2] === dir ? 0 : 1, stdout: "" };
    return { code: 0, stdout: j.includes("rev-parse") ? (o.head ?? HEAD) : "" };
  };
  const listing = [...(o.listing ?? [[agent()]])];
  const port: AgentStartPort = {
    request: async (method, params) => {
      log.push(method);
      for (const [k, v] of Object.entries(params ?? {})) if (k.endsWith("_id")) match(String(v), /^pod:/);
      if (method === "pane.layout") return { layout: { panes: [{ pane_id: "pod:w3:p1", rect: { width: 200, height: 40 } }] } };
      if (method === "pane.split") return { pane: { pane_id: "pod:w3:p2", workspace_id: "pod:w3", terminal_id: "pod:t" } };
      return method === "pane.get" ? { pane: { terminal_id: "pod:t" } } : { read: { text: "Do you trust this folder?" } };
    },
    listAgentsWithWorkspaceNames: async () => {
      log.push("fresh");
      const next = listing.length > 1 ? listing.shift()! : listing[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const remote: RemoteReviewDeps = {
    machine: (id) => (id === "pod" ? machine : undefined),
    exec: () => exec,
    originUrl: async () => o.origin ?? "git@github.com:acme/repo.git\n",
    createWorkspace: async (_m, cwd) => (log.push(`create:${cwd.startsWith(`${ROOT}/acme__repo__`)}`), o.ws?.() ?? { workspaceId: "pod:w3", paneId: "pod:w3:p1" }),
    closeWorkspace: async (m, id) => {
      log.push(`close:${id}`);
      if (o.closeFails) throw new Error("gone pod stderr SECRET");
    },
    closeWorkspaceLabeled: async (m, label) => (log.push(`closeLabeled:${m}:${/^review-[0-9a-f]{10}-[0-9a-f]{8}$/.test(label)}`), 1),
    panePort: () => port,
    startAgent: async (input) => (log.push(`start:${input.kind}@${input.paneId}`), agent({ agent_status: "working" })),
  };
  const spy = (name: string) => async () => { local.push(name); throw new Error(name); };
  const flow: ReviewFlowDeps = {
    panePort: { request: spy("request"), listAgentsWithWorkspaceNames: spy("list") },
    startAgent: spy("start"),
    fingerprint: spy("fingerprint"),
    runTurn: async (a) => (log.push(`turn:${a.machine}`), { state: "done", text: JSON.stringify({ verdict: "pass", criteria: [{ index: 1, status: "met" }], findings: [] }) }),
    recordRoleStrict: (identity) => void recorded.push(identity),
    readyTimeoutMs: 200, readyPollMs: 2, timeoutMs: 1000,
  };
  const run = () => reviewOnRemote(remote, flow, "pod", {
    card, round: 1, scope: "whole", pr: { number: 7, headSha: HEAD }, material: { files: ["x.ts"], diff: "diff --git a/x.ts b/x.ts\n+x\n" },
    author: { agent: "claude", paneId: "w1:p1", workspaceId: "w1" }, worktreePath: "/l", launch: profiles[1]!, prRepo: "acme/repo", localWorktree: "/l",
  });
  return { run, log, local, recorded, remote, flow };
}

test("remote review: clone, remote workspace, fresh identity, reviewer on pod, full cleanup, nothing local", async () => {
  const h = harness();
  const result = await h.run();
  ok(result.ok && result.batch.verdict === "pass" && result.closed);
  for (const entry of ["exec:clone", "create:true", "start:agy@pod:w3:p2", "turn:pod", "fresh"]) ok(h.log.includes(entry), entry);
  eq([h.log.slice(-3), h.local], [["pane.close", ...tail], []]);
  const built = buildLogEntry(roleEvent(h.recorded[0] as never, "2026-11-11T00:00:00Z"));
  ok(built.ok && /reviewer.*machine=pod.*ss=CC/.test(built.entry.text) && !/SECRET/.test(built.entry.text));
});

test("origin not the PR's GitHub repo is rejected before a remote call", async () => {
  for (const origin of ["https://gitlab.com/acme/repo", "https://github.com/evil/repo", "/srv/repo"]) {
    const h = harness({ origin });
    await rejects(h.run(), /origin 不是與 PR 相同的 GitHub repo/);
    eq([...h.log, ...h.local], []);
  }
});

test("checkout failures use fixed labels; sha mismatch removes the clone, uncertain timeout keeps it as cleanup_pending; never local", async () => {
  const sha = harness({ head: "f".repeat(40) });
  await rejects(sha.run(), fixed("HEAD 與 PR head 不符"));
  equal(sha.log.at(-1), "exec:rm");
  const timeout = harness({ throwOn: "fetch" });
  await rejects(timeout.run(), (e: unknown) => fixed("逾時")(e) && /cleanup_pending：directory/.test(String(e)));
  ok(!timeout.log.includes("exec:rm"));
  for (const h of [sha, timeout]) ok(!h.log.some((l) => /^(create|start)/.test(l)) && !h.local.length);
});

test("workspace.create failure or unprefixed id closes by label and removes the checkout", async () => {
  for (const ws of [() => { throw new Error("pod timeout"); }, () => ({ workspaceId: "w3", paneId: "w3:p1" })]) {
    const h = harness({ ws });
    await rejects(h.run(), fixed("workspace 失敗"));
    eq(h.log.slice(-2), ["closeLabeled:pod:true", "exec:rm"]);
  }
});

test("readiness listing failure is inconclusive with scrubbed reason; identity mismatch stops before the prompt; always cleaned, never local", async () => {
  const down = harness({ listing: [new Error("machine pod unreachable")] });
  const result = await down.run();
  ok(result.ok && result.batch.verdict === "inconclusive" && /讀取 Agent 清單失敗$/.test(result.inconclusiveReason ?? ""));
  for (const patch of [{ workspace_id: "pod:w9" }, { machine: "local" }]) {
    const h = harness({ listing: [[agent()], [agent(patch)]] });
    await rejects(h.run(), fixed("身分不符"));
    ok(!h.log.some((l) => l.startsWith("turn")) && !h.recorded.length);
    for (const x of [h, down]) eq([x.log.slice(-2), x.local], [tail, []]);
  }
});

test("blocked at start keeps pane, workspace and checkout; cleanup failure only adds cleanup_pending", async () => {
  const blocked = harness({ listing: [[agent({ agent_status: "blocked" })]] });
  const kept = await blocked.run();
  ok(kept.ok && kept.paneKept && !blocked.log.some((l) => /^(close|exec:rm|pane\.close)/.test(l)));
  const failing = harness({ closeFails: true });
  const result = await failing.run();
  ok(result.ok && result.batch.verdict === "pass" && /cleanup_pending：workspace/.test(result.closeNote ?? "") && failing.log.at(-1) === "exec:rm");
  for (const whole of [kept, result]) ok(!/SECRET|pod|stderr/.test(JSON.stringify(whole)), JSON.stringify(whole)); // 整份結果，不只單一欄位
});

test("wiring: frozen remote snapshot needs the running config to open the machine and a remote port before fetching material", async () => {
  const h = harness();
  const author = { pane_id: "w7:p1", terminal_id: "t", workspace_id: "w7", agent: "claude" } as AgentRecord;
  let fetched = 0;
  const run = (extra: object) => reviewCardPullRequest({
    worktrees: { active: () => ({ cardId: card.id, workspaceId: "w7", sourceWorkspaceId: "w1", path: "/l", repoPath: "/l/repo", branch: "b", createdAt: "" }) },
    prs: { forCard: () => [{ cardId: card.id, repo: "acme/repo", number: 7, url: "", headSha: HEAD, openedAt: "", state: "OPEN" as const }] },
    assignments: { forCard: () => [{ taskId: "t" }] },
    taskLead: () => author,
    taskRoleSnapshot: () => preflightRoles(reviewerRole, context),
    policy: () => ({ status: "loaded" as const, file: "/p", policy: { default: "L1" as const, projects: {} } }),
    listAgents: async () => [author],
    fetchMaterial: async () => (fetched++, { headSha: HEAD, files: ["x.ts"], diff: "diff --git a/x.ts b/x.ts\n+x\n" }),
    flow: h.flow,
    ...extra,
  }, card, { round: 1 });
  await rejects(run({ roleContext: closed, remote: h.remote }), (e: unknown) => /machine 未開放卡片 review/.test(String(e)) && !/pod/.test(String(e)));
  await rejects(run({ roleContext: context }), /remote reviewer 介面不存在/);
  equal(fetched as number, 0);
  // 舊快照允許 agy，目前配置只開放 codex：啟動前拒絕，固定標籤、不啟動任何東西。
  await rejects(run({ roleContext: { ...context, remoteMachines: [{ id: "pod", kinds: ["codex"] }] }, remote: h.remote }), (e: unknown) => /machine 目前未開放這個 agent 種類/.test(String(e)) && !/pod|agy/.test(String(e)));
  eq([...h.log, ...h.local], []);
  ok((await run({ roleContext: context, remote: h.remote })).result.ok && fetched === 2 && h.log.includes("turn:pod") && !h.local.length);
});

test("main remoteReviewDeps: workspace.create parsing, label close, pane routing, startAgent machine from paneId, fresh listing", async () => {
  const calls: string[] = [];
  const a = agent({ pane_id: "pod:w3:p1" });
  const hub = {
    request: async (method: string, p?: Record<string, unknown>) => (calls.push(`req:${method}:${p?.pane_id}`), {}),
    requestOn: async (m: string, method: string, p?: Record<string, unknown>) => {
      calls.push(`on:${m}:${method}:${p?.workspace_id ?? ""}`);
      if (method === "workspace.list") return { workspaces: [{ workspace_id: "pod:w3", label: "pod:review-x" }, { workspace_id: "pod:w4", label: "other" }] };
      return p?.cwd === "/bad" ? { workspace: {} } : { workspace: { workspace_id: "pod:w3" }, root_pane: { pane_id: "pod:w3:p1" } };
    },
    freshAgentsOn: async (m: string) => (calls.push(`fresh:${m}`), [a]),
    machineConfig: () => machine,
  };
  const deps = remoteReviewDeps(hub as never);
  eq(await deps.createWorkspace("pod", "/d", "review-x"), { workspaceId: "pod:w3", paneId: "pod:w3:p1" });
  await rejects(deps.createWorkspace("pod", "/bad", "review-x"), /缺少 workspace 或 pane id/);
  await deps.closeWorkspaceLabeled("pod", "review-x");
  ok(calls.includes("on:pod:workspace.close:pod:w3") && !calls.includes("on:pod:workspace.close:pod:w4"));
  await deps.panePort("pod").request("pane.get", { pane_id: "pod:w3:p2" });
  equal((await deps.startAgent({ paneId: "pod:w3:p1", kind: "agy", name: "r", cwd: "/d" })).pane_id, "pod:w3:p1");
  ok(calls.includes("req:pane.get:pod:w3:p2") && calls.includes("req:agent.start:pod:w3:p1") && calls.includes("fresh:pod") && deps.machine("pod") === machine);
});

test("main wiring: remote interface only with a HerdrHub; remote reviewers read the fresh listing, local agents the usual one", async () => {
  const seen: string[] = [];
  const listing = (tag: string) => async () => (seen.push(tag), [agent()]);
  const hub = new HerdrHub([machine], "/nonexistent/l.sock", 100, 10, () => undefined, () => "/nonexistent/t.sock");
  hub.listAgentsWithWorkspaceNames = listing("cached");
  hub.freshAgentsOn = async (m) => (seen.push(`fresh:${m}`), [agent()]);
  const plain = { listAgentsWithWorkspaceNames: listing("plain") } as never;
  // 沒有 HerdrHub（單機）：不注入 remote，行為與以前相同。
  eq(remoteReviewInjection(plain), {});
  eq(Object.keys(remoteReviewInjection(hub)), ["remote"]);
  equal(remoteReviewInjection(hub).remote?.machine("pod")?.cardReview?.root, ROOT);
  const local = agent({ pane_id: "w1:p1", machine: undefined });
  await liveAgentList(hub, local);
  await liveAgentList(hub, agent());
  await liveAgentList(plain, agent());
  await liveAgentList(plain, local);
  eq(seen, ["cached", "fresh:pod", "plain", "plain"]);
});
