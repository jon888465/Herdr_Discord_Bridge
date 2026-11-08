import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { CardPullRequest } from "../src/card-prs.js";
import type { CardWorktree } from "../src/card-worktrees.js";
import {
  reviewCardPullRequest,
  type ReviewWiringDeps,
} from "../src/card-review-wiring.js";
import type { ReviewFlowInput } from "../src/card-review-flow.js";
import { DEFAULT_POLICY, type LoadedPolicy } from "../src/policy.js";
import type { AgentRecord } from "../src/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
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

const pr = (patch: Partial<CardPullRequest> = {}): CardPullRequest => ({
  cardId: card.id,
  repo: "jon888465/repo",
  number: 42,
  url: "https://github.com/jon888465/repo/pull/42",
  headSha: "f".repeat(40),
  openedAt: "2026-11-04T01:10:00Z",
  state: "OPEN",
  ...patch,
});

const author: AgentRecord = {
  pane_id: "w7:p1",
  terminal_id: "term_author",
  workspace_id: "w7",
  tab_id: "w7:t1",
  agent: "agy",
  agent_status: "done",
};

const l1: LoadedPolicy = {
  status: "loaded",
  file: "/cfg/policy.yml",
  policy: { default: "L0", projects: { "local:repo": "L1" } },
};

interface Setup {
  deps: ReviewWiringDeps;
  seen: { input?: ReviewFlowInput; fetched?: Array<[string, string, number]> };
}

function setup(overrides: Partial<ReviewWiringDeps> = {}): Setup {
  const seen: Setup["seen"] = {};
  const deps: ReviewWiringDeps = {
    worktrees: { active: () => worktree },
    prs: { forCard: () => [pr()] },
    assignments: { forCard: () => [{ taskId: "task-1" }, { taskId: "task-2" }] },
    taskLead: (taskId) => (taskId === "task-2" ? author : undefined),
    policy: () => l1,
    listAgents: async () => [author],
    fetchMaterial: async (repo, number) => {
      (seen.fetched ??= []).push([repo.owner, repo.repo, number]);
      return { headSha: HEAD, files: ["src/a.ts"], diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n" };
    },
    flow: {
      panePort: {
        request: async () => ({}),
        listAgentsWithWorkspaceNames: async () => [],
      },
      startAgent: async () => author,
      runTurn: async () => ({ state: "done", text: "" }),
      fingerprint: async () => "clean",
    },
    ...overrides,
  };
  return { deps, seen };
}

async function refused(overrides: Partial<ReviewWiringDeps>, reason: RegExp) {
  const { deps } = setup(overrides);
  await assert.rejects(reviewCardPullRequest(deps, card, { round: 1 }), reason);
}

test("without an active worktree the review is refused, since the reviewer starts there", async () => {
  await refused({ worktrees: { active: () => undefined } }, /沒有作用中的 worktree/);
});

test("a project whose policy is L0 is refused, because the review reads GitHub", async () => {
  await refused(
    { policy: () => ({ status: "missing", file: "/cfg/policy.yml", policy: DEFAULT_POLICY }) },
    /L0/,
  );
});

test("without an open pull request the review is refused and says to run card pr first", async () => {
  await refused({ prs: { forCard: () => [] } }, /card pr/);
  await refused({ prs: { forCard: () => [pr({ state: "MERGED" }), pr({ state: "CLOSED" })] } }, /card pr/);
});

test("the latest open pull request is the one that gets reviewed", async () => {
  const { deps, seen } = setup({
    prs: { forCard: () => [pr({ number: 7 }), pr({ number: 9 })] },
    flow: setup().deps.flow,
  });
  // 流程會真的被呼叫；讓它在第一步（組提示）以外的地方不被用到：只看 fetchMaterial 收到的編號
  await reviewCardPullRequest(deps, card, { round: 1 }).catch(() => undefined);
  assert.deepEqual(seen.fetched, [["jon888465", "repo", 9]]);
});

test("the author must be known, local and still present, otherwise there is no pane to split from", async () => {
  await refused({ assignments: { forCard: () => [] } }, /作者/);
  await refused({ taskLead: () => undefined }, /作者/);
  await refused({ taskLead: () => ({ ...author, machine: "agy-pod" }) }, /本機/);
  await refused({ listAgents: async () => [] }, /pane 已不在|不在/);
  await refused({ listAgents: async () => [{ ...author, terminal_id: "term_other" }] }, /pane 已不在|不在/);
});

test("a PR whose material cannot be fetched is refused with the reason, before a reviewer is started", async () => {
  let started = false;
  const { deps } = setup({
    fetchMaterial: async () => {
      throw new Error("PR 的 diff 太大；請 Lead 把需求重新切分");
    },
    flow: {
      ...setup().deps.flow,
      startAgent: async () => {
        started = true;
        return author;
      },
    },
  });
  await assert.rejects(reviewCardPullRequest(deps, card, { round: 1 }), /切分/);
  assert.equal(started, false);
});

test("the flow gets the worktree, the author's pane, the requested kind, the round and the material read from GitHub", async () => {
  const requests: string[] = [];
  const { deps } = setup({
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
      fingerprint: async () => "clean",
    },
  });
  const run = await reviewCardPullRequest(deps, card, { agent: "codex", round: 3 });
  assert.equal(run.pr.number, 42);
  assert.equal(run.pr.url, "https://github.com/jon888465/repo/pull/42");
  assert.equal(run.pr.headSha, HEAD, "the head comes from the material that was reviewed, not from the index");
  assert.equal(run.result.ok, false);
  assert.equal(!run.result.ok && run.result.stage, "open");
  assert.match(requests[0], /^pane\.layout:\{"pane_id":"w7:p1"\}$/);
});
