// 把 worktree 清理的結果記到卡片（`card cleanup` 與 PR merge 後的自動清理共用）：
// 流程紀錄 `cleanup_done`／`cleanup_pending`，以及 `## 異動專案` 的 `worktree 狀態`。

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
