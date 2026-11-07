import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient, HerdrError } from "../src/herdr.js";
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

// ISSUE-098：剛分割出來的 pane，shell 還沒初始化完時 Herdr 以 agent_pane_busy 拒絕 agent.start
// （與 ISSUE-067 相同，但那次只修了 `card assign --worktree` 的路徑，Worker profile 沒有）。
function busyThenReady(busyTimes: number, error: Error = busy()) {
  const starts: number[] = [];
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
      _params: Record<string, unknown> = {},
    ): Promise<T> {
      if (method === "agent.start") {
        starts.push(Date.now());
        if (starts.length <= busyTimes) throw error;
      }
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
  return { client: new Fake(), starts };
}

function busy(): Error {
  return new HerdrError(
    "agent.start",
    "agent_pane_busy",
    "agent target pane w1:p7 is not an available shell",
  );
}

test("ISSUE-098: a profile Worker whose pane shell is not ready yet is started once the shell is ready", async () => {
  const { client, starts } = busyThenReady(2);
  const result = await client.startProfile(
    lead,
    { id: "helper", kind: "codex" },
    "worker-name",
    () => undefined,
  );
  assert.equal(result.pane_id, "w1:p7");
  assert.equal(starts.length, 3);
  assert.ok(starts[2]! - starts[0]! >= 900, "the retries are spaced out");
});

test("ISSUE-098: only agent_pane_busy is retried; every other start error fails at once", async () => {
  const other = busyThenReady(
    5,
    new HerdrError("agent.start", "agent_not_supported", "no such kind"),
  );
  await assert.rejects(
    other.client.startProfile(
      lead,
      { id: "helper", kind: "codex" },
      "n",
      () => undefined,
    ),
    /agent_not_supported/,
  );
  assert.equal(other.starts.length, 1);
});

test("ISSUE-108: crowded profile startup opens a tab and registers it before starting the Worker", async () => {
  const calls: string[] = [];
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
      calls.push(method);
      if (method === "pane.layout")
        return {
          layout: {
            panes: [{ pane_id: lead.pane_id, rect: { width: 200, height: 7 } }],
          },
        } as T;
      if (method === "tab.create") {
        assert.deepEqual(params, {
          workspace_id: lead.workspace_id,
          cwd: lead.cwd,
          focus: false,
        });
        assert.equal(options.retries, 0);
        return {
          root_pane: {
            pane_id: worker.pane_id,
            workspace_id: worker.workspace_id,
            terminal_id: worker.terminal_id,
          },
        } as T;
      }
      assert.equal(method, "agent.start");
      assert.equal(params.pane_id, worker.pane_id);
      assert.equal(options.retries, 0);
      return {} as T;
    }
  }
  const agent = await new Fake().startProfile(
    lead,
    { id: "helper", kind: "codex" },
    "worker",
    (id) => {
      assert.equal(id, worker.pane_id);
      calls.push("registered");
    },
    () => {
      calls.push("starting");
    },
  );
  assert.equal(agent.pane_id, worker.pane_id);
  assert.deepEqual(calls, [
    "pane.layout",
    "starting",
    "tab.create",
    "registered",
    "agent.start",
  ]);
});
