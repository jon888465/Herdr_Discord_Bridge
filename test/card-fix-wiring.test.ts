import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { CardWorktree } from "../src/card-worktrees.js";
import type { OpenFinding } from "../src/card-fix.js";
import { fixCardWorktree, type FixWiringDeps } from "../src/card-fix-wiring.js";
import type { AgentRecord } from "../src/types.js";

const card: Card = {
  id: "REQ-20261104-export",
  type: "requirement",
  status: "done",
  title: "加入匯出功能",
  version: 1,
  created: "2026-11-04",
  updated: "2026-11-04",
  body: "# x\n\n## 描述\n內容\n\n## 驗收條件\n- 可以下載\n",
};

const worktree: CardWorktree = {
  cardId: card.id,
  workspaceId: "w7",
  sourceWorkspaceId: "w1",
  path: "/Users/example/.herdr/worktrees/repo/card-req-20261104-export",
  repoPath: "/Users/example/git_wk/repo",
  branch: `card/${card.id}`,
  createdAt: "2026-11-04T01:00:00Z",
};

const author: AgentRecord = {
  pane_id: "w7:p1",
  terminal_id: "term_author",
  workspace_id: "w7",
  tab_id: "w7:t1",
  agent: "claude",
  agent_status: "idle",
};

const findings: OpenFinding[] = [
  { id: "F1", severity: "high", path: "src/a.ts", summary: "x", round: 1 },
];

function setup(overrides: Partial<FixWiringDeps> = {}) {
  const requests: string[] = [];
  const deps: FixWiringDeps = {
    worktrees: { active: () => worktree },
    assignments: { forCard: () => [{ taskId: "task-1" }, { taskId: "task-2" }] },
    taskLead: (taskId) => (taskId === "task-2" ? author : undefined),
    listAgents: async () => [author],
    flow: {
      panePort: {
        request: async (method, params) => {
          requests.push(`${method}:${JSON.stringify(params)}`);
          throw new Error("stop after the first pane call");
        },
        listAgentsWithWorkspaceNames: async () => [],
      },
      startAgent: async () => author,
      runTurn: async () => ({ state: "done", text: "" }),
      state: async () => ({ head: "a".repeat(40), dirty: false }),
      changedFiles: async () => [],
    },
    ...overrides,
  };
  return { deps, requests };
}

async function refused(overrides: Partial<FixWiringDeps>, reason: RegExp) {
  const { deps } = setup(overrides);
  await assert.rejects(
    fixCardWorktree(deps, card, { round: 1, findings }),
    reason,
  );
}

test("without an active worktree the fix is refused, since the author works there", async () => {
  await refused({ worktrees: { active: () => undefined } }, /沒有作用中的 worktree/);
});

test("the last author must be known, local and still present, otherwise there is no pane to split from", async () => {
  await refused({ assignments: { forCard: () => [] } }, /作者/);
  await refused({ taskLead: () => undefined }, /作者/);
  await refused({ taskLead: () => ({ ...author, machine: "agy-pod" }) }, /本機/);
  await refused({ listAgents: async () => [] }, /不在/);
  await refused({ listAgents: async () => [{ ...author, terminal_id: "term_other" }] }, /不在/);
});

test("the flow gets the worktree, the last author's pane and kind, the round, the findings and the requested kind", async () => {
  const { deps, requests } = setup();
  const result = await fixCardWorktree(deps, card, { agent: "codex", round: 2, findings });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.stage, "open");
  assert.match(requests[0], /^pane\.layout:\{"pane_id":"w7:p1"\}$/);
});

test("the default kind is the last author's kind, as read from the live pane", async () => {
  const started: string[] = [];
  const { deps } = setup({
    flow: {
      ...setup().deps.flow,
      panePort: {
        request: async (method) => {
          if (method === "pane.layout")
            return { layout: { panes: [{ pane_id: "w7:p1", rect: { width: 200, height: 40 } }] } };
          if (method === "pane.split")
            return { pane: { pane_id: "w7:p9", workspace_id: "w7", terminal_id: "term_new" } };
          if (method === "pane.get") return { pane: { terminal_id: "term_new" } };
          return {};
        },
        listAgentsWithWorkspaceNames: async () => [],
      },
      startAgent: async (start) => {
        started.push(start.kind);
        throw new Error("stop");
      },
    },
  });
  await fixCardWorktree(deps, card, { round: 1, findings });
  assert.deepEqual(started, ["claude"]);
});
