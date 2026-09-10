import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../src/main.js";
import { createConsoleContext, parseConsoleCommand } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";
import { ConsoleAgent } from "../src/console-agent.js";
import type { AgentRecord } from "../src/types.js";

test("selecting agy from a fresh console makes current resolve it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-local-agent-"));
  const routing = new RoutingStore(join(dir, "state.json"));
  const output: string[] = [];
  const context = createConsoleContext((text) => output.push(text));
  const agent = {
    workspace_id: "w2",
    pane_id: "w2:p6",
    terminal_id: "term",
    agent: "agy",
    agent_status: "idle",
  };
  const runtime = {
    routing,
    config: { allowedWorkspaceIds: [] },
    activeStreams: new Set(),
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      listWorkspaces: async () => [{ workspace_id: "w2" }],
    },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  try {
    await handleCommand("agent", ["use", "w2:p6"], context, runtime);
    await handleCommand("current", [], context, runtime);
    assert.match(output.at(-1)!, /w2:p6/);
    assert.doesNotMatch(output.at(-1)!, /No Agent is selected/);
    routing.flush();
    const reloaded = new RoutingStore(join(dir, "state.json"));
    assert.equal(reloaded.resolve(context.routing)?.workspaceId, "w2");
    assert.equal(reloaded.workspaceActiveTarget("w2")?.paneId, "w2:p6");
  } finally {
    routing.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console prompts preserve case and whitespace, controls remain commands", () => {
  assert.deepEqual(parseConsoleCommand("Yes  Use A", "/herdr"), {
    command: "ask",
    args: ["Yes  Use A"],
  });
  assert.deepEqual(parseConsoleCommand("ask Yes  Use A", "/herdr"), {
    command: "ask",
    args: ["Yes  Use A"],
  });
  assert.deepEqual(parseConsoleCommand("current", "/herdr"), {
    command: "current",
    args: [],
  });
  assert.deepEqual(parseConsoleCommand("ask current", "/herdr"), {
    command: "ask",
    args: ["current"],
  });
});

function fixture() {
  let live: AgentRecord = {
    workspace_id: "w2",
    pane_id: "w2:p6",
    terminal_id: "term",
    tab_id: "w2:t1",
    agent: "agy",
    agent_status: "idle",
    agent_session: { kind: "id", value: "session" },
    state_change_seq: 1,
  };
  let selection = { workspaceId: "w2", paneId: "w2:p6" };
  let visible = "Ready";
  const output: string[] = [];
  const sent: string[][] = [];
  const port = {
    listAgentsWithWorkspaceNames: async () => [live],
    readAgent: async (_pane: string, source?: string, lines?: number) => {
      assert.equal(source, "visible");
      assert.equal(lines, 40);
      return visible;
    },
    sendAgent: async (pane: string, text: string) => {
      sent.push(["answer", pane, text]);
    },
    promptAgent: async (pane: string, text: string) => {
      sent.push(["prompt", pane, text]);
      live = { ...live, agent_status: "working" };
    },
  };
  const session = new ConsoleAgent(
    port,
    async () => selection,
    ["w2"],
    (text) => output.push(text),
  );
  return {
    session,
    output,
    sent,
    port,
    state(status: string, text: string, seq = 2) {
      live = { ...live, agent_status: status, state_change_seq: seq };
      visible = text;
    },
    replace() {
      live = { ...live, terminal_id: "new-term" };
    },
    select(pane: string) {
      selection = { ...selection, paneId: pane };
      live = { ...live, pane_id: pane };
    },
  };
}

test("selected agy displays idle, working, blocked and final snapshots without another ask", async () => {
  const f = fixture();
  await f.session.tick();
  assert.match(f.output.at(-1)!, /Ready/);
  await f.session.tick();
  assert.equal(f.output.length, 1);
  for (const [status, text] of [
    ["working", "Progress"],
    ["blocked", "Choose A or B?"],
    ["done", "Completed result"],
  ]) {
    f.state(status, text);
    await f.session.tick();
    assert.ok(f.output.at(-1)!.includes(text));
  }
  assert.deepEqual(f.sent, []);
});

test("blocked answer goes once to displayed agy; next question can be answered", async () => {
  const f = fixture();
  f.state("blocked", "Choose A or B?");
  await f.session.tick();
  await f.session.send("A  Please");
  assert.deepEqual(f.sent, [["answer", "w2:p6", "A  Please"]]);
  await assert.rejects(f.session.send("A"), /already sent/);
  f.state("working", "Continuing", 3);
  await f.session.tick();
  f.state("blocked", "Next question?", 4);
  await f.session.tick();
  await f.session.send("Yes");
  assert.equal(f.sent.length, 2);
});

test("unseen or changed question is shown and requires a fresh answer", async () => {
  const f = fixture();
  f.state("blocked", "First question");
  await assert.rejects(f.session.send("yes"), /not yet shown/);
  f.state("blocked", "Different question", 3);
  await assert.rejects(f.session.send("yes"), /question changed/);
  assert.deepEqual(f.sent, []);
  assert.match(f.output.at(-1)!, /Different question/);
});

test("idle follow-up works; working and unknown do not accept another task", async () => {
  const f = fixture();
  await f.session.send("Use  A");
  assert.deepEqual(f.sent, [["prompt", "w2:p6", "Use  A"]]);
  await assert.rejects(f.session.send("more"), /working/);
  f.state("unknown", "Unclassified screen");
  await assert.rejects(f.session.send("more"), /unknown/);
});

test("identity replacement fails closed until explicit reselection", async () => {
  const f = fixture();
  await f.session.tick();
  f.replace();
  await assert.rejects(f.session.send("hello"), /session changed/);
  f.session.reset();
  await f.session.tick();
  await f.session.send("hello");
  assert.equal(f.sent.length, 1);
});

test("selection during read discards old output; read failure recovers", async () => {
  const f = fixture();
  let resolve!: (s: string) => void;
  f.port.readAgent = async () =>
    new Promise<string>((r) => {
      resolve = r;
    });
  const pending = f.session.tick();
  while (!resolve) await Promise.resolve();
  f.select("w2:p7");
  f.session.reset();
  resolve("old output");
  await pending;
  assert.equal(f.output.length, 0);
  f.port.readAgent = async () => {
    throw new Error("offline");
  };
  await f.session.tick();
  await f.session.tick();
  assert.equal(f.output.filter((text) => text.includes("offline")).length, 1);
  f.port.readAgent = async () => "new pane output";
  await f.session.tick();
  assert.match(f.output.at(-1)!, /new pane output/);
});

test("unauthorized selection cannot be read or sent", async () => {
  const f = fixture();
  const denied = new ConsoleAgent(
    f.port,
    async () => ({ workspaceId: "private", paneId: "private:p1" }),
    ["w2"],
    () => {},
  );
  await assert.rejects(denied.send("hello"), /not authorized/);
  assert.deepEqual(f.sent, []);
});

test("switching during answer validation neither sends nor displays old question", async () => {
  const f = fixture();
  f.state("blocked", "Old question");
  await f.session.tick();
  let resolve!: (s: string) => void;
  f.port.readAgent = async () => new Promise<string>((r) => { resolve = r; });
  const pending = f.session.send("Yes");
  while (!resolve) await Promise.resolve();
  const before = f.output.length;
  f.select("w2:p7"); f.session.reset(); resolve("Old question");
  await assert.rejects(pending, /no longer current/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.output.length, before);
});

test("known control commands stay usable while selected Agent is working or blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-controls-"));
  const routing = new RoutingStore(join(dir, "state.json"));
  const f = fixture();
  const output: string[] = [];
  const context = createConsoleContext((s) => output.push(s));
  routing.bind(context.routing, { workspaceId: "w2" });
  routing.bindWorkspace("w2", {
    workspaceId: "w2",
    paneId: "w2:p6",
    agentName: "agy",
  });
  const runtime = {
    routing,
    consoleAgent: f.session,
    activeStreams: new Set(["term"]),
    config: { allowedWorkspaceIds: [] },
    herdr: { ...f.port, listWorkspaces: async () => [{ workspace_id: "w2" }] },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  try {
    for (const status of ["working", "blocked"]) {
      f.state(status, "Question");
      await f.session.tick();
      await handleCommand("current", [], context, runtime);
      assert.match(output.at(-1)!, /w2:p6/);
      await handleCommand("agent", [], context, runtime);
      assert.match(output.at(-1)!, /agy/);
      await handleCommand("help", [], context, runtime);
      assert.doesNotMatch(output.at(-1)!, /\/herdr/);
      assert.match(output.at(-1)!, /Herdr Bridge Console 使用說明/);
      assert.match(output.at(-1)!, /agent use <pane>/);
      assert.match(output.at(-1)!, /本機 Agent 互動/);
    }
    await handleCommand("ask", ["Yes"], context, runtime);
    assert.deepEqual(f.sent, [["answer", "w2:p6", "Yes"]]);
  } finally {
    routing.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop cancels pending output and failed answer is not automatically retried", async () => {
  const f = fixture();
  f.state("blocked", "Confirm?");
  await f.session.tick();
  let calls = 0;
  f.port.sendAgent = async () => {
    calls++;
    throw new Error("delivery uncertain");
  };
  await assert.rejects(f.session.send("Yes"), /uncertain/);
  await assert.rejects(f.session.send("Yes"), /already sent/);
  assert.equal(calls, 1);
  let resolve!: (s: string) => void;
  f.port.readAgent = async () =>
    new Promise<string>((r) => {
      resolve = r;
    });
  const pending = f.session.tick();
  while (!resolve) await Promise.resolve();
  const before = f.output.length;
  f.session.stop();
  resolve("late output");
  await pending;
  assert.equal(f.output.length, before);
});

test("normal submit callback preserves existing capture path but blocked uses answer API", async () => {
  const f = fixture();
  const submitted: string[] = [];
  const submit = async (_: AgentRecord, text: string) => {
    submitted.push(text);
  };
  await f.session.send("prompt", submit);
  assert.deepEqual(submitted, ["prompt"]);
  f.state("blocked", "Question?");
  await f.session.tick();
  await f.session.send("answer", submit);
  assert.deepEqual(submitted, ["prompt"]);
  assert.deepEqual(f.sent, [["answer", "w2:p6", "answer"]]);
});
