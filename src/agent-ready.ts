// Agent 剛啟動後等它就緒（ISSUE-079）。`card review` 與 `card fix` 共用：兩者都是在新開的 pane 啟動一個全新的 Agent，
// `agent.start` 回來時 Agent 常常還在初始化（實測：codex 啟動後先是 working），不能一看到不是 idle 就放棄。

import type { AgentStartPort } from "./agent-start.js";
import type { AgentRecord } from "./types.js";

export interface ReadyDeps {
  panePort: AgentStartPort;
  /** 啟動後等 Agent 變成 idle 的上限（預設 30 秒）與輪詢間隔（預設 1 秒）。 */
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

const BLOCKED_AT_START =
  "reviewer 卡在啟動提示（blocked）。常見原因：Agent 自己的更新提示或新資料夾的信任提示；bridge 不會替人確認，請先在要用的種類上處理一次";

/**
 * ISSUE-079：`agent.start` 回來時 Agent 常常還在初始化（實測：codex 啟動後先是 working），不能一看到不是 idle
 * 就放棄。已經 idle 就直接用；blocked 立刻放棄（在等人，等也沒用）；其他狀態輪詢到 idle、blocked、
 * pane 消失或逾時為止。
 */
export async function waitUntilReady(
  deps: ReadyDeps,
  pane: { paneId: string; terminalId: string },
  started: AgentRecord,
): Promise<{ ok: true; agent: AgentRecord } | { ok: false; reason: string }> {
  let agent = started;
  if (agent.agent_status === "idle") return { ok: true, agent };
  if (agent.agent_status === "blocked")
    return { ok: false, reason: BLOCKED_AT_START };
  const timeout = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const poll = deps.readyPollMs ?? READY_POLL_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (Date.now() >= deadline)
      return {
        ok: false,
        reason: `reviewer 在 ${Math.round(timeout / 1000)} 秒內沒有就緒（狀態 ${agent.agent_status}）`,
      };
    await new Promise((resolve) => setTimeout(resolve, poll));
    let listed: AgentRecord[];
    try {
      listed = await deps.panePort.listAgentsWithWorkspaceNames();
    } catch (error) {
      return {
        ok: false,
        reason: `等待 reviewer 就緒時讀取 Agent 清單失敗：${(error instanceof Error ? error.message : "unknown error")}`,
      };
    }
    const current = listed.find(
      (item) =>
        item.pane_id === pane.paneId && item.terminal_id === pane.terminalId,
    );
    if (!current)
      return {
        ok: false,
        reason: "等待 reviewer 就緒時，它的 pane 不見了（消失或被換掉）",
      };
    agent = current;
    if (agent.agent_status === "idle") return { ok: true, agent };
    if (agent.agent_status === "blocked")
      return { ok: false, reason: BLOCKED_AT_START };
  }
}

