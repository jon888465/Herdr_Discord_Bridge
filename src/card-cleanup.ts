// 把 worktree 清理的結果記到卡片（`card cleanup` 與 PR merge 後的自動清理共用）：
// 流程紀錄 `cleanup_done`／`cleanup_pending`，以及 `## 異動專案` 的 `worktree 狀態`。

import { AUTOPICK_LEADS, autopickLeadLabel } from "./policy.js";
import type { CardStore } from "./card-store.js";
import type { CleanupResult } from "./card-worktree-flow.js";

export interface CleanupRecording {
  /** 卡片檔是否存在；不存在時什麼都不寫。 */
  exists: boolean;
  logError?: string;
  projectError?: string;
}

export function recordCleanupOnCard(
  store: CardStore | undefined,
  id: string,
  result: CleanupResult,
  now: () => string,
): CleanupRecording {
  if (!store || store.read(id).ok !== true) return { exists: false };
  const safeWorkspace = result.workspaceId.replace(/[^A-Za-z0-9_-]/g, "-");
  const logged = store.recordEvent(
    id,
    result.removed
      ? {
          event: "cleanup_done",
          result: "removed",
          time: now(),
          eventId: `${safeWorkspace}-cleanup-removed`,
        }
      : {
          event: "cleanup_pending",
          reason: result.reason,
          time: now(),
          eventId: `${safeWorkspace}-cleanup-pending`,
        },
  );
  // 卡片上的 `## 異動專案` 同步顯示 worktree 目前的狀況，讓人從卡片就看得到（保留中或已清理）。
  const project = store.recordProject(
    id,
    {
      machine: "local",
      repoPath: result.repoPath,
      branch: result.branch,
      worktreePath: result.path,
      worktreeState: result.removed ? "removed" : "kept_dirty",
    },
    now().slice(0, 10),
  );
  return {
    exists: true,
    ...(logged.ok ? {} : { logError: logged.error }),
    ...(project.ok ? {} : { projectError: project.error }),
  };
}

/** Only a persisted Lead identity and a current matching label authorize closing. */
export async function closeAutopickLead(
  store: CardStore | undefined,
  id: string,
  port: {
    listWorkspaces(): Promise<import("./types.js").WorkspaceRecord[]>;
    request(
      method: string,
      params?: Record<string, unknown>,
      options?: { retries?: number },
    ): Promise<unknown>;
  },
  cleanupCompleted = false,
  log: (message: string) => void = console.warn,
): Promise<void> {
  try {
    const read = store?.read(id);
    if (!read?.ok) return;
    const card = read.card;
    if (card.status === "in_progress") return;
    if (!cleanupCompleted && !["done", "cancelled"].includes(card.status))
      return;
    const workspaceId = card.autopick_workspace_id;
    const label = card.autopick_workspace_label;
    if (!workspaceId || !label) return;
    if (!AUTOPICK_LEADS.some((kind) => label === autopickLeadLabel(kind, id))) {
      log(`autopick Lead cleanup ${id}: invalid recorded label`);
      return;
    }
    const workspace = (await port.listWorkspaces()).find(
      (w) => w.workspace_id === workspaceId,
    );
    if (!workspace || workspace.label !== label) {
      log(`autopick Lead cleanup ${id}: workspace missing or label mismatch`);
      return;
    }
    await port.request(
      "workspace.close",
      { workspace_id: workspaceId },
      { retries: 0 },
    );
  } catch {
    log(`autopick Lead cleanup ${id}: lookup or close failed`);
  }
}
