// H2 自動撿卡（追蹤清單 H2，使用者 2026-11-05 決定）：政策檔明確選用的專案裡，`status: ready` 的卡片由 bridge
// 自己開始，並依該專案的政策等級一路自動走：
//   L0：assign（worktree＋coding）→ 等 task 完成 → commit            （不 push）
//   L1：…→ pr                                                        （由人 review 與 merge）
//   L2：…→ loop --merge（獨立 review → 等 CI → 全綠才 merge）           （仍受 card merge 的全部守門）
// 一次只做一張卡；任何一步失敗或需要人就停下，不重試、不繞過；失敗時保留 Lead 的 workspace 與 worktree 供檢查。
//
// 這個模組只放邏輯（選卡、依序執行、停止條件），所有外部動作都經注入的 `AutopickSteps`，
// 由接線層（main.ts）決定怎麼開 Lead、怎麼下指令。

import type { Card } from "./card.js";
import {
  autopickFor,
  type AutopickLead,
  type LoadedPolicy,
  type Policy,
  type PolicyLevel,
} from "./policy.js";

export interface AutopickJob {
  card: Card;
  project: string;
  repoPath: string;
  level: PolicyLevel;
  lead: AutopickLead;
}

/** 卡片宣告的專案：`projects`（bridge 寫入）優先，其次舊的 `project` 欄位。 */
function declaredProjects(card: Card): string[] {
  return [...(card.projects ?? []), ...(card.project ? [card.project] : [])];
}

/**
 * 選下一張要自動做的卡：狀態是 ready、宣告的專案被政策選用；先建立的先做（`created`，再依 id），
 * 這樣結果可預測。`skip` 是這個 bridge 程序已經試過的卡（不重試，避免失敗後無限迴圈）。
 */
export function pickNext(
  policy: Policy,
  cards: Card[],
  skip: ReadonlySet<string> = new Set(),
): AutopickJob | undefined {
  const ordered = [...cards]
    .filter((card) => card.status === "ready" && !skip.has(card.id))
    .sort((a, b) =>
      a.created === b.created
        ? a.id.localeCompare(b.id)
        : a.created.localeCompare(b.created),
    );
  for (const card of ordered)
    for (const project of declaredProjects(card)) {
      const enabled = autopickFor(policy, project);
      if (enabled) return { card, project, ...enabled };
    }
  return undefined;
}

export type AutopickStep =
  "lead" | "assign" | "task" | "card_done" | "commit" | "pr" | "loop";

export interface LeadHandle {
  /** 關閉 bridge 自己為這張卡開的 Lead workspace（只在成功收尾時呼叫）。 */
  close(): Promise<void>;
}

export interface AutopickSteps {
  /** 在 `job.repoPath` 開 workspace 與 Lead，並把本機 console 的路由指過去。 */
  startLead(job: AutopickJob): Promise<LeadHandle>;
  /** 執行一個 `card …` 指令，回傳回覆文字；失敗丟出說明原因的錯誤。 */
  command(text: string): Promise<string>;
  /** 等這張卡最新的 task 結束；`completed` 才算可以繼續。 */
  waitTask(cardId: string): Promise<{ completed: boolean; detail: string }>;
  /** 等卡片狀態同步成 done（ISSUE-095：同步最多晚 60 秒）；逾時回傳 false。 */
  waitCardDone(cardId: string): Promise<boolean>;
  /** `card loop --merge` 的結果：有沒有真的 merge，以及給人看的文字。 */
  loop(
    cardId: string,
    reviewer: string,
  ): Promise<{ merged: boolean; text: string }>;
}

export interface AutopickReport {
  cardId: string;
  project: string;
  level: PolicyLevel;
  /** reached＝走到該等級該到的最後一步；stopped＝需要人（review 沒過、CI 紅…）；failed＝某一步出錯。 */
  outcome: "reached" | "stopped" | "failed";
  lastStep: AutopickStep;
  reason?: string;
  log: string[];
}

/** 與作者不同種類的 reviewer（H4 用 codex 審 claude 與 codex 混合的作者）。 */
function reviewerFor(lead: AutopickLead): string {
  return lead === "codex" ? "claude" : "codex";
}

export async function runAutopick(
  job: AutopickJob,
  steps: AutopickSteps,
): Promise<AutopickReport> {
  const id = job.card.id;
  const log: string[] = [];
  const report = (
    outcome: AutopickReport["outcome"],
    lastStep: AutopickStep,
    reason?: string,
  ): AutopickReport => ({
    cardId: id,
    project: job.project,
    level: job.level,
    outcome,
    lastStep,
    ...(reason ? { reason } : {}),
    log,
  });
  const fail = (step: AutopickStep, error: unknown) =>
    report(
      "failed",
      step,
      error instanceof Error ? error.message : String(error),
    );

  let lead: LeadHandle;
  try {
    lead = await steps.startLead(job);
  } catch (error) {
    return fail("lead", error);
  }
  log.push("lead");

  const run = async (step: AutopickStep, text: string): Promise<void> => {
    await steps.command(text);
    log.push(step);
  };

  let step: AutopickStep = "assign";
  try {
    await run("assign", `card assign ${id} --worktree --coding`);

    step = "task";
    const task = await steps.waitTask(id);
    log.push("task");
    if (!task.completed)
      return report("stopped", "task", `task 沒有完成：${task.detail}`);

    step = "card_done";
    if (!(await steps.waitCardDone(id)))
      return report("stopped", "card_done", "卡片狀態沒有在時限內同步成 done");
    log.push("card_done");

    step = "commit";
    await run("commit", `card commit ${id}`);
    if (job.level === "L0") {
      await lead.close();
      return report("reached", "commit");
    }

    step = "pr";
    await run("pr", `card pr ${id}`);
    if (job.level === "L1") {
      await lead.close();
      return report("reached", "pr");
    }

    step = "loop";
    const loop = await steps.loop(id, reviewerFor(job.lead));
    log.push("loop");
    if (!loop.merged) return report("stopped", "loop", loop.text);
    await lead.close();
    return report("reached", "loop");
  } catch (error) {
    return fail(step, error);
  }
}

export interface AutopickerDeps {
  policy(): LoadedPolicy;
  readyCards(): Card[];
  steps: AutopickSteps;
  /** 每張卡做完（不論結果）呼叫一次，接線層用來通知與記錄。 */
  onReport(report: AutopickReport): void | Promise<void>;
  onError?(error: unknown): void;
}

/**
 * 排程器：`tick()` 每次最多啟動一張卡，上一張還沒結束就不啟動新的；這個程序已經試過的卡不重試
 * （要重試請重啟 bridge 或把卡片重新設成 ready 並重啟）。政策檔有問題時不撿任何卡。
 */
export function createAutopicker(deps: AutopickerDeps) {
  const attempted = new Set<string>();
  let running: Promise<void> | undefined;
  return {
    get busy(): boolean {
      return running !== undefined;
    },
    tick(): Promise<void> | undefined {
      if (running) return undefined;
      const loaded = deps.policy();
      if (loaded.status !== "loaded") return undefined;
      const job = pickNext(loaded.policy, deps.readyCards(), attempted);
      if (!job) return undefined;
      attempted.add(job.card.id);
      running = (async () => {
        try {
          await deps.onReport(await runAutopick(job, deps.steps));
        } catch (error) {
          deps.onError?.(error);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
}
