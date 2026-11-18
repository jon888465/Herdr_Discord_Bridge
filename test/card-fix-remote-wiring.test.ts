import assert from "node:assert/strict";
import test from "node:test";
import { validateProfiles } from "../src/agent-pool.js";
import type { Card } from "../src/card.js";
import type { OpenFinding } from "../src/card-fix.js";
import { fixCardWorktree, type FixWiringDeps } from "../src/card-fix-wiring.js";
import { preflightRoles, type RoleContext } from "../src/card-role-assignment.js";
import type { CardWorktree } from "../src/card-worktrees.js";
import { remoteRoleWork } from "../src/machine-busy.js";
import type { AgentRecord } from "../src/types.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const profiles = validateProfiles([{ id: "agy", kind: "agy", capabilities: ["implementation", "review"] }]);
const writable = [{ id: "pod", kinds: ["agy"], write: true }];
const context: RoleContext = { machineIds: ["pod"], profiles, remoteMachines: writable };
const snapshot = preflightRoles({ fixer: { machine: "pod", agent: "agy" } }, context);

const card: Card = {
  id: "REQ-20261118-remote-fix",
  type: "requirement",
  status: "done",
  title: "遠端修正",
  version: 1,
  created: "2026-11-18",
  updated: "2026-11-18",
  body: "# x\n\n## 描述\n內容\n\n## 驗收條件\n- 可以\n",
  roles: { fixer: { machine: "pod", agent: "agy" } },
};
const worktree: CardWorktree = {
  cardId: card.id,
  workspaceId: "w7",
  sourceWorkspaceId: "w1",
  path: "/local/worktree",
  repoPath: "/local/repo",
  branch: `card/${card.id}`,
  createdAt: "2026-11-18T01:00:00Z",
};
const author: AgentRecord = { pane_id: "w7:p1", terminal_id: "term_author", workspace_id: "w7", tab_id: "w7:t1", agent: "claude", agent_status: "idle" };
const podAgent: AgentRecord = { pane_id: "pod:w3:p1", terminal_id: "pod:t", workspace_id: "pod:w3", tab_id: "", agent: "agy", agent_status: "idle", machine: "pod", profileId: "agy" };
const findings: OpenFinding[] = [{ id: "F1", severity: "high", path: "src/a.ts", summary: "x", round: 1 }];

function setup(overrides: Partial<FixWiringDeps> = {}) {
  const log: string[] = [];
  const local: string[] = [];
  const states = [{ head: A, dirty: false }, { head: B, dirty: false }];
  const deps: FixWiringDeps = {
    worktrees: { active: () => worktree },
    assignments: { forCard: () => [{ taskId: "task-1" }] },
    taskLead: () => author,
    taskRoleSnapshot: () => snapshot,
    listAgents: async () => [author],
    roleContext: context,
    remote: {
      start: async (input) => {
        log.push(`start:${input.machineId}:${input.role}:${[...remoteRoleWork.entries().values()].join(",")}`);
        return { agent: podAgent, continuity: "new-session", afterTurn: async () => void log.push("afterTurn"), cleanup: async () => void log.push("cleanup") };
      },
    },
    flow: {
      panePort: { request: async (m) => (local.push(m), Promise.reject(new Error("本機 pane 不該被使用"))), listAgentsWithWorkspaceNames: async () => [] },
      startAgent: async () => (local.push("startAgent"), author),
      recordRoleStrict: async () => undefined,
      runTurn: async () => ({ state: "done", text: JSON.stringify({ fixed: ["F1"], skipped: [] }) }),
      state: async () => states.shift() ?? { head: B, dirty: false },
      changedFiles: async () => ["src/a.ts"],
    },
    ...overrides,
  };
  return { deps, log, local };
}

test("roles.fixer 指到開放寫入的遠端：走遠端流程，不碰本機 pane，進行中工作在執行期間登記、結束後釋放", async () => {
  const h = setup();
  const result = await fixCardWorktree(h.deps, card, { round: 1, findings });
  assert.ok(result.ok && result.outcome.kind === "fixed");
  assert.deepEqual(h.local, []);
  assert.deepEqual(h.log, ["start:pod:fixer:pod", "afterTurn", "cleanup"]);
  assert.equal(remoteRoleWork.entries().size, 0, "結束後釋放");
});

test("目前配置已不開放寫入或這個 agent 種類、介面不存在、machine 已手動斷線：啟動前拒絕", async () => {
  const cases: Array<[Partial<FixWiringDeps>, RegExp]> = [
    [{ roleContext: { ...context, remoteMachines: [{ id: "pod", kinds: ["agy"] }] } }, /未開放寫入/],
    [{ roleContext: { ...context, remoteMachines: [{ id: "pod", kinds: ["codex"], write: true }] } }, /未開放這個 agent 種類/],
    [{ roleContext: { ...context, remoteMachines: [] } }, /未開放寫入/],
    [{ remote: undefined }, /remote fixer 介面不存在/],
    [{ roleContext: { ...context, isDisconnected: () => true } }, /已手動斷線/],
  ];
  for (const [overrides, reason] of cases) {
    const h = setup(overrides);
    await assert.rejects(fixCardWorktree(h.deps, card, { round: 1, findings }), reason);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.local, []);
    assert.equal(remoteRoleWork.entries().size, 0);
  }
});

test("roles.fixer 在本機或沒有 roles：仍走本機流程（行為不變）", async () => {
  const localCard: Card = { ...card };
  delete localCard.roles;
  const h = setup({ taskRoleSnapshot: () => undefined });
  const result = await fixCardWorktree(h.deps, localCard, { round: 1, findings });
  assert.ok(!result.ok && result.stage === "open", "本機流程在開 pane 時失敗（假的 pane 介面）");
  assert.ok(h.local.length > 0, "本機的 pane 被呼叫");
  assert.deepEqual(h.log, [], "沒有走遠端");
});
