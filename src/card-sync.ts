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
import type { CardAssignment } from "./card-assignments.js";
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

/** 任務還在進行中、但原本指派它的卡片檔已經不存在（ADR-0002 階段 2c，Q6）。 */
export interface MissingCard {
  taskId: string;
  cardId: string;
  state: string;
}

export interface SyncResult {
  /** 這一輪有改動的卡片 id。 */
  updated: string[];
  /** 無法同步的原因（目錄不安全、單張卡片寫入失敗等）。 */
  problems: string[];
  /** 進行中的任務，其卡片被刪除且尚未通知過。bridge 不會再寫入那張卡，也不會自動取消任務或重建卡片。 */
  missing: MissingCard[];
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

/** 卡片被刪除而任務還在跑時，通知原 thread 的文字（Q6：列出選項，由人決定）。 */
export function missingCardMessage(missing: MissingCard): string {
  return [
    `⚠️ 卡片 ${missing.cardId} 已被刪除，但它指派的 Team 任務 ${missing.taskId} 還在進行中（${missing.state}）。`,
    "bridge 不會再寫入這張卡片，也不會自動取消任務或自動重建卡片。請選擇：",
    `- \`card recreate ${missing.cardId}\` — 從任務紀錄重建卡片（只還原標題、描述、驗收條件），任務結束後照常同步結果`,
    `- \`team cancel ${missing.taskId}\` — 取消任務`,
    "- 不處理 — 任務照常執行，結束後沒有卡片可更新",
  ].join("\n");
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

/** 卡片檔確實不存在才算被刪除；讀不了或內容壞掉的卡片不算（那是另一種問題）。 */
function findMissing(
  store: CardStore | undefined,
  tasks: TaskSource,
  assignments: CardAssignment[],
): MissingCard[] {
  const missing: MissingCard[] = [];
  for (const assignment of assignments) {
    if (assignment.notifiedAt) continue;
    const task = tasks.get(assignment.taskId);
    if (!task || TERMINAL.has(task.state)) continue;
    const read = store?.read(assignment.cardId);
    if (store && !(read && !read.ok && read.code === "not_found")) continue;
    missing.push({
      taskId: assignment.taskId,
      cardId: assignment.cardId,
      state: task.state,
    });
  }
  return missing;
}

export function syncCards(options: {
  rootDir: string;
  tasks: TaskSource;
  /** 只同步這張卡；不掃其他卡片或刪除偵測。未提供時維持定時全量掃描。 */
  cardId?: string;
  /** 有提供時才會偵測被刪除的卡片。 */
  assignments?: { list(): CardAssignment[] };
  now: () => string;
}): SyncResult {
  const result: SyncResult = { updated: [], problems: [], missing: [] };
  const directory = ensureCardsDirectory(options.rootDir, { create: false });
  if (!directory.ok) {
    result.problems.push(directory.error);
    return result;
  }
  const store = directory.exists
    ? new CardStore(options.rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES })
    : undefined;
  if (options.assignments && !options.cardId) {
    // 索引壞掉只會停用「卡片被刪除」偵測；任務結果同步不受影響。
    try {
      result.missing = findMissing(
        store,
        options.tasks,
        options.assignments.list(),
      );
    } catch (error) {
      result.problems.push(
        `卡片刪除偵測停用：${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  if (!store) return result;
  const cards = options.cardId
    ? (() => {
        const read = store.read(options.cardId);
        if (!read.ok) {
          if (read.code !== "not_found") result.problems.push(read.error);
          return [];
        }
        return [read.card];
      })()
    : store.list().cards.map(({ card }) => card);
  for (const card of cards) {
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
