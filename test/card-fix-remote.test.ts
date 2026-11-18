import assert from "node:assert/strict";
import test from "node:test";
import type { Card } from "../src/card.js";
import type { OpenFinding } from "../src/card-fix.js";
import { runRemoteCardFix, type StartRemoteRole } from "../src/card-fix-remote.js";
import type { FixFlowDeps, FixFlowInput } from "../src/card-fix-flow.js";
import { validateProfiles } from "../src/agent-pool.js";
import type { AgentRecord } from "../src/types.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const profile = validateProfiles([{ id: "agy", kind: "agy", capabilities: ["implementation", "review"] }])[0]!;
const card: Card = {
  id: "REQ-20261118-remote-fix",
  type: "requirement",
  status: "done",
  title: "遠端修正",
  version: 1,
  created: "2026-11-18",
  updated: "2026-11-18",
  body: "# x\n\n## 描述\n修一下。\n\n## 驗收條件\n- 可以\n",
  roles: { fixer: { machine: "pod", agent: "agy" } },
};
const findings: OpenFinding[] = [
  { id: "F1", severity: "high", path: "src/a.ts", summary: "缺少錯誤處理", round: 1 },
  { id: "F2", severity: "low", path: "package.json", summary: "改到敏感路徑", round: 1 },
];
const input: FixFlowInput = {
  card,
  round: 1,
  findings,
  author: { agent: "claude", paneId: "w5:p1", workspaceId: "w5" },
  worktreePath: "/local/worktree",
  launch: profile,
};
const podAgent: AgentRecord = {
  pane_id: "pod:w3:p1",
  terminal_id: "pod:t",
  workspace_id: "pod:w3",
  tab_id: "",
  agent: "agy",
  agent_status: "idle",
  machine: "pod",
  profileId: "agy",
};
const reply = (patch: Record<string, unknown> = {}) => JSON.stringify({ fixed: ["F1", "F2"], skipped: [], ...patch });

type Opts = {
  states?: Array<{ head: string; dirty: boolean }>;
  turn?: () => { state: "done" | "blocked"; text: string } | Error;
  afterTurn?: () => void;
  start?: () => void;
  files?: string[];
  record?: boolean;
};

function setup(o: Opts = {}) {
  const log: string[] = [];
  const states = [...(o.states ?? [{ head: A, dirty: false }, { head: B, dirty: false }])];
  const flow: FixFlowDeps = {
    panePort: {} as never,
    startAgent: async () => podAgent,
    ...(o.record === false ? {} : { recordRoleStrict: async (identity) => void log.push(`record:${identity.role}:${identity.machine ?? ""}`) }),
    runTurn: async (agent, prompt) => {
      log.push(`turn:${agent.pane_id}:${prompt.includes("F1")}`);
      const result = o.turn?.() ?? { state: "done" as const, text: reply() };
      if (result instanceof Error) throw result;
      return result;
    },
    state: async () => states.shift() ?? { head: B, dirty: false },
    changedFiles: async () => o.files ?? ["src/a.ts", "package.json"],
  };
  const start: StartRemoteRole = async (startInput) => {
    log.push(`start:${startInput.machineId}:${startInput.role}:${startInput.cwd}`);
    o.start?.();
    return {
      agent: podAgent,
      continuity: "new-session",
      afterTurn: async () => {
        log.push("afterTurn");
        o.afterTurn?.();
      },
      cleanup: async (reason) => void log.push(`cleanup:${reason}`),
    };
  };
  return { log, run: () => runRemoteCardFix({ flow, start }, "pod", input) };
}

test("成功：先記錄角色、再送提示，作者宣告修好後才取回；結果與本機 fixer 相同形狀，敏感路徑只回報", async () => {
  const h = setup();
  const result = await h.run();
  assert.ok(result.ok && result.outcome.kind === "fixed");
  assert.deepEqual(result.outcome.fixed, ["F1", "F2"]);
  assert.equal(result.outcome.headBefore, A);
  assert.equal(result.outcome.headAfter, B);
  assert.deepEqual(result.outcome.files, ["src/a.ts", "package.json"]);
  assert.deepEqual(result.outcome.sensitivePaths, ["package.json"]);
  assert.equal(result.fixerKind, "agy");
  assert.equal(result.closed, true);
  assert.deepEqual(h.log, ["start:pod:fixer:/local/worktree", "record:fixer:pod", "turn:pod:w3:p1:true", "afterTurn", "cleanup:completed"]);
});

test("沒有 profile、工作樹不乾淨：派工前就拒絕，沒有啟動遠端", async () => {
  const noProfile = setup();
  const { launch: _launch, ...rest } = input;
  void _launch;
  const result = await runRemoteCardFix({ flow: {} as never, start: async () => assert.fail("不該啟動") }, "pod", rest);
  assert.ok(!result.ok && result.stage === "kind");
  assert.deepEqual(noProfile.log, []);

  const dirty = setup({ states: [{ head: A, dirty: true }] });
  const dirtyResult = await dirty.run();
  assert.ok(!dirtyResult.ok && dirtyResult.stage === "state" && /未提交的修改/.test(dirtyResult.error));
  assert.deepEqual(dirty.log, []);
});

test("遠端啟動失敗：ok:false、stage start，沒有任何取回", async () => {
  const h = setup({
    start: () => {
      throw new Error("遠端角色失敗：implement 不可用");
    },
  });
  const result = await h.run();
  assert.ok(!result.ok && result.stage === "start" && /遠端角色失敗/.test(result.error));
  assert.ok(!h.log.includes("afterTurn"));
});

test("作者卡住或逾時：這一圈不採用、不取回，並保留遠端現場給人處理", async () => {
  for (const [turn, reason, note] of [
    [() => ({ state: "blocked" as const, text: "" }), "blocked", /卡住了/],
    [() => new Error("timed out"), "timeout", /沒有回覆/],
  ] as const) {
    const h = setup({ turn });
    const result = await h.run();
    assert.ok(result.ok && result.outcome.kind === "failed" && note.test(result.outcome.reason));
    assert.equal(result.closed, false);
    assert.match(result.closeNote ?? "", /已保留/);
    assert.ok(!h.log.includes("afterTurn"), "不取回");
    assert.ok(h.log.includes(`cleanup:${reason}`));
  }
});

test("回覆不合格、沒有宣告修好任何 finding：不取回遠端改動，並清理", async () => {
  for (const text of ["not json", reply({ fixed: [], skipped: [{ id: "F1", reason: "x" }, { id: "F2", reason: "y" }] })]) {
    const h = setup({ turn: () => ({ state: "done", text }) });
    const result = await h.run();
    assert.ok(result.ok && result.outcome.kind === "failed");
    assert.ok(!h.log.includes("afterTurn"));
    assert.ok(h.log.includes("cleanup:completed"));
  }
});

test("取回或套用失敗：這一圈不採用並附原因，仍清理", async () => {
  const h = setup({
    afterTurn: () => {
      throw new Error("遠端角色失敗：遠端改動不被接受");
    },
  });
  const result = await h.run();
  assert.ok(result.ok && result.outcome.kind === "failed" && /遠端改動不被接受/.test(result.outcome.reason));
  assert.deepEqual(h.log.slice(-2), ["afterTurn", "cleanup:completed"]);
});

test("套用後本機沒有新 commit 或不乾淨：不採用", async () => {
  for (const states of [[{ head: A, dirty: false }, { head: A, dirty: false }], [{ head: A, dirty: false }, { head: B, dirty: true }]]) {
    const result = await setup({ states }).run();
    assert.ok(result.ok && result.outcome.kind === "failed" && /狀態不符/.test(result.outcome.reason));
  }
});

test("派工前的例外（沒有角色紀錄介面）往外丟，但遠端資源仍清理", async () => {
  const h = setup({ record: false });
  await assert.rejects(h.run(), /卡片角色紀錄介面不存在/);
  assert.ok(h.log.includes("cleanup:before_dispatch_failure"));
  assert.ok(!h.log.some((l) => l.startsWith("turn:")));
});
