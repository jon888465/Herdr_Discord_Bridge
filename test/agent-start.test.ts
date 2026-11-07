import test from "node:test";
import assert from "node:assert/strict";
import { HerdrError } from "../src/herdr.js";
import { startAgentInPane, type AgentStartPort } from "../src/agent-start.js";
import type { AgentRecord } from "../src/types.js";

const input = { paneId: "w19:p1", kind: "claude", name: "card-req-x" };

const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w19:p1",
  terminal_id: "t1",
  workspace_id: "w19",
  tab_id: "w19:t1",
  agent: "claude",
  agent_status: "idle",
  ...patch,
});

/** 假的時鐘：sleep 只推進假的時間，測試不會真的等。 */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function port(
  start: (attempt: number) => void,
  agents: () => AgentRecord[],
): AgentStartPort & { starts: Array<{ params: unknown; options: unknown }> } {
  const starts: Array<{ params: unknown; options: unknown }> = [];
  return {
    starts,
    async request(method, params, options) {
      assert.equal(method, "agent.start");
      starts.push({ params, options });
      start(starts.length);
      return {};
    },
    listAgentsWithWorkspaceNames: async () => agents(),
  };
}

const busy = () =>
  new HerdrError(
    "agent.start",
    "agent_pane_busy",
    "agent target pane w19:p1 is not an available shell",
  );

test("a pane that is ready starts the Agent once, with the usual parameters, and returns the settled record", async () => {
  const c = clock();
  const p = port(
    () => undefined,
    () => [record()],
  );
  const result = await startAgentInPane(p, input, c);
  assert.equal(result.agent_status, "idle");
  assert.deepEqual(p.starts, [
    {
      params: {
        pane_id: "w19:p1",
        name: "card-req-x",
        kind: "claude",
        timeout_ms: 30000,
      },
      options: { retries: 0, timeoutMs: 35000 },
    },
  ]);
  assert.deepEqual(c.sleeps, []);
});

test("a pane whose shell is not ready yet is retried briefly and then starts", async () => {
  const c = clock();
  const p = port(
    (attempt) => {
      if (attempt <= 2) throw busy();
    },
    () => [record()],
  );
  const result = await startAgentInPane(p, input, c);
  assert.equal(result.agent, "claude");
  assert.equal(p.starts.length, 3);
  assert.deepEqual(c.sleeps, [500, 500]);
});

test("a pane that stays busy gives up after the retry window with the original error, and the number of attempts is bounded", async () => {
  const c = clock();
  const p = port(
    () => {
      throw busy();
    },
    () => [],
  );
  await assert.rejects(
    startAgentInPane(p, input, c),
    (error: unknown) =>
      error instanceof HerdrError &&
      error.code === "agent_pane_busy" &&
      /not an available shell/.test(error.message),
  );
  assert.ok(p.starts.length > 5, String(p.starts.length));
  assert.ok(p.starts.length <= 40, String(p.starts.length));
  assert.ok(c.now() >= 15_000 - 500 && c.now() <= 16_000, String(c.now()));
});

test("every other failure is not retried", async () => {
  for (const error of [
    new HerdrError("agent.start", "agent_start_failed", "boom"),
    new HerdrError("agent.start", "unsupported_agent_kind", "no such kind"),
    new Error("socket closed before response"),
  ]) {
    const c = clock();
    const p = port(
      () => {
        throw error;
      },
      () => [],
    );
    await assert.rejects(
      startAgentInPane(p, input, c),
      (thrown: unknown) => thrown === error,
      error.message,
    );
    assert.equal(p.starts.length, 1, error.message);
    assert.deepEqual(c.sleeps, []);
  }
});

test("after the start it waits until the Agent is detected, and returns the last record it saw when that takes too long", async () => {
  const c = clock();
  const sequence = [
    [record({ agent: undefined, agent_status: "unknown" })],
    [record({ agent_status: "unknown" })],
    [record({ agent_status: "blocked" })],
  ];
  let polled = 0;
  const p = port(
    () => undefined,
    () => sequence[Math.min(polled++, sequence.length - 1)],
  );
  const settled = await startAgentInPane(p, input, c);
  assert.equal(settled.agent_status, "blocked");
  assert.equal(polled, 3);

  const slow = clock();
  const never = port(
    () => undefined,
    () => [record({ agent: undefined, agent_status: "unknown" })],
  );
  const last = await startAgentInPane(never, input, slow);
  assert.equal(last.agent_status, "unknown");
  assert.ok(slow.now() >= 30_000, String(slow.now()));
});

test("an Agent that never shows up in the list is an error that says to inspect the pane", async () => {
  const c = clock();
  const p = port(
    () => undefined,
    () => [],
  );
  await assert.rejects(startAgentInPane(p, input, c), /not visible in w19:p1/);
});

// ISSUE-115：所有入口（reviewer／fixer／autopick Lead／agent start）都經 startAgentInPane。
import { makeLinkedWorktree } from "./cli-adapter.test.js";
import { CODEX_ADD_DIR_IGNORED } from "../src/cli-adapter.js";

test("startAgentInPane adds the worktree git dir for codex and leaves other launches byte-identical", async () => {
  const { wt, gitDir } = makeLinkedWorktree();
  const codexPort = port(() => {}, () => [record({ agent: "codex" })]);
  await startAgentInPane(codexPort, { ...input, kind: "codex", cwd: wt, args: ["-m", "x"] }, clock());
  assert.deepEqual((codexPort.starts[0]!.params as { args: string[] }).args, [
    "-m",
    "x",
    "--add-dir",
    gitDir,
  ]);
  const claudePort = port(() => {}, () => [record()]);
  await startAgentInPane(claudePort, { ...input, cwd: wt }, clock());
  assert.ok(!("args" in (claudePort.starts[0]!.params as object)));
  const noCwd = port(() => {}, () => [record({ agent: "codex" })]);
  await startAgentInPane(noCwd, { ...input, kind: "codex" }, clock());
  assert.ok(!("args" in (noCwd.starts[0]!.params as object)));
});

test("codex ignoring --add-dir gives an explicit error, with no retry without the flag", async () => {
  const { wt } = makeLinkedWorktree();
  const ignored = "Error adding directories: Ignoring --add-dir /x because the effective permissions do not allow additional writable roots.";
  // 情況一：agent.start 自己失敗並帶出輸出。
  const failing = port(() => {
    throw new Error(ignored);
  }, () => []);
  await assert.rejects(
    startAgentInPane(failing, { ...input, kind: "codex", cwd: wt }, clock()),
    (e: Error) => e.message.includes("--add-dir 被忽略，有效沙箱不是 workspace-write"),
  );
  assert.equal(failing.starts.length, 1);
  // 情況二：start 回來但 codex 已結束、偵測不到 Agent，pane 輸出有該訊息。
  const reads: unknown[] = [];
  const exited: AgentStartPort = {
    async request(method, params) {
      if (method === "agent.read") {
        reads.push(params);
        return { read: { text: ignored } };
      }
      return {};
    },
    listAgentsWithWorkspaceNames: async () => [],
  };
  await assert.rejects(
    startAgentInPane(exited, { ...input, kind: "codex", cwd: wt }, clock()),
    (e: Error) => e.message.includes(CODEX_ADD_DIR_IGNORED),
  );
  assert.equal(reads.length, 1);
});
