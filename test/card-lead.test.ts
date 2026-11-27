import test from "node:test";
import assert from "node:assert/strict";
import { parseCard } from "../src/card.js";
import { serializeCard } from "../src/card-serialize.js";
import { formatLead, parseLead, preflightLead, type LeadSpec } from "../src/card-lead.js";
import { classifyRoleRejection } from "../src/card-notify.js";
import type { RoleContext } from "../src/card-role-assignment.js";

test("parseLead：只有種類維持舊行為；machine:agent[:model[:effort]] 解析出完整指定", () => {
  assert.deepEqual(parseLead("agy"), { ok: true, kind: "agy" });
  assert.deepEqual(parseLead("agy-machine:agy:neon:medium"), { ok: true, kind: "agy", spec: { machine: "agy-machine", agent: "agy", model: "neon", effort: "medium" } });
  assert.deepEqual(parseLead("local:codex"), { ok: true, kind: "codex", spec: { machine: "local", agent: "codex" } });
  assert.deepEqual(parseLead(":claude:opus"), { ok: true, kind: "claude", spec: { agent: "claude", model: "opus" } });
  assert.deepEqual(parseLead("m1:pi::high"), { ok: true, kind: "pi", spec: { machine: "m1", agent: "pi", effort: "high" } });
});

test("parseLead：不合法的寫法整個拒絕，並說明哪一段", () => {
  const bad = (value: string, pattern: RegExp) => {
    const result = parseLead(value);
    assert.equal(result.ok, false, value);
    if (!result.ok) assert.match(result.error, pattern, value);
  };
  bad("gemini", /use claude, codex, agy or pi/);
  bad("m1:agy:neon:medium:extra", /agent or machine:agent/);
  bad("1bad:agy", /machine/);
  bad("m1:gemini", /agent/);
  bad("m1:agy:bad model", /model/);
  bad("m1:agy:neon:turbo", /effort/);
  bad("m1:agy:neon:Medium", /effort/);
});

test("formatLead 與 parseLead 互逆，尾端空白段省略", () => {
  for (const value of ["agy-machine:agy:neon:medium", "local:codex", ":claude:opus", "m1:pi::high", "m1:agy:neon"]) {
    const result = parseLead(value);
    assert.ok(result.ok && result.spec, value);
    if (result.ok && result.spec) assert.equal(formatLead(result.spec), value);
  }
});

const card = (lead: string) => `---
id: REQ-20261127-lead
type: requirement
status: draft
title: 範例
version: 1
created: 2026-11-27
updated: 2026-11-27
lead: ${lead}
---
# 範例

## 描述
x
`;

test("卡片解析：lead 寫成四段時 lead 仍是 agent 種類（舊程式照舊讀），leadSpec 帶完整指定；序列化原樣寫回", () => {
  const parsed = parseCard(card("agy-machine:agy:neon:medium"), "REQ-20261127-lead.md");
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.card.lead, "agy");
  assert.deepEqual(parsed.card.leadSpec, { machine: "agy-machine", agent: "agy", model: "neon", effort: "medium" });
  const written = serializeCard(parsed.card);
  assert.ok(written.ok);
  if (written.ok) assert.match(written.text, /^lead: agy-machine:agy:neon:medium$/m);
  // 舊寫法完全不變：沒有 leadSpec。
  const plain = parseCard(card("agy"), "REQ-20261127-lead.md");
  assert.ok(plain.ok);
  if (plain.ok) {
    assert.equal(plain.card.lead, "agy");
    assert.equal(plain.card.leadSpec, undefined);
    const text = serializeCard(plain.card);
    assert.ok(text.ok && /^lead: agy$/m.test(text.text));
  }
  assert.equal(parseCard(card("agy-machine:agy:neon:turbo"), "REQ-20261127-lead.md").ok, false);
});

// 實際的 cardRoleContext：machineIds 含所有設定的 machine；斷線的 machine 會被排除出 remoteMachines（ISSUE-223）。
const context = (over: Partial<RoleContext> & { machine?: Record<string, unknown> } = {}): RoleContext => ({
  machineIds: ["m1"],
  profiles: [],
  remoteMachines: [{ id: "m1", kinds: ["agy"], lead: true, hook: true, ...(over.machine ?? {}) }],
  ...over,
});
const spec = (extra: Partial<LeadSpec> = {}): LeadSpec => ({ machine: "m1", agent: "agy", ...extra });
const reason = (s: LeadSpec, c: RoleContext) => {
  try {
    preflightLead(s, c);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

test("preflightLead：本機只有種類不擋；本機指定 model／effort 先拒絕", () => {
  assert.equal(reason({ agent: "agy" }, context()), "");
  assert.equal(reason({ machine: "local", agent: "codex" }, context()), "");
  assert.match(reason({ agent: "agy", model: "neon" }, context()), /model／effort 指定尚未支援/);
});

test("preflightLead：遠端依序檢查 存在、斷線（含被排除出清單的實際形狀）、開放與種類、hook，全通過仍回尚未實作（不啟動、不 fallback）", () => {
  assert.match(reason(spec(), context({ machineIds: [] })), /不存在 machine/);
  const real = context({ isDisconnected: (id) => id === "m1", remoteMachines: [] });
  assert.match(reason(spec(), real), /machine 已斷線（m1），不會 fallback 到本機/);
  assert.match(reason(spec(), context({ machine: { lead: false } })), /machine 未開放遠端 Lead/);
  assert.match(reason(spec(), context({ machine: { lead: undefined } })), /machine 未開放遠端 Lead/);
  assert.match(reason(spec({ agent: "codex" }), context()), /machine 未開放遠端 Lead/);
  assert.match(reason(spec(), context({ machine: { hook: false } })), /沒有設定 hookSocket/);
  assert.match(reason(spec(), context()), /遠端 Lead 尚未實作/);
});

test("通知只放分類過的固定標籤，不帶 machine 名稱", () => {
  for (const [text, expected] of [
    ["卡片角色指定無效：lead：machine 已斷線（m1），不會 fallback 到本機，連線後再重試", "卡片角色指定無效：lead：machine 已斷線"],
    ["卡片角色指定無效：lead：machine 未開放遠端 Lead（m1）", "卡片角色指定無效：lead：machine 未開放遠端 Lead"],
    ["卡片角色指定無效：lead：machine 沒有設定 hookSocket，不能當 Lead（m1）", "卡片角色指定無效：lead：machine 沒有設定 hookSocket"],
    ["卡片角色指定無效：lead：遠端 Lead 尚未實作（ISSUE-225 第 2 階段）", "卡片角色指定無效：lead：遠端 Lead 尚未實作"],
    ["卡片角色指定無效：lead：不存在 machine m1", "卡片角色指定無效：lead：不存在 machine"],
  ] as const) {
    const label = classifyRoleRejection(text);
    assert.equal(label, expected, text);
    assert.doesNotMatch(label, /m1/);
  }
});
