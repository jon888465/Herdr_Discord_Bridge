import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AgentPool } from "../src/agent-pool.js";
import { HerdrClient } from "../src/herdr.js";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamTaskStore,
  assertTaskTransition,
  type TaskState,
} from "../src/team-task-store.js";
import { TeamTaskEngine } from "../src/team-task-engine.js";
import type { AgentRecord } from "../src/types.js";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";

const lead: AgentRecord = {
  pane_id: "w1:p1",
  terminal_id: "lead",
  workspace_id: "w1",
  tab_id: "t1",
  agent: "agy",
  agent_status: "idle",
  agent_session: { kind: "id", value: "lead-session" },
};
const worker: AgentRecord = {
  ...lead,
  pane_id: "w1:p2",
  terminal_id: "worker",
  agent_session: { kind: "id", value: "worker-session" },
};
const input = {
  taskId: "task-test",
  prompt: "Inspect and verify",
  lead,
  workers: [worker],
  replan: true,
  timeoutMs: 500,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "durable-team-"));
  const store = new TeamTaskStore(join(dir, "tasks"));
  const streams = new Set<string>();
  const released: string[] = [];
  let live = structuredClone([lead, worker]);
  const prompts: Array<{ target: string; text: string }> = [];
  const cancels: string[] = [];
  let round = 0;
  const port = {
    listAgentsWithWorkspaceNames: async () => live,
    promptAgent: async (target: string, text: string) => {
      // Dispatch intent and complete frozen plan are already durable.
      const task = new TeamTaskStore(join(dir, "tasks")).get(input.taskId);
      assert.ok(task.turns.some((t) => t.agent.pane_id === target));
      prompts.push({ target, text });
      if (text.includes("Do not modify files while planning")) round++;
    },
    waitAgent: async (target: string) => ({
      ...live.find((a) => a.pane_id === target)!,
      agent_status: "done",
    }),
    readAgent: async (target: string) => {
      const prompt = prompts.filter((p) => p.target === target).at(-1)?.text;
      if (!prompt) return "historical output";
      const body =
        target !== lead.pane_id
          ? `report ${round}`
          : prompt.includes("Do not modify files while planning")
            ? JSON.stringify({
                assignments:
                  round < 3
                    ? [
                        {
                          id: `step-${round}`,
                          workerPaneId: worker.pane_id,
                          instruction: "Inspect",
                        },
                      ]
                    : [],
              })
            : "Verified synthesis";
      return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
    },
    cancelAgent: async (target: string) => {
      cancels.push(target);
      live = live.map((a) =>
        a.pane_id === target ? { ...a, agent_status: "idle" } : a,
      );
    },
  };
  const engine = new TeamTaskEngine(store, port, streams, (id) =>
    released.push(id),
  );
  return {
    dir,
    store,
    engine,
    port,
    streams,
    prompts,
    cancels,
    released,
    setLive: (agents: AgentRecord[]) => {
      live = agents;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function seedRunning(f: ReturnType<typeof fixture>) {
  f.store.create(input);
  f.store.update(input.taskId, "fixture-dispatched", (t) => {
    t.state = "running";
    t.assignments.push({
      plan: { id: "a", workerPaneId: worker.pane_id, instruction: "Inspect" },
      state: "working",
      agent: worker,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
    t.turns.push({
      agent: worker,
      phase: "assignment",
      assignmentId: "a",
      state: "dispatched",
    });
  });
}

test("task state machine rejects terminal resurrection and invalid completion", () => {
  for (const state of ["completed", "failed", "cancelled"] as TaskState[])
    assert.throws(() => assertTaskTransition(state, "planning"), /invalid/);
  assert.throws(() => assertTaskTransition("running", "completed"), /invalid/);
  for (const [a, b] of [
    ["planning", "running"],
    ["running", "planning"],
    ["running", "synthesizing"],
    ["synthesizing", "blocked"],
    ["blocked", "cancelling"],
    ["cancelling", "cancelled"],
  ] as [TaskState, TaskState][])
    assert.doesNotThrow(() => assertTaskTransition(a, b));
});

// F8：引擎會用丟出的錯誤再記錄 task_failed；最後持久化的原因（自動撿卡讀的）必須仍帶 Worker 逾時摘要。
test("ISSUE-124 Worker 逾時後 Lead 彙整丟出非逾時錯誤，引擎最後持久化的原因仍帶逾時摘要", async () => {
  const f = fixture();
  try {
    const original = f.port.waitAgent;
    let leadWaits = 0;
    f.port.waitAgent = async (target: string) => {
      if (target === worker.pane_id)
        throw new Error(
          "herdr agent.prompt: timeout timed out waiting for agent status",
        );
      if (target === lead.pane_id && ++leadWaits >= 2)
        throw new Error("Lead synthesis exploded");
      return original(target);
    };
    const result = await f.engine.run({ ...input, replan: false });
    const detail = String(result.detail);
    assert.match(detail, /Assignment .+ 等待逾時/);
    assert.match(detail, /Lead synthesis exploded/);
    // 卡片只保留失敗原因前 200 字元：逾時摘要必須在最前面。
    assert.ok(detail.indexOf("等待逾時") < 60, detail);
    const loaded = new TeamTaskStore(join(f.dir, "tasks")).get(input.taskId);
    assert.equal(loaded.detail, result.detail);
  } finally {
    f.close();
  }
});

test("durable dynamic multi-round task persists plans, reports, journal and frozen identity", async () => {
  const f = fixture();
  try {
    const result = await f.engine.run(input);
    assert.equal(result.state, "completed");
    assert.equal(result.assignments.length, 2);
    assert.deepEqual(
      result.assignments.map((a) => a.report),
      ["report 1", "report 2"],
    );
    assert.equal(result.synthesis, "Verified synthesis");
    assert.equal(result.turns.length, 0);
    assert.equal(f.streams.size, 0);
    assert.deepEqual(f.released, [input.taskId]);
    const loaded = new TeamTaskStore(join(f.dir, "tasks"));
    assert.deepEqual(loaded.get(input.taskId), result);
    const events = loaded.events(input.taskId);
    assert.equal(events.filter((e) => e.type === "plan_validated").length, 3);
    assert.ok(events.some((e) => e.task.state === "running"));
    assert.ok(events.some((e) => e.task.state === "synthesizing"));
    assert.equal(
      events.find((e) => e.type === "task_completed")?.task.synthesis,
      "Verified synthesis",
    );
    assert.throws(
      () =>
        loaded.update(input.taskId, "bad", (t) => {
          t.lead.pane_id = "other";
        }),
      /immutable/,
    );
    assert.deepEqual(readdirSync(join(f.dir, "tasks")), [
      `${input.taskId}.json`,
    ]);
    if (process.platform !== "win32")
      assert.equal(
        statSync(join(f.dir, "tasks", `${input.taskId}.json`)).mode & 0o777,
        0o600,
      );
  } finally {
    f.close();
  }
});

test("zero-Worker direct execution remains durable without acquiring a Worker", async () => {
  const f = fixture();
  try {
    const read = f.port.readAgent;
    f.port.readAgent = async (target) =>
      (await read(target)).replace(
        /\{"assignments":.*\}/,
        '{"assignments":[]}',
      );
    const task = await f.engine.run({
      ...input,
      workers: [],
      acquireWorker: async () => {
        throw new Error("must not acquire");
      },
    });
    assert.equal(task.state, "completed");
    assert.equal(task.assignments.length, 0);
    assert.equal(f.prompts.length, 2);
    assert.ok(f.prompts.every((p) => p.target === lead.pane_id));
  } finally {
    f.close();
  }
});

test("restart reconciles stale running to blocked/recoverable, never dispatches or infers completion", async () => {
  const f = fixture();
  try {
    seedRunning(f);
    const engine = new TeamTaskEngine(
      new TeamTaskStore(join(f.dir, "tasks")),
      f.port,
      f.streams,
    );
    await engine.reconcile();
    const task = engine.store.get(input.taskId);
    assert.equal(task.state, "blocked");
    assert.equal(task.recovery?.status, "recoverable");
    assert.equal(task.assignments[0].state, "blocked");
    assert.equal(task.turns[0].state, "uncertain");
    assert.equal(f.prompts.length, 0);
    await engine.reconcile();
    assert.equal(f.prompts.length, 0);
    assert.equal((await engine.cancel(input.taskId)).state, "cancelled");
    assert.equal(f.cancels.length, 0); // idle is not evidence of a report, but no work needs interrupting
    assert.equal(f.streams.size, 0);
  } finally {
    f.close();
  }
});

for (const scenario of [
  "missing",
  "replaced",
  "unknown",
  "offline",
  "working",
] as const)
  test(`restart ${scenario} session is never claimed running or automatically interrupted`, async () => {
    const f = fixture();
    try {
      seedRunning(f);
      if (scenario === "missing") f.setLive([lead]);
      if (scenario === "replaced")
        f.setLive([
          lead,
          {
            ...worker,
            agent_session: { kind: "id", value: "replacement" },
            agent_status: "working",
          },
        ]);
      if (scenario === "unknown")
        f.setLive([lead, { ...worker, agent_session: undefined }]);
      if (scenario === "working")
        f.setLive([lead, { ...worker, agent_status: "working" }]);
      if (scenario === "offline")
        f.port.listAgentsWithWorkspaceNames = async () => {
          throw new Error("offline");
        };
      await f.engine.reconcile();
      assert.equal(
        f.store.get(input.taskId).recovery?.status,
        scenario === "working" ? "recoverable" : "unknown",
      );
      const result = await f.engine.cancel(input.taskId);
      assert.equal(
        result.state,
        ["missing", "replaced"].includes(scenario) ? "cancelled" : "cancelling",
      );
      assert.equal(f.cancels.length, 0);
      assert.equal(f.prompts.length, 0);
    } finally {
      f.close();
    }
  });

test("whole task cancellation stops active Worker, cancels pending dependencies and releases reservations once", async () => {
  const f = fixture();
  try {
    const waiting = deferred<void>();
    const wait = f.port.waitAgent;
    f.port.waitAgent = async (target) => {
      if (target === worker.pane_id) {
        f.setLive([lead, { ...worker, agent_status: "working" }]);
        waiting.resolve();
        return new Promise<AgentRecord>(() => {});
      }
      return wait(target);
    };
    const read = f.port.readAgent;
    f.port.readAgent = async (target) =>
      (await read(target)).replace(
        '"instruction":"Inspect"}',
        '"instruction":"Inspect"},{"id":"dependent","workerPaneId":"w1:p2","instruction":"Later","dependsOn":["step-1"]}',
      );
    const running = f.engine.run(input);
    await waiting.promise;
    const [a, b] = await Promise.all([
      f.engine.cancel(input.taskId),
      f.engine.cancel(input.taskId),
    ]);
    await running;
    assert.equal(a.state, "cancelled");
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.assignments.map((v) => v.state),
      ["cancelled", "cancelled"],
    );
    assert.deepEqual(f.cancels, [worker.pane_id]);
    assert.equal(f.prompts.length, 2);
    assert.equal(f.streams.size, 0);
    assert.deepEqual(f.released, [input.taskId]);
    await f.engine.cancel(input.taskId);
    assert.deepEqual(f.cancels, [worker.pane_id]);
  } finally {
    f.close();
  }
});

test("cancel during pending atomic dispatch waits for dispatch before signalling and never starts synthesis", async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const delivered = deferred<AgentRecord>();
    const port = {
      ...f.port,
      promptAgentAndWait: async (_target: string, _text: string) => {
        entered.resolve();
        return delivered.promise;
      },
    };
    const engine = new TeamTaskEngine(f.store, port, f.streams);
    const running = engine.run(input);
    await entered.promise;
    const cancellation = engine.cancel(input.taskId);
    assert.equal(f.store.get(input.taskId).state, "cancelling");
    assert.equal(f.cancels.length, 0);
    assert.ok(f.streams.has(lead.terminal_id));
    f.setLive([{ ...lead, agent_status: "working" }, worker]);
    delivered.resolve({ ...lead, agent_status: "working" });
    assert.equal((await cancellation).state, "cancelled");
    await running;
    assert.deepEqual(f.cancels, [lead.pane_id]);
    assert.equal(f.streams.size, 0);
  } finally {
    f.close();
  }
});

test("uncertain cancel delivery stays cancelling, retains leases and does not replay Ctrl-C", async () => {
  const f = fixture();
  try {
    const waiting = deferred<void>();
    f.port.waitAgent = async () => {
      waiting.resolve();
      return new Promise<AgentRecord>(() => {});
    };
    f.port.cancelAgent = async (target) => {
      f.cancels.push(target);
      throw new Error("delivery uncertain");
    };
    const running = f.engine.run(input);
    await waiting.promise;
    f.setLive([{ ...lead, agent_status: "working" }, worker]);
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelling");
    await running;
    assert.ok(f.streams.has(lead.terminal_id));
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelling");
    assert.deepEqual(f.cancels, [lead.pane_id]);
    f.setLive([lead, worker]);
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelled");
    assert.equal(f.streams.size, 0);
  } finally {
    f.close();
  }
});

test("blocked Lead is durable and safely cancellable without a second planning lifecycle", async () => {
  const f = fixture();
  try {
    f.port.waitAgent = async () => ({ ...lead, agent_status: "blocked" });
    f.setLive([{ ...lead, agent_status: "blocked" }, worker]);
    const result = await f.engine.run(input);
    assert.equal(result.state, "blocked");
    assert.equal(result.turns[0].state, "blocked");
    assert.equal(result.assignments.length, 0);
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelled");
    assert.deepEqual(f.cancels, [lead.pane_id]);
  } finally {
    f.close();
  }
});

test("unknown schema, corrupt journal, altered roster and invalid assignment transitions fail closed", () => {
  const f = fixture();
  try {
    seedRunning(f);
    assert.throws(
      () =>
        f.store.update(input.taskId, "bad", (t) => {
          t.assignments[0].state = "pending";
        }),
      /invalid assignment transition/,
    );
    const file = join(f.dir, "tasks", `${input.taskId}.json`);
    const original = readFileSync(file, "utf8");
    const journal = JSON.parse(original);
    journal.schemaVersion = 999;
    writeFileSync(file, JSON.stringify(journal));
    assert.throws(() => new TeamTaskStore(join(f.dir, "tasks")), /unsupported/);
    writeFileSync(file, '{"truncated":');
    assert.throws(() => new TeamTaskStore(join(f.dir, "tasks")));
    writeFileSync(file, original);
    writeFileSync(join(f.dir, "tasks", "orphan.tmp"), "incomplete");
    assert.equal(
      new TeamTaskStore(join(f.dir, "tasks")).get(input.taskId).state,
      "running",
    );
  } finally {
    f.close();
  }
});

test("atomic write failure leaves the last committed journal intact and stops future mutations", () => {
  const f = fixture();
  try {
    f.store.create(input);
    const directory = join(f.dir, "tasks");
    const backup = join(f.dir, "saved");
    renameSync(directory, backup);
    writeFileSync(directory, "not a directory");
    assert.throws(() =>
      f.store.update(input.taskId, "running", (t) => {
        t.state = "running";
      }),
    );
    assert.equal(f.store.get(input.taskId).state, "planning");
    rmSync(directory);
    mkdirSync(directory);
    assert.throws(
      () => f.store.update(input.taskId, "retry", () => {}),
      /persistence failed/,
    );
    assert.equal(new TeamTaskStore(backup).get(input.taskId).state, "planning");
  } finally {
    f.close();
  }
});

test("team status/cancel enforce selected workspace and ordinary cancel cannot interrupt owned sessions", async () => {
  const f = fixture();
  const output: string[] = [];
  const routing = new RoutingStore(join(f.dir, "routing.json"));
  try {
    seedRunning(f);
    await f.engine.reconcile();
    const context = createConsoleContext((text) => output.push(text));
    routing.bind(context.routing, { workspaceId: "w1" });
    routing.bindWorkspace("w1", { workspaceId: "w1", paneId: worker.pane_id });
    const runtime = {
      tasks: f.engine,
      herdr: f.port,
      routing,
      activeStreams: f.streams,
      config: { allowedWorkspaceIds: [] },
      discord: {
        reply: async (_: unknown, text: string) => {
          output.push(text);
        },
      },
    } as unknown as Parameters<typeof handleCommand>[3];
    await handleCommand("team", ["status", input.taskId], context, runtime);
    assert.match(output.join("\n"), /recoverable/);
    await assert.rejects(
      handleCommand("cancel", [worker.pane_id], context, runtime),
      /team cancel/,
    );
    routing.bind(context.routing, { workspaceId: "w2" });
    await assert.rejects(
      handleCommand("team", ["cancel", input.taskId], context, runtime),
      /another workspace/,
    );
    routing.bind(context.routing, { workspaceId: "w1" });
    await handleCommand("team", ["cancel", input.taskId], context, runtime);
    assert.equal(f.store.get(input.taskId).state, "cancelled");
  } finally {
    routing.flush();
    f.close();
  }
});

test("cancellation waits for lazy acquisition and releases its profile lease without dispatch", async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const acquired = deferred<{ agent: AgentRecord; continuity: string }>();
    const running = f.engine.run({
      ...input,
      acquireWorker: async () => {
        entered.resolve();
        return acquired.promise;
      },
    });
    await entered.promise;
    const cancelled = f.engine.cancel(input.taskId);
    assert.deepEqual(f.released, []);
    acquired.resolve({ agent: worker, continuity: "new-session" });
    assert.equal((await cancelled).state, "cancelled");
    await running;
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.cancels, []);
    assert.deepEqual(f.released, [input.taskId]);
  } finally {
    f.close();
  }
});

test("whole-team cancellation stops two parallel Workers but leaves the settled Lead untouched", async () => {
  const f = fixture();
  try {
    const other = {
      ...worker,
      pane_id: "w1:p3",
      terminal_id: "other",
      agent_session: { kind: "id", value: "other-session" },
    };
    f.setLive([lead, worker, other]);
    const both = deferred<void>();
    let waits = 0;
    const wait = f.port.waitAgent;
    f.port.waitAgent = async (target) => {
      if (target === lead.pane_id) return wait(target);
      if (++waits === 2) {
        f.setLive([
          lead,
          { ...worker, agent_status: "working" },
          { ...other, agent_status: "working" },
        ]);
        both.resolve();
      }
      return new Promise<AgentRecord>(() => {});
    };
    const read = f.port.readAgent;
    f.port.readAgent = async (target) =>
      (await read(target)).replace(
        '"instruction":"Inspect"}',
        '"instruction":"Inspect"},{"id":"other","workerPaneId":"w1:p3","instruction":"Inspect"}',
      );
    const running = f.engine.run({ ...input, workers: [worker, other] });
    await both.promise;
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelled");
    await running;
    assert.deepEqual(f.cancels.sort(), [worker.pane_id, other.pane_id].sort());
    assert.equal(f.streams.size, 0);
  } finally {
    f.close();
  }
});

test("blocked Worker and dependent failure remain durable with partial synthesis", async () => {
  const f = fixture();
  try {
    const wait = f.port.waitAgent;
    f.port.waitAgent = async (target) =>
      target === worker.pane_id
        ? { ...worker, agent_status: "blocked" }
        : wait(target);
    const read = f.port.readAgent;
    f.port.readAgent = async (target) =>
      (await read(target)).replace(
        '"instruction":"Inspect"}',
        '"instruction":"Inspect"},{"id":"dependent","workerPaneId":"w1:p2","instruction":"Later","dependsOn":["step-1"]}',
      );
    const result = await f.engine.run(input);
    assert.equal(result.state, "blocked");
    assert.deepEqual(
      result.assignments.map((a) => a.state),
      ["blocked", "failed"],
    );
    assert.equal(result.synthesis, "Verified synthesis");
    assert.equal(result.turns.length, 1);
    assert.ok(f.streams.has(worker.terminal_id));
    f.setLive([lead, { ...worker, agent_status: "blocked" }]);
    assert.equal((await f.engine.cancel(input.taskId)).state, "cancelled");
    assert.deepEqual(f.cancels, [worker.pane_id]);
  } finally {
    f.close();
  }
});

test("a journal failure before dispatch fences all further side effects", async () => {
  const f = fixture();
  try {
    const update = f.store.update.bind(f.store);
    f.store.update = (id, type, change) => {
      if (type === "turn_dispatched") throw new Error("disk full fixture");
      return update(id, type, change);
    };
    await assert.rejects(f.engine.run(input), /disk full/);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.store.get(input.taskId).state, "planning");
    assert.ok(f.streams.has(lead.terminal_id));
  } finally {
    f.close();
  }
});

test("Ctrl-C primitive opts out of transport retries after an uncertain acknowledgement", async () => {
  const calls: unknown[] = [];
  class Client extends HerdrClient {
    override async request<T = unknown>(
      ...args: Parameters<HerdrClient["request"]>
    ): Promise<T> {
      calls.push(args);
      throw Object.assign(new Error("ack lost"), { code: "ECONNRESET" });
    }
  }
  await assert.rejects(new Client().cancelAgent(worker.pane_id), /ack lost/);
  assert.deepEqual(calls, [
    [
      "agent.send_keys",
      { target: worker.pane_id, keys: ["ctrl+c"] },
      { retries: 0 },
    ],
  ]);
});

/** ISSUE-066：任務記錄的 Lead 當時還沒有 session（剛啟動的 Agent），之後 Herdr 才登記。 */
function seedLeadWithoutSession(f: ReturnType<typeof fixture>) {
  f.store.create(input);
  f.store.update(input.taskId, "fixture-lead-without-session", (t) => {
    t.state = "blocked";
    t.turns.push({
      agent: { ...lead, agent_session: undefined },
      phase: "planning",
      state: "blocked",
    });
  });
}

test("cancel settles a turn whose recorded session was empty once the same pane is idle, and sends no signal", async () => {
  for (const status of ["idle", "done"] as const) {
    const f = fixture();
    try {
      seedLeadWithoutSession(f);
      f.setLive([{ ...lead, agent_status: status }, worker]);
      const result = await f.engine.cancel(input.taskId);
      assert.equal(result.state, "cancelled", status);
      assert.deepEqual(f.cancels, [], status);
    } finally {
      f.close();
    }
  }
});

test("cancel still refuses to signal an Agent that is working when the recorded session was empty", async () => {
  const f = fixture();
  try {
    seedLeadWithoutSession(f);
    f.setLive([{ ...lead, agent_status: "working" }, worker]);
    const result = await f.engine.cancel(input.taskId);
    assert.equal(result.state, "cancelling");
    assert.match(String(result.detail), /session identity unknown/);
    assert.deepEqual(f.cancels, []);
  } finally {
    f.close();
  }
});

test("cancel does not settle on an idle pane whose terminal, workspace or Agent kind differs from the recorded turn", async () => {
  for (const changed of [
    { terminal_id: "other-terminal" },
    { agent: "codex" },
  ]) {
    const f = fixture();
    try {
      seedLeadWithoutSession(f);
      f.setLive([{ ...lead, ...changed, agent_status: "idle" }, worker]);
      const result = await f.engine.cancel(input.taskId);
      assert.equal(result.state, "cancelling", JSON.stringify(changed));
      assert.deepEqual(f.cancels, [], JSON.stringify(changed));
    } finally {
      f.close();
    }
  }
});

test("a recorded session that is known keeps the old rules: a replaced session is not signalled and a matching one is", async () => {
  const f = fixture();
  try {
    f.setLive([
      {
        ...lead,
        agent_session: { kind: "id", value: "someone-else" },
        agent_status: "working",
      },
      worker,
    ]);
    f.store.create(input);
    f.store.update(input.taskId, "fixture-known-session", (t) => {
      t.state = "blocked";
      t.turns.push({ agent: lead, phase: "planning", state: "blocked" });
    });
    const result = await f.engine.cancel(input.taskId);
    assert.equal(result.state, "cancelled");
    assert.deepEqual(f.cancels, []);
  } finally {
    f.close();
  }
});

test("cancel while the atomic prompt is still pending interrupts a working Agent without waiting for it to finish (ISSUE-061)", { timeout: 3000 }, async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const delivered = deferred<AgentRecord>();
    const port = {
      ...f.port,
      promptAgentAndWait: async (_target: string, _text: string) => {
        entered.resolve();
        return delivered.promise;
      },
      cancelAgent: async (target: string) => {
        f.cancels.push(target);
        f.setLive([{ ...lead, agent_status: "idle" }, worker]);
        // Herdr's agent.prompt wait only returns once the Agent stops working.
        delivered.resolve({ ...lead, agent_status: "idle" });
      },
    };
    const engine = new TeamTaskEngine(f.store, port, f.streams, undefined, [], 10);
    const running = engine.run(input);
    await entered.promise;
    f.setLive([{ ...lead, agent_status: "working" }, worker]);
    const result = await engine.cancel(input.taskId);
    assert.equal(result.state, "cancelled");
    assert.deepEqual(f.cancels, [lead.pane_id]);
    await running;
  } finally {
    f.close();
  }
});

test("cancel while the atomic prompt is pending sends nothing to an Agent that has not started working and never signals twice (ISSUE-061)", { timeout: 3000 }, async () => {
  const f = fixture();
  try {
    const entered = deferred<void>();
    const delivered = deferred<AgentRecord>();
    const port = {
      ...f.port,
      promptAgentAndWait: async (_target: string, _text: string) => {
        entered.resolve();
        return delivered.promise;
      },
    };
    const engine = new TeamTaskEngine(f.store, port, f.streams, undefined, [], 10);
    const running = engine.run(input);
    await entered.promise;
    const cancellation = engine.cancel(input.taskId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(f.cancels.length, 0);
    f.setLive([{ ...lead, agent_status: "working" }, worker]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(f.cancels, [lead.pane_id]);
    delivered.resolve({ ...lead, agent_status: "idle" });
    await cancellation;
    await running;
    assert.deepEqual(f.cancels, [lead.pane_id]);
  } finally {
    f.close();
  }
});


// 有 session 的對照組用 opencode（非 codex、畫面解析是通用的），只有 agy 模擬「第一個 prompt 之後才登記 session」。
type Participant = {
  agent: string;
  /** 派工前就有的 session。 */
  initial?: string;
  /** 處理完第一個 prompt 後才被登記的 session（模擬 agy）。 */
  after?: string;
};

function codingRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agy-coding-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "base");
  return repo;
}
function codingRun(options: {
  author: Participant;
  reviewer: Participant;
  /** review 指派給作者自己的 pane。 */
  reviewOnAuthorPane?: boolean;
  /** 計畫略過 implement。 */
  skipImplement?: boolean;
  /** Single configured profile is reacquired as a fresh session per assignment. */
  singleProfile?: boolean;
}) {
  const repo = codingRepo();
  const dir = mkdtempSync(join(tmpdir(), "agy-coding-task-"));
  const store = new TeamTaskStore(join(dir, "tasks"));
  const make = (pane: string, kind: string, initial?: string): AgentRecord => ({
    pane_id: pane,
    terminal_id: `term-${pane}`,
    workspace_id: "w1",
    tab_id: "t1",
    agent: kind,
    agent_status: "idle",
    cwd: repo,
    ...(initial ? { agent_session: { kind: "id", value: initial } } : {}),
  });
  const leadAgent = make("w1:p1", "opencode", "lead-session");
  const author = make("w1:p2", options.author.agent, options.author.initial);
  const reviewer = make(
    "w1:p3",
    options.reviewer.agent,
    options.reviewer.initial,
  );
  const specs = new Map<string, Participant>([
    [author.pane_id, options.author],
    [reviewer.pane_id, options.reviewer],
  ]);
  const registered = new Set<string>();
  const sessionNow = (pane: string): AgentRecord["agent_session"] => {
    const spec = specs.get(pane);
    if (!spec) return { kind: "id", value: "lead-session" };
    const value = registered.has(pane)
      ? (spec.after ?? spec.initial)
      : spec.initial;
    return value ? { kind: "id", value } : undefined;
  };
  const record = (item: AgentRecord): AgentRecord => {
    const { agent_session: _drop, ...rest } = item;
    const session = sessionNow(item.pane_id);
    return session ? { ...rest, agent_session: session } : rest;
  };
  const all = [leadAgent, author, reviewer];
  const prompts: Array<{ target: string; text: string }> = [];
  let plans = 0;
  const port = {
    listAgentsWithWorkspaceNames: async () => all.map(record),
    promptAgent: async (target: string, text: string) => {
      prompts.push({ target, text });
      if (text.includes("Do not modify files while planning")) plans += 1;
      if (text.includes("Coding role: implement"))
        writeFileSync(join(repo, "added.txt"), "one\n");
      // 第一個 prompt 處理完之後 Herdr 才登記 session。
      registered.add(target);
    },
    waitAgent: async (target: string) => ({
      ...record(all.find((item) => item.pane_id === target)!),
      agent_status: "done" as const,
    }),
    readAgent: async (target: string) => {
      const prompt = prompts
        .filter((item) => item.target === target)
        .at(-1)?.text;
      if (!prompt) return "historical";
      let body = "done";
      if (prompt.includes("Do not modify files while planning")) {
        const implement = {
          id: "impl",
          workerPaneId: options.singleProfile ? "profile:pi" : author.pane_id,
          instruction: "Add the feature",
          role: "implement",
          access: "write",
          writeScope: ["added.txt"],
        };
        const review = {
          id: "rev",
          workerPaneId: options.singleProfile
            ? "profile:pi"
            : options.reviewOnAuthorPane
              ? author.pane_id
              : reviewer.pane_id,
          instruction: "Review the current version",
          role: "review",
          access: "read",
        };
        const verify = {
          id: "ver",
          workerPaneId: options.singleProfile ? "profile:pi" : reviewer.pane_id,
          instruction: "Run the local check",
          role: "verify",
          access: "read",
        };
        const first = options.skipImplement ? [review] : [implement];
        const rounds = options.skipImplement
          ? [first, []]
          : [first, [review], [verify], []];
        body = JSON.stringify({ assignments: rounds[plans - 1] ?? [] });
      } else if (prompt.includes("Coding role: implement"))
        body = JSON.stringify({
          codingResult: { kind: "implement", files: ["added.txt"] },
        });
      else if (prompt.includes("Coding role: review"))
        body = JSON.stringify({
          codingResult: { kind: "review", verdict: "pass", findings: [] },
        });
      else if (prompt.includes("Coding role: verify"))
        body = JSON.stringify({
          codingResult: {
            kind: "verify",
            commands: [{ command: "node --test", exitCode: 0 }],
          },
        });
      else if (
        prompt.includes("Synthesize") ||
        prompt.includes("acceptance gate")
      )
        body = "Local delivery report";
      return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
    },
    cancelAgent: async () => {},
  };
  const engine = new TeamTaskEngine(store, port, new Set());
  return {
    run: () =>
      engine.run({
        taskId: "task-agy",
        prompt: "ship the local change",
        lead: record(leadAgent),
        workers: options.singleProfile
          ? [
              {
                pane_id: "profile:pi",
                terminal_id: "profile:pi",
                workspace_id: "w1",
                tab_id: "",
                agent: "pi",
                agent_status: "idle",
                profile: { id: "pi", kind: "pi" },
              },
            ]
          : [record(author), record(reviewer)],
        ...(options.singleProfile
          ? {
              acquireWorker: async (_target, assignment) => ({
                agent: record(
                  assignment?.coding?.role === "implement" ? author : reviewer,
                ),
                continuity: "new-session" as const,
              }),
            }
          : {}),
        replan: true,
        coding: true,
        timeoutMs: 500,
      }),
    close: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

test("ISSUE-107: a session that agy gets only after its first turn becomes the implement artifact's authorSession, and a different known reviewer passes", async () => {
  const h = codingRun({
    author: { agent: "agy", after: "agy-author" },
    reviewer: { agent: "opencode", initial: "claude-review" },
  });
  try {
    const task = await h.run();
    const implement = task.coding?.artifacts.find(
      (a) => a.role === "implement",
    );
    assert.deepEqual(implement?.authorSession, {
      kind: "id",
      value: "agy-author",
    });
    const reviews = (task.coding?.artifacts ?? []).filter(
      (a) => a.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(
      reviews.every(
        (a) => a.independentReview === true && a.verdict === "pass",
      ),
    );
    assert.equal(task.state, "completed");
  } finally {
    h.close();
  }
});

test("one configured pi profile can implement and independently review through fresh sessions", async () => {
  const h = codingRun({
    author: { agent: "pi", initial: "pi-author" },
    reviewer: { agent: "pi", initial: "pi-reviewer" },
    singleProfile: true,
  });
  try {
    const task = await h.run();
    const implement = task.coding?.artifacts.find(
      (artifact) => artifact.role === "implement",
    );
    const review = task.coding?.artifacts.find(
      (artifact) => artifact.role === "review",
    );
    assert.equal(task.state, "completed");
    assert.deepEqual(implement?.authorSession, {
      kind: "id",
      value: "pi-author",
    });
    assert.deepEqual(review?.reviewerSession, {
      kind: "id",
      value: "pi-reviewer",
    });
    assert.equal(review?.independentReview, true);
    assert.equal(review?.verdict, "pass");
  } finally {
    h.close();
  }
});

test("ISSUE-107: an agy reviewer with no session at assignment start is judged when its turn completes; a different session passes", async () => {
  const h = codingRun({
    author: { agent: "opencode", initial: "claude-author" },
    reviewer: { agent: "agy", after: "agy-review" },
  });
  try {
    const task = await h.run();
    const reviews = (task.coding?.artifacts ?? []).filter(
      (a) => a.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.deepEqual(reviews[0].reviewerSession, {
      kind: "id",
      value: "agy-review",
    });
    assert.ok(
      reviews.every(
        (a) => a.independentReview === true && a.verdict === "pass",
      ),
    );
    assert.equal(task.state, "completed");
  } finally {
    h.close();
  }
});

test("ISSUE-107: an agy reviewer that turns out to share the author's session is inconclusive, never a pass", async () => {
  const h = codingRun({
    author: { agent: "opencode", initial: "shared" },
    reviewer: { agent: "agy", after: "shared" },
  });
  try {
    const task = await h.run();
    const reviews = (task.coding?.artifacts ?? []).filter(
      (a) => a.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((a) => a.independentReview === false));
    assert.ok(reviews.every((a) => a.verdict === "inconclusive"));
    assert.match(reviews[0].independenceFailure ?? "", /same-session/);
    assert.notEqual(task.state, "completed");
  } finally {
    h.close();
  }
});

test("ISSUE-107: an agy reviewer that never gets a session is inconclusive (fail closed)", async () => {
  const h = codingRun({
    author: { agent: "opencode", initial: "claude-author" },
    reviewer: { agent: "agy" },
  });
  try {
    const task = await h.run();
    const reviews = (task.coding?.artifacts ?? []).filter(
      (a) => a.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(
      reviews.every(
        (a) => a.independentReview === false && a.verdict === "inconclusive",
      ),
    );
    assert.match(reviews[0].independenceFailure ?? "", /unknown reviewer/);
    assert.notEqual(task.state, "completed");
  } finally {
    h.close();
  }
});

test("ISSUE-107: an agy author that never gets a session leaves reviews inconclusive (unknown author)", async () => {
  const h = codingRun({
    author: { agent: "agy" },
    reviewer: { agent: "agy", after: "agy-review" },
  });
  try {
    const task = await h.run();
    const reviews = (task.coding?.artifacts ?? []).filter(
      (a) => a.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(
      reviews.every(
        (a) => a.verdict === "inconclusive" && a.independentReview === false,
      ),
    );
    assert.match(reviews[0].independenceFailure ?? "", /unknown author/);
    assert.equal(
      (task.coding?.artifacts ?? []).some(
        (a) => a.role === "review" && a.verdict === "pass",
      ),
      false,
    );
    assert.notEqual(task.state, "completed");
  } finally {
    h.close();
  }
});

test("ISSUE-107: deferring the agy session check still rejects the author's own pane before dispatch", async () => {
  const h = codingRun({
    author: { agent: "agy" },
    reviewer: { agent: "opencode", initial: "claude-review" },
    reviewOnAuthorPane: true,
  });
  try {
    const task = await h.run();
    assert.equal(
      (task.coding?.artifacts ?? []).filter((a) => a.role === "review").length,
      0,
    );
    assert.notEqual(task.state, "completed");
    assert.match(JSON.stringify(task.assignments), /same-session review/);
  } finally {
    h.close();
  }
});

test("ISSUE-107: deferring the agy session check still requires an implementation artifact before review", async () => {
  const h = codingRun({
    author: { agent: "opencode", initial: "claude-author" },
    reviewer: { agent: "agy", after: "agy-review" },
    skipImplement: true,
  });
  try {
    const task = await h.run();
    assert.equal(
      (task.coding?.artifacts ?? []).filter((a) => a.role === "review").length,
      0,
    );
    assert.notEqual(task.state, "completed");
    assert.match(
      JSON.stringify(task.assignments),
      /no implementation artifact/,
    );
  } finally {
    h.close();
  }
});

test("ISSUE-107: other non-codex kinds still require a reviewer identity before dispatch", async () => {
  for (const agent of ["opencode", "claude", "pi"]) {
    const h = codingRun({
      author: { agent: "opencode", initial: "author" },
      reviewer: { agent, after: "late-reviewer" },
    });
    try {
      const task = await h.run();
      assert.equal(
        (task.coding?.artifacts ?? []).filter((a) => a.role === "review")
          .length,
        0,
      );
      assert.match(JSON.stringify(task.assignments), /unknown reviewer/);
      assert.notEqual(task.state, "completed");
    } finally {
      h.close();
    }
  }
});

// ISSUE-107（review 追補）：從 orchestration 的 `onWorkerSession` 一路到真實 AgentPool 綁定的整合測試。
// 回呼的接線與 `src/main.ts` 的 `startTeamTask` 相同（pane → profile id，再呼叫 `pool.refreshSession`）。
function wiringRun(options: {
  kind: "agy" | "codex";
  turn: "done" | "blocked" | "failed";
}) {
  const repo = codingRepo();
  const dir = mkdtempSync(join(tmpdir(), "agy-wiring-"));
  const codexHome = join(dir, "codex-home");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const uuid = (label: string) => {
    const h = createHash("sha256").update(label).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const lead: AgentRecord = {
    pane_id: "w1:p1",
    terminal_id: "term-lead",
    workspace_id: "w1",
    tab_id: "t1",
    agent: "opencode",
    agent_status: "idle",
    cwd: repo,
    agent_session: { kind: "id", value: "lead-session" },
  };
  const paneId = "w1:p2";
  let prompted = false;
  let rollouts = 0;
  // agy 的 session 在第一個 prompt 處理完才登記；codex 的 Herdr session 另外存在（但不可信、不會被採用）。
  const authorRecord = (): AgentRecord => ({
    pane_id: paneId,
    terminal_id: "term-author",
    workspace_id: "w1",
    tab_id: "t1",
    agent: options.kind,
    agent_status: "idle",
    cwd: repo,
    ...(prompted ? { agent_session: { kind: "id", value: "s1" } } : {}),
  });
  let started = false;
  const agents = () => [lead, ...(started ? [authorRecord()] : [])];
  const prompts: string[] = [];
  const port = {
    listAgentsWithWorkspaceNames: async () => agents(),
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      onPane: (id: string) => void,
    ) => {
      started = true;
      onPane(paneId);
      return authorRecord();
    },
    promptAgent: async (target: string, text: string) => {
      if (target === lead.pane_id) {
        prompts.push(text);
        return;
      }
      prompted = true;
      prompts.push(text);
      writeFileSync(join(repo, "added.txt"), "one\n");
      if (options.kind === "codex") {
        const day = join(codexHome, "sessions", "2026", "11", "05");
        mkdirSync(day, { recursive: true });
        writeFileSync(
          join(day, `rollout-${rollouts++}-${uuid("rollout-session")}.jsonl`),
          text,
        );
      }
    },
    waitAgent: async (target: string) => {
      const record = target === lead.pane_id ? lead : authorRecord();
      if (target === lead.pane_id)
        return { ...record, agent_status: "done" as const };
      if (options.turn === "blocked")
        return { ...record, agent_status: "blocked" as const };
      if (options.turn === "failed")
        return {
          ...record,
          terminal_id: "other-terminal",
          agent_status: "done" as const,
        };
      return { ...record, agent_status: "done" as const };
    },
    readAgent: async (target: string) => {
      const prompt =
        target === lead.pane_id
          ? prompts
              .filter((t) => t.includes("Do not modify files while planning"))
              .at(-1)
          : prompts.filter((t) => t.includes("Coding role: implement")).at(-1);
      if (!prompt) return "historical";
      const planning =
        target === lead.pane_id &&
        prompt.includes("Do not modify files while planning");
      const plans = prompts.filter((t) =>
        t.includes("Do not modify files while planning"),
      ).length;
      const body = planning
        ? JSON.stringify({
            assignments:
              plans === 1
                ? [
                    {
                      id: "impl",
                      workerPaneId: "profile:agy",
                      instruction: "Add the feature",
                      role: "implement",
                      access: "write",
                      writeScope: ["added.txt"],
                    },
                  ]
                : [],
          })
        : target === lead.pane_id
          ? "Local delivery report"
          : JSON.stringify({
              codingResult: { kind: "implement", files: ["added.txt"] },
            });
      return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
    },
    cancelAgent: async () => {},
  };
  const poolFile = join(dir, "pool.json");
  const profiles = [{ id: "agy", kind: options.kind }];
  const pool = new AgentPool(poolFile, profiles, port, ["w1"]);
  pool.select("w1", "agy", true);
  const taskId = "task-wiring";
  const calls: Array<{ pane: string; session: unknown }> = [];
  const profilePanes = new Map<string, string>();
  const store = new TeamTaskStore(join(dir, "tasks"));
  const engine = new TeamTaskEngine(store, port, new Set());
  return {
    pool,
    calls,
    poolFile,
    reopen: () => new AgentPool(poolFile, profiles, port, ["w1"]),
    lead,
    taskId,
    binding: () =>
      (
        JSON.parse(readFileSync(poolFile, "utf8")) as {
          sessions: Record<string, { agent?: { agent_session?: unknown } }>;
        }
      ).sessions["w1/agy"]?.agent?.agent_session,
    run: () =>
      engine.run({
        taskId,
        prompt: "ship the local change",
        lead,
        workers: pool.roster("w1"),
        replan: true,
        coding: true,
        timeoutMs: 500,
        acquireWorker: async (target) => {
          const acquired = await pool.acquire(
            "w1",
            target.pane_id.slice(8),
            lead,
            taskId,
          );
          profilePanes.set(acquired.agent.pane_id, target.pane_id.slice(8));
          return { agent: acquired.agent, continuity: acquired.continuity };
        },
        onWorkerSession: async (worker, session) => {
          calls.push({ pane: worker.pane_id, session });
          const id = profilePanes.get(worker.pane_id);
          if (id) await pool.refreshSession("w1", id, taskId, worker, session);
        },
      }),
    close: () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

test("ISSUE-107: an agy first turn reaches onWorkerSession after it is done, refreshes the real pool binding to s1, and the same profile can be acquired again", async () => {
  const h = wiringRun({ kind: "agy", turn: "done" });
  try {
    await h.run();
    assert.deepEqual(h.calls, [
      { pane: "w1:p2", session: { kind: "id", value: "s1" } },
    ]);
    assert.deepEqual(h.binding(), { kind: "id", value: "s1" });
    h.pool.release(h.taskId);
    const again = await h.reopen().acquire("w1", "agy", h.lead, "task-2");
    assert.equal(again.continuity, "same-session");
    assert.deepEqual(again.agent.agent_session, { kind: "id", value: "s1" });
  } finally {
    h.close();
  }
});

test("ISSUE-107: onWorkerSession never fires for a blocked turn, and the binding stays unknown", async () => {
  const h = wiringRun({ kind: "agy", turn: "blocked" });
  try {
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.equal(h.binding(), undefined);
  } finally {
    h.close();
  }
});

test("ISSUE-107: onWorkerSession never fires for a failed turn, and the binding stays unknown", async () => {
  const h = wiringRun({ kind: "agy", turn: "failed" });
  try {
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.equal(h.binding(), undefined);
  } finally {
    h.close();
  }
});

test("ISSUE-107: onWorkerSession never fires for codex even though its rollout session was observed", async () => {
  const h = wiringRun({ kind: "codex", turn: "done" });
  try {
    const task = await h.run();
    // 前提：codex 的 rollout session 有被觀察到並記成 authorSession（所以守門不是因為「沒有 session」才通過）。
    const implement = task.coding?.artifacts.find(
      (a) => a.role === "implement",
    );
    assert.ok(implement?.authorSession?.value);
    assert.deepEqual(h.calls, []);
    assert.equal(h.binding(), undefined);
  } finally {
    h.close();
  }
});
