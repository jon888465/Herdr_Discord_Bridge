import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import { recordFindingBatch, setFindingStatus } from "../src/card-findings.js";
import type { CardPullRequest } from "../src/card-prs.js";
import type { CardWorktree } from "../src/card-worktrees.js";
import {
  mergeCardPullRequest,
  readCardChecks,
  type MergeWiringDeps,
} from "../src/card-merge-wiring.js";
import type { LoadedPolicy } from "../src/policy.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const STALE = "f".repeat(40);

function passedBody(headSha = HEAD): string {
  let body = "# x\n\n## 描述\n內容\n\n## 驗收條件\n- a\n";
  const first = recordFindingBatch(body, {
    round: 1,
    scope: "whole",
    headSha: STALE,
    verdict: "changes_requested",
    findings: [{ severity: "low", path: "src/a.ts", summary: "x" }],
  });
  assert.ok(first.ok);
  body = first.ok ? first.body : body;
  const moved = setFindingStatus(body, "F1", "fixed");
  body = moved.ok ? moved.body : body;
  const second = recordFindingBatch(body, {
    round: 2,
    scope: "whole",
    headSha,
    verdict: "pass",
    findings: [],
  });
  assert.ok(second.ok);
  body = second.ok ? second.body : body;
  const resolved = setFindingStatus(body, "F1", "resolved");
  return resolved.ok ? resolved.body : body;
}

const card = (patch: Partial<Card> = {}): Card => ({
  id: "REQ-20261104-export",
  type: "requirement",
  status: "done",
  title: "加入匯出功能",
  version: 1,
  created: "2026-11-04",
  updated: "2026-11-04",
  body: passedBody(),
  ...patch,
});

const worktree: CardWorktree = {
  cardId: "REQ-20261104-export",
  workspaceId: "w7",
  sourceWorkspaceId: "w1",
  path: "/Users/jon/.herdr/worktrees/repo/card-req-20261104-export",
  repoPath: "/Users/jon/git_wk/repo",
  branch: "card/REQ-20261104-export",
  createdAt: "2026-11-04T01:00:00Z",
};

const pr = (patch: Partial<CardPullRequest> = {}): CardPullRequest => ({
  cardId: "REQ-20261104-export",
  repo: "jon888465/repo",
  number: 42,
  url: "https://github.com/jon888465/repo/pull/42",
  headSha: STALE,
  openedAt: "2026-11-04T01:10:00Z",
  state: "OPEN",
  ...patch,
});

const l2: LoadedPolicy = {
  status: "loaded",
  file: "/cfg/policy.yml",
  policy: { default: "L0", projects: { "local:repo": "L2" } },
};
const l1: LoadedPolicy = {
  ...l2,
  policy: { default: "L0", projects: { "local:repo": "L1" } },
};

function setup(overrides: Partial<MergeWiringDeps["github"]> = {}, rest: Partial<MergeWiringDeps> = {}) {
  const log: string[] = [];
  const merges: Array<{ number: number; method: string; headSha: string }> = [];
  const deps: MergeWiringDeps = {
    worktrees: { latest: () => worktree },
    prs: { forCard: () => [pr()] },
    policy: () => l2,
    github: {
      mergeState: async () => {
        log.push("mergeState");
        return { state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", base: "main" };
      },
      checks: async () => {
        log.push("checks");
        return { conclusion: "success" };
      },
      files: async () => {
        log.push("files");
        return { files: ["src/a.ts", "docs/x.md"], complete: true };
      },
      allowedMethods: async () => {
        log.push("allowedMethods");
        return ["merge", "squash", "rebase"];
      },
      merge: async (_repo, input) => {
        log.push("merge");
        merges.push(input);
      },
      ...overrides,
    },
    ...rest,
  };
  return { deps, log, merges };
}

test("the checks of a card's open PR are read live, and nothing is merged", async () => {
  const { deps, log, merges } = setup({
    checks: async () => {
      log.push("checks");
      return { conclusion: "pending" };
    },
  });
  const result = await readCardChecks(deps, card());
  assert.equal(result.conclusion, "pending");
  assert.deepEqual(log, ["checks"]);
  assert.deepEqual(merges, []);
});

test("reading the checks of a card without an open PR says so", async () => {
  const { deps } = setup({}, { prs: { forCard: () => [pr({ state: "MERGED" })] } });
  await assert.rejects(readCardChecks(deps, card()), /沒有開著的 PR/);
});

test("a card that satisfies every condition is merged once, last, at the head that was checked, by squash", async () => {
  const { deps, log, merges } = setup();
  const run = await mergeCardPullRequest(deps, card(), {});
  assert.equal(run.method, "squash");
  assert.deepEqual(run.pr, { number: 42, url: "https://github.com/jon888465/repo/pull/42", headSha: HEAD });
  assert.deepEqual(merges, [{ number: 42, method: "squash", headSha: HEAD }]);
  assert.equal(log.at(-1), "merge");
  assert.equal(log.filter((entry) => entry === "merge").length, 1);
  for (const read of ["mergeState", "checks", "files"]) assert.ok(log.indexOf(read) < log.indexOf("merge"), read);
});

test("the head that is merged is the live head of the PR, not the one in the local index", async () => {
  const { deps, merges } = setup({}, { prs: { forCard: () => [pr({ headSha: STALE })] } });
  await mergeCardPullRequest(deps, card(), {});
  assert.equal(merges[0].headSha, HEAD);
});

test("a requested method that the repository allows is used", async () => {
  const { deps, merges } = setup();
  await mergeCardPullRequest(deps, card(), { method: "rebase" });
  assert.equal(merges[0].method, "rebase");
});

test("without a worktree record or an open pull request the merge is refused", async () => {
  const noWorktree = setup({}, { worktrees: { latest: () => undefined } });
  await assert.rejects(mergeCardPullRequest(noWorktree.deps, card(), {}), /worktree/);
  const noPr = setup({}, { prs: { forCard: () => [pr({ state: "MERGED" }), pr({ state: "CLOSED" })] } });
  await assert.rejects(mergeCardPullRequest(noPr.deps, card(), {}), /沒有開著的 PR/);
  assert.equal(noPr.merges.length, 0);
});

test("each failing condition refuses the merge, lists every reason, and never calls merge", async () => {
  const cases: Array<[string, Partial<MergeWiringDeps["github"]>, Partial<MergeWiringDeps>, Partial<Card>, RegExp]> = [
    ["policy L1", {}, { policy: () => l1 }, {}, /L2/],
    ["card not done", {}, {}, { status: "in_progress" }, /done/],
    ["review of an older head", {}, {}, { body: passedBody("e".repeat(40)) }, /review 通過的是 head eeeeeeeeeeee/],
    ["red CI", { checks: async () => ({ conclusion: "failure" }) }, {}, {}, /CI/],
    ["pending CI", { checks: async () => ({ conclusion: "pending" }) }, {}, {}, /還在跑/],
    ["sensitive path", { files: async () => ({ files: ["AGENTS.md", "src/a.ts"], complete: true }) }, {}, {}, /敏感路徑.*AGENTS\.md/s],
    ["unknown file list", { files: async () => ({ files: [], complete: false }) }, {}, {}, /無法確認/],
    ["behind main", { mergeState: async () => ({ state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", base: "main" }) }, {}, {}, /落後/],
    ["draft", { mergeState: async () => ({ state: "OPEN", headSha: HEAD, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", base: "main" }) }, {}, {}, /草稿/],
    ["already merged", { mergeState: async () => ({ state: "MERGED", headSha: HEAD, isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", base: "main" }) }, {}, {}, /已經 merge/],
  ];
  for (const [label, github, rest, patch, expected] of cases) {
    const { deps, merges } = setup(github, rest);
    await assert.rejects(mergeCardPullRequest(deps, card(patch), {}), expected, label);
    assert.equal(merges.length, 0, label);
  }
});

test("several failing conditions are all named in one refusal", async () => {
  const { deps } = setup(
    { checks: async () => ({ conclusion: "failure" }), files: async () => ({ files: ["AGENTS.md"], complete: true }) },
    { policy: () => l1 },
  );
  await assert.rejects(mergeCardPullRequest(deps, card({ status: "in_progress" }), {}), (error: unknown) => {
    const text = error instanceof Error ? error.message : "";
    return /L2/.test(text) && /done/.test(text) && /CI/.test(text) && /AGENTS\.md/.test(text);
  });
});

test("a method the repository forbids, or an unknown one, is refused before anything is merged", async () => {
  const { deps, merges } = setup({ allowedMethods: async () => ["merge"] });
  await assert.rejects(mergeCardPullRequest(deps, card(), {}), /squash.*--method|--method/s);
  await assert.rejects(mergeCardPullRequest(deps, card(), { method: "rebase" }), /rebase/);
  await assert.rejects(mergeCardPullRequest(deps, card(), { method: "force" }), /force/);
  assert.equal(merges.length, 0);
});

test("a failure of GitHub while merging is passed through, and nothing is claimed as merged", async () => {
  const { deps } = setup({
    merge: async () => {
      throw new Error("gh pr merge failed: Head branch was modified");
    },
  });
  await assert.rejects(mergeCardPullRequest(deps, card(), {}), /Head branch was modified/);
});

// ISSUE-100：review 判 pass 但留了一筆 low 等級的 open finding（「可另案更新」的備註）時，
// 不該讓整個 L2 流程停下來；medium／high 的 open finding 仍然擋。
function passWithOpenFinding(severity: "low" | "medium" | "high"): string {
  const recorded = recordFindingBatch("# x\n\n## 描述\n內容\n\n## 驗收條件\n- a\n", {
    round: 1,
    scope: "whole",
    headSha: HEAD,
    verdict: "pass",
    findings: [{ severity, path: "docs/a.md", summary: "後文仍寫著下一步" }],
  });
  assert.ok(recorded.ok);
  return recorded.ok ? recorded.body : "";
}

test("ISSUE-100: a pass with only a low-severity open finding is merged, and the finding stays on the card", async () => {
  const { deps, merges } = setup();
  const body = passWithOpenFinding("low");
  await mergeCardPullRequest(deps, card({ body }), {});
  assert.equal(merges.length, 1);
  assert.match(body, /\| low \| open \|/);
});

test("ISSUE-100: a medium or high open finding still refuses the merge, naming how many block it", async () => {
  for (const severity of ["medium", "high"] as const) {
    const { deps, merges } = setup();
    await assert.rejects(
      mergeCardPullRequest(deps, card({ body: passWithOpenFinding(severity) }), {}),
      /1 筆 open 的 finding/,
      severity,
    );
    assert.equal(merges.length, 0);
  }
});

// ISSUE-100：GitHub 剛收到 push／剛開 PR 時 mergeable 會是 UNKNOWN，過幾秒就算好；等一下再讀，不要當成拒絕。
test("ISSUE-100: a merge state that GitHub is still computing is waited out, then the merge goes ahead", async () => {
  let reads = 0;
  const sleeps: number[] = [];
  const { deps, merges } = setup(
    {
      mergeState: async () => {
        reads += 1;
        return reads < 3
          ? { state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", base: "main" }
          : { state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", base: "main" };
      },
    },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  await mergeCardPullRequest(deps, card(), {});
  assert.equal(reads, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(merges.length, 1);
});

test("ISSUE-100: if GitHub never finishes computing, the merge is refused after a bounded number of reads", async () => {
  let reads = 0;
  const { deps, merges } = setup(
    {
      mergeState: async () => {
        reads += 1;
        return { state: "OPEN", headSha: HEAD, isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", base: "main" };
      },
    },
    { sleep: async () => undefined },
  );
  await assert.rejects(mergeCardPullRequest(deps, card(), {}), /還在計算/);
  assert.ok(reads > 1 && reads <= 12, `reads=${reads}`);
  assert.equal(merges.length, 0);
});
