// Agent 剛啟動後等它就緒（ISSUE-079）。`card review` 與 `card fix` 共用：兩者都是在新開的 pane 啟動一個全新的 Agent，
// `agent.start` 回來時 Agent 常常還在初始化（實測：codex 啟動後先是 working），不能一看到不是 idle 就放棄。

import type { AgentStartPort } from "./agent-start.js";
import type { AgentRecord } from "./types.js";
import { matchUpdatePrompt } from "./update-prompts.js";

export interface ReadyDeps {
  panePort: AgentStartPort;
  /** 啟動後等 Agent 變成 idle 的上限（預設 30 秒）與輪詢間隔（預設 1 秒）。 */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  /** 訊息裡稱呼被等的 Agent（預設 reviewer；autopick 的 Lead 用 Lead）。 */
  role?: string;
}

// Shared across calls on the same bridge port, including concurrent waits.
export interface UpdateSkip {
  kind: string;
  paneId: string;
  key: string;
}

export type ReadyResult =
  | { ok: true; agent: AgentRecord; updateSkip?: UpdateSkip }
  | { ok: false; reason: string; updateSkip?: UpdateSkip };

const skippedPanes = new WeakMap<AgentStartPort, Set<string>>();

const settledPorts = new WeakMap<AgentStartPort, AgentStartPort>();

/**
 * 讓 `waitUntilReady`（只認 idle）把 `done` 也當成就緒：Lead 啟動後可能先 working、再直接變 done。
 * 每個底層 port 只建一個轉接，這樣 `skippedPanes`（依 port 去重）在重複等待之間仍然有效。
 */
export function doneAsReady(port: AgentStartPort): AgentStartPort {
  let adapted = settledPorts.get(port);
  if (!adapted) {
    adapted = {
      request: (method, params, options) =>
        port.request(method, params, options),
      listAgentsWithWorkspaceNames: async () =>
        (await port.listAgentsWithWorkspaceNames()).map((agent) =>
          agent.agent_status === "done"
            ? { ...agent, agent_status: "idle" }
            : agent,
        ),
    };
    settledPorts.set(port, adapted);
  }
  return adapted;
}

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

function blockedAtStart(role: string): string {
  return `${role} 卡在啟動提示（blocked）。常見原因：Agent 自己的更新提示或新資料夾的信任提示；bridge 不會替人確認，請先在要用的種類上處理一次`;
}

export const BLOCKED_AT_START = blockedAtStart("reviewer");

async function skipKnownUpdate(
  deps: ReadyDeps,
  paneId: string,
  kind: string | undefined,
): Promise<{ proceed: boolean; skip?: UpdateSkip }> {
  let sent = skippedPanes.get(deps.panePort);
  if (sent?.has(paneId)) return { proceed: false };
  const readScreen = async (): Promise<string | undefined> => {
    const result = await deps.panePort.request("agent.read", {
      target: paneId,
      source: "visible",
      lines: 80,
    });
    if (!result || typeof result !== "object") return undefined;
    const record = result as { read?: { text?: unknown }; text?: unknown };
    const text = record.read?.text ?? record.text;
    return typeof text === "string" ? text : undefined;
  };
  let skip: UpdateSkip | undefined;
  try {
    const screen = await readScreen();
    const entry =
      screen === undefined ? undefined : matchUpdatePrompt(kind, screen);
    if (!entry) return { proceed: false };
    // Recheck after the read: another wait may have sent while we awaited it.
    if (!sent) {
      sent = skippedPanes.get(deps.panePort) ?? new Set<string>();
      skippedPanes.set(deps.panePort, sent);
    }
    if (sent.has(paneId)) return { proceed: false };
    sent.add(paneId); // Uncertain delivery must never be retried.
    await deps.panePort.request(
      "pane.send_keys",
      {
        pane_id: paneId,
        keys: [entry.skipKey],
      },
      { retries: 0 },
    );
    console.log(
      `已自動跳過 ${entry.kind} 的更新提示（pane ${paneId}、按鍵 ${entry.skipKey}）`,
    );
    skip = { kind: entry.kind, paneId, key: entry.skipKey };
    const after = await readScreen();
    return {
      proceed:
        after !== undefined &&
        !entry.match.every((text) => after.includes(text)),
      skip,
    };
  } catch {
    return { proceed: false, ...(skip ? { skip } : {}) };
  }
}

/**
 * ISSUE-079：`agent.start` 回來時 Agent 常常還在初始化（實測：codex 啟動後先是 working），不能一看到不是 idle
 * 就放棄。已經 idle 就直接用；blocked 只嘗試跳過已知更新提示，其餘保持原失敗；其他狀態輪詢到 idle、blocked、
 * pane 消失或逾時為止。
 */
export async function waitUntilReady(
  deps: ReadyDeps,
  pane: { paneId: string; terminalId: string },
  started: AgentRecord,
): Promise<ReadyResult> {
  const role = deps.role ?? "reviewer";
  let agent = started;
  let updateSkip: UpdateSkip | undefined;
  const withSkip = <T extends object>(result: T) =>
    updateSkip ? { ...result, updateSkip } : result;
  if (agent.agent_status === "idle") return { ok: true, agent };
  if (agent.agent_status === "blocked") {
    const handled = await skipKnownUpdate(deps, pane.paneId, agent.agent);
    updateSkip = handled.skip ?? updateSkip;
    if (!handled.proceed)
      return withSkip({ ok: false as const, reason: blockedAtStart(role) });
  }
  const timeout = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const poll = deps.readyPollMs ?? READY_POLL_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (Date.now() >= deadline)
      return withSkip({
        ok: false as const,
        reason: `${role} 在 ${Math.round(timeout / 1000)} 秒內沒有就緒（狀態 ${agent.agent_status}）`,
      });
    await new Promise((resolve) => setTimeout(resolve, poll));
    let listed: AgentRecord[];
    try {
      listed = await deps.panePort.listAgentsWithWorkspaceNames();
    } catch (error) {
      return withSkip({
        ok: false as const,
        reason: `等待 ${role} 就緒時讀取 Agent 清單失敗：${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
    const current = listed.find(
      (item) =>
        item.pane_id === pane.paneId && item.terminal_id === pane.terminalId,
    );
    if (!current)
      return withSkip({
        ok: false as const,
        reason: `等待 ${role} 就緒時，它的 pane 不見了（消失或被換掉）`,
      });
    agent = current;
    if (agent.agent_status === "idle") return withSkip({ ok: true as const, agent });
    if (agent.agent_status === "blocked") {
      const handled = await skipKnownUpdate(deps, pane.paneId, agent.agent);
      updateSkip = handled.skip ?? updateSkip;
      if (!handled.proceed)
        return withSkip({ ok: false as const, reason: blockedAtStart(role) });
    }
  }
}
