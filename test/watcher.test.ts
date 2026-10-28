import test from "node:test";
import assert from "node:assert/strict";
import { AgentWatcher, type AgentTransition } from "../src/watcher.js";
import type { HerdrClient } from "../src/herdr.js";
import type { AgentRecord } from "../src/types.js";

const agent = (terminal: string, status: string): AgentRecord =>
  ({
    terminal_id: terminal,
    pane_id: `p-${terminal}`,
    agent_status: status,
  }) as AgentRecord;

test("watcher announces already-blocked agents on the first poll only (ISSUE-042)", async () => {
  let current = [agent("t1", "blocked"), agent("t2", "idle")];
  const herdr = { listAgents: async () => current } as unknown as HerdrClient;
  const watcher = new AgentWatcher(herdr, 100000);
  const seen: AgentTransition[] = [];
  watcher.on("transition", (t: AgentTransition) => seen.push(t));
  const tick = () => (watcher as unknown as { tick(): Promise<void> }).tick();
  await tick();
  assert.deepEqual(
    seen.map((t) => [t.agent.terminal_id, t.from, t.to]),
    [["t1", "unknown", "blocked"]],
  );
  await tick();
  assert.equal(seen.length, 1);
  current = [agent("t1", "blocked"), agent("t2", "working")];
  await tick();
  assert.deepEqual(seen[1] && [seen[1].agent.terminal_id, seen[1].to], [
    "t2",
    "working",
  ]);
});
