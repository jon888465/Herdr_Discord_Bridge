import {
  preflightRoles,
  resolveFlowRole,
  validateRoleSnapshot,
  type RoleContext,
  type RoleSnapshot,
} from "./card-role-assignment.js";
// `card fix` 的前提檢查與組裝（追蹤清單 F5 的 loop 手動版）：把卡片、worktree 索引、任務紀錄與 Herdr 接成一圈
// `runCardFix`。所有外部東西都由呼叫端注入。前提不符合就丟出說明原因的錯誤（卡片不動、不開任何 pane）。
// 作者是「最後一個 pane」（使用者 2026-11-04）：卡片最後一個任務的 Lead，它的 pane 必須還在（新 pane 從它分割出來，
// 種類沿用它）。修正只動本機的 worktree，不讀 GitHub，所以不需要專案政策 L1 以上。

import type { Card } from "./card.js";
import type { OpenFinding } from "./card-fix.js";
import {
  runCardFix,
  type FixFlowDeps,
  type FixFlowResult,
} from "./card-fix-flow.js";
import { runRemoteCardFix, type StartRemoteRole } from "./card-fix-remote.js";
import { remoteRoleWork, trackRemoteWork } from "./machine-busy.js";
import type { CardWorktree } from "./card-worktrees.js";
import type { AgentRecord } from "./types.js";

export interface FixWiringDeps {
  roleContext?: RoleContext;
  /** 任務建立時凍結的角色快照（優先於磁碟卡片，防止任務中改寫卡片竄改約束）。 */
  taskRoleSnapshot?(taskId: string): RoleSnapshot | undefined;
  worktrees: { active(cardId: string): CardWorktree | undefined };
  assignments: { forCard(cardId: string): Array<{ taskId: string }> };
  /** 任務紀錄裡的 Lead（作者）；找不到回傳 undefined。 */
  taskLead(taskId: string): AgentRecord | undefined;
  listAgents(): Promise<AgentRecord[]>;
  flow: FixFlowDeps;
  /** 遠端 fixer（ISSUE-171）：卡片 `roles.fixer` 指到開放寫入的 machine 時使用；沒給就拒絕遠端 fixer。 */
  remote?: { start: StartRemoteRole };
}

export async function fixCardWorktree(
  deps: FixWiringDeps,
  card: Card,
  options: { agent?: string; round: number; findings: OpenFinding[] },
): Promise<FixFlowResult> {
  const assignedTaskId = deps.assignments.forCard(card.id).at(-1)?.taskId;
  const snapshot = deps.taskRoleSnapshot
    ? assignedTaskId
      ? deps.taskRoleSnapshot(assignedTaskId)
      : undefined
    : card.roles
      ? preflightRoles(
          card.roles,
          deps.roleContext ?? { machineIds: [], profiles: [] },
        )
      : undefined;
  if (deps.taskRoleSnapshot && snapshot) validateRoleSnapshot(snapshot);
  const effectiveCard: Card = snapshot
    ? { ...card, roles: structuredClone(snapshot.roles) }
    : (() => {
        const copy = { ...card };
        delete copy.roles;
        return copy;
      })();
  const entry = deps.worktrees.active(card.id);
  if (!entry)
    throw new Error(
      `卡片 ${card.id} 沒有作用中的 worktree（作者要在那裡修正；用 \`card assign ${card.id} --worktree\` 建立）`,
    );

  const taskId = deps.assignments.forCard(card.id).at(-1)?.taskId;
  const lead = taskId ? deps.taskLead(taskId) : undefined;
  if (!lead)
    throw new Error(
      `找不到卡片 ${card.id} 的作者（最後一個任務的 Lead），無法決定新作者的種類與要在哪個 pane 旁邊開新 pane`,
    );
  if (typeof lead.machine === "string" && lead.machine !== "local")
    throw new Error(
      `作者在遠端機器 ${lead.machine}；目前修正只支援本機（跨機器是後續階段）`,
    );
  const live = (await deps.listAgents()).find(
    (agent) =>
      agent.pane_id === lead.pane_id &&
      agent.terminal_id === lead.terminal_id &&
      agent.workspace_id === lead.workspace_id,
  );
  if (!live)
    throw new Error(
      `最後一個作者的 pane（${lead.pane_id}）已不在，無法在它旁邊開新作者的 pane`,
    );

  const input: Parameters<typeof runCardFix>[1] = {
    card: effectiveCard,
    round: options.round,
    findings: options.findings,
    author: {
      agent: live.agent,
      paneId: live.pane_id,
      workspaceId: live.workspace_id,
      session: live.agent_session,
    },
    worktreePath: entry.path,
    ...(snapshot?.roles.fixer
      ? {
          launch: resolveFlowRole(snapshot, "fixer", live.agent, options.agent),
        }
      : {}),
    ...(options.agent !== undefined ? { requestedKind: options.agent } : {}),
  };
  // 卡片 fixer 在遠端（ISSUE-171）：執行中的 config 也必須仍開放這台機器的寫入與這個 agent 種類；舊快照允許的，目前配置可能已關閉。
  const remote = snapshot?.roles.fixer?.machine?.replace(/^local$/, "");
  if (!remote) return runCardFix(deps.flow, input);
  const open = deps.roleContext?.remoteMachines?.find((m) => m.id === remote);
  if (!open?.write) throw new Error("遠端修正失敗：machine 目前未開放寫入");
  if (!open.kinds.includes(input.launch?.kind ?? ""))
    throw new Error("遠端修正失敗：machine 目前未開放這個 agent 種類");
  if (!deps.remote) throw new Error("remote fixer 介面不存在，不開始修正");
  const start = deps.remote.start;
  // 準備與執行期間都算進該機器的進行中工作，普通斷線才會被擋下（與遠端 reviewer 相同）。
  return trackRemoteWork(
    remoteRoleWork,
    `card-fix:${card.id}:r${options.round}`,
    remote,
    () => {
      if (deps.roleContext?.isDisconnected?.(remote))
        throw new Error("遠端修正失敗：machine 已手動斷線");
      return runRemoteCardFix({ flow: deps.flow, start }, remote, input);
    },
  );
}
