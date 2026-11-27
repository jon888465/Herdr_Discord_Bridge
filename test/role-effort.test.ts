import test from "node:test";
import assert from "node:assert/strict";
import { validateProfiles } from "../src/agent-pool.js";
import { parseCardRoles, preflightRoles, resolveFlowRole, serializeCardRoles } from "../src/card-role-assignment.js";

test("roles 第四段 level：拆出已知的推理強度、舊的含冒號 model 照舊、往返不變", () => {
  const roles = parseCardRoles({ reviewer: "remote-a:codex:GPT-6.2-Astra:medium", verify: "remote-a:pi", fixer: ":codex::high" });
  assert.deepEqual(roles.reviewer, { machine: "remote-a", agent: "codex", model: "GPT-6.2-Astra", level: "medium" });
  assert.deepEqual(roles.fixer, { agent: "codex", level: "high" });
  assert.deepEqual(parseCardRoles(serializeCardRoles(roles)), roles);
  assert.equal(serializeCardRoles(roles).reviewer, "remote-a:codex:GPT-6.2-Astra:medium");
  // 最後一段不是已知 level：整串仍是 model（舊卡不受影響）。
  assert.deepEqual(parseCardRoles({ reviewer: ":codex:team:alpha" }).reviewer, { agent: "codex", model: "team:alpha" });
  assert.deepEqual(parseCardRoles({ reviewer: ":codex:gpt-5" }).reviewer, { agent: "codex", model: "gpt-5" });
});

test("profile 的 level：換成該 CLI 的啟動參數併入 args、重複驗證不疊加、不支援的 CLI 與壞格式拒絕", () => {
  const [once] = validateProfiles([{ id: "p", kind: "codex", model: "m1", level: "medium", args: ["--x"] }]);
  assert.equal(once!.level, "medium");
  assert.deepEqual(once!.args, ["--x", "-c", "model_reasoning_effort=medium"]);
  const [twice] = validateProfiles([once!]);
  assert.deepEqual(twice!.args, once!.args, "再驗證一次不會多加");
  const [claude] = validateProfiles([{ id: "c", kind: "claude", level: "high" }]);
  assert.deepEqual(claude!.args, ["--effort", "high"]);
  assert.deepEqual(validateProfiles([{ id: "n", kind: "codex" }])[0]!.args, []);
  assert.throws(() => validateProfiles([{ id: "a", kind: "agy", level: "high" }]), /level/);
  assert.throws(() => validateProfiles([{ id: "b", kind: "codex", level: "--bad" }]), /level/);
});

const profiles = validateProfiles([
  { id: "astra-medium", kind: "codex", model: "GPT-6.2-Astra", level: "medium", capabilities: ["review"] },
  { id: "astra-high", kind: "codex", model: "GPT-6.2-Astra", level: "high", capabilities: ["review"] },
  { id: "astra-plain", kind: "codex", model: "GPT-6.2-Astra", capabilities: ["review"] },
]);
const context = {
  machineIds: ["m1"],
  profiles,
  remoteMachines: [{ id: "m1", kinds: ["codex", "pi"], toolchain: true, write: true }],
};

test("preflight：model 與 level 都要符合；選到的 profile 帶著 level 的啟動參數（本機與遠端）", () => {
  for (const machine of ["", "m1"]) {
    const snapshot = preflightRoles({ reviewer: parseCardRoles({ reviewer: `${machine}:codex:GPT-6.2-Astra:medium` }).reviewer! }, context);
    const picked = resolveFlowRole(snapshot, "reviewer", "codex");
    assert.deepEqual(picked.args, ["-c", "model_reasoning_effort=medium"], machine || "local");
    assert.equal(picked.model, "GPT-6.2-Astra");
  }
});

test("preflight：沒有 profile 設了這個 level 時拒絕並說明要加 level 欄位；沒寫 level 不限制", () => {
  assert.throws(
    () => preflightRoles({ reviewer: { agent: "codex", model: "GPT-6.2-Astra", level: "xhigh" } }, context),
    /不合法 level xhigh.*agentProfiles 要加 level 欄位/,
  );
  assert.throws(() => preflightRoles({ reviewer: { agent: "codex", model: "other", level: "medium" } }, context), /不合法 model/);
  const open = preflightRoles({ reviewer: { agent: "codex", model: "GPT-6.2-Astra" } }, context);
  assert.equal(open.candidates.reviewer?.length, 3, "沒寫 level：同 model 的 profile 都是候選");
});

test("persisted 的 roles 物件可以有 level 欄位，其他未知欄位仍拒絕", () => {
  assert.ok(preflightRoles({ reviewer: { agent: "codex", model: "GPT-6.2-Astra", level: "high" } }, context));
  assert.throws(() => preflightRoles({ reviewer: { agent: "codex", effort: "high" } as never }, context), /不合法角色欄位/);
});
