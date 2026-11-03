// Herdr 原生 worktree 的轉接層（ADR-0002／需求卡 REQ-20261101-worktree-isolation，階段 3a）。
//
// 走 Herdr socket API（`worktree.list`／`create`／`remove`），不呼叫 CLI。這一層刻意很窄：
// - 只送安全的參數：永不送 `force`、`trust_repository`、`path`、`label`；`focus` 固定 false。
// - 清理遇到有未提交修改的檢出時回報「保留」，不丟錯誤、也不強制（強制移除會永久丟失未提交修改）。
// - 不刪分支（Herdr 本來就不刪）。
// - 所有輸入在送出前驗證；回應缺欄位就拒絕，不猜測。

import path from "node:path";
import { HerdrError } from "./herdr.js";
import { isCardId } from "./card.js";

/** 只用到 `request`，`HerdrClient` 直接符合；測試用假 port。 */
export interface WorktreePort {
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; retries?: number },
  ): Promise<T>;
}

export type WorktreeErrorCode =
  "invalid" | "create_failed" | "unexpected_response";

export class WorktreeError extends Error {
  constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** 實測過 worktree 行為的版本（本機 0.9.1；官方文件 v0.9.5 與實測一致）。 */
export const MIN_HERDR_VERSION = "0.9.1";

const CONTROL = /[\u0000-\u001F\u007F]/;
const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,80}$/;
const BASE_CHARS = /^[A-Za-z0-9._/@-]{1,100}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
// worktree 建立可能要跑 git（clone 大型 repo 的 checkout），給比一般請求寬鬆的逾時。
const CREATE_TIMEOUT_MS = 60_000;

/** 卡片的分支名：`card/<卡片 id>`（使用者 2026-11-02 決定）。 */
export function branchForCard(cardId: string): string {
  if (!isCardId(cardId))
    throw new WorktreeError("invalid", `${cardId} is not a card id`);
  return `card/${cardId}`;
}

function assertBranch(branch: string): void {
  const reason = (what: string): never => {
    throw new WorktreeError("invalid", `invalid branch name: ${what}`);
  };
  if (!BRANCH_CHARS.test(branch))
    return reason("only letters, digits, . _ / - up to 80 characters");
  if (branch.startsWith("-") || branch.startsWith("/"))
    return reason("cannot start with - or /");
  if (branch.endsWith("/") || branch.endsWith("."))
    return reason("cannot end with / or .");
  if (branch.includes("..") || branch.includes("//"))
    return reason("cannot contain .. or //");
  for (const part of branch.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock"))
      return reason("a path component cannot start with . or end with .lock");
  }
}

function assertBase(base: string): void {
  if (!BASE_CHARS.test(base) || base.startsWith("-") || base.includes(".."))
    throw new WorktreeError("invalid", "invalid base ref");
}

function assertRepoPath(repoPath: string): void {
  if (
    typeof repoPath !== "string" ||
    !path.isAbsolute(repoPath) ||
    repoPath.length > 1024 ||
    CONTROL.test(repoPath)
  )
    throw new WorktreeError(
      "invalid",
      "repository path must be an absolute path without control characters",
    );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export interface CreatedWorktree {
  workspaceId: string;
  path: string;
  branch: string;
  rootPaneId: string;
  tabId?: string;
}

/**
 * 建立 worktree 與對應的 Herdr workspace。基準預設為 repo 目前的 HEAD（不給 `base`）；
 * 不會先 `git fetch`。分支已存在時 Herdr 會直接檢出它（可續作）。
 */
export async function createWorktree(
  port: WorktreePort,
  input: { repoPath: string; branch: string; base?: string },
): Promise<CreatedWorktree> {
  assertRepoPath(input.repoPath);
  assertBranch(input.branch);
  if (input.base !== undefined) assertBase(input.base);
  let response: unknown;
  try {
    response = await port.request(
      "worktree.create",
      {
        cwd: input.repoPath,
        branch: input.branch,
        focus: false,
        ...(input.base !== undefined ? { base: input.base } : {}),
      },
      { timeoutMs: CREATE_TIMEOUT_MS, retries: 0 },
    );
  } catch (error) {
    if (error instanceof HerdrError && error.code === "worktree_create_failed")
      throw new WorktreeError("create_failed", error.message);
    throw error;
  }
  const result = record(response);
  const workspaceId = text(record(result.workspace).workspace_id);
  const worktree = record(result.worktree);
  const worktreePath = text(worktree.path);
  const rootPaneId = text(record(result.root_pane).pane_id);
  if (!workspaceId || !worktreePath || !rootPaneId)
    throw new WorktreeError(
      "unexpected_response",
      "unexpected worktree.create response: missing workspace, path or root pane",
    );
  return {
    workspaceId,
    path: worktreePath,
    branch: text(worktree.branch) ?? input.branch,
    rootPaneId,
    tabId: text(record(result.tab).tab_id),
  };
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
  linked: boolean;
  openWorkspaceId?: string;
}

/** 列出某個 repo 的所有檢出；無副作用（不會開 workspace）。 */
export async function listWorktrees(
  port: WorktreePort,
  repoPath: string,
): Promise<WorktreeEntry[]> {
  assertRepoPath(repoPath);
  const response = record(
    await port.request("worktree.list", { cwd: repoPath }),
  );
  const items = Array.isArray(response.worktrees) ? response.worktrees : [];
  const entries: WorktreeEntry[] = [];
  for (const item of items) {
    const entry = record(item);
    const entryPath = text(entry.path);
    if (!entryPath) continue;
    entries.push({
      path: entryPath,
      branch: text(entry.branch),
      linked: entry.is_linked_worktree === true,
      openWorkspaceId: text(entry.open_workspace_id),
    });
  }
  return entries;
}

export type RemoveResult =
  { ok: true } | { ok: false; reason: "dirty_worktree" };

/**
 * 移除 worktree。**永不強制**：有未提交修改時 Herdr 會拒絕，這裡回報 `dirty_worktree`（保留檢出，
 * 由呼叫端通知使用者）。分支不會被刪除。
 */
export async function removeWorktree(
  port: WorktreePort,
  workspaceId: string,
): Promise<RemoveResult> {
  if (!WORKSPACE_ID.test(workspaceId))
    throw new WorktreeError("invalid", "invalid workspace id");
  let response: unknown;
  try {
    response = await port.request("worktree.remove", {
      workspace_id: workspaceId,
    });
  } catch (error) {
    if (
      error instanceof HerdrError &&
      error.code === "dirty_worktree_requires_force"
    )
      return { ok: false, reason: "dirty_worktree" };
    throw error;
  }
  if (record(response).forced === true)
    throw new WorktreeError(
      "unexpected_response",
      "worktree.remove reported a forced removal; the bridge never forces",
    );
  return { ok: true };
}

function parseVersion(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

export type SupportResult =
  { ok: true; version: string } | { ok: false; reason: string };

/** 啟動前檢查 Herdr 版本；不足、讀不到版本或連不上都回報原因，不丟錯誤。 */
export async function checkWorktreeSupport(
  port: WorktreePort,
): Promise<SupportResult> {
  let reply: unknown;
  try {
    reply = await port.request("ping", {}, { timeoutMs: 1500, retries: 0 });
  } catch (error) {
    return {
      ok: false,
      reason: `cannot reach Herdr: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  const raw = record(reply).version;
  const have = parseVersion(raw);
  if (!have)
    return {
      ok: false,
      reason: `cannot determine the Herdr version (need ${MIN_HERDR_VERSION} or newer)`,
    };
  const need = parseVersion(MIN_HERDR_VERSION)!;
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return { ok: true, version: String(raw) };
    if (have[i] < need[i])
      return {
        ok: false,
        reason: `Herdr ${String(raw)} is older than ${MIN_HERDR_VERSION}, which worktree support was tested on`,
      };
  }
  return { ok: true, version: String(raw) };
}
