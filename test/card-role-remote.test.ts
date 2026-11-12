import test from "node:test";
import { ok, deepEqual as eq, equal, throws, rejects, match } from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { AgentStartPort } from "../src/agent-start.js";
import { validateProfiles } from "../src/agent-pool.js";
import { preflightRoles, remoteReviewerCandidates, validateRoleSnapshot, type RoleContext } from "../src/card-role-assignment.js";
import { parseRemoteTarget, remoteRoleCandidates, remoteRoleTargets, roleTargets, teamMember, type RoleSnapshot } from "../src/card-role-assignment.js";
import { acceptanceReasons } from "../src/coding-workflow.js";
import { buildLogEntry, roleEvent } from "../src/card-events.js";
import { notificationReason } from "../src/card-notify.js";
import { reviewCardPullRequest } from "../src/card-review-wiring.js";
import type { ReviewFlowDeps } from "../src/card-review-flow.js";
import { REMOVE_SCRIPT, RemoteFailure, cardHash, remoteReviewDeps, reviewOnRemote, type RemoteExec, type RemoteReviewDeps } from "../src/remote-checkout.js";
import { planningInstruction, runTeamTask, validateAssignmentPlan, type AssignmentPlan, type OrchestrationPort } from "../src/team-orchestration.js";
import { cardRoleContext, liveAgentList, remoteReviewInjection } from "../src/main.js";
import { HerdrHub, validateMachines } from "../src/machines.js";
import { TeamTaskStore } from "../src/team-task-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRecord } from "../src/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "/home/agy/r";
const profiles = validateProfiles([{ id: "opus", kind: "claude", model: "opus" }, { id: "agy", kind: "agy", model: "gemini", modelFlag: "--model", capabilities: ["review"] }]);
const remoteMachines = [{ id: "pod", kinds: ["agy"] }];
const context: RoleContext = { machineIds: ["pod"], profiles, remoteMachines };
const closed = { machineIds: ["pod"], profiles };
const machine = { id: "pod", ssh: "pod", socket: "/s", cardReview: { root: ROOT, kinds: ["agy"] } };
const reviewerRole = { reviewer: { machine: "pod", agent: "agy" } };

test("preflight: remote reviewer/diagnose/review allowed and frozen; writers, toolless verify, closed machines rejected", () => {
  const snapshot = preflightRoles({ implement: { machine: "local", agent: "claude", model: "opus" }, ...reviewerRole }, context);
  eq([snapshot.candidates.reviewer?.map((p) => p.id), snapshot.remoteMachines], [["agy"], remoteMachines]);
  eq(preflightRoles({ reviewer: { machine: "pod" } }, context).candidates.reviewer?.map((p) => p.kind), ["agy"]);
  const read = preflightRoles({ diagnose: { machine: "pod", agent: "agy" }, review: { machine: "pod" }, ...reviewerRole }, context);
  eq([read.candidates.diagnose?.map((p) => p.id), read.remoteMachines], [["agy"], remoteMachines]);
  validateRoleSnapshot(structuredClone(read));
  for (const role of ["implement", "fixer"]) throws(() => preflightRoles({ [role]: { machine: "pod", agent: "agy" } }, context), /remote 寫入尚未支援/);
  throws(() => preflightRoles({ verify: { machine: "pod", agent: "agy" } }, context), /remote verify 不可用/);
  validateRoleSnapshot(preflightRoles({ verify: { machine: "pod", agent: "agy" } }, { ...context, remoteMachines: [{ id: "pod", kinds: ["agy"], toolchain: true }] }));
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
  for (const label of ["implement：remote 寫入尚未支援", "verify：remote verify 不可用", "reviewer：machine 未開放卡片 review"])
    equal(notificationReason({ event: "failed", text: `失敗：autopick_stopped；原因：卡片角色指定無效：${label}：machine pod（x）；SECRET`, time: "", eventId: "x" }), `卡片角色指定無效：${label}`);
  const identity = { role: "reviewer", agent: "agy", machine: "a".repeat(32), model: "m".repeat(80), taskId: "t".repeat(64), round: 1_000_000, source: "card" as const, selectionSources: { machine: "card", agent: "card", model: "card" } as const, modelEvidence: "launch" as const };
  const built = buildLogEntry(roleEvent(identity, "2026-11-11T00:00:00Z"));
  ok(built.ok && Array.from(built.entry.text).length <= 300 && /machine=a{32}/.test(built.entry.text));
  equal(buildLogEntry(roleEvent({ ...identity, role: "implement" }, "2026-11-11T00:00:00Z")).ok, false);
  const inTask = (codingRole: "review" | "implement") => buildLogEntry(roleEvent({ ...identity, role: "r".repeat(64), assignmentId: "r".repeat(64), codingRole }, "2026-11-11T00:00:00Z"));
  const read = inTask("review");
  ok(read.ok && Array.from(read.entry.text).length <= 300 && !inTask("implement").ok);
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

const lead = { ...agent(), pane_id: "w1:p1", terminal_id: "lead", workspace_id: "w1", agent: "codex", machine: undefined } as AgentRecord;
const pod = remoteRoleTargets(context, "w1");
const C = { prior: [], findingIds: [], artifactIds: [] };
const plan = (workerPaneId: string, role = "review"): AssignmentPlan => ({ assignments: [{ id: "a1", workerPaneId, instruction: "x", coding: { role: role as "review", access: role === "implement" ? "write" : "read", writeScope: role === "implement" ? ["src/"] : [], artifactRefs: [], findingRefs: [] } }] });
const ctx2: RoleContext = { ...context, remoteMachines: [{ id: "pod", kinds: ["agy"], toolchain: true }] };

test("Lead candidates and targets: pod diagnose/review; verify unavailable without toolchain", () => {
  const listed = remoteRoleCandidates(context);
  eq(listed.map((c) => [c.machine, c.kind, c.profileId, c.role, c.available, c.reason]), [["pod", "agy", "agy", "diagnose", true, undefined], ["pod", "agy", "agy", "review", true, undefined], ["pod", "agy", "agy", "verify", false, "no toolchain on machine"]]);
  eq(pod.map((t) => [t.pane_id, t.machine, t.roleTarget, t.workspace_id]), [["remote:pod:diagnose:agy", "pod", "diagnose", "w1"], ["remote:pod:review:agy", "pod", "review", "w1"]]);
  eq([remoteRoleTargets(ctx2, "w1").map((t) => t.roleTarget), remoteRoleCandidates(closed)], [["diagnose", "review", "verify"], []]);
  eq(parseRemoteTarget("remote:pod:review:agy"), { machine: "pod", role: "review", profileId: "agy" });
  for (const bad of ["remote:pod:implement:agy", "remote:pod:review:../x", "remote:-pod:review:agy", "remote:pod:review:a b", "remote:pod:review:a\nb", "role:review:agy"]) equal(parseRemoteTarget(bad), undefined);
  ok(!roleTargets(preflightRoles({ diagnose: { machine: "pod" }, implement: { agent: "claude" } }, context), "w1").some((t) => t.roleTarget === "diagnose"));
  match(planningInstruction({ taskId: "t", prompt: "p", lead, workers: [], coding: true, remoteRoles: listed }), /Remote in-task role candidates.*never pushes.*"role":"verify".*"available":false/);
});

test("plan validation; ISSUE-150 forces in-task review to the remote reviewer machine; gate unchanged", () => {
  const v = (target: string, role?: string, s?: RoleSnapshot) => () => validateAssignmentPlan(plan(target, role), lead, [{ ...lead, pane_id: "w1:p2", agent: "agy" }, ...pod], C, s);
  v("remote:pod:review:agy")();
  v("remote:pod:diagnose:agy", "diagnose")();
  for (const role of ["diagnose", "implement"]) throws(v("remote:pod:review:agy", role), /只能用於 review/);
  throws(v("remote:pod:verify:agy", "verify"), /not in the Team roster/);
  const s = preflightRoles(reviewerRole, context);
  v("remote:pod:review:agy", "review", s)();
  v("w1:p2", "diagnose", s)();
  throws(v("w1:p2", "review", s), /派工不符：machine 預期 pod，實際 local/);
  match(planningInstruction({ taskId: "t", prompt: "p", lead, workers: pod, coding: true, roleSnapshot: s }), /In-task review must use a remote:pod:review/);
  ok(acceptanceReasons({ baseline: {}, artifacts: [], findings: [] } as never, { fingerprint: "v", deliveryPaths: [] } as never, []).includes("no passing review for the current version"));
});

test("pod Worker is a Team member only via a same-machine remote target; store reloads it", () => {
  const w = agent();
  eq([teamMember(w, "w1", pod), teamMember(w, "w1", []), teamMember({ ...w, workspace_id: "w9" }, "w1", pod), teamMember({ ...lead, pane_id: "w1:p5" }, "w1", [])], [true, false, false, true]);
  ok(!teamMember(agent({ machine: "other", pane_id: "other:w3:p2", workspace_id: "other:w3" }), "w1", pod));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hdb-remote-store-"));
  const now = new Date().toISOString();
  const add = (id: string, pane: string) => store.update(id, "assigned", (t) => void t.assignments.push({ plan: { id: "a1", workerPaneId: pane, instruction: "x", dependsOn: [] }, state: "working", createdAt: now, updatedAt: now, agent: w }));
  const store = new TeamTaskStore(root);
  store.create({ taskId: "r", lead, prompt: "p", workers: pod });
  add("r", "remote:pod:review:agy");
  const loaded = new TeamTaskStore(root).get("r");
  eq([loaded.roster.map((r) => r.pane_id), loaded.assignments[0]?.agent?.pane_id], [pod.map((t) => t.pane_id), "pod:w3:p2"]);
  store.create({ taskId: "l", lead, prompt: "p", workers: [{ ...lead, pane_id: "w1:p2" }] });
  throws(() => add("l", "w1:p2"), /workspace mismatch/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runTeamTask: pod Worker accepted; afterTurn failure fails without crediting; cleanup runs", async () => {
  for (const broken of [false, true]) {
    const marker = (p: string, k: string) => new RegExp(`${k} marker \\(\\w+ line\\): (BRIDGE_\\w+)`).exec(p)?.[1];
    const prompts = new Map<string, string>();
    const [done, cleanups]: string[][] = [[], []];
    let planned = false;
    const reply = (target: string, p: string) =>
      target !== lead.pane_id ? '{"codingResult":{"kind":"review","verdict":"pass","findings":[]}}' : !p.includes("Do not modify files while planning") ? "s"
        : JSON.stringify({ assignments: planned ? [] : ((planned = true), plan("remote:pod:review:agy").assignments.map(({ coding: c, ...a }) => ({ ...a, ...c }))) });
    const port: OrchestrationPort = {
      promptAgent: async (t, text) => void prompts.set(t, text),
      waitAgent: async (t) => (t === lead.pane_id ? lead : agent()),
      readAgent: async (t) => (prompts.has(t) ? `${marker(prompts.get(t)!, "Opening")}\n${reply(t, prompts.get(t)!)}\n${marker(prompts.get(t)!, "Closing")}` : "history"),
    };
    const hooks = { findingIds: () => [], artifactIds: () => [], evidenceSummary: () => ({}), onAssignmentStart: () => {}, onAssignmentDone: (a: { id: string }) => void done.push(a.id), assess: () => ({ reasons: [], fingerprint: "v" }) };
    const fail = async () => { if (broken) throw new Error("遠端角色失敗：快照已作廢"); };
    const result = await runTeamTask({ taskId: "t", prompt: "p", lead, workers: pod, coding: true, timeoutMs: 2000, codingHooks: hooks, acquireWorker: async () => ({ agent: agent(), continuity: "new-session", cleanup: async (r) => void cleanups.push(r!), afterTurn: fail }) }, port, () => {});
    const report = result.reports.find((r) => r.assignmentId === "a1")!;
    eq([report.state, done, cleanups, broken ? /^遠端角色失敗：快照已作廢/.test(report.blocker!) : true], [broken ? "failed" : "done", broken ? [] : ["a1"], ["completed"], true]);
  }
});

test("machines config: cardReview.toolchain is an optional boolean", () => {
  const base = { id: "pod", ssh: "pod", socket: "/s" };
  const cr = (toolchain: unknown) => validateMachines([{ ...base, cardReview: { root: ROOT, kinds: ["agy"], toolchain } }])[0]?.cardReview;
  eq([cr(true), cr(false)], [{ root: ROOT, kinds: ["agy"], toolchain: true }, { root: ROOT, kinds: ["agy"] }]);
  throws(() => cr("yes"), /cardReview/);
  eq(cardRoleContext({ config: { machines: [{ id: "pod", cardReview: { kinds: ["agy"], toolchain: true } }], agentProfiles: profiles } }).remoteMachines, ctx2.remoteMachines);
});
