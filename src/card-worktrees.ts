// 卡片與它的 worktree 的索引（階段 3b）。
//
// 用途：(1) `card cleanup <id>` 找得到要移除哪個 worktree workspace；(2) 只放行「bridge 自己建立並
// 記錄」的 worktree workspace（`allowedWorkspaceIds` 規則，使用者 2026-11-02 決定）；(3) 一張卡
// 同時只能有一個作用中的 worktree。這只是索引，不是權威資料：worktree 是否存在以 Herdr／git 為準。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCardId } from "./card.js";

export interface CardWorktree {
  cardId: string;
  /** worktree 自己的 Herdr workspace。 */
  workspaceId: string;
  /** 建立時卡片所在 thread 路由的 workspace；授權以它為前提。 */
  sourceWorkspaceId: string;
  /** worktree 的絕對路徑。 */
  path: string;
  /** 來源 repo 的絕對路徑。 */
  repoPath: string;
  branch: string;
  /** UTC，`YYYY-MM-DDTHH:MM:SSZ`。 */
  createdAt: string;
  removedAt?: string;
}

interface FileShape {
  version: 1;
  worktrees: CardWorktree[];
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    value.length <= 1024 &&
    !CONTROL.test(value)
  );
}

function assertEntry(item: unknown, label: string): CardWorktree {
  const entry = item as Partial<CardWorktree> | null;
  if (!entry || typeof entry !== "object")
    throw new Error(`${label}: not an object`);
  if (typeof entry.cardId !== "string" || !isCardId(entry.cardId))
    throw new Error(`${label}: invalid cardId`);
  if (
    typeof entry.workspaceId !== "string" ||
    !WORKSPACE_ID.test(entry.workspaceId)
  )
    throw new Error(`${label}: invalid workspaceId`);
  if (
    typeof entry.sourceWorkspaceId !== "string" ||
    !WORKSPACE_ID.test(entry.sourceWorkspaceId)
  )
    throw new Error(`${label}: invalid sourceWorkspaceId`);
  if (!absolute(entry.path)) throw new Error(`${label}: invalid path`);
  if (!absolute(entry.repoPath)) throw new Error(`${label}: invalid repoPath`);
  if (typeof entry.branch !== "string" || !BRANCH.test(entry.branch))
    throw new Error(`${label}: invalid branch`);
  if (!validTime(entry.createdAt)) throw new Error(`${label}: invalid time`);
  if (entry.removedAt !== undefined && !validTime(entry.removedAt))
    throw new Error(`${label}: invalid removedAt`);
  return {
    cardId: entry.cardId,
    workspaceId: entry.workspaceId,
    sourceWorkspaceId: entry.sourceWorkspaceId,
    path: entry.path,
    repoPath: entry.repoPath,
    branch: entry.branch,
    createdAt: entry.createdAt,
    ...(entry.removedAt ? { removedAt: entry.removedAt } : {}),
  };
}

export class CardWorktreeStore {
  private worktrees: CardWorktree[] = [];

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
      throw new Error(`card-worktrees file is not valid JSON: ${file}`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.worktrees))
      throw new Error(`card-worktrees file has an unsupported format: ${file}`);
    const activeCards = new Set<string>();
    const activeWorkspaces = new Set<string>();
    for (const [index, item] of parsed.worktrees.entries()) {
      const entry = assertEntry(item, `card-worktrees entry ${index}`);
      if (!entry.removedAt) {
        if (
          activeCards.has(entry.cardId) ||
          activeWorkspaces.has(entry.workspaceId)
        )
          throw new Error(
            `card-worktrees has two active entries for ${entry.cardId} or ${entry.workspaceId}`,
          );
        activeCards.add(entry.cardId);
        activeWorkspaces.add(entry.workspaceId);
      }
      this.worktrees.push(entry);
    }
  }

  list(): CardWorktree[] {
    return structuredClone(this.worktrees);
  }

  /** 卡片目前作用中（尚未移除）的 worktree。 */
  active(cardId: string): CardWorktree | undefined {
    const found = this.worktrees.find(
      (entry) => entry.cardId === cardId && !entry.removedAt,
    );
    return found ? structuredClone(found) : undefined;
  }

  /** 卡片最近的 worktree 紀錄：作用中的優先，否則是最後一筆（可能已清理）。 */
  latest(cardId: string): CardWorktree | undefined {
    const mine = this.worktrees.filter((entry) => entry.cardId === cardId);
    const found = mine.find((entry) => !entry.removedAt) ?? mine.at(-1);
    return found ? structuredClone(found) : undefined;
  }

  activeWorkspaceIds(): string[] {
    return this.worktrees
      .filter((entry) => !entry.removedAt)
      .map((entry) => entry.workspaceId);
  }

  record(
    input: Omit<CardWorktree, "createdAt" | "removedAt">,
    at: string,
  ): void {
    const entry = assertEntry({ ...input, createdAt: at }, "worktree");
    if (
      this.worktrees.some(
        (item) => item.cardId === entry.cardId && !item.removedAt,
      )
    )
      throw new Error(`card ${entry.cardId} already has an active worktree`);
    if (
      this.worktrees.some(
        (item) => item.workspaceId === entry.workspaceId && !item.removedAt,
      )
    )
      throw new Error(`workspace ${entry.workspaceId} is already recorded`);
    this.worktrees.push(entry);
    this.save();
  }

  markRemoved(cardId: string, at: string): void {
    if (!validTime(at)) throw new Error("invalid time");
    const entry = this.worktrees.find(
      (item) => item.cardId === cardId && !item.removedAt,
    );
    if (!entry) throw new Error(`no active worktree for ${cardId}`);
    entry.removedAt = at;
    this.save();
  }

  private save(): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const body: FileShape = { version: 1, worktrees: this.worktrees };
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

const shared = new Map<string, CardWorktreeStore>();

/** 同一個檔案在程序內共用一個實例：各自快取再整檔寫回會互相覆蓋對方的更新。 */
export function sharedCardWorktrees(file: string): CardWorktreeStore {
  let store = shared.get(file);
  if (!store) {
    store = new CardWorktreeStore(file);
    shared.set(file, store);
  }
  return store;
}
