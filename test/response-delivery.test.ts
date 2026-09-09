import test from "node:test";
import assert from "node:assert/strict";
import { streamAgent } from "../src/main.js";
import { splitFinalMarkdown } from "../src/final-format.js";

test("long final keeps code fences balanced and Unicode intact", () => {
  const text =
    "結論\n```ts\n" + "const value = '😀';\n".repeat(500) + "```\n最後回答";
  const chunks = splitFinalMarkdown(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length < 1900);
    assert.equal((chunk.match(/^```/gm) || []).length % 2, 0);
    assert.ok(!chunk.includes("\uFFFD"));
  }
  assert.equal(chunks.join("").split("const value").length - 1, 500);
  assert.ok(chunks.at(-1)?.endsWith("最後回答"));
});

test("progress failure cannot prevent structured final delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p1",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "codex",
    agent_status: "idle",
  };
  const sent: string[] = [];
  const runtime = {
    config: { streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "› question\nlatest preview",
    },
    discord: {
      editProgress: async () => {
        throw new Error("message deleted");
      },
      postOutput: async (_m: unknown, text: string) => {
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const transcript = {
    poll: async () => {},
    turn: { completed: true, final: "complete answer" },
  } as unknown as Parameters<typeof streamAgent>[5];
  const task = streamAgent(
    agent,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
    transcript,
  );
  t.mock.timers.tick(2000);
  await task;
  assert.deepEqual(sent, ["complete answer"]);
});

test("failed final delivery is not marked successfully finished", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p1",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "codex",
    agent_status: "done",
  };
  const cards: string[] = [];
  const runtime = {
    config: { streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "",
    },
    discord: {
      editProgress: async (_m: unknown, text: string) => {
        cards.push(text);
      },
      postOutput: async () => {
        throw new Error("offline");
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const transcript = {
    poll: async () => {},
    turn: { completed: true, final: "answer" },
  } as unknown as Parameters<typeof streamAgent>[5];
  const task = streamAgent(
    agent,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
    transcript,
  );
  t.mock.timers.tick(2000);
  await task;
  assert.ok(cards.at(-1)?.includes("delivery failed or was partial"));
  assert.ok(!cards.some((card) => card.includes("final response delivered")));
});
