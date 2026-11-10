// H2 自動撿卡的接線層（ISSUE-096 第二部分）：把 `src/autopick.ts` 的 `AutopickSteps` 接到真的 Herdr 與
// 本機 console 指令。所有外部依賴都經 `AutopickWiringDeps` 注入，所以可以單元測試。
//
// 為什麼用 console 指令：`card assign／commit／pr／loop` 的每個守門都在指令裡，自動流程走同一條路，
// 不另開後門。為了不動到使用者自己的 console 路由，自動流程用另一個使用者 id（`autopick`）。

import { autopickLeadLabel } from "./policy.js";
import { doneAsReady, waitUntilReady } from "./agent-ready.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { startAgentInPane, type AgentStartPort } from "./agent-start.js";
import type { AutopickJob, AutopickSteps } from "./autopick.js";

export const AUTOPICK_USER = "autopick";

export interface AutopickWiringDeps {
  validateJob?: (job: AutopickJob) => void;
  port: AgentStartPort;
  /** 以自動撿卡的身分執行一個 console 指令（例如 `card commit <id>`），回傳印出的文字；失敗丟錯誤。 */
  command(text: string): Promise<string>;
  recordLeadWorkspace(cardId: string, workspaceId: string, label: string): void;
  taskIdForCard(cardId: string): string | undefined;
  taskState(taskId: string): { state: string; detail?: string } | undefined;
  cardStatus(cardId: string): string | undefined;
  /** 非空的 workspace 白名單：新開的 workspace 不在名單內，第一版不支援。 */
  allowedWorkspaceIds: string[];
  sleep(ms: number): Promise<void>;
  now(): number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  taskTimeoutMs?: number;
  cardDoneTimeoutMs?: number;
  pollMs?: number;
}

const TERMINAL = ["completed", "failed", "cancelled"];

export function createAutopickSteps(deps: AutopickWiringDeps): AutopickSteps {
  // 共用的等待只認 idle；Lead 啟動後 working → done 也算就緒（見 doneAsReady）。
  const readyPort = doneAsReady(deps.port);
  const pollMs = deps.pollMs ?? 3000;
  const taskTimeoutMs = deps.taskTimeoutMs ?? 45 * 60 * 1000;
  // ISSUE-095：卡片檔每 60 秒才同步一次，所以要等得比一個掃描週期久。
  const cardDoneTimeoutMs = deps.cardDoneTimeoutMs ?? 150 * 1000;

  async function waitFor<T>(
    timeoutMs: number,
    check: () => T | undefined,
  ): Promise<T | undefined> {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value !== undefined) return value;
      if (deps.now() >= deadline) return undefined;
      await deps.sleep(pollMs);
    }
  }

  return {
    async startLead(job: AutopickJob) {
      deps.validateJob?.(job);
      if (deps.allowedWorkspaceIds.length)
        throw new Error(
          "workspace 白名單（allowedWorkspaceIds）非空時，自動撿卡新開的 workspace 不在名單內，第一版不支援",
        );
      let stat: fs.Stats;
      try {
        stat = fs.statSync(job.repoPath);
      } catch {
        throw new Error(`repo 路徑不存在：${job.repoPath}`);
      }
      if (!stat.isDirectory())
        throw new Error(`repo 路徑不是資料夾：${job.repoPath}`);

      const label = autopickLeadLabel(job.lead, job.card.id);
      const created = (await deps.port.request("workspace.create", {
        cwd: job.repoPath,
        label,
        focus: false,
      })) as {
        workspace?: { workspace_id?: string };
        root_pane?: { pane_id?: string };
      };
      const workspaceId = created.workspace?.workspace_id;
      const paneId = created.root_pane?.pane_id;
      if (!workspaceId || !paneId)
        throw new Error("workspace.create 的回應缺少 workspace 或 pane id");
      const close = async () => {
        try {
          await deps.port.request("workspace.close", {
            workspace_id: workspaceId,
          });
        } catch (error) {
          // Merge cleanup may already have closed this Lead before loop returns.
          // Only confirmed absence is success; query failures and other close errors retain the original failure.
          const current = (await deps.port
            .request("workspace.list")
            .catch(() => undefined)) as
            { workspaces?: { workspace_id: string }[] } | undefined;
          if (
            Array.isArray(current?.workspaces) &&
            current.workspaces.every(
              (w) => typeof w?.workspace_id === "string",
            ) &&
            !current.workspaces.some((w) => w.workspace_id === workspaceId)
          ) {
            console.warn(
              `autopick Lead ${job.card.id}: workspace already closed`,
            );
            return;
          }
          throw error;
        }
      };
      try {
        deps.recordLeadWorkspace(job.card.id, workspaceId, label);
        const lead = await startAgentInPane(deps.port, {
          paneId,
          kind: job.lead,
          name: `hdb-autopick-${randomUUID().slice(0, 8)}`,
          cwd: job.repoPath,
        });
        const ready = await waitUntilReady(
          {
            panePort: readyPort,
            role: "Lead",
            readyTimeoutMs: deps.readyTimeoutMs,
            readyPollMs: deps.readyPollMs,
          },
          { paneId, terminalId: lead.terminal_id },
          lead.agent_status === "done"
            ? { ...lead, agent_status: "idle" }
            : lead,
        );
        if (!ready.ok)
          throw new Error(`Lead（${job.lead}）沒有就緒：${ready.reason}`);
        await deps.command(`wk use ${workspaceId}`);
        await deps.command(`agent use ${paneId}`);
      } catch (error) {
        // 還沒開始任何工作：不留下空的 workspace。
        await close().catch(() => undefined);
        throw error;
      }
      return { close };
    },

    command: (text) => deps.command(text),

    async waitTask(cardId) {
      const taskId = deps.taskIdForCard(cardId);
      if (!taskId) return { completed: false, detail: "找不到這張卡的 task" };
      let last = "unknown";
      const done = await waitFor(taskTimeoutMs, () => {
        const task = deps.taskState(taskId);
        if (!task) return undefined;
        last = task.state;
        // blocked 需要人回答，不等。
        if (TERMINAL.includes(task.state) || task.state === "blocked")
          return task;
        return undefined;
      });
      if (!done) return { completed: false, detail: `逾時，task 狀態 ${last}` };
      return {
        completed: done.state === "completed",
        detail: `${done.state}${done.detail ? `：${done.detail}` : ""}`,
      };
    },

    async waitCardDone(cardId) {
      const found = await waitFor(cardDoneTimeoutMs, () =>
        deps.cardStatus(cardId) === "done" ? true : undefined,
      );
      return found === true;
    },

    async loop(cardId, reviewer) {
      const text = await deps.command(
        `card loop ${cardId}${reviewer ? ` --agent ${reviewer}` : ""} --merge`,
      );
      // ISSUE-101：收到的是 `card loop` 印出的全部輸出（進度行在前、最後才是「loop 結束」），
      // 所以要找「以『loop 結束：』開頭、同一行含『已 merge』」的那一行，不能假設它在整段文字開頭。
      return {
        merged: /^loop 結束：.*已 merge/m.test(text),
        text,
      };
    },
  };
}
