import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLaunchSpec, resolveLaunch } from "../src/agent-launch-spec.js";
import { levelArgsFor } from "../src/cli-adapter.js";
import {
  parseAgentStartArgs,
  runAgentStart,
  type AgentStartDeps,
} from "../src/agent-launch.js";
import type { AgentStartPort } from "../src/agent-start.js";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";
import type { AgentRecord } from "../src/types.js";

const selected = { machine: "local", kind: "claude" };
function resolve(
  spec: string,
  sel: { machine: string; kind?: string } = selected,
) {
  const parsed = parseLaunchSpec(spec);
  assert.ok(parsed.ok, spec);
  return resolveLaunch(parsed.value, sel, ["agy-pod"]);
}
function error(spec: string, sel?: { machine: string; kind?: string }): string {
  const result = resolve(spec, sel);
  assert.ok(!result.ok, spec);
  return result.error;
}

test("example specs resolve; omitted segments follow the selected Agent or CLI default", () => {
  const cases: Array<[string, string]> = [
    ["claude", "local claude - - "],
    [":codex", "local codex - - "],
    ["::opus", "local claude opus - --model opus"],
    [
      ":codex:gpt-6.1-sol:medium",
      "local codex gpt-6.1-sol medium -m gpt-6.1-sol -c model_reasoning_effort=medium",
    ],
    [":::high", "local claude - high --effort high"],
    [
      "agy-pod:codex:gpt-6.1-sol:medium",
      "agy-pod codex gpt-6.1-sol medium -m gpt-6.1-sol -c model_reasoning_effort=medium",
    ],
    ["", "local claude - - "],
  ];
  for (const [spec, expected] of cases) {
    const r = resolve(spec);
    assert.ok(r.ok, spec);
    const v = r.value;
    const line = `${v.machine} ${v.kind} ${v.model ?? "-"} ${v.level ?? "-"} ${v.args.join(" ")}`;
    assert.equal(line, expected, spec);
  }
});

test("single segment is an agent or a machine; over four segments is rejected", () => {
  assert.deepEqual(parseLaunchSpec("codex"), {
    ok: true,
    value: { agent: "codex" },
  });
  const machine = parseLaunchSpec("agy-pod");
  assert.ok(machine.ok && machine.value.machine === "agy-pod");
  assert.match(error("gemini"), /未知的 machine "gemini"/);
  const many = parseLaunchSpec("local:claude:opus:high:extra");
  assert.ok(!many.ok && /最多四段/.test(many.error));
});

test("unknown machine/agent and no agent to follow are rejected", () => {
  assert.match(error("nowhere:claude"), /未知的 machine/);
  assert.match(error("local:gemini"), /未知的 agent/);
  assert.match(error("::opus", { machine: "local" }), /沒有指定 agent/);
});

test("level format rejects injection characters", () => {
  const bad = ["hi gh", "high;ls", "$(id)", "high\nx", 'hi"gh', "hi'gh", "--x"];
  bad.push("-x", "a".repeat(33), "high\0", "`id`", "a|b");
  for (const level of bad)
    assert.ok(!levelArgsFor("codex", level).ok, JSON.stringify(level));
  for (const level of ["low", "xhigh", "ultra", "a_b-c", "a".repeat(32)])
    assert.ok(levelArgsFor("codex", level).ok, level);
});

test("level: agy and pi (no confirmed parameter) reject it", () => {
  for (const kind of ["agy", "pi"])
    assert.match(error(`:${kind}::high`), /沒有已確認的推理強度/);
});

test("model: no modelFlag for agy/pi, existing rules, all control characters", () => {
  for (const kind of ["agy", "pi"])
    assert.match(error(`:${kind}:some-model`), /modelFlag/);
  assert.ok(resolve(":agy").ok);
  error(`::${"m".repeat(201)}`);
  error("::--evil");
  for (const ch of ["\u001b", "\u0007", "\u007f", "\u0085"])
    assert.match(error(`::op${ch}us`), /控制字元/, JSON.stringify(ch));
});

test("argument parsing", () => {
  const parsed = parseAgentStartArgs(["codex", "--cwd", "/a", "b"]);
  assert.equal(parsed.cwd, "/a b");
  for (const args of [[], ["codex", "extra"], ["codex", "--cwd"]])
    assert.throws(() => parseAgentStartArgs(args), /usage/);
});

// ---- command flow with a fake Herdr ----

const agent = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w1:p1",
  terminal_id: "t1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "claude",
  agent_status: "idle",
  cwd: process.cwd(),
  ...patch,
});

/** `started` 覆寫新 pane 實際偵測到的 Agent 欄位（測試身分不符）。 */
function fakePort(
  status: AgentRecord["agent_status"] = "idle",
  started: Partial<AgentRecord> = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rect = { width: 200, height: 60 };
  const port: AgentStartPort = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "pane.layout")
        return { layout: { panes: [{ pane_id: params.pane_id, rect }] } };
      if (method === "pane.split")
        return {
          pane: { pane_id: "w1:p2", workspace_id: "w1", terminal_id: "t2" },
        };
      if (method === "pane.get") return { pane: { terminal_id: "t2" } };
      return {};
    },
    async listAgentsWithWorkspaceNames() {
      const pane = { pane_id: "w1:p2", terminal_id: "t2", agent: "codex" };
      return [agent(), agent({ ...pane, agent_status: status, ...started })];
    },
  };
  return { port, calls };
}

const baseDeps = (port: AgentStartPort): AgentStartDeps => ({
  port,
  selected: agent(),
  workspacePath: process.cwd(),
  machineIds: ["agy-pod", "pod"],
  allowedWorkspaceIds: [],
  readyTimeoutMs: 50,
  readyPollMs: 5,
});
const methods = (calls: Array<{ method: string }>) =>
  calls.map((c) => c.method);
const startParams = (calls: Array<{ method: string; params: object }>) =>
  calls.find((c) => c.method === "agent.start")!.params as Record<
    string,
    unknown
  >;

test("opens a pane, passes args, reports", async () => {
  const { port, calls } = fakePort();
  const spec = ":codex:gpt-6.1-sol:medium";
  const text = await runAgentStart(baseDeps(port), { spec });
  assert.equal(startParams(calls).pane_id, "w1:p2");
  assert.deepEqual(startParams(calls).args, [
    "-m",
    "gpt-6.1-sol",
    "-c",
    "model_reasoning_effort=medium",
  ]);
  assert.match(text, /w1:p2/);
  assert.match(
    text,
    /機器：local · 種類：codex · model：gpt-6\.1-sol · level：medium/,
  );
  assert.match(text, /未自動切換/);
});

test("invalid specs fail before a pane is opened", async () => {
  const { port, calls } = fakePort();
  const run = (spec: string, deps = baseDeps(port)) =>
    runAgentStart(deps, { spec });
  for (const spec of ["::opus:--x", ":agy::high", ":pi:m", "nowhere:codex"])
    await assert.rejects(run(spec), Error, spec);
  await assert.rejects(run("agy-pod:codex"), /只能在選定 Agent 所在的機器/);
  await assert.rejects(
    run("codex", { ...baseDeps(port), selected: undefined }),
    /尚未選定 Agent/,
  );
  assert.equal(calls.length, 0);
});

test("--cwd must exist and stay inside the workspace when restricted", async () => {
  const { port, calls } = fakePort();
  const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));
  const root = tmp("launch-");
  const inside = path.join(root, "sub");
  fs.mkdirSync(inside);
  const deps = { ...baseDeps(port), workspacePath: root };
  const run = (d: AgentStartDeps, cwd: string) =>
    runAgentStart(d, { spec: "codex", cwd });
  await assert.rejects(run(deps, "rel"), /絕對路徑/);
  await assert.rejects(run(deps, path.join(root, "nope")), /不是存在的資料夾/);
  const restricted = { ...deps, allowedWorkspaceIds: ["w1"] };
  await assert.rejects(run(restricted, tmp("launch-out-")), /白名單/);
  await assert.rejects(
    run(restricted, path.join(inside, "..", "..")),
    /白名單/,
  );
  assert.equal(calls.length, 0);
  await run(restricted, inside);
  const split = calls.find((c) => c.method === "pane.split")!;
  assert.equal(split.params.cwd, fs.realpathSync(inside));
});

test("remote --cwd: symlink escape and unverifiable paths are rejected", async () => {
  const { port, calls } = fakePort();
  const real: Record<string, string> = {
    "/ws/link": "/outside",
    "/ws/ok": "/ws/real",
  };
  const deps: AgentStartDeps = {
    ...baseDeps(port),
    selected: agent({ pane_id: "pod:w1:p1", cwd: "/ws" }),
    workspacePath: "/ws",
    allowedWorkspaceIds: ["w1"],
    remoteRealpath: async (_machine, target) => real[target] ?? target,
  };
  const run = (d: AgentStartDeps, cwd: string) =>
    runAgentStart(d, { spec: "codex", cwd });
  await assert.rejects(run(deps, "/ws/link"), /白名單/);
  const failing = async () => Promise.reject(new Error("ssh"));
  for (const remoteRealpath of [failing, undefined])
    await assert.rejects(
      run({ ...deps, remoteRealpath }, "/ws/ok"),
      /無法驗證遠端 pod/,
    );
  assert.equal(calls.length, 0);
  await run(deps, "/ws/ok");
  const split = calls.find((c) => c.method === "pane.split")!;
  assert.equal(split.params.cwd, "/ws/real");
});

test("success requires kind, workspace, pane and terminal to match", async () => {
  for (const patch of [
    { agent: "claude" },
    { workspace_id: "w9" },
    { terminal_id: "t9" },
  ]) {
    const { port, calls } = fakePort("idle", patch);
    await assert.rejects(
      runAgentStart(baseDeps(port), { spec: "codex" }),
      /與要求不符.*未關閉/,
      JSON.stringify(patch),
    );
    assert.ok(!methods(calls).includes("pane.close"));
  }
});

test("blocked start is reported, never confirmed, pane kept", async () => {
  const { port, calls } = fakePort("blocked");
  await assert.rejects(
    runAgentStart(baseDeps(port), { spec: "codex" }),
    /Agent 卡在啟動提示.*w1:p2.*未關閉/,
  );
  const forbidden = ["pane.send_input", "pane.close"];
  assert.ok(!methods(calls).some((m) => forbidden.includes(m)));
});

test("failed agent.start closes the new pane", async () => {
  const { port, calls } = fakePort();
  const failing: AgentStartPort = {
    ...port,
    request: async (method, params, options) => {
      if (method === "agent.start") throw new Error("boom");
      return port.request(method, params, options);
    },
  };
  await assert.rejects(
    runAgentStart(baseDeps(failing), { spec: "codex" }),
    /啟動失敗：boom.*已關閉/,
  );
  assert.ok(methods(calls).includes("pane.close"));
});

test("handleCommand runs agent start", async () => {
  const { port, calls } = fakePort();
  const output: string[] = [];
  const context = createConsoleContext((text) => output.push(text));
  const runtime = {
    config: { allowedWorkspaceIds: [], machines: [] },
    discord: { reply: async (_: unknown, t: string) => void output.push(t) },
    routing: {
      resolve: () => ({ workspaceId: "w1", paneId: "w1:p1" }),
      workspaceActiveTarget: () => undefined,
    },
    herdr: Object.assign(port, {
      listWorkspaces: async () => [{ workspace_id: "w1", path: process.cwd() }],
    }),
  } as unknown as Parameters<typeof handleCommand>[3];
  const start = (spec: string) =>
    handleCommand("agent", ["start", spec], context, runtime);
  await start(":codex::high");
  assert.match(
    output.join("\n"),
    /種類：codex · model：CLI 預設 · level：high/,
  );
  assert.deepEqual(startParams(calls).args, [
    "-c",
    "model_reasoning_effort=high",
  ]);
  await assert.rejects(start(":agy::high"), /沒有已確認的推理強度/);
});
