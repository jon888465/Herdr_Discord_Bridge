import type { AgentProfile } from "./agent-pool.js";

/**
 * ISSUE-202：沒有 `roles` 的卡，PR review 與 `card fix` 只用種類啟動 Agent，不帶 model。
 * claude 因此落在帳號預設的 Fable 5.1，prompt 送出後 pane 就 blocked（整個 session 沒有任何 API 呼叫）。
 *
 * 只在「完全沒有指定 args」時補上 config 內第一個「同種類且有設 model」的 profile 的 model 旗標與 model；
 * 不補 profile 的其他 args（例如 codex helper 的 `--dangerously-bypass-approvals-and-sandbox`，reviewer 不該因此放寬權限）。
 * 沒有 model、沒有 modelFlag（不猜參數）或沒有同種類 profile 時原樣回傳。
 */
export function withDefaultModel<T extends { kind: string; args?: string[] }>(
  profiles: readonly AgentProfile[],
  input: T,
): T {
  if (input.args !== undefined) return input;
  const profile = profiles.find(
    (p) => p.kind === input.kind && p.model && p.modelFlag,
  );
  if (!profile) return input;
  return { ...input, args: [profile.modelFlag!, profile.model!] };
}
