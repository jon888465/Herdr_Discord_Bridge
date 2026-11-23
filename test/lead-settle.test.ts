import test from "node:test";
import assert from "node:assert/strict";
import { settleWorkingAgent } from "../src/lead-settle.js";
import type { AgentRecord } from "../src/types.js";

function agent(status: string): AgentRecord {
  return {
    pane_id: "w1:p1",
    terminal_id: "term_1",
    workspace_id: "w1",
    tab_id: "t1",
    agent: "codex",
    agent_status: status,
  };
}

// 假時鐘：sleep 只推進時間，不真的等。
function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

// ISSUE-185：codex 跳過更新選單後會短暫 working（載入工作階段）；卡片指派 Lead 時不能因為這一瞬間的 working 就丟 busy。
test("a Lead that is only briefly working is waited for and the settled record is returned", async () => {
  const seen = ["working", "working", "idle"];
  let reads = 0;
  const result = await settleWorkingAgent(
    async () => agent(seen[Math.min(reads++, seen.length - 1)]),
    agent("working"),
    { timeoutMs: 10_000, pollMs: 500 },
    fakeClock(),
  );
  assert.equal(result.agent_status, "idle");
  assert.equal(reads, 3);
});

test("a Lead that is not working is returned as is without reading again", async () => {
  let reads = 0;
  const idle = agent("idle");
  const result = await settleWorkingAgent(
    async () => (reads++, agent("working")),
    idle,
    {},
    fakeClock(),
  );
  assert.equal(result, idle);
  assert.equal(reads, 0);
});

test("a Lead that stays working past the timeout is returned still working so the caller can refuse it", async () => {
  const clock = fakeClock();
  const result = await settleWorkingAgent(
    async () => agent("working"),
    agent("working"),
    { timeoutMs: 2_000, pollMs: 500 },
    clock,
  );
  assert.equal(result.agent_status, "working");
  assert.ok(clock.now() >= 2_000 && clock.now() <= 2_500);
});

test("a Lead that disappears or a failing read keeps the last known record instead of throwing", async () => {
  const start = agent("working");
  for (const read of [
    async () => undefined,
    async () => {
      throw new Error("list failed");
    },
  ]) {
    const result = await settleWorkingAgent(read, start, { timeoutMs: 1_000, pollMs: 500 }, fakeClock());
    assert.equal(result, start);
  }
});
