import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { AgentStartPort } from "../src/agent-start.js";
import {
  reviewerAgentName,
  runCardReview,
  type ReviewFlowDeps,
  type ReviewFlowInput,
} from "../src/card-review-flow.js";
import type { AgentRecord } from "../src/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const WORKTREE = "/Users/jon/.herdr/worktrees/repo/card-req-20261104-export";

const BODY = [
  "# 加入匯出功能",
  "",
  "## 描述",
  "把報表匯出成 CSV。",
  "",
  "## 驗收條件",
  "- 可以下載 CSV",
  "- 欄位順序固定",
  "",
].join("\n");

const card: Card = {
  id: "REQ-20261104-export",
  type: "requirement",
  status: "done",
  title: "加入匯出功能",
  version: 1,
  created: "2026-11-04",
  updated: "2026-11-04",
  body: BODY,
};

const input = (patch: Partial<ReviewFlowInput> = {}): ReviewFlowInput => ({
  card,
  round: 1,
  scope: "whole",
  pr: { number: 42, headSha: HEAD },
  material: {
    files: ["src/export.ts"],
    diff: "diff --git a/src/export.ts b/src/export.ts\n+export const x = 1;\n",
  },
  author: { agent: "agy", paneId: "w5:p1", workspaceId: "w5" },
  worktreePath: WORKTREE,
  ...patch,
});

const goodReply = JSON.stringify({
  verdict: "pass",
  criteria: [
    { index: 1, status: "met" },
    { index: 2, status: "met" },
  ],
  findings: [],
});

const reviewer = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w5:p9",
  terminal_id: "term_new",
  workspace_id: "w5",
  tab_id: "w5:t1",
  agent: "claude",
  agent_status: "idle",
  ...patch,
});

interface Setup {
  deps: ReviewFlowDeps;
  log: string[];
  prompts: string[];
}

function setup(
  options: {
    fingerprints?: Array<string | Error>;
    start?: () => AgentRecord | Error;
    turn?: () => { state: "done" | "blocked"; text: string } | Error;
    split?: () => unknown;
    closeFails?: boolean;
    /** 啟動後輪詢用的 Agent 清單（每次呼叫回傳一次；用完後重複最後一筆）。 */
    listing?: Array<AgentRecord[]>;
  } = {},
): Setup {
  const log: string[] = [];
  const prompts: string[] = [];
  const fingerprints = [...(options.fingerprints ?? ["clean", "clean"])];
  const panePort: AgentStartPort = {
    request: async (method, params) => {
      log.push(
        method === "pane.split"
          ? `pane.split:${JSON.stringify(params)}`
          : method,
      );
      if (method === "pane.layout")
        return {
          layout: {
            panes: [{ pane_id: "w5:p1", rect: { width: 200, height: 40 } }],
          },
        };
      if (method === "pane.split")
        return (
          options.split?.() ?? {
            pane: {
              pane_id: "w5:p9",
              workspace_id: "w5",
              terminal_id: "term_new",
            },
          }
        );
      if (method === "pane.get")
        return { pane: { pane_id: "w5:p9", terminal_id: "term_new" } };
      if (method === "pane.close") {
        if (options.closeFails) throw new Error("close refused");
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
    listAgentsWithWorkspaceNames: async () => {
      log.push("listAgents");
      const queue = options.listing;
      if (!queue || queue.length === 0) return [];
      return queue.length > 1 ? (queue.shift() as AgentRecord[]) : queue[0];
    },
  };
  const deps: ReviewFlowDeps = {
    panePort,
    readyTimeoutMs: 60,
    readyPollMs: 5,
    startAgent: async (start) => {
      log.push(`startAgent:${start.kind}@${start.paneId}:${start.name}`);
      const result = options.start?.() ?? reviewer({ agent: start.kind });
      if (result instanceof Error) throw result;
      return result;
    },
    runTurn: async (_agent, prompt) => {
      log.push("runTurn");
      prompts.push(prompt);
      const result = options.turn?.() ?? { state: "done", text: goodReply };
      if (result instanceof Error) throw result;
      return result;
    },
    fingerprint: async (cwd) => {
      log.push(`fingerprint:${cwd}`);
      const next = fingerprints.shift() ?? "clean";
      if (next instanceof Error) throw next;
      return next;
    },
    timeoutMs: 1000,
  };
  return { deps, log, prompts };
}

const methods = (log: string[]): string[] =>
  log.map((entry) => entry.split(":")[0]);

test("a clean review opens a fresh pane, starts a different kind, runs one turn, checks the tree before and after, and closes the pane", async () => {
  const { deps, log, prompts } = setup();
  const result = await runCardReview(deps, input());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ok && result.batch.verdict, "pass");
  assert.equal(result.ok && result.reviewerKind, "claude");
  assert.equal(result.ok && result.sameKind, false);
  assert.equal(result.ok && result.closed, true);
  assert.deepEqual(
    methods(log),
    [
      "fingerprint",
      "pane.layout",
      "pane.split",
      "startAgent",
      "runTurn",
      "fingerprint",
      "pane.get",
      "pane.close",
    ],
    log.join("\n"),
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /<<<REVIEW_DATA id=REQ-20261104-export/);
  assert.match(log[0], new RegExp(WORKTREE));
  const split = log.find((entry) => entry.startsWith("pane.split"));
  assert.match(split ?? "", /"cwd":"\/Users\/jon\/\.herdr\/worktrees\/repo\/card-req-20261104-export"/);
  assert.match(split ?? "", /"target_pane_id":"w5:p1"/);
});

test("the reviewer's agent name is valid for Herdr, short, and stable for a card and round", () => {
  const name = reviewerAgentName("REQ-20261104-sensitive-accept-and-more", 3);
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(name, reviewerAgentName("REQ-20261104-sensitive-accept-and-more", 3));
  assert.notEqual(name, reviewerAgentName("REQ-20261104-sensitive-accept-and-more", 4));
  assert.notEqual(name, reviewerAgentName("REQ-20261104-sensitive-other", 3));
});

test("an explicitly requested kind is used and reported as the author's own kind when it is", async () => {
  const { deps, log } = setup();
  const result = await runCardReview(deps, input({ requestedKind: "agy" }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.reviewerKind, "agy");
  assert.equal(result.ok && result.sameKind, true);
  assert.ok(log.some((entry) => entry.startsWith("startAgent:agy@")));
});

test("when the prompt cannot be built nothing is opened or started", async () => {
  const { deps, log } = setup();
  const result = await runCardReview(
    deps,
    input({ card: { ...card, body: "# x\n\n## 描述\nx\n" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.stage, "prompt");
  assert.match(!result.ok ? result.error : "", /驗收條件/);
  assert.deepEqual(log, []);
});

test("an invalid requested kind or a failing tree fingerprint stops before a pane is opened", async () => {
  const kind = setup();
  const badKind = await runCardReview(kind.deps, input({ requestedKind: "Bad Kind" }));
  assert.equal(!badKind.ok && badKind.stage, "kind");
  assert.deepEqual(kind.log, []);

  const print = setup({ fingerprints: [new Error("git failed")] });
  const noPrint = await runCardReview(print.deps, input());
  assert.equal(!noPrint.ok && noPrint.stage, "fingerprint");
  assert.equal(print.log.some((entry) => entry.startsWith("pane.")), false);
});

test("when the pane cannot be opened nothing is started and there is nothing to close", async () => {
  const { deps, log } = setup({ split: () => ({ pane: { pane_id: "w5:p9", workspace_id: "w5" } }) });
  const result = await runCardReview(deps, input());
  assert.equal(!result.ok && result.stage, "open");
  assert.equal(log.some((entry) => entry.startsWith("startAgent")), false);
  assert.equal(log.includes("pane.close"), false);
});

test("when the Agent cannot start the pane is closed and the failure is reported, without switching kind", async () => {
  const { deps, log } = setup({ start: () => new Error("agent.start: unsupported_agent_kind") });
  const result = await runCardReview(deps, input());
  assert.equal(!result.ok && result.stage, "start");
  assert.match(!result.ok ? result.error : "", /unsupported_agent_kind/);
  assert.equal(log.filter((entry) => entry.startsWith("startAgent")).length, 1);
  assert.equal(log.includes("runTurn"), false);
  assert.ok(log.includes("pane.close"));
});

test("a reviewer that is not ready (for example waiting at a trust prompt) gives inconclusive and its pane is closed; nobody confirms the prompt", async () => {
  const { deps, log } = setup({ start: () => reviewer({ agent_status: "blocked" }) });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", /blocked/);
  assert.equal(log.includes("runTurn"), false);
  assert.ok(log.includes("pane.close"));
});

test("a turn that fails, gets blocked, or returns something unusable gives inconclusive with the reason, and the pane is still closed", async () => {
  const cases: Array<[string, Parameters<typeof setup>[0], RegExp]> = [
    ["throws", { turn: () => new Error("Agent identity changed while waiting") }, /identity changed/],
    ["blocked", { turn: () => ({ state: "blocked", text: "" }) }, /卡住|blocked/],
    ["not json", { turn: () => ({ state: "done", text: "看起來不錯" }) }, /JSON/],
    ["bad shape", { turn: () => ({ state: "done", text: JSON.stringify({ verdict: "pass" }) }) }, /criteria/],
  ];
  for (const [label, options, reason] of cases) {
    const { deps, log } = setup(options);
    const result = await runCardReview(deps, input());
    assert.ok(result.ok, label);
    assert.equal(result.ok && result.batch.verdict, "inconclusive", label);
    assert.deepEqual(result.ok && result.batch.findings, [], label);
    assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", reason, label);
    assert.ok(log.includes("pane.close"), label);
  }
});

test("a reviewer that changed the working tree makes even a pass inconclusive, with its findings dropped", async () => {
  const { deps } = setup({ fingerprints: ["clean", "dirty"] });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  assert.deepEqual(result.ok && result.batch.findings, []);
  assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", /工作樹/);
});

test("a tree fingerprint that cannot be read after the review is also inconclusive", async () => {
  const { deps } = setup({ fingerprints: ["clean", new Error("git failed")] });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", /工作樹/);
});

test("a pane that cannot be closed is reported but does not change the review result", async () => {
  const { deps } = setup({ closeFails: true });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "pass");
  assert.equal(result.ok && result.closed, false);
  assert.match(result.ok ? (result.closeNote ?? "") : "", /close refused/);
});

test("findings, downgrades and the per-criterion results of a usable reply are carried through", async () => {
  const reply = JSON.stringify({
    verdict: "pass",
    criteria: [
      { index: 1, status: "unmet", note: "沒有下載按鈕" },
      { index: 2, status: "met" },
    ],
    findings: [{ severity: "high", path: "src/export.ts", summary: "缺少錯誤處理" }],
  });
  const { deps } = setup({ turn: () => ({ state: "done", text: reply }) });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "changes_requested");
  assert.match(result.ok ? (result.downgraded ?? "") : "", /未達成/);
  assert.equal(result.ok && result.batch.findings.length, 1);
  assert.equal(result.ok && result.criteria[0].status, "unmet");
  assert.equal(result.ok && result.inconclusiveReason, undefined);
});

const working = (status: string) => reviewer({ agent_status: status });

test("an Agent that is still starting up (working) is waited for until it is idle, and then the review goes on with the fresh record", async () => {
  const { deps, log } = setup({
    start: () => working("working"),
    listing: [[working("working")], [working("working")], [working("idle")]],
  });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ok && result.batch.verdict, "pass");
  assert.ok(log.includes("runTurn"));
  assert.equal(log.filter((entry) => entry === "listAgents").length >= 3, true);
  assert.ok(log.includes("pane.close"));
});

test("an Agent whose status is still unknown right after start is waited for too", async () => {
  const { deps, log } = setup({
    start: () => working("unknown"),
    listing: [[working("idle")]],
  });
  const result = await runCardReview(deps, input());
  assert.equal(result.ok && result.batch.verdict, "pass");
  assert.ok(log.includes("runTurn"));
});

test("an Agent that is already idle is not polled at all", async () => {
  const { deps, log } = setup();
  await runCardReview(deps, input());
  assert.equal(log.includes("listAgents"), false);
});

test("an Agent that turns out to be blocked while starting stops the wait at once, naming start-up prompts as the usual cause", async () => {
  const { deps, log } = setup({
    start: () => working("working"),
    listing: [[working("working")], [working("blocked")]],
  });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  const reason = result.ok ? (result.inconclusiveReason ?? "") : "";
  assert.match(reason, /blocked/);
  assert.match(reason, /更新|信任/);
  assert.equal(log.includes("runTurn"), false);
  assert.ok(log.includes("pane.close"));
});

test("an Agent that never becomes idle in time gives inconclusive with its last status, not a guess about trust prompts", async () => {
  const { deps, log } = setup({
    start: () => working("working"),
    listing: [[working("working")]],
  });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  const reason = result.ok ? (result.inconclusiveReason ?? "") : "";
  assert.match(reason, /working/);
  assert.match(reason, /沒有就緒/);
  assert.doesNotMatch(reason, /信任提示/);
  assert.equal(log.includes("runTurn"), false);
  assert.ok(log.includes("pane.close"));
});

test("a reviewer pane that disappears while it is being waited for is reported, and the close is still attempted", async () => {
  const { deps, log } = setup({
    start: () => working("working"),
    listing: [[]],
  });
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", /不見|消失|不在/);
  assert.ok(log.includes("pane.close"));
});

test("a failing agent listing while waiting is inconclusive with the reason, and the pane is still closed", async () => {
  const { deps, log } = setup({ start: () => working("working") });
  deps.panePort.listAgentsWithWorkspaceNames = async () => {
    throw new Error("socket closed");
  };
  const result = await runCardReview(deps, input());
  assert.ok(result.ok);
  assert.equal(result.ok && result.batch.verdict, "inconclusive");
  assert.match(result.ok ? (result.inconclusiveReason ?? "") : "", /socket closed/);
  assert.ok(log.includes("pane.close"));
});
