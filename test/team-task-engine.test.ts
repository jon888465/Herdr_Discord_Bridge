import test from "node:test";
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
    journal.schemaVersion = 2;
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
