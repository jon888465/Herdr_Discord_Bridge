import test from "node:test";
import assert from "node:assert/strict";
import { runTeamTurn } from "../src/team-turn.js";
import type { OrchestrationPort } from "../src/team-orchestration.js";
import type { AgentRecord } from "../src/types.js";

const session = (value: string) => ({ kind: "id", value });

const base: AgentRecord = {
  pane_id: "w17:p1",
  terminal_id: "t-1",
  workspace_id: "w17",
  tab_id: "w17:t1",
  agent: "agy",
  agent_status: "idle",
};

/** 假的 Herdr：送出 prompt 後，輸出裡才有完整的 BEGIN／END 框。 */
function fakePort(waits: AgentRecord[]) {
  let prompt = "";
  const queue = [...waits];
  const port: OrchestrationPort = {
    promptAgent: async (_target, text) => {
      prompt = text;
    },
    waitAgent: async () => queue.shift() ?? waits.at(-1),
    readAgent: async () => {
      if (!prompt) return "";
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
      return `${begin}\n{"assignments": []}\n${end}`;
    },
  };
  return port;
}

const run = (
  agent: AgentRecord,
  waits: AgentRecord[],
  onBlocked?: (agent: AgentRecord) => void,
) =>
  runTeamTurn(agent, "plan", fakePort(waits), 2_000, 20, undefined, onBlocked);

test("an Agent that had no session when the turn was sent may register its first session during the turn", async () => {
  const result = await run(base, [{ ...base, agent_session: session("s1") }]);
  assert.equal(result.state, "done");
  assert.match(result.text, /assignments/);
});

test("an Agent that still has no session at the end of the turn is fine", async () => {
  const result = await run(base, [{ ...base }]);
  assert.equal(result.state, "done");
});

test("once a first session was seen, a different session later in the same turn is an identity change", async () => {
  let blocks = 0;
  await assert.rejects(
    run(
      base,
      [
        { ...base, agent_status: "blocked", agent_session: session("s1") },
        { ...base, agent_status: "idle", agent_session: session("s2") },
      ],
      () => {
        blocks += 1;
      },
    ),
    /Agent identity changed/,
  );
  assert.equal(blocks, 1);
});

test("a session that appears later in the turn and then disappears again is also an identity change", async () => {
  await assert.rejects(
    run(
      base,
      [
        { ...base, agent_status: "blocked", agent_session: session("s1") },
        { ...base, agent_status: "idle" },
      ],
      () => undefined,
    ),
    /Agent identity changed/,
  );
});

test("an Agent that already had a session must keep exactly that session", async () => {
  const known = { ...base, agent_session: session("s1") };
  const ok = await run(known, [{ ...known }]);
  assert.equal(ok.state, "done");
  for (const changed of [
    { ...known, agent_session: session("s2") },
    { ...known, agent_session: undefined },
  ])
    await assert.rejects(run(known, [changed]), /Agent identity changed/);
});

test("the pane, terminal, workspace and Agent kind must still match even when a first session appears", async () => {
  for (const changed of [
    { ...base, pane_id: "w17:p2" },
    { ...base, terminal_id: "t-2" },
    { ...base, workspace_id: "w18" },
    { ...base, agent: "claude" },
  ])
    await assert.rejects(
      run(base, [{ ...changed, agent_session: session("s1") }]),
      /Agent identity changed/,
      JSON.stringify(changed),
    );
});
