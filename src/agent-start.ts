// 在既有 pane 啟動指定種類的 Agent，等它被偵測到（`card assign --worktree` 用，與 Worker profile 的
// `agent.start` 相同）。
//
// ISSUE-067：新建 worktree 的 root pane 的 shell 可能還沒初始化完，Herdr 會以 `agent_pane_busy`
// 拒絕 `agent.start`（「target pane … is not an available shell」），幾秒後 shell 就好了。所以只對
// 這一個錯誤碼短暫重試（有上限）；其他任何錯誤都立刻失敗，不重試。

import { HerdrError } from "./herdr.js";
import {
  CODEX_ADD_DIR_IGNORED,
  detectIgnoredAddDir,
  extraLaunchArgsFor,
} from "./cli-adapter.js";
import type { AgentRecord } from "./types.js";

export interface AgentStartPort {
  prepareWorkspaceTrust?(kind: string, paneId: string, cwd?: string): void;
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; retries?: number },
  ): Promise<unknown>;
  listAgentsWithWorkspaceNames(): Promise<AgentRecord[]>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** shell 還沒就緒（`agent_pane_busy`）時最多重試這麼久，每次間隔固定。 */
export const BUSY_RETRY_MS = 15_000;
export const BUSY_RETRY_INTERVAL_MS = 500;
/** `agent.start` 回來後等 Agent 被偵測到的上限。 */
export const AGENT_SETTLE_MS = 30_000;
const SETTLE_INTERVAL_MS = 1_000;

export async function startAgentInPane(
  port: AgentStartPort,
  input: {
    paneId: string;
    kind: string;
    name: string;
    args?: string[];
    /** Agent 的工作目錄；codex 在 linked worktree 時據此加 `--add-dir`（ISSUE-115）。 */
    cwd?: string;
    skipWorkspaceTrust?: boolean;
  },
  clock: Clock = realClock,
): Promise<AgentRecord> {
  if (!input.skipWorkspaceTrust)
    port.prepareWorkspaceTrust?.(input.kind, input.paneId, input.cwd);
  const extra = extraLaunchArgsFor(input.kind, input.cwd);
  const args = [...(input.args ?? []), ...extra];
  const params = {
    pane_id: input.paneId,
    name: input.name,
    kind: input.kind,
    ...(args.length ? { args } : {}),
    timeout_ms: 30000,
  };
  const retryDeadline = clock.now() + BUSY_RETRY_MS;
  for (;;) {
    try {
      await port.request("agent.start", params, {
        retries: 0,
        timeoutMs: 35000,
      });
      break;
    } catch (error) {
      const busy =
        error instanceof HerdrError && error.code === "agent_pane_busy";
      if (!busy || clock.now() + BUSY_RETRY_INTERVAL_MS > retryDeadline) {
        if (
          extra.length &&
          detectIgnoredAddDir(error instanceof Error ? error.message : "")
        )
          throw new Error(CODEX_ADD_DIR_IGNORED);
        throw error;
      }
      await clock.sleep(BUSY_RETRY_INTERVAL_MS);
    }
  }

  // `agent.start` 回來時 Agent 常常還沒被偵測到（實測：先是沒有種類與 unknown，約 2–4 秒後才變成
  // claude／blocked 或 idle）。輪詢到狀態離開 unknown 或逾時，回傳最後看到的紀錄，由呼叫端判斷是否 idle。
  const deadline = clock.now() + AGENT_SETTLE_MS;
  let agent: AgentRecord | undefined;
  for (;;) {
    agent = (await port.listAgentsWithWorkspaceNames()).find(
      (item) => item.pane_id === input.paneId,
    );
    if (agent?.agent && agent.agent_status !== "unknown") return agent;
    if (clock.now() >= deadline) break;
    await clock.sleep(SETTLE_INTERVAL_MS);
  }
  if (extra.length && !agent?.agent) {
    // codex 拒絕 --add-dir 時會直接結束；讀 pane 輸出確認原因，不退回成沒有該參數的啟動。
    const text = await readPaneText(port, input.paneId);
    if (detectIgnoredAddDir(text)) throw new Error(CODEX_ADD_DIR_IGNORED);
  }
  if (!agent)
    throw new Error(
      `started Agent not visible in ${input.paneId}; inspect the pane before retrying`,
    );
  return agent;
}

async function readPaneText(
  port: AgentStartPort,
  paneId: string,
): Promise<string> {
  try {
    const result = (await port.request("agent.read", {
      target: paneId,
      source: "recent_unwrapped",
      lines: 80,
    })) as { read?: { text?: unknown }; text?: unknown } | undefined;
    const text = result?.read?.text ?? result?.text;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}
