import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import type { AgentStartPort } from "../src/agent-start.js";
import {
  fixerAgentName,
  runCardFix,
  type FixFlowDeps,
  type FixFlowInput,
} from "../src/card-fix-flow.js";
import type { OpenFinding } from "../src/card-fix.js";
import type { AgentRecord } from "../src/types.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const WORKTREE = "/Users/jon/.herdr/worktrees/repo/card-req-20261104-export";

const card: Card = {
  id: "REQ-20261104-export",
  type: "requirement",
  status: "done",
  title: "加入匯出功能",
  version: 1,
  created: "2026-11-04",
  updated: "2026-11-04",
  body: "# x\n\n## 描述\n把報表匯出成 CSV。\n\n## 驗收條件\n- 可以下載\n",
};

const findings: OpenFinding[] = [
  { id: "F1", severity: "high", path: "src/export.ts", lineStart: 3, lineEnd: 9, summary: "缺少錯誤處理", round: 1 },
  { id: "F2", severity: "low", path: "test/export.test.ts", summary: "命名", round: 1 },
];

const input = (patch: Partial<FixFlowInput> = {}): FixFlowInput => ({
  card,
  round: 1,
  findings,
  author: { agent: "agy", paneId: "w5:p1", workspaceId: "w5" },
  worktreePath: WORKTREE,
  ...patch,
});

const fixer = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w5:p9",
  terminal_id: "term_new",
  workspace_id: "w5",
  tab_id: "w5:t1",
  agent: "agy",
  agent_status: "idle",
  ...patch,
});

const reply = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ fixed: ["F1", "F2"], skipped: [], ...patch });

type State = { head: string; dirty: boolean };

interface Options {
  states?: Array<State | Error>;
  files?: string[] | Error;
  start?: () => AgentRecord | Error;
  turn?: () => { state: "done" | "blocked"; text: string } | Error;
  split?: () => unknown;
  closeFails?: boolean;
  listing?: AgentRecord[][];
}

function setup(options: Options = {}) {
  const log: string[] = [];
  const prompts: string[] = [];
  const states = [...(options.states ?? [{ head: A, dirty: false }, { head: B, dirty: false }])];
  const panePort: AgentStartPort = {
    request: async (method, params) => {
      log.push(method === "pane.split" ? `pane.split:${JSON.stringify(params)}` : method);
      if (method === "pane.layout")
        return { layout: { panes: [{ pane_id: "w5:p1", rect: { width: 200, height: 40 } }] } };
      if (method === "pane.split")
        return options.split?.() ?? { pane: { pane_id: "w5:p9", workspace_id: "w5", terminal_id: "term_new" } };
      if (method === "pane.get") return { pane: { pane_id: "w5:p9", terminal_id: "term_new" } };
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
  const deps: FixFlowDeps = {
    panePort,
    readyTimeoutMs: 60,
    readyPollMs: 5,
    startAgent: async (start) => {
      log.push(`startAgent:${start.kind}@${start.paneId}:${start.name}`);
      const result = options.start?.() ?? fixer({ agent: start.kind });
      if (result instanceof Error) throw result;
      return result;
    },
    runTurn: async (_agent, prompt) => {
      log.push("runTurn");
      prompts.push(prompt);
      const result = options.turn?.() ?? { state: "done", text: reply() };
      if (result instanceof Error) throw result;
      return result;
    },
    state: async (cwd) => {
      log.push(`state:${cwd}`);
      const next = states.shift() ?? { head: B, dirty: false };
      if (next instanceof Error) throw next;
      return next;
    },
    changedFiles: async (_cwd, from, to) => {
      log.push(`changedFiles:${from.slice(0, 1)}..${to.slice(0, 1)}`);
      const files = options.files ?? ["src/export.ts", "test/export.test.ts"];
      if (files instanceof Error) throw files;
      return files;
    },
    timeoutMs: 1000,
  };
  return { deps, log, prompts };
}

const names = (log: string[]): string[] => log.map((entry) => entry.split(":")[0]);

test("a clean fix opens a fresh pane with the author's own kind, runs one turn, checks the new commit and closes the pane", async () => {
  const { deps, log, prompts } = setup();
  const result = await runCardFix(deps, input());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ok && result.fixerKind, "agy");
  const outcome = result.ok ? result.outcome : undefined;
  assert.equal(outcome?.kind, "fixed");
  assert.deepEqual(outcome?.kind === "fixed" && outcome.fixed, ["F1", "F2"]);
  assert.equal(outcome?.kind === "fixed" && outcome.headBefore, A);
  assert.equal(outcome?.kind === "fixed" && outcome.headAfter, B);
  assert.deepEqual(outcome?.kind === "fixed" && outcome.files, ["src/export.ts", "test/export.test.ts"]);
  assert.deepEqual(outcome?.kind === "fixed" && outcome.sensitivePaths, []);
  assert.equal(result.ok && result.closed, true);
  assert.deepEqual(
    names(log),
    ["state", "pane.layout", "pane.split", "startAgent", "runTurn", "state", "changedFiles", "pane.get", "pane.close"],
    log.join("\n"),
  );
  assert.match(prompts[0], /<<<FIX_DATA id=REQ-20261104-export/);
  const split = log.find((entry) => entry.startsWith("pane.split")) ?? "";
  assert.match(split, /"target_pane_id":"w5:p1"/);
  assert.match(split, /card-req-20261104-export/);
});

test("a requested kind replaces the author's kind, and an unknown author kind needs one", async () => {
  const requested = setup();
  await runCardFix(requested.deps, input({ requestedKind: "codex" }));
  assert.ok(requested.log.some((entry) => entry.startsWith("startAgent:codex@")));

  const unknown = setup();
  const result = await runCardFix(unknown.deps, input({ author: { paneId: "w5:p1", workspaceId: "w5" } }));
  assert.equal(!result.ok && result.stage, "kind");
  assert.match(!result.ok ? result.error : "", /--agent/);
  assert.deepEqual(unknown.log, []);

  const bad = setup();
  const badResult = await runCardFix(bad.deps, input({ requestedKind: "Bad Kind" }));
  assert.equal(!badResult.ok && badResult.stage, "kind");
});

test("the agent name is valid for Herdr, short, and stable for a card and round", () => {
  const name = fixerAgentName("REQ-20261104-sensitive-accept-and-more", 2);
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(name, fixerAgentName("REQ-20261104-sensitive-accept-and-more", 2));
  assert.notEqual(name, fixerAgentName("REQ-20261104-sensitive-accept-and-more", 3));
});

test("nothing is opened when the prompt cannot be built or the working tree is already dirty", async () => {
  const empty = setup();
  const noPrompt = await runCardFix(empty.deps, input({ findings: [] }));
  assert.equal(!noPrompt.ok && noPrompt.stage, "prompt");
  assert.deepEqual(empty.log, []);

  const dirty = setup({ states: [{ head: A, dirty: true }] });
  const result = await runCardFix(dirty.deps, input());
  assert.equal(!result.ok && result.stage, "state");
  assert.match(!result.ok ? result.error : "", /未提交|乾淨/);
  assert.equal(dirty.log.some((entry) => entry.startsWith("pane.")), false);

  const broken = setup({ states: [new Error("git failed")] });
  const unreadable = await runCardFix(broken.deps, input());
  assert.equal(!unreadable.ok && unreadable.stage, "state");
});

test("when the pane cannot be opened nothing is started, and when the Agent cannot start the pane is closed without switching kind", async () => {
  const open = setup({ split: () => ({ pane: { pane_id: "w5:p9", workspace_id: "w5" } }) });
  const a = await runCardFix(open.deps, input());
  assert.equal(!a.ok && a.stage, "open");
  assert.equal(open.log.some((entry) => entry.startsWith("startAgent")), false);

  const start = setup({ start: () => new Error("agent.start: unsupported_agent_kind") });
  const b = await runCardFix(start.deps, input());
  assert.equal(!b.ok && b.stage, "start");
  assert.match(!b.ok ? b.error : "", /unsupported_agent_kind/);
  assert.equal(start.log.filter((entry) => entry.startsWith("startAgent")).length, 1);
  assert.ok(start.log.includes("pane.close"));
});

test("an Agent that stays blocked or never gets ready fails the round, the pane is closed, and nothing is changed", async () => {
  const blocked = setup({ start: () => fixer({ agent_status: "blocked" }) });
  const a = await runCardFix(blocked.deps, input());
  assert.ok(a.ok);
  assert.equal(a.ok && a.outcome.kind, "failed");
  assert.match(a.ok && a.outcome.kind === "failed" ? a.outcome.reason : "", /blocked/);
  assert.equal(blocked.log.includes("runTurn"), false);
  assert.ok(blocked.log.includes("pane.close"));

  const slow = setup({ start: () => fixer({ agent_status: "working" }), listing: [[fixer({ agent_status: "working" })]] });
  const b = await runCardFix(slow.deps, input());
  assert.equal(b.ok && b.outcome.kind, "failed");
  assert.match(b.ok && b.outcome.kind === "failed" ? b.outcome.reason : "", /working/);
  assert.ok(slow.log.includes("pane.close"));
});

test("an Agent that is still starting up is waited for, then the fix goes on", async () => {
  const { deps } = setup({
    start: () => fixer({ agent_status: "working" }),
    listing: [[fixer({ agent_status: "working" })], [fixer({ agent_status: "idle" })]],
  });
  const result = await runCardFix(deps, input());
  assert.equal(result.ok && result.outcome.kind, "fixed");
});

test("a turn that fails, gets blocked or returns something unusable fails the round with the reason, and the pane is closed", async () => {
  const cases: Array<[string, Options, RegExp]> = [
    ["throws", { turn: () => new Error("Agent identity changed while waiting") }, /identity changed/],
    ["blocked", { turn: () => ({ state: "blocked", text: "" }) }, /卡住|blocked/],
    ["not json", { turn: () => ({ state: "done", text: "已修好" }) }, /JSON/],
    ["does not account for every finding", { turn: () => ({ state: "done", text: reply({ fixed: ["F1"] }) }) }, /沒有交代/],
  ];
  for (const [label, options, expected] of cases) {
    const { deps, log } = setup(options);
    const result = await runCardFix(deps, input());
    assert.ok(result.ok, label);
    assert.equal(result.ok && result.outcome.kind, "failed", label);
    assert.match(result.ok && result.outcome.kind === "failed" ? result.outcome.reason : "", expected, label);
    assert.ok(log.includes("pane.close"), label);
  }
});

test("a claim of fixed without a new commit, or a new commit with no claim, or leftover uncommitted changes, is a failed round", async () => {
  const noCommit = setup({ states: [{ head: A, dirty: false }, { head: A, dirty: false }] });
  const a = await runCardFix(noCommit.deps, input());
  assert.equal(a.ok && a.outcome.kind, "failed");
  assert.match(a.ok && a.outcome.kind === "failed" ? a.outcome.reason : "", /沒有新的 commit/);

  const noClaim = setup({ turn: () => ({ state: "done", text: reply({ fixed: [], skipped: [{ id: "F1", reason: "x" }, { id: "F2", reason: "y" }] }) }) });
  const b = await runCardFix(noClaim.deps, input());
  assert.equal(b.ok && b.outcome.kind, "failed");

  const leftover = setup({ states: [{ head: A, dirty: false }, { head: B, dirty: true }] });
  const c = await runCardFix(leftover.deps, input());
  assert.equal(c.ok && c.outcome.kind, "failed");
  assert.match(c.ok && c.outcome.kind === "failed" ? c.outcome.reason : "", /未提交/);
});

test("when the state or the changed files cannot be read after the turn, the round fails with the reason and the pane is still closed", async () => {
  const a = setup({ states: [{ head: A, dirty: false }, new Error("git failed")] });
  const first = await runCardFix(a.deps, input());
  assert.equal(first.ok && first.outcome.kind, "failed");
  assert.match(first.ok && first.outcome.kind === "failed" ? first.outcome.reason : "", /git failed/);
  assert.ok(a.log.includes("pane.close"));

  const b = setup({ files: new Error("diff failed") });
  const second = await runCardFix(b.deps, input());
  assert.equal(second.ok && second.outcome.kind, "failed");
  assert.ok(b.log.includes("pane.close"));
});

test("a partial fix keeps the skipped findings with their reasons", async () => {
  const { deps } = setup({
    turn: () => ({ state: "done", text: reply({ fixed: ["F1"], skipped: [{ id: "F2", reason: "需要人決定" }] }) }),
  });
  const result = await runCardFix(deps, input());
  const outcome = result.ok ? result.outcome : undefined;
  assert.equal(outcome?.kind, "fixed");
  assert.deepEqual(outcome?.kind === "fixed" && outcome.fixed, ["F1"]);
  assert.deepEqual(outcome?.skipped, [{ id: "F2", reason: "需要人決定" }]);
});

test("a fix that touches sensitive paths is still reported as fixed, with those paths listed", async () => {
  const { deps } = setup({ files: ["src/export.ts", "AGENTS.md", ".github/workflows/ci.yml"] });
  const result = await runCardFix(deps, input());
  const outcome = result.ok ? result.outcome : undefined;
  assert.equal(outcome?.kind, "fixed");
  assert.deepEqual(outcome?.kind === "fixed" && outcome.sensitivePaths, ["AGENTS.md", ".github/workflows/ci.yml"]);
});

test("a pane that cannot be closed is reported but does not change the outcome", async () => {
  const { deps } = setup({ closeFails: true });
  const result = await runCardFix(deps, input());
  assert.equal(result.ok && result.outcome.kind, "fixed");
  assert.equal(result.ok && result.closed, false);
  assert.match(result.ok ? (result.closeNote ?? "") : "", /close refused/);
});
