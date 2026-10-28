import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  HookEventStore,
  hookEvents,
  parseHookEvent,
  sendHookEvent,
  startHookServer,
} from "../src/hook-events.js";
import { streamAgent } from "../src/main.js";

test("parseHookEvent accepts Stop and rejects malformed input (ISSUE-045)", () => {
  assert.deepEqual(
    parseHookEvent({
      event: "Stop",
      sessionId: "s1",
      message: "hi",
      paneId: "w1:p1",
    }),
    {
      event: "Stop",
      sessionId: "s1",
      paneId: "w1:p1",
      promptId: undefined,
      message: "hi",
    },
  );
  assert.equal(
    parseHookEvent({ event: "Other", sessionId: "s", message: "" }),
    undefined,
  );
  assert.equal(
    parseHookEvent({ event: "Stop", sessionId: "", message: "" }),
    undefined,
  );
  assert.equal(parseHookEvent({ event: "Stop", sessionId: "s" }), undefined);
  assert.equal(parseHookEvent(null), undefined);
});

test("HookEventStore only returns events at or after the turn started", () => {
  const store = new HookEventStore();
  store.record({ event: "Stop", sessionId: "s1", message: "old" }, 1000);
  assert.equal(store.stopSince("s1", 2000), undefined);
  store.record({ event: "Stop", sessionId: "s1", message: "new" }, 3000);
  assert.equal(store.stopSince("s1", 2000)?.message, "new");
  assert.equal(store.stopSince("other", 0), undefined);
  assert.equal(store.stopSince(undefined, 0), undefined);
});

test("hook socket delivers a Stop event into the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-"));
  const path = join(dir, "h.sock");
  const store = new HookEventStore();
  const stop = await startHookServer(store, path);
  try {
    assert.equal(
      await sendHookEvent(
        { event: "Stop", sessionId: "sx", message: "答案" },
        path,
      ),
      true,
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.stopSince("sx", 0)?.message, "答案");
    assert.equal(
      await sendHookEvent(
        { event: "Stop", sessionId: "sx", message: "" },
        join(dir, "none.sock"),
      ),
      false,
    );
  } finally {
    stop();
  }
});

test("Claude Stop hook completes the stream without the screen footer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p1",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "claude",
    agent_status: "working",
    agent_session: { kind: "id", value: "sess-hook" },
  };
  const sent: string[] = [];
  const runtime = {
    config: { streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "❯ question\n\n⏺ partial",
    },
    discord: {
      editProgress: async () => {},
      postOutput: async (_m: unknown, text: string) => {
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const task = streamAgent(
    agent as never,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
  );
  hookEvents.record({
    event: "Stop",
    sessionId: "sess-hook",
    message: "hook final",
  });
  t.mock.timers.tick(2000);
  await task;
  assert.deepEqual(sent, ["hook final"]);
});
