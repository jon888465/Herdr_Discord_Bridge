import test from "node:test";
import assert from "node:assert/strict";
import { formatElapsed } from "../src/progress-time.js";
import { streamAgent } from "../src/main.js";

test("elapsed duration handles seconds, minutes and hours", () => {
  assert.equal(formatElapsed(0), "0秒");
  assert.equal(formatElapsed(80999), "1分20秒");
  assert.equal(formatElapsed(3661000), "1小時1分1秒");
});

test("unchanged working preview refreshes every ten seconds; final updates immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p1",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "codex",
    agent_status: "working",
  };
  const cards: { at: number; text: string }[] = [];
  const runtime = {
    config: { streamIntervalMs: 1000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "› question\nunchanged",
    },
    discord: {
      editProgress: async (_m: unknown, text: string) => {
        cards.push({ at: Date.now(), text });
      },
      postOutput: async () => {},
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const source = {
    poll: async () => {},
    turn: { completed: false, final: "answer" },
  };
  const task = streamAgent(
    agent,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
    source as unknown as Parameters<typeof streamAgent>[5],
  );
  for (let second = 1; second <= 12; second++) {
    if (second === 12) source.turn.completed = true;
    t.mock.timers.tick(1000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  await task;
  assert.deepEqual(
    cards.map((c) => c.at),
    [1000, 11000, 12000],
  );
  assert.match(cards[0].text, /working.*已耗時 1秒/);
  assert.match(cards[1].text, /已耗時 11秒/);
  assert.match(cards[2].text, /finished.*總耗時 12秒/);
});
