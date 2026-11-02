// 哪個 Team 任務是由哪張卡片指派的（ADR-0002 階段 2c）。
//
// 卡片被刪除後，卡片本身就看不到 task id 了；任務 journal 也不知道卡片。這份小索引讓 bridge
// 在卡片消失時仍能認出「這個進行中的任務原本屬於哪張卡」。它只是索引，不是權威資料：
// 任務狀態以 Team 任務 journal 為準，卡片內容以卡片檔為準。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCardId } from "./card.js";
import { TASK_ID } from "./card-fields.js";

export interface CardAssignment {
  taskId: string;
  cardId: string;
  type: string;
  /** UTC，`YYYY-MM-DDTHH:MM:SSZ`。 */
  assignedAt: string;
  /** 已通知「卡片被刪除」的時間；只通知一次。 */
  notifiedAt?: string;
}

interface FileShape {
  version: 1;
  assignments: CardAssignment[];
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TYPES = ["requirement", "ticket"];

function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function assertAssignment(item: unknown, label: string): CardAssignment {
  const entry = item as Partial<CardAssignment> | null;
  if (!entry || typeof entry !== "object")
    throw new Error(`${label}: not an object`);
  if (typeof entry.taskId !== "string" || !TASK_ID.test(entry.taskId))
    throw new Error(`${label}: invalid taskId`);
  if (typeof entry.cardId !== "string" || !isCardId(entry.cardId))
    throw new Error(`${label}: invalid cardId`);
  if (typeof entry.type !== "string" || !TYPES.includes(entry.type))
    throw new Error(`${label}: invalid type`);
  if (!validTime(entry.assignedAt)) throw new Error(`${label}: invalid time`);
  if (entry.notifiedAt !== undefined && !validTime(entry.notifiedAt))
    throw new Error(`${label}: invalid notifiedAt`);
  return {
    taskId: entry.taskId,
    cardId: entry.cardId,
    type: entry.type,
    assignedAt: entry.assignedAt,
    ...(entry.notifiedAt ? { notifiedAt: entry.notifiedAt } : {}),
  };
}

const shared = new Map<string, CardAssignmentStore>();

/** 同一個檔案在程序內共用一個實例：各自快取再整檔寫回會互相覆蓋對方的更新。 */
export function sharedCardAssignments(file: string): CardAssignmentStore {
  let store = shared.get(file);
  if (!store) {
    store = new CardAssignmentStore(file);
    shared.set(file, store);
  }
  return store;
}

export class CardAssignmentStore {
  private assignments: CardAssignment[] = [];

  constructor(private readonly file: string) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: FileShape;
    try {
      parsed = JSON.parse(text) as FileShape;
    } catch {
      throw new Error(`card-assignments file is not valid JSON: ${file}`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.assignments))
      throw new Error(
        `card-assignments file has an unsupported format: ${file}`,
      );
    const seen = new Set<string>();
    for (const [index, item] of parsed.assignments.entries()) {
      const entry = assertAssignment(item, `card-assignments entry ${index}`);
      if (seen.has(entry.taskId))
        throw new Error(
          `card-assignments has a duplicate task ${entry.taskId}`,
        );
      seen.add(entry.taskId);
      this.assignments.push(entry);
    }
  }

  list(): CardAssignment[] {
    return structuredClone(this.assignments);
  }

  forCard(cardId: string): CardAssignment[] {
    return this.list().filter((entry) => entry.cardId === cardId);
  }

  /** 冪等：同一個 task 已經記過就不改。 */
  record(
    input: { taskId: string; cardId: string; type: string },
    at: string,
  ): void {
    const entry = assertAssignment({ ...input, assignedAt: at }, "assignment");
    if (this.assignments.some((item) => item.taskId === entry.taskId)) return;
    this.assignments.push(entry);
    this.save();
  }

  /** 只記第一次通知的時間；重複呼叫不改。 */
  markNotified(taskId: string, at: string): void {
    const entry = this.assignments.find((item) => item.taskId === taskId);
    if (!entry) throw new Error(`unknown task ${taskId}`);
    if (!validTime(at)) throw new Error("invalid time");
    if (entry.notifiedAt) return;
    entry.notifiedAt = at;
    this.save();
  }

  private save(): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const body: FileShape = { version: 1, assignments: this.assignments };
    try {
      fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}
