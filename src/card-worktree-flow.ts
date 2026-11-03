// 卡片的 worktree 準備與清理流程（階段 3b）。所有外部動作（Herdr、git、路由、授權）都由呼叫端注入，
// 這一層只管順序與失敗時的處理：
//
// 準備：驗證 → 建立 worktree → **先記進索引** → 授權 → 啟動同種 Agent → 切換路由。
// 索引先於 Agent 啟動，所以 Agent 啟動失敗時 worktree 仍找得到、`card cleanup` 清得掉；
// 路由最後才切，Agent 沒起來就不會把對話導到一個沒有 Agent 的 workspace。
// 清理：永不強制；髒檢出保留；成功才改索引與授權。

import {
  branchForCard,
  checkWorktreeSupport,
  createWorktree,
  removeWorktree,
  type WorktreePort,
} from "./worktree.js";
import type { CardWorktreeStore } from "./card-worktrees.js";
import type { AgentRecord } from "./types.js";

/** worktree 已建立但後續步驟失敗：訊息要讓使用者知道它在哪裡、怎麼清掉。 */
export class WorktreePartialError extends Error {
  constructor(
    message: string,
    public readonly workspaceId: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "WorktreePartialError";
  }
}

export interface PrepareDeps {
  port: WorktreePort;
  /** 目前 thread 的 active Agent（呼叫端已解析並驗證過授權）。 */
  lead: AgentRecord;
  /** thread 目前路由的 workspace；新 worktree workspace 的授權以它為前提。 */
  sourceWorkspaceId: string;
  /** 取得某目錄所在 git repo 的根目錄；不是 git repo 回傳 undefined。 */
  repoRoot(directory: string): Promise<string | undefined>;
  /** 取得某目錄目前的 HEAD sha；失敗回傳 undefined。 */
  headSha(directory: string): Promise<string | undefined>;
  startAgent(input: {
    paneId: string;
    kind: string;
    name: string;
  }): Promise<AgentRecord>;
  worktrees: Pick<CardWorktreeStore, "active" | "record">;
  authorize(workspaceId: string): void;
  switchRoute(workspaceId: string, agent: AgentRecord): void;
  now(): string;
}

export interface PreparedWorktree {
  workspaceId: string;
  path: string;
  branch: string;
  repoPath: string;
  baseSha?: string;
  agent: AgentRecord;
  /** Agent 已經 idle、可以接任務。blocked（例如 Claude Code 的「信任這個資料夾」提示）時為 false。 */
  agentReady: boolean;
}

export async function prepareCardWorktree(
  deps: PrepareDeps,
  cardId: string,
): Promise<PreparedWorktree> {
  if (deps.worktrees.active(cardId))
    throw new Error(
      `卡片 ${cardId} 已有作用中的 worktree；先用 \`card cleanup ${cardId}\` 清掉，或直接在目前路由的 workspace 用 \`card assign ${cardId}\``,
    );
  const directory = deps.lead.foreground_cwd || deps.lead.cwd;
  if (!directory)
    throw new Error(
      "目前 Agent 沒有可用的工作目錄，無法判斷要在哪個 repo 建立 worktree",
    );
  const kind = deps.lead.agent;
  if (typeof kind !== "string" || !kind)
    throw new Error(
      "無法判斷目前 Agent 的種類，無法在新 workspace 啟動同種 Agent",
    );
  const repoPath = await deps.repoRoot(directory);
  if (!repoPath)
    throw new Error(
      `目前 Agent 的工作目錄 ${directory} 不在 git repository 內`,
    );
  const support = await checkWorktreeSupport(deps.port);
  if (!support.ok) throw new Error(`無法使用 worktree：${support.reason}`);

  const created = await createWorktree(deps.port, {
    repoPath,
    branch: branchForCard(cardId),
  });
  const baseSha = await deps.headSha(created.path).catch(() => undefined);
  try {
    deps.worktrees.record(
      {
        cardId,
        workspaceId: created.workspaceId,
        sourceWorkspaceId: deps.sourceWorkspaceId,
        path: created.path,
        repoPath,
        branch: created.branch,
      },
      deps.now(),
    );
  } catch (error) {
    throw new WorktreePartialError(
      `worktree 已建立（workspace ${created.workspaceId}，${created.path}）但寫入索引失敗：${error instanceof Error ? error.message : "unknown error"}。bridge 不會追蹤它，需要手動清理`,
      created.workspaceId,
      created.path,
    );
  }
  deps.authorize(created.workspaceId);
  let agent: AgentRecord;
  try {
    agent = await deps.startAgent({
      paneId: created.rootPaneId,
      kind,
      name: `card-${cardId.toLowerCase()}`.slice(0, 40),
    });
  } catch (error) {
    throw new WorktreePartialError(
      `worktree 已建立（workspace ${created.workspaceId}，${created.path}）但 Agent 沒有啟動：${error instanceof Error ? error.message : "unknown error"}。任務沒有啟動；可 \`card cleanup ${cardId}\` 清掉`,
      created.workspaceId,
      created.path,
    );
  }
  // 路由一律切過去：Agent 在等人確認時，人處理完仍可在這個 thread 直接 `card assign`。
  deps.switchRoute(created.workspaceId, agent);
  return {
    workspaceId: created.workspaceId,
    path: created.path,
    branch: created.branch,
    repoPath,
    baseSha,
    agent,
    agentReady: agent.agent_status === "idle",
  };
}

export interface CleanupDeps {
  port: WorktreePort;
  worktrees: Pick<CardWorktreeStore, "active" | "markRemoved">;
  deauthorize(workspaceId: string): void;
  now(): string;
}

export type CleanupResult =
  | { removed: true; workspaceId: string; path: string; branch: string }
  | {
      removed: false;
      reason: "dirty_worktree";
      workspaceId: string;
      path: string;
      branch: string;
    };

/** 移除卡片的 worktree：永不強制；有未提交修改就保留，分支一律保留。 */
export async function cleanupCardWorktree(
  deps: CleanupDeps,
  cardId: string,
): Promise<CleanupResult> {
  const entry = deps.worktrees.active(cardId);
  if (!entry) throw new Error(`卡片 ${cardId} 沒有作用中的 worktree`);
  const info = {
    workspaceId: entry.workspaceId,
    path: entry.path,
    branch: entry.branch,
  };
  const result = await removeWorktree(deps.port, entry.workspaceId);
  if (!result.ok) return { removed: false, reason: result.reason, ...info };
  deps.worktrees.markRemoved(cardId, deps.now());
  deps.deauthorize(entry.workspaceId);
  return { removed: true, ...info };
}
