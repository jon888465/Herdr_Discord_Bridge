import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentProfile } from "../src/agent-pool.js";
import { withDefaultModel } from "../src/default-launch.js";

/**
 * ISSUE-202：沒有 roles 的卡，PR review 與 card fix 只用種類啟動 claude，沒帶 model，落在帳號預設的 Fable 5.1，
 * prompt 送出後 pane 就 blocked（整個 session 沒有任何 API 呼叫）。只補 model，不補 profile 的其他 args。
 */
const profiles: AgentProfile[] = [
  {
    id: "helper",
    kind: "codex",
    modelFlag: "-m",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  { id: "claude", kind: "claude", model: "sonnet", modelFlag: "--model", args: [] },
  { id: "agy", kind: "agy", args: [] },
];

interface Launch {
  paneId: string;
  kind: string;
  name: string;
  args?: string[];
}

const input: Launch = { paneId: "p1", kind: "claude", name: "reviewer" };

test("a kind-only claude launch gets the configured model flag and model", () => {
  assert.deepEqual(withDefaultModel(profiles, input), {
    ...input,
    args: ["--model", "sonnet"],
  });
});

test("a launch that already carries args is left unchanged", () => {
  const given = { ...input, args: ["--model", "opus"] };
  assert.equal(withDefaultModel(profiles, given), given);
  const empty = { ...input, args: [] as string[] };
  assert.equal(withDefaultModel(profiles, empty), empty);
});

test("a kind whose profile has no model is left unchanged and never inherits profile args", () => {
  const codex = { paneId: "p1", kind: "codex", name: "reviewer" };
  assert.equal(withDefaultModel(profiles, codex), codex);
  assert.ok(!("args" in withDefaultModel(profiles, codex)));
  const agy = { paneId: "p1", kind: "agy", name: "reviewer" };
  assert.equal(withDefaultModel(profiles, agy), agy);
});

test("a kind with no profile at all is left unchanged", () => {
  const pi = { paneId: "p1", kind: "pi", name: "reviewer" };
  assert.equal(withDefaultModel(profiles, pi), pi);
  assert.equal(withDefaultModel([], input), input);
});

test("a model without a model flag is not guessed", () => {
  const broken: AgentProfile[] = [{ id: "x", kind: "claude", model: "sonnet" }];
  assert.equal(withDefaultModel(broken, input), input);
});

test("the first profile of the kind that sets a model is used", () => {
  const several: AgentProfile[] = [
    { id: "c0", kind: "claude", modelFlag: "--model" },
    { id: "c1", kind: "claude", model: "sonnet", modelFlag: "--model" },
    { id: "c2", kind: "claude", model: "opus", modelFlag: "--model" },
  ];
  assert.deepEqual(withDefaultModel(several, input).args, ["--model", "sonnet"]);
});

test("the input object is not mutated", () => {
  const original = { ...input };
  withDefaultModel(profiles, original);
  assert.deepEqual(original, input);
});

test("card review and card fix start their agents through the default model, the Lead does not", () => {
  const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
  const wired = source.match(/startAgentInPane\(\s*runtime\.herdr,\s*withDefaultModel\(/g) ?? [];
  assert.equal(wired.length, 2, "PR review 與 card fix 兩處");
  // Lead 的啟動（ISSUE-180，使用者決定不固定 Lead 的 model）維持只傳種類。
  const lead = source.match(/lead,\s*sourceWorkspaceId: workspaceId,[\s\S]{0,200}startAgent: \(input\) =>\s*startAgentInPane\(runtime\.herdr, input\)/);
  assert.ok(lead, "Lead 的 startAgent 不套用預設 model");
});
