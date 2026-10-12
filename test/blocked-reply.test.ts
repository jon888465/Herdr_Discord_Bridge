import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptMappedAgent } from "../src/main.js";
import { RoutingStore } from "../src/routing.js";

function fixture(status: string, streaming: boolean) {
  const routing = new RoutingStore(
    join(mkdtempSync(join(tmpdir(), "bridge-blocked-")), "routing.json"),
  );
  const routingContext = { guildId: "g", channelId: "c", userId: "u" };
  routing.bind(routingContext, {
    workspaceId: "w1",
    paneId: "w1:p1",
    terminalId: "term",
  } as never);
  const agent = {
    terminal_id: "term",
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t",
    agent: "claude",
    agent_status: status,
  };
  const sent: string[] = [];
  const replies: string[] = [];
  const runtime = {
    config: { allowedWorkspaceIds: [] },
    routing,
    activeStreams: new Set(streaming ? ["term"] : []),
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      sendAgent: async (_pane: string, text: string) => {
        sent.push(text);
      },
    },
    discord: {
      reply: async (_m: unknown, text: string) => {
        replies.push(text);
        return {};
      },
    },
  } as never;
  const context = {
    message: { attachments: new Map() },
    routing: routingContext,
  } as never;
  return { runtime, context, sent, replies };
}

test("text answers a blocked Agent even while its stream is still active", async () => {
  const f = fixture("blocked", true);
  await promptMappedAgent("1", f.context, f.runtime);
  assert.deepEqual(f.sent, ["1"]);
  assert.match(f.replies[0], /已將回答送給等待中的/);
});

test("a working Agent with an active stream is still busy", async () => {
  const f = fixture("working", true);
  await assert.rejects(
    promptMappedAgent("hi", f.context, f.runtime),
    /agent is busy/,
  );
  assert.deepEqual(f.sent, []);
});
