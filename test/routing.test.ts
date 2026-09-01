import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoutingStore, validateAgentTarget } from "../src/routing.js";
import type { AgentRecord, RoutingContext } from "../src/types.js";

const context: RoutingContext = { guildId: "g", channelId: "c", userId: "u" };
const agent: AgentRecord = {
  terminal_id: "term-1",
  agent: "codex",
  agent_name: "builder",
  agent_status: "idle",
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
};

test("routing precedence is thread, then user, then channel", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-routing-"));
  const store = new RoutingStore(path.join(directory, "state.json"));
  store.setChannelDefault(context, { workspaceId: "channel" });
  assert.equal(store.resolve(context)?.workspaceId, "channel");
  store.bind(context, { workspaceId: "user" });
  assert.equal(store.resolve(context)?.workspaceId, "user");
  store.bind({ ...context, threadId: "t1" }, { workspaceId: "thread" });
  assert.equal(
    store.resolve({ ...context, threadId: "t1" })?.workspaceId,
    "thread",
  );
  assert.equal(
    store.resolve({ ...context, threadId: "t2" })?.workspaceId,
    "user",
  );
  store.flush();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("agent target validation rejects cross-workspace and unauthorized targets", () => {
  assert.doesNotThrow(() =>
    validateAgentTarget(agent, { workspaceId: "w1" } as never, ["w1"]),
  );
  assert.throws(
    () => validateAgentTarget(agent, { workspaceId: "w2" } as never, []),
    /stale mapping/,
  );
  assert.throws(
    () => validateAgentTarget(agent, undefined, ["w2"]),
    /not authorized/,
  );
});

test("approval tokens are scoped to the minted Discord context", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-approval-"));
  const store = new RoutingStore(path.join(directory, "state.json"));
  const approval = store.createApproval({
    discordGuildId: "g",
    discordChannelId: "c",
    discordThreadId: "t",
    discordMessageId: "m",
    terminalId: "term-1",
    workspaceId: "w1",
    paneId: "w1:p1",
    agentName: "builder",
    timeoutMs: 60000,
  });
  assert.ok(store.getApproval(approval.token, { ...context, threadId: "t" }));
  assert.equal(
    store.getApproval(approval.token, {
      ...context,
      channelId: "other",
      threadId: "t",
    }),
    undefined,
  );
  assert.equal(
    store.getApproval(approval.token, { ...context, threadId: "other" }),
    undefined,
  );
  store.flush();
  fs.rmSync(directory, { recursive: true, force: true });
});
