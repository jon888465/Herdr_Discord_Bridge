import test from "node:test";
import assert from "node:assert/strict";
import { startFreshProfileSession } from "../src/card-role-session.js";
import type { AgentRecord } from "../src/types.js";

/**
 * ISSUE-206（Worker 版）：`startFreshProfileSession` 在 `waitUntilReady` 判定就緒之後會「重讀」一次 live 記錄，
 * 拿它當作交出去的 Agent。剛啟動的 codex 載入工作階段時會短暫 working；若重讀剛好落在那一瞬間，
 * 交給引擎的記錄就是 working，引擎立刻丟 `Agent is working`，指派沒有啟動（agent 也還沒綁定）。
 * 現在重讀到 working 時會先等它穩定，再用穩定的記錄（重新核對身分）交出去。
 */
const lead: AgentRecord = {
  pane_id: "w1:p1",
  terminal_id: "lead-term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "idle",
};
const worker: AgentRecord = {
  pane_id: "w1:p2",
  terminal_id: "worker-term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "idle",
};
const profile = { id: "helper", kind: "codex" };

/** workingOn：第幾次（從 1 起算）讀取清單時，這個 Worker 回報 working；其餘回報 idle。 */
function fake(workingOn: (call: number) => boolean) {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      request: async (method: string) =>
        method === "pane.get" ? { pane: { terminal_id: worker.terminal_id } } : {},
      listAgentsWithWorkspaceNames: async () => {
        calls++;
        return [lead, { ...worker, agent_status: workingOn(calls) ? "working" : "idle" }] as AgentRecord[];
      },
      startProfile: async (
        _lead: AgentRecord,
        _profile: unknown,
        _name: string,
        created: (id: string, terminalId?: string) => void,
      ) => {
        created(worker.pane_id, worker.terminal_id);
        return { ...worker };
      },
    },
  };
}

test("baseline: a Worker that is idle the whole time is returned as idle", async () => {
  const f = fake(() => false);
  const started = await startFreshProfileSession(f.port, lead, profile, "fresh");
  assert.equal(started.agent.agent_status, "idle");
  assert.ok(f.calls() >= 1);
});

test("a Worker that flips to working right after the ready check is waited for and returned settled (ISSUE-206)", async () => {
  // 先量出全部 idle 時讀取清單的次數；最後一次就是 startFreshProfileSession 重讀 live 的那一次。
  const baseline = fake(() => false);
  await startFreshProfileSession(baseline.port, lead, profile, "fresh");
  const lastRead = baseline.calls();

  const f = fake((call) => call === lastRead);
  const started = await startFreshProfileSession(f.port, lead, profile, "fresh");
  assert.equal(started.agent.agent_status, "idle", "交出去的記錄不能是 working");
  assert.equal(started.agent.profileId, "helper");
  assert.ok(f.calls() > lastRead, "有重讀來等它穩定");
});

test("a Worker that stays working is still handed over as working so the engine refuses it", async () => {
  const baseline = fake(() => false);
  await startFreshProfileSession(baseline.port, lead, profile, "fresh");
  const lastRead = baseline.calls();

  const f = fake((call) => call >= lastRead);
  const started = await startFreshProfileSession(f.port, lead, profile, "fresh", {
    beforeCreate: () => {},
    claimPane: () => {},
    afterCreate: () => {},
    modelMatches: () => true,
    note: () => {},
    retainLaunchError: () => false,
    settle: { timeoutMs: 40, pollMs: 5 },
  });
  assert.equal(started.agent.agent_status, "working", "逾時仍 working 就照實交出去，由引擎拒絕");
});
