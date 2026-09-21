import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamTaskStore } from "../src/team-task-store.js";
import { TeamTaskEngine } from "../src/team-task-engine.js";
import { handleCommand } from "../src/main.js";
import { RoutingStore } from "../src/routing.js";
import { createConsoleContext } from "../src/console.js";
import { parseConsoleCommand } from "../src/console.js";
import type { AgentRecord } from "../src/types.js";

function fixture(
  leadBlocked = false,
  timeoutMs = 3000,
  directQuestion = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "team-questions-"));
  const store = new TeamTaskStore(dir);
  const agents: AgentRecord[] = ["lead", "one", "two"].map((id, i) => ({
    pane_id: `w:p${i}`,
    terminal_id: id,
    workspace_id: "w",
    tab_id: "tab",
    agent: "agy",
    agent_status: "idle",
    agent_session: { kind: "id", value: id },
    state_change_seq: 1,
  }));
  const prompts = new Map<string, string>();
  const snapshots = new Map<string, string>();
  const answers: string[] = [];
  let uncertain = false;
  let planning = 0;
  const port = {
    listAgentsWithWorkspaceNames: async () => structuredClone(agents),
    promptAgent: async (target: string, prompt: string) => {
      prompts.set(target, prompt);
      if (prompt.includes("Do not modify files while planning")) planning++;
      const a = agents.find((a) => a.pane_id === target)!;
      a.agent_status =
        (directQuestion &&
          !prompt.includes("Do not modify files while planning")) ||
        target !== "w:p0" ||
        (leadBlocked &&
          planning === 1 &&
          prompt.includes("Do not modify files while planning"))
          ? "blocked"
          : "done";
      snapshots.set(target, `Question for ${target}?`);
    },
    waitAgent: async (target: string) =>
      structuredClone(agents.find((a) => a.pane_id === target)),
    readAgent: async (target: string) => {
      const a = agents.find((a) => a.pane_id === target)!;
      if (a.agent_status === "blocked") return snapshots.get(target)!;
      const prompt = prompts.get(target);
      if (!prompt) return "old";
      const body =
        target === "w:p0" &&
        prompt.includes("Do not modify files while planning")
          ? JSON.stringify({
              assignments:
                planning === 1 && !directQuestion
                  ? agents.slice(1).map((a) => ({
                      id: a.terminal_id,
                      workerPaneId: a.pane_id,
                      instruction: "Inspect",
                    }))
                  : [],
            })
          : "Verified report";
      return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
    },
    sendAgent: async (
      target: string,
      text: string,
      options: { retries: number },
    ) => {
      assert.equal(options.retries, 0);
      assert.equal(
        store
          .get("task")
          .questions?.find(
            (q) => q.agent.pane_id === target && q.state === "sending",
          )?.state,
        "sending",
      );
      answers.push(`${target}:${text}`);
      if (uncertain) throw new Error("lost acknowledgement");
      agents.find((a) => a.pane_id === target)!.agent_status = "done";
    },
    cancelAgent: async (target: string) => {
      agents.find((a) => a.pane_id === target)!.agent_status = "idle";
    },
  };
  const streams = new Set<string>();
  const engine = new TeamTaskEngine(store, port, streams);
  const done = engine.run({
    taskId: "task",
    origin: { guildId: "g", channelId: "thread-a", threadId: "thread-a" },
    prompt: "Inspect",
    lead: agents[0],
    workers: directQuestion ? [] : agents.slice(1),
    replan: true,
    timeoutMs,
  });
  return {
    dir,
    store,
    agents,
    port,
    engine,
    done,
    answers,
    snapshots,
    streams,
    uncertain: () => {
      uncertain = true;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

test("parallel questions route separately; duplicate replies rejected; original turns finish and replan", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const [one, two] = f.store.get("task").questions!;
    assert.notEqual(one.assignmentId, two.assignmentId);
    const first = f.engine.reply("task", two.id, "Yes  Use B");
    await assert.rejects(
      f.engine.reply("task", two.id, "duplicate"),
      /in progress/,
    );
    await first;
    await assert.rejects(
      f.engine.reply("task", two.id, "duplicate"),
      /not replyable/,
    );
    assert.equal(f.store.get("task").state, "blocked");
    await f.engine.reply("task", one.id, "Use A");
    assert.equal((await f.done).state, "completed");
    assert.deepEqual(f.answers, [
      `${two.agent.pane_id}:Yes  Use B`,
      `${one.agent.pane_id}:Use A`,
    ]);
    assert.equal(f.streams.size, 0);
    assert.equal(
      new TeamTaskStore(f.dir)
        .get("task")
        .questions!.filter((q) => q.state === "answered").length,
      2,
    );
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("Lead planning can ask and continue without a second planning prompt", async () => {
  const f = fixture(true);
  try {
    await until(() => f.store.get("task").questions?.length === 1);
    const q = f.store.get("task").questions![0];
    assert.equal(q.phase, "planning");
    await f.engine.reply("task", q.id, "Proceed");
    await until(() => f.store.get("task").questions?.length === 3);
    for (const q of f.store
      .get("task")
      .questions!.filter((q) => q.state === "pending"))
      await f.engine.reply("task", q.id, "OK");
    assert.equal((await f.done).state, "completed");
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

for (const mode of ["snapshot", "session", "workspace"] as const)
  test(`reject ${mode} mismatch without delivery`, async () => {
    const f = fixture();
    try {
      await until(() => f.store.get("task").questions?.length === 2);
      const q = f.store.get("task").questions![0];
      if (mode === "snapshot")
        f.snapshots.set(q.agent.pane_id, "Different question");
      if (mode === "session")
        f.agents.find((a) => a.pane_id === q.agent.pane_id)!.agent_session = {
          kind: "id",
          value: "replacement",
        };
      const engine =
        mode === "workspace"
          ? new TeamTaskEngine(f.store, f.port, new Set(), undefined, ["other"])
          : f.engine;
      await assert.rejects(engine.reply("task", q.id, "unsafe"));
      assert.equal(f.answers.length, 0);
    } finally {
      await f.engine.cancel("task");
      await f.done;
      f.close();
    }
  });

test("uncertain delivery is durable and cannot retry or reopen the same pane question", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const q = f.store.get("task").questions![0];
    f.uncertain();
    await assert.rejects(
      f.engine.reply("task", q.id, "Yes"),
      /acknowledgement/,
    );
    assert.equal(
      new TeamTaskStore(f.dir).get("task").questions![0].state,
      "unknown",
    );
    await assert.rejects(f.engine.reply("task", q.id, "Yes"));
    f.snapshots.set(q.agent.pane_id, "Changed after uncertain delivery");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.store.get("task").questions!.length, 2);
    assert.equal(f.answers.length, 1);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("restart invalidates pending questions and never resumes or sends an answer", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const recoveredStore = new TeamTaskStore(f.dir);
    // Isolated read of the persisted snapshot; no concurrent writer touches it during assertions.
    const recovered = new TeamTaskEngine(recoveredStore, f.port, new Set());
    await recovered.reconcile();
    const q = recoveredStore.get("task").questions![0];
    assert.equal(q.state, "unknown");
    await assert.rejects(recovered.reply("task", q.id, "Yes"));
    assert.equal(f.answers.length, 0);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("whole team cancel closes questions and frees reservations", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const task = await f.engine.cancel("task");
    await f.done;
    assert.equal(task.state, "cancelled");
    assert.ok(task.questions!.every((q) => q.state !== "pending"));
    assert.equal(f.streams.size, 0);
    await assert.rejects(f.engine.reply("task", task.questions![0].id, "late"));
    assert.equal(f.answers.length, 0);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("console explicit reply preserves whitespace and case", () => {
  assert.deepEqual(
    parseConsoleCommand("team reply task q-id Yes  Use A", "/herdr"),
    { command: "team", args: ["reply", "task", "q-id", "Yes  Use A"] },
  );
});

test("unanswered questions expire with the bounded turn and cannot be replayed", async () => {
  const f = fixture(false, 150);
  try {
    await f.done;
    const t = f.store.get("task");
    assert.equal(t.state, "blocked");
    assert.ok(t.questions!.every((q) => q.state === "stale"));
    await assert.rejects(f.engine.reply("task", t.questions![0].id, "late"));
    assert.equal(f.answers.length, 0);
  } finally {
    await f.engine.cancel("task");
    f.close();
  }
});

test("changed questions supersede old IDs, and the new ID can continue the same assignment", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const old = f.store.get("task").questions![0];
    f.snapshots.set(old.agent.pane_id, "New choice?");
    await until(() => f.store.get("task").questions?.length === 3);
    await assert.rejects(f.engine.reply("task", old.id, "old answer"));
    assert.equal(f.store.get("task").questions![0].state, "stale");
    for (const q of f.store
      .get("task")
      .questions!.filter((q) => q.state === "pending"))
      await f.engine.reply("task", q.id, "new answer");
    assert.equal((await f.done).state, "completed");
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("cancellation waits for an in-flight answer before releasing the session", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const send = f.port.sendAgent;
    let release!: () => void;
    f.port.sendAgent = async (...args) => {
      await new Promise<void>((r) => {
        release = r;
      });
      await send(...args);
    };
    const q = f.store.get("task").questions![0];
    const answer = f.engine.reply("task", q.id, "Yes");
    await until(() => !!release);
    const cancel = f.engine.cancel("task");
    assert.ok(f.streams.size > 0);
    release();
    await answer;
    assert.equal((await cancel).state, "cancelled");
    assert.equal(f.streams.size, 0);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("command handlers enforce workspace and originating Discord thread; console uses explicit IDs", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    const output: string[] = [];
    const context = createConsoleContext((text) => output.push(text));
    const routing = new RoutingStore(join(f.dir, "routing.tmp"));
    routing.bind(context.routing, { workspaceId: "w" });
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
    await handleCommand("team", ["questions", "task"], context, runtime);
    assert.match(output.join("\n"), /Question for/);
    const q = f.store.get("task").questions![0];
    const discordContext = {
      ...context,
      source: undefined,
      routing: {
        guildId: "g",
        channelId: "thread-b",
        threadId: "thread-b",
        userId: "user",
      },
    };
    routing.bind(discordContext.routing, { workspaceId: "w" });
    await assert.rejects(
      handleCommand(
        "team",
        ["reply", "task", q.id, "wrong thread"],
        discordContext,
        runtime,
      ),
      /originating/,
    );
    routing.bind(context.routing, { workspaceId: "other" });
    await assert.rejects(
      handleCommand("team", ["questions", "task"], context, runtime),
      /another workspace/,
    );
    routing.bind(context.routing, { workspaceId: "w" });
    await handleCommand(
      "team",
      ["reply", "task", q.id, "Yes  Use A"],
      context,
      runtime,
    );
    assert.equal(f.answers[0], `${q.agent.pane_id}:Yes  Use A`);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("v1 journals remain readable, next mutation upgrades to v2 and question identity cannot change", async () => {
  const f = fixture();
  try {
    await until(() => f.store.get("task").questions?.length === 2);
    assert.throws(
      () =>
        f.store.update("task", "tamper", (t) => {
          t.questions![0].agent.pane_id = "other";
        }),
      /identity changed/,
    );
    assert.throws(
      () =>
        f.store.update("task", "tamper", (t) => {
          t.questions = [];
        }),
      /history removed/,
    );
    await f.engine.cancel("task");
    await f.done;
    // A real pre-Phase-2 record contains no questions or origin.
    const file = join(f.dir, "task.json");
    const journal = JSON.parse(readFileSync(file, "utf8"));
    journal.schemaVersion = 1;
    journal.events = journal.events.slice(0, 1);
    delete journal.events[0].task.origin;
    writeFileSync(file, JSON.stringify(journal));
    const old = new TeamTaskStore(f.dir);
    assert.equal(old.get("task").state, "planning");
    old.update("task", "upgrade", (t) => {
      t.state = "blocked";
    });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 2);
  } finally {
    f.close();
  }
});

test("zero Worker direct synthesis can ask and finish the original turn", async () => {
  const f = fixture(false, 3000, true);
  try {
    await until(() => f.store.get("task").questions?.length === 1);
    const q = f.store.get("task").questions![0];
    assert.equal(q.phase, "synthesis");
    assert.equal(f.store.get("task").assignments.length, 0);
    await f.engine.reply("task", q.id, "Proceed");
    assert.equal((await f.done).state, "completed");
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});

test("report completion cannot release reservations while answer acknowledgement is in flight", async () => {
  const f = fixture(false, 3000, true);
  try {
    await until(() => f.store.get("task").questions?.length === 1);
    const send = f.port.sendAgent;
    let release!: () => void;
    f.port.sendAgent = async (...args) => {
      await send(...args);
      await new Promise<void>((r) => {
        release = r;
      });
    };
    const q = f.store.get("task").questions![0];
    const reply = f.engine.reply("task", q.id, "Yes");
    await until(() => !!release);
    await new Promise((r) => setTimeout(r, 150));
    assert.notEqual(f.store.get("task").state, "completed");
    assert.ok(f.streams.size > 0);
    release();
    await reply;
    assert.equal((await f.done).state, "completed");
    assert.equal(f.streams.size, 0);
  } finally {
    await f.engine.cancel("task");
    await f.done;
    f.close();
  }
});
