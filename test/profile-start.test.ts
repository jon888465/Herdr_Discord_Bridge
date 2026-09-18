import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient } from "../src/herdr.js";
import type { AgentRecord } from "../src/types.js";

const lead: AgentRecord = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  terminal_id: "lead",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "idle",
  cwd: "/repo with spaces",
};
test("profile startup uses explicit official socket IDs, literal argv and no mutation retries", async () => {
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options: { retries?: number };
  }> = [];
  const worker = { ...lead, pane_id: "w1:p7", terminal_id: "worker" };
  class Fake extends HerdrClient {
    override async listAgents() {
      return [lead];
    }
    override async listAgentsWithWorkspaceNames() {
      return [lead, worker];
    }
    override async request<T>(
      method: string,
      params: Record<string, unknown> = {},
      options: { retries?: number } = {},
    ): Promise<T> {
      calls.push({ method, params, options });
      return (
        method === "pane.layout"
          ? {
              layout: {
                panes: [
                  { pane_id: lead.pane_id, rect: { width: 160, height: 40 } },
                ],
              },
            }
          : method === "pane.split"
            ? {
                pane: {
                  pane_id: worker.pane_id,
                  workspace_id: worker.workspace_id,
                },
              }
            : {}
      ) as T;
    }
  }
  let recorded = "";
  const result = await new Fake().startProfile(
    lead,
    {
      id: "helper",
      kind: "codex",
      model: "chosen-model",
      modelFlag: "-m",
      args: ["--literal-argument"],
    },
    "worker-name",
    (id) => {
      recorded = id;
    },
  );
  assert.equal(result.pane_id, "w1:p7");
  assert.equal(recorded, "w1:p7");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["pane.layout", "pane.split", "agent.start"],
  );
  assert.equal(calls[1].params.focus, false);
  assert.equal(calls[1].params.cwd, "/repo with spaces");
  assert.equal(calls[1].params.target_pane_id, lead.pane_id);
  assert.deepEqual(calls[2].params.args, [
    "--literal-argument",
    "-m",
    "chosen-model",
  ]);
  assert.ok(
    calls
      .filter((c) => c.method !== "pane.layout")
      .every((c) => c.options.retries === 0),
  );
});
