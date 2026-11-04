// Coding 任務至少要有一個 Worker（pane 或 profile）才可能完成（ISSUE-085）：規劃提示要求 Lead「不可用空計畫自己
// 實作」又「只能指派清單上的目標、不可指派自己」，而且 review 必須是與作者不同的 session。沒有 Worker 時 Lead 只會
// 回空計畫（任務失敗），或回沒有傳輸標記的說明而讓任務一直停在 planning，所以在啟動前就拒絕並說明原因。

export function assertCodingRoster(coding: boolean, workerCount: number): void {
  if (!coding || workerCount > 0) return;
  throw new Error(
    "--coding 任務需要至少一個 Worker（同一個 workspace 裡除了 Lead 以外的 Agent pane，或已用 `team select` 勾選的 profile）：Lead 不能用空計畫自己實作，也不能指派自己，review 也要與作者不同的 session。目前沒有任何 Worker。若只是要讓卡片的 Agent 自己做完，請不帶 --coding 指派（例如 `card assign <id> --worktree`）",
  );
}
