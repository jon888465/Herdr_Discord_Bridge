import test from "node:test";
import assert from "node:assert/strict";
import {
  ORIGIN_TTL_MS,
  agentOrigin,
  clearAgentOrigins,
  recordAgentOrigin,
} from "../src/agent-origin.js";
import { deliverToAgentThread } from "../src/main.js";

const agent = {
  terminal_id: "term-dm",
  pane_id: "w5:p3",
  workspace_id: "w5",
  tab_id: "w5:t1",
  agent: "claude",
  agent_status: "idle",
  cwd: process.cwd(),
};

function runtimeWith(mappings: unknown[] = []) {
  const calls: { kind: string; content: string[] }[] = [];
  return {
    calls,
    runtime: {
      routing: { allMappings: () => mappings },
      discord: {
        postDirect: async (_target: unknown, content: string[]) => {
          calls.push({ kind: "thread", content });
        },
        postToChannel: async (_channel: unknown, content: string[]) => {
          calls.push({ kind: "origin", content });
        },
      },
    } as never,
  };
}

test("origin expires after the TTL and ignores objects that cannot send", () => {
  clearAgentOrigins();
  const channel = { send: async () => undefined };
  recordAgentOrigin("t1", channel, 1000);
  recordAgentOrigin("t2", {}, 1000);
  assert.equal(agentOrigin("t1", 1000 + ORIGIN_TTL_MS), channel);
  assert.equal(agentOrigin("t2", 1000), undefined);
  assert.equal(agentOrigin("t1", 1001 + ORIGIN_TTL_MS), undefined);
});

test("a pane without a thread mapping sends back to the Discord conversation that prompted it", async () => {
  clearAgentOrigins();
  const { calls, runtime } = runtimeWith();
  const before = await deliverToAgentThread(
    agent as never,
    ["hi"],
    [],
    runtime,
  );
  assert.equal(before.ok, false);
  assert.match(before.message, /no mapped Discord thread/);
  assert.equal(calls.length, 0);

  recordAgentOrigin(agent.terminal_id, { send: async () => undefined });
  const after = await deliverToAgentThread(
    agent as never,
    ["https://example.com/x"],
    [],
    runtime,
  );
  assert.equal(after.ok, true);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["origin"],
  );
  assert.match(calls[0].content[0], /https:\/\/example\.com\/x/);
});

test("a mapped thread still wins over the conversation origin", async () => {
  clearAgentOrigins();
  recordAgentOrigin(agent.terminal_id, { send: async () => undefined });
  const mapping = {
    discordGuildId: "g",
    discordChannelId: "c",
    discordThreadId: "th",
    workspaceId: "w5",
    updatedAt: "2026-10-21T00:00:00Z",
  };
  const { calls, runtime } = runtimeWith([mapping]);
  const result = await deliverToAgentThread(
    agent as never,
    ["hi"],
    [],
    runtime,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["thread"],
  );
});
