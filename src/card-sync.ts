// 把已結束的 Team 任務同步回卡片（ADR-0002 階段 2 決定 Q4，階段 2b 第三步）。
//
// - 任務完成 → 卡片 `done`，記 `completed`。
// - 任務失敗或取消 → 卡片維持 `in_progress`，只記事件，由人決定下一步。
// - 事件 id = `<taskId>-<journal 中第一次進入終止狀態的 sequence>`，重複同步不會重複寫入。
// - 先記事件、再改狀態：中途當機時，下一輪仍會補上狀態；反過來狀態先變 done 會讓事件永遠補不回來。
// - 一張卡有多個任務時，只有最後一個任務完成才會變 `done`；較早的任務只記事件。
// - 只處理 `in_progress` 且有 `tasks` 的卡片；人已經改動狀態的卡片不碰。

import { ensureCardsDirectory } from "./card-directory.js";
import { LEDGER_MAX_FILE_BYTES, type Card } from "./card.js";
import { CardStore } from "./card-store.js";
import { terminalTask, type TeamTaskStore } from "./team-task-store.js";

export interface TaskSnapshot {
  state: string;
  detail?: string;
  finishedAt?: string;
  /** journal 中第一次進入目前終止狀態的事件 sequence（非終止狀態時沒有）。 */
  terminalSequence?: number;
}

export interface TaskSource {
  get(taskId: string): TaskSnapshot | undefined;
}

export interface SyncResult {
  /** 這一輪有改動的卡片 id。 */
  updated: string[];
  /** 無法同步的原因（目錄不安全、單張卡片寫入失敗等）。 */
  problems: string[];
}

export function taskSourceFrom(store: TeamTaskStore): TaskSource {
  return {
    get(taskId) {
      let task;
      try {
        task = store.get(taskId);
      } catch {
        return undefined;
      }
      const snapshot: TaskSnapshot = {
        state: task.state,
        detail: task.detail,
        finishedAt: task.finishedAt,
      };
      if (terminalTask(task.state)) {
        const index = store
          .events(taskId)
          .findIndex((event) => event.task.state === task.state);
        snapshot.terminalSequence = index < 0 ? undefined : index + 1;
      }
      return snapshot;
    },
  };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function eventTime(finishedAt: string | undefined, now: () => string): string {
  const parsed = finishedAt ? new Date(finishedAt) : undefined;
  if (parsed && !Number.isNaN(parsed.getTime()))
    return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
  return now();
}

function syncCard(
  store: CardStore,
  card: Card,
  tasks: TaskSource,
  now: () => string,
  problems: string[],
): boolean {
  const ids = card.tasks ?? [];
  let changed = false;
  for (const [index, taskId] of ids.entries()) {
    const task = tasks.get(taskId);
    if (!task || !TERMINAL.has(task.state)) continue;
    const eventId = `${taskId}-${task.terminalSequence ?? "final"}`;
    const time = eventTime(task.finishedAt, now);
    const logged = store.recordEvent(
      card.id,
      task.state === "completed"
        ? { time, eventId, event: "completed", taskId }
        : task.state === "failed"
          ? {
              time,
              eventId,
              event: "failed",
              code: "task_failed",
              ...(task.detail ? { reason: task.detail } : {}),
            }
          : { time, eventId, event: "cancelled", by: "user" },
    );
    if (!logged.ok) {
      problems.push(`${card.id}：${logged.error}`);
      continue;
    }
    if (logged.added > 0) changed = true;
    if (task.state === "completed" && index === ids.length - 1) {
      const moved = store.setStatus(card.id, "done", time.slice(0, 10));
      if (!moved.ok) problems.push(`${card.id}：${moved.error}`);
      else changed = true;
    }
  }
  return changed;
}

export function syncCards(options: {
  rootDir: string;
  tasks: TaskSource;
  now: () => string;
}): SyncResult {
  const result: SyncResult = { updated: [], problems: [] };
  const directory = ensureCardsDirectory(options.rootDir, { create: false });
  if (!directory.ok) {
    result.problems.push(directory.error);
    return result;
  }
  if (!directory.exists) return result;
  const store = new CardStore(options.rootDir, {
    maxFileBytes: LEDGER_MAX_FILE_BYTES,
  });
  for (const { card } of store.list().cards) {
    if (card.status !== "in_progress" || !card.tasks?.length) continue;
    try {
      if (syncCard(store, card, options.tasks, options.now, result.problems))
        result.updated.push(card.id);
    } catch (error) {
      result.problems.push(
        `${card.id}：${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  return result;
}
