// 卡片指派的 Lead 剛就緒時可能還在短暫 working（ISSUE-185）：codex 跳過更新選單後會載入工作階段，
// 就緒判斷看到 idle／done，送第一個提示時又讀到 working，直接丟 `agent is busy`。這裡只輪詢到 working 結束，
// 逾時仍 working 就把最後看到的紀錄交回去，由呼叫端照原本的忙碌檢查拒絕。

import type { AgentRecord } from "./types.js";

export const LEAD_SETTLE_MS = 15_000;
export const LEAD_SETTLE_POLL_MS = 500;

export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 不是 working 就原樣回傳；working 就輪詢到狀態改變或逾時。讀取失敗或 pane 不見時保留最後已知的紀錄。 */
export async function settleWorkingAgent(
  read: () => Promise<AgentRecord | undefined>,
  agent: AgentRecord,
  options: { timeoutMs?: number; pollMs?: number } = {},
  clock: SettleClock = realClock,
): Promise<AgentRecord> {
  if (agent.agent_status !== "working") return agent;
  const deadline = clock.now() + (options.timeoutMs ?? LEAD_SETTLE_MS);
  const pollMs = options.pollMs ?? LEAD_SETTLE_POLL_MS;
  let last = agent;
  while (clock.now() < deadline) {
    await clock.sleep(pollMs);
    let current: AgentRecord | undefined;
    try {
      current = await read();
    } catch {
      return last;
    }
    if (!current) return last;
    last = current;
    if (current.agent_status !== "working") return current;
  }
  return last;
}
