import {
  preflightRoles,
  resolveFlowRole,
  type RoleContext,
} from "./card-role-assignment.js";
import { chooseReviewerKind } from "./review-pane.js";
// `card review` 的前提檢查與組裝（追蹤清單 F5 階段 3d）：把卡片、worktree 索引、PR 索引、任務紀錄、政策、
// GitHub 與 Herdr 接成一次 `runCardReview`。所有外部東西都由呼叫端注入，所以前提檢查可以單獨測試。
// 前提不符合就丟出說明原因的錯誤（卡片不動、不開任何 pane）。

import path from "node:path";
import type { Card } from "./card.js";
import { projectName } from "./card-projects.js";
import type { CardPullRequest } from "./card-prs.js";
import type { ReviewRun } from "./card-review-command.js";
import type { ReviewMaterial } from "./card-review-fetch.js";
import { runCardReview, type ReviewFlowDeps } from "./card-review-flow.js";
import type { CardWorktree } from "./card-worktrees.js";
import { levelFor, type LoadedPolicy } from "./policy.js";
import type { AgentRecord } from "./types.js";

export interface ReviewWiringDeps {
  roleContext?: RoleContext;
  worktrees: { active(cardId: string): CardWorktree | undefined };
  prs: { forCard(cardId: string): CardPullRequest[] };
  assignments: { forCard(cardId: string): Array<{ taskId: string }> };
  /** 任務紀錄裡的 Lead（作者）；找不到回傳 undefined。 */
  taskLead(taskId: string): AgentRecord | undefined;
  policy(): LoadedPolicy;
  listAgents(): Promise<AgentRecord[]>;
  fetchMaterial(
    repo: { owner: string; repo: string },
    number: number,
  ): Promise<ReviewMaterial>;
  flow: ReviewFlowDeps;
}

export async function reviewCardPullRequest(
  deps: ReviewWiringDeps,
  card: Card,
  options: { agent?: string; round: number },
): Promise<ReviewRun> {
  const snapshot = card.roles
    ? preflightRoles(
        card.roles,
        deps.roleContext ?? { machineIds: [], profiles: [] },
      )
    : undefined;
  const entry = deps.worktrees.active(card.id);
  if (!entry)
    throw new Error(
      `卡片 ${card.id} 沒有作用中的 worktree（reviewer 要在那裡啟動；用 \`card assign ${card.id} --worktree\` 建立）`,
    );

  const project = projectName("local", path.basename(entry.repoPath));
  if (!project) throw new Error("無法由 repo 目錄名組出專案名稱");
  const loaded = deps.policy();
  if (levelFor(loaded.policy, project) === "L0")
    throw new Error(
      `專案 ${project} 的政策等級是 L0；review 要讀 GitHub，請在政策檔把它設成 L1 以上，可用 \`card policy ${project}\` 查看`,
    );

  const pr = deps.prs
    .forCard(card.id)
    .filter((item) => item.state === "OPEN")
    .at(-1);
  if (!pr)
    throw new Error(
      `卡片 ${card.id} 沒有開著的 PR；請先 \`card pr ${card.id}\`（review 的材料來自 PR）`,
    );

  const taskId = deps.assignments.forCard(card.id).at(-1)?.taskId;
  const lead = taskId ? deps.taskLead(taskId) : undefined;
  if (!lead)
    throw new Error(
      `找不到卡片 ${card.id} 的作者（最後一個任務的 Lead），無法決定 reviewer 的種類與要在哪個 pane 旁邊開新 pane`,
    );
  if (typeof lead.machine === "string" && lead.machine !== "local")
    throw new Error(
      `作者在遠端機器 ${lead.machine}；目前 review 只支援本機（跨機器是後續階段）`,
    );
  const live = (await deps.listAgents()).find(
    (agent) =>
      agent.pane_id === lead.pane_id &&
      agent.terminal_id === lead.terminal_id &&
      agent.workspace_id === lead.workspace_id,
  );
  if (!live)
    throw new Error(
      `作者的 pane（${lead.pane_id}）已不在，無法在它旁邊開 reviewer 的 pane`,
    );

  const [owner, repo] = pr.repo.split("/");
  const material = await deps.fetchMaterial({ owner, repo }, pr.number);
  const result = await runCardReview(deps.flow, {
    card,
    round: options.round,
    scope: "whole",
    pr: { number: pr.number, headSha: material.headSha },
    material: { files: material.files, diff: material.diff },
    author: {
      agent: live.agent,
      paneId: live.pane_id,
      workspaceId: live.workspace_id,
      session: live.agent_session,
    },
    worktreePath: entry.path,
    ...(snapshot?.roles.reviewer
      ? {
          launch: resolveFlowRole(
            snapshot,
            "reviewer",
            chooseReviewerKind({ authorKind: live.agent }).ok
              ? (
                  chooseReviewerKind({ authorKind: live.agent }) as {
                    kind: string;
                  }
                ).kind
              : undefined,
            options.agent,
          ),
        }
      : {}),
    ...(options.agent !== undefined ? { requestedKind: options.agent } : {}),
  });
  return {
    pr: { number: pr.number, url: pr.url, headSha: material.headSha },
    result,
  };
}
