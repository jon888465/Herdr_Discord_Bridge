import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";
import type { AgentRecord } from "../src/types.js";
import { runTeamTurn } from "../src/team-turn.js";

const lead: AgentRecord = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  terminal_id: "lead",
  tab_id: "w1:t1",
  agent: "agy",
  agent_status: "idle",
};

test("attach and watch inspect another pane without changing the conversation route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-inspector-"));
  const routing = new RoutingStore(join(dir, "routing.json"));
  const output: string[] = [];
  const context = createConsoleContext((text) => output.push(text));
  routing.bind(context.routing, { workspaceId: "w1" });
  routing.bindWorkspace("w1", { workspaceId: "w1", paneId: lead.pane_id });
  const inspected: string[] = [];
  const runtime = {
    routing,
    config: { allowedWorkspaceIds: [], pollIntervalMs: 1000 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [
        lead,
        { ...lead, pane_id: "w1:p2", terminal_id: "worker" },
      ],
    },
    consoleAgent: {
      inspect: (target: { paneId: string }, mode: string) =>
        inspected.push(`${mode}:${target.paneId}`),
      setMode: () => {},
      start: () => {},
    },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  try {
    await handleCommand("attach", ["w1:p2"], context, runtime);
    await handleCommand("watch", ["w1:p2"], context, runtime);
    await handleCommand("detach", [], context, runtime);
    assert.deepEqual(inspected, ["attach:w1:p2", "watch:w1:p2"]);
    assert.equal(routing.workspaceActiveTarget("w1")?.paneId, lead.pane_id);
  } finally {
    routing.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local non-Codex prompt delivers only its framed answer, with no CLI progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-conversation-"));
  const routing = new RoutingStore(join(dir, "routing.json"));
  const output: string[] = [];
  const context = createConsoleContext((text) => output.push(text));
  routing.bind(context.routing, { workspaceId: "w1" });
  routing.bindWorkspace("w1", { workspaceId: "w1", paneId: lead.pane_id });
  let prompt = "";
  let delivered!: () => void;
  const finished = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const runtime = {
    routing,
    activeStreams: new Set<string>(),
    config: {
      allowedWorkspaceIds: [],
      approvalTimeoutMs: 1000,
      outputLines: 120,
    },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [lead],
      promptAgent: async (_: string, text: string) => {
        prompt = text;
      },
      waitAgent: async () => ({ ...lead, agent_status: "done" }),
      readAgent: async () => {
        if (!prompt) return "CLI private history";
        const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
        const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
        return `CLI tool noise\n${begin}\nThe actual answer\n${end}\nCLI footer`;
      },
    },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
        if (
          text.includes("The actual answer") ||
          text.includes("capture incomplete")
        )
          delivered();
        return context.message;
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  try {
    await handleCommand("ask", ["Explain the change"], context, runtime);
    await finished;
    assert.match(output.join("\n"), /The actual answer/);
    assert.doesNotMatch(
      output.join("\n"),
      /CLI tool noise|CLI footer|CLI private history|BRIDGE_BEGIN/,
    );
  } finally {
    routing.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conversation receiver waits through blocked state without dispatching another prompt", async () => {
  let prompt = "";
  let waits = 0;
  let blocked = 0;
  const result = await runTeamTurn(
    lead,
    "question",
    {
      promptAgent: async (_target, text) => {
        assert.equal(prompt, "");
        prompt = text;
      },
      waitAgent: async () => ({
        ...lead,
        agent_status: ++waits === 1 ? "blocked" : "done",
      }),
      readAgent: async () => {
        if (!prompt) return "old output";
        return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\nContinued answer\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
      },
    },
    2000,
    120,
    undefined,
    () => {
      blocked++;
    },
  );
  assert.equal(result.text, "Continued answer");
  assert.equal(blocked, 1);
});
