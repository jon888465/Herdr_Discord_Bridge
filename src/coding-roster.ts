// Coding 任務至少要有一個 Worker（pane 或 profile）才可能完成（ISSUE-085）：規劃提示要求 Lead「不可用空計畫自己
// 實作」又「只能指派清單上的目標、不可指派自己」，而且 review 必須是與作者不同的 session。沒有 Worker 時 Lead 只會
// 回空計畫（任務失敗），或回沒有傳輸標記的說明而讓任務一直停在 planning，所以在啟動前就拒絕並說明原因。

/**
 * E14：`--coding` 沒有指定任何 Worker 時，由 bridge 自動補上候選，誰寫、誰審交給 Lead。
 * 預設候選為已驗證的 claude、codex 與使用者已確認可用於 coding 的 pi。agy（ISSUE-107）仍是選用：
 * 只有 profile capabilities 含 `implementation` 或 `review` 才自動啟用。Capabilities 只決定是否自動入池，
 * 不限制角色；Lead 決定誰寫誰審。指定 Worker 時一律照指定，不自動加。
 * 一個合格 profile 也會啟用；當 coding roster 只有一個 profile 時，每個 assignment 都啟動新的獨立 session，
 * 讓 implement 與 review 仍能滿足不同 session 的驗收要求。
 */
export const AUTO_CODING_KINDS = ["claude", "codex", "pi"];

/** 需要使用者在 profile 的 `capabilities` 明確宣告其中之一才會自動啟用的 kind（目前只有 agy）。 */
export const OPT_IN_CODING_KIND = "agy";
export const OPT_IN_CODING_CAPABILITIES = ["implementation", "review"];

/** 當 autopick Lead 前必須先通過 coding 驗證、由使用者在 profile 宣告的種類（claude、codex 已實機驗證）。 */
export const LEAD_GATED_KINDS: readonly string[] = ["agy", "pi"];

/**
 * autopick Lead 的開放條件：agy、pi 要在 `config.json` 的 `agentProfiles` 有同種類、且 `capabilities` 含
 * `implementation` 的 profile（使用者表示這個種類的 coding 已驗證過）；沒達到回傳原因，通過回傳 undefined。
 * 這與 Worker 自動入池使用同一個明確宣告機制；bridge 不會自己判斷 CLI 的 coding 是否可靠。
 */
export function leadGateFor(
  profiles: ReadonlyArray<{ kind: string; capabilities?: readonly string[] }>,
): (kind: string) => string | undefined {
  return (kind) => {
    if (!LEAD_GATED_KINDS.includes(kind)) return undefined;
    const declared = profiles.some(
      (profile) =>
        profile.kind === kind &&
        profile.capabilities?.includes("implementation"),
    );
    return declared
      ? undefined
      : `${kind} 當 Lead 要先在 config.json 的 agentProfiles 有一個 kind 為 ${kind}、capabilities 含 implementation 的 profile（表示你已驗證它的 coding 能力）`;
  };
}

interface AutoPool {
  profiles: ReadonlyArray<{
    id: string;
    kind: string;
    capabilities?: readonly string[];
  }>;
  select(workspace: string, id: string, enabled: boolean): void;
}

function autoCodingCandidate(profile: AutoPool["profiles"][number]): boolean {
  if (AUTO_CODING_KINDS.includes(profile.kind)) return true;
  return (
    profile.kind === OPT_IN_CODING_KIND &&
    OPT_IN_CODING_CAPABILITIES.some((capability) =>
      profile.capabilities?.includes(capability),
    )
  );
}

/**
 * 沒有 Worker 時自動啟用 claude／codex／pi profile，加上宣告了 implementation／review 的 agy profile。
 * 單一 profile 也可使用；呼叫端須讓每個 coding assignment 使用 fresh session。回傳新啟用的 id。
 */
export function needsFreshCodingProfileSession(
  coding: boolean,
  workers: ReadonlyArray<{ pane_id: string }>,
): boolean {
  return (
    coding &&
    workers.length === 1 &&
    workers[0].pane_id.startsWith("profile:")
  );
}

export function autoEnableCodingProfiles(
  workspace: string,
  pool: AutoPool,
): string[] {
  const ids = pool.profiles.filter(autoCodingCandidate).map((p) => p.id);
  if (ids.length === 0) return [];
  for (const id of ids) pool.select(workspace, id, true);
  return ids;
}

export function assertCodingRoster(coding: boolean, workerCount: number): void {
  if (!coding || workerCount > 0) return;
  throw new Error(
    "--coding 任務需要至少一個 Worker（同一個 workspace 裡除了 Lead 以外的 Agent pane，或已用 `team select` 勾選的 profile；沒有指定時會自動啟用 `config.json` 的 `agentProfiles` 裡 claude／codex／pi profile，以及 `capabilities` 宣告了 `implementation` 或 `review` 的 agy profile；單一 profile 也可用，coding assignments 會各自啟動 fresh session）：Lead 不能用空計畫自己實作，也不能指派自己，review 也要與作者不同的 session。目前沒有任何 Worker。若只是要讓卡片的 Agent 自己做完，請不帶 --coding 指派（例如 `card assign <id> --worktree`）",
  );
}
