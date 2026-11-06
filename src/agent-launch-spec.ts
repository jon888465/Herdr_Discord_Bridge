// `agent start` 規格解析與驗證（純函式）。省略的 machine／agent 沿用目前的 Agent；省略的 model／level 不帶參數。

import { validateProfiles } from "./agent-pool.js";
import { levelArgsFor } from "./cli-adapter.js";

export const LAUNCH_KINDS: readonly string[] = ["claude", "codex", "agy", "pi"];
export const LOCAL_MACHINE = "local";

export interface ParsedLaunchSpec {
  machine?: string;
  agent?: string;
  model?: string;
  level?: string;
}

export interface LaunchSelection {
  machine: string;
  kind?: string;
}

export interface ResolvedLaunch {
  machine: string;
  kind: string;
  model?: string;
  level?: string;
  args: string[];
}

export type LaunchResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

export function parseLaunchSpec(text: string): LaunchResult<ParsedLaunchSpec> {
  const parts = text.split(":");
  if (parts.length > 4)
    return {
      ok: false,
      error: `規格最多四段 <machine>:<agent>:<model>:<level>，收到 ${parts.length} 段`,
    };
  // 單段且是已知種類時視為 agent（`claude`），其餘單段視為 machine。
  if (parts.length === 1 && LAUNCH_KINDS.includes(parts[0]!))
    return { ok: true, value: { agent: parts[0] } };
  const [machine, agent, model, level] = parts.map((part) => part || undefined);
  return { ok: true, value: { machine, agent, model, level } };
}

export function resolveLaunch(
  parsed: ParsedLaunchSpec,
  selection: LaunchSelection,
  machineIds: readonly string[],
): LaunchResult<ResolvedLaunch> {
  const machine = parsed.machine ?? selection.machine;
  if (machine !== LOCAL_MACHINE && !machineIds.includes(machine))
    return {
      ok: false,
      error: `未知的 machine "${machine}"（只接受 ${[LOCAL_MACHINE, ...machineIds].join("、")}）`,
    };
  const kind = parsed.agent ?? selection.kind;
  if (!kind)
    return {
      ok: false,
      error:
        "沒有指定 agent，也沒有選定的 Agent 可沿用；請先 `agent use <pane>` 或在規格寫出 agent",
    };
  if (!LAUNCH_KINDS.includes(kind))
    return {
      ok: false,
      error: `未知的 agent 種類 "${kind}"（只接受 ${LAUNCH_KINDS.join("、")}${parsed.agent ? "" : "；請在規格明確指定 agent"}）`,
    };
  const args: string[] = [];
  if (parsed.model !== undefined) {
    // validateProfiles 只擋 CR／LF／NUL；臨時啟動的 model 另外拒絕所有 C0／DEL／C1 控制字元。
    if (/[\u0000-\u001f\u007f-\u009f]/.test(parsed.model))
      return { ok: false, error: "model 不可含控制字元" };
    if (parsed.model.startsWith("-"))
      return {
        ok: false,
        error: `model "${parsed.model.slice(0, 40)}" 不可以 - 開頭`,
      };
    try {
      // 沿用 agentProfiles 的 model／modelFlag 規則，不另寫一份。
      const [profile] = validateProfiles([
        { id: "launch", kind, model: parsed.model },
      ]);
      args.push(profile!.modelFlag!, profile!.model!);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid model";
      return {
        ok: false,
        error: /modelFlag/.test(detail)
          ? `${kind} 沒有已確認的 model 啟動參數（modelFlag），不猜參數；請不要帶 model`
          : `不合法的 model：${detail}`,
      };
    }
  }
  if (parsed.level !== undefined) {
    const mapped = levelArgsFor(kind, parsed.level);
    if (!mapped.ok) return { ok: false, error: mapped.reason };
    args.push(...mapped.args);
  }
  return {
    ok: true,
    value: { machine, kind, model: parsed.model, level: parsed.level, args },
  };
}
