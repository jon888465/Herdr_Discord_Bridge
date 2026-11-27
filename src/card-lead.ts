// ISSUE-225 第 1 階段：卡片 `lead` 的解析、格式化與撿卡前檢查（docs/remote-lead.md）。
// 只做「看得懂與擋得下」：**不啟動任何遠端 Lead**——通過所有檢查的遠端 Lead 在這個階段仍以「尚未實作」拒絕。
//
// 寫法：
//   lead: agy                      只寫種類（舊寫法，本機，行為不變）
//   lead: machine:agent            指定 machine（`local` 或留空代表本機）
//   lead: machine:agent:model      再加 model
//   lead: machine:agent:model:effort  再加 effort；model 不可含冒號（與 `roles` 不同，見設計文件 §3 B）

import { CARD_MODEL, roleError, type RoleContext } from "./card-role-assignment.js";

export const LEAD_KINDS = ["claude", "codex", "agy", "pi"] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];
export const LEAD_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const MACHINE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface LeadSpec {
  /** 沒寫或 `local` 都是本機。 */
  machine?: string;
  agent: LeadKind;
  model?: string;
  effort?: string;
}

export type LeadParse = { ok: true; kind: LeadKind; spec?: LeadSpec } | { ok: false; error: string };

/** 只有種類（沒有冒號）時回傳 kind、沒有 spec，與舊行為完全相同。 */
export function parseLead(value: string): LeadParse {
  if (!value.includes(":")) {
    if (!(LEAD_KINDS as readonly string[]).includes(value))
      return { ok: false, error: "invalid lead; use claude, codex, agy or pi" };
    return { ok: true, kind: value as LeadKind };
  }
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 4)
    return { ok: false, error: "invalid lead; use agent or machine:agent[:model[:effort]]" };
  const [machine = "", agent = "", model = "", effort = ""] = parts;
  if (machine && !MACHINE.test(machine)) return { ok: false, error: "invalid lead machine" };
  if (!(LEAD_KINDS as readonly string[]).includes(agent)) return { ok: false, error: "invalid lead agent; use claude, codex, agy or pi" };
  if (model && !CARD_MODEL.test(model)) return { ok: false, error: "invalid lead model" };
  if (effort && !(LEAD_EFFORTS as readonly string[]).includes(effort))
    return { ok: false, error: `invalid lead effort; use ${LEAD_EFFORTS.join(", ")}` };
  return {
    ok: true,
    kind: agent as LeadKind,
    spec: {
      ...(machine ? { machine } : {}),
      agent: agent as LeadKind,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}

/** 與 `parseLead` 互逆（尾端空白段省略，所以原樣寫回）。 */
export function formatLead(spec: LeadSpec): string {
  const tail = spec.effort ? `:${spec.model ?? ""}:${spec.effort}` : spec.model ? `:${spec.model}` : "";
  return `${spec.machine ?? ""}:${spec.agent}${tail}`;
}

/**
 * 撿卡前檢查（第 1 階段）。順序重要：實際的 `cardRoleContext` 在 machine 斷線時會把它從 `remoteMachines` 排除（ISSUE-223），
 * 所以斷線要先於「有沒有開放」判斷。拒絕訊息不帶 machine 名稱的分類由 `card-notify` 處理。
 * 本機（沒寫或 `local`）：model／effort 的指定在第 4 階段才支援，先拒絕；只有種類時什麼都不擋。
 * 遠端：通過所有檢查後仍拒絕（尚未實作），**不啟動任何東西、不 fallback 本機**。
 */
export function preflightLead(spec: LeadSpec, context: RoleContext): void {
  const machine = spec.machine ?? "local";
  if (machine === "local") {
    if (spec.model || spec.effort) roleError("lead", "model／effort 指定尚未支援（ISSUE-225 第 4 階段）");
    return;
  }
  if (!context.machineIds.includes(machine)) roleError("lead", `不存在 machine ${machine}`);
  if (context.isDisconnected?.(machine)) roleError("lead", `machine 已斷線（${machine}），不會 fallback 到本機，連線後再重試`);
  const remote = context.remoteMachines?.find((m) => m.id === machine);
  if (!remote || !remote.lead || !remote.kinds.includes(spec.agent)) roleError("lead", `machine 未開放遠端 Lead（${machine}）`);
  if (!remote.hook) roleError("lead", `machine 沒有設定 hookSocket，不能當 Lead（${machine}）`);
  roleError("lead", "遠端 Lead 尚未實作（ISSUE-225 第 2 階段）");
}
