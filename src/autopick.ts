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
import type { CardEvent } from "./card-events.js";
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
  leadSelection?: "card" | "policy";
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
  leadGate?: LeadGate,
  roleGate?: (card: Card) => string | undefined,
): AutopickJob | undefined {
  const ordered = [...cards]
    .filter(
      (card) => eligibleAutopickProject(policy, card) && !skip.has(card.id),
    )
    .sort((a, b) =>
      a.created === b.created
        ? a.id.localeCompare(b.id)
        : a.created.localeCompare(b.created),
    );
  for (const card of ordered)
    for (const project of declaredProjects(card)) {
      const enabled = autopickFor(policy, project);
      if (
        enabled &&
        !leadRejection(policy, card, leadGate) &&
        !roleGate?.(card)
      )
        return {
          card,
          project,
          ...enabled,
          lead: card.lead ?? enabled.lead,
          leadSelection: card.lead ? "card" : "policy",
        };
    }
  return undefined;
}

/** Only ready cards in an explicitly selected autopick project may be rejected. */
export function eligibleAutopickProject(policy: Policy, card: Card) {
  if (card.status !== "ready") return undefined;
  return declaredProjects(card)
    .map((project) => {
      const enabled = autopickFor(policy, project);
      return enabled ? { project, ...enabled } : undefined;
    })
    .find((enabled) => enabled !== undefined);
}

/** Lead 種類的開放條件：沒達到回傳原因，通過回傳 undefined（見 `leadGateFor`）。 */
export type LeadGate = (kind: string) => string | undefined;

/** 這張卡的 Lead 尚未開放（agy、pi 沒宣告）：回傳原因（只有被政策選用的專案才算），否則 undefined。 */
export function leadRejection(
  policy: Policy,
  card: Card,
  leadGate?: LeadGate,
): string | undefined {
  const picked = eligibleAutopickProject(policy, card);
  if (!picked) return undefined;
  const selected = card.lead ?? picked.lead;
  if (!(policy.autopickLead ?? ["claude"]).includes(selected))
    return `Lead「${selected}」不在政策候選清單內，不撿這張卡`;
  const closed = leadGate?.(selected);
  return closed === undefined
    ? undefined
    : `Lead「${selected}」尚未開放，不撿這張卡：${closed}；改完 config.json 後重啟 bridge`;
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

/** Extract the actionable stop reason from `card loop` output. */
export function loopStopReason(text: string, maxChars = 194): string {
  const starts = [...text.matchAll(/^原因：/gm)];
  const normalize = (value: string) =>
    value.replace(/[\u0000-\u001F\u007F\s]+/g, " ").trim();
  const chars = (value: string, keepTail: boolean) => {
    const points = Array.from(value);
    return (
      keepTail ? points.slice(-maxChars) : points.slice(0, maxChars)
    ).join("");
  };
  if (starts.length) {
    const start = (starts.at(-1)?.index ?? 0) + "原因：".length;
    const tail = text.slice(start);
    const end = tail.indexOf("\n卡片的狀態維持在這一步之後：");
    let reason = normalize(end < 0 ? tail : tail.slice(0, end));
    if (/inconclusive/i.test(reason)) {
      const details = [...text.matchAll(/^inconclusive 的原因：(.+)$/gm)];
      const detail = normalize(details.at(-1)?.[1] ?? "");
      if (detail && !reason.includes(detail))
        reason += `（inconclusive 的原因：${detail}）`;
    }
    return chars(reason, false);
  }
  const stopMarkers = [...text.matchAll(/^loop (?:停下來了|結束)：/gm)];
  if (stopMarkers.length) {
    const start = stopMarkers.at(-1)?.index ?? 0;
    const section = text
      .slice(start)
      .replace(/\n卡片的狀態維持在這一步之後：[\s\S]*$/, "");
    let reason = normalize(section);
    if (/inconclusive/i.test(reason)) {
      const details = [...text.matchAll(/^inconclusive 的原因：(.+)$/gm)];
      const detail = normalize(details.at(-1)?.[1] ?? "");
      if (detail && !reason.includes(detail))
        reason += `（inconclusive 的原因：${detail}）`;
    }
    return chars(reason, false);
  }
  const inconclusiveDetails = [
    ...text.matchAll(/^inconclusive 的原因：(.+)$/gm),
  ];
  if (inconclusiveDetails.length) {
    const detail = normalize(inconclusiveDetails.at(-1)?.[1] ?? "");
    return chars(`inconclusive 的原因：${detail}`, false);
  }
  return chars(normalize(text), true);
}

/** reviewer 偏好：codex Lead 用 claude，其餘用 codex；真正的作者／reviewer session 獨立性仍由 gate 核對。 */
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
    const loop = await steps.loop(
      id,
      job.card.roles ? "" : reviewerFor(job.lead),
    );
    log.push("loop");
    if (!loop.merged)
      return report("stopped", "loop", loopStopReason(loop.text));
    await lead.close();
    return report("reached", "loop");
  } catch (error) {
    return fail(step, error);
  }
}

export interface AutopickerDeps {
  onPicked?(job: AutopickJob): void | Promise<void>;
  policy(): LoadedPolicy;
  readyCards(): Card[];
  steps: AutopickSteps;
  /** 每張卡做完（不論結果）呼叫一次，接線層用來通知與記錄。 */
  onReport(report: AutopickReport): void | Promise<void>;
  onError?(error: unknown): void;
  /** Lead 種類的開放條件（agy、pi 要先在 config.json 宣告）；沒提供就不檢查。 */
  leadGate?: LeadGate;
  /** Lead 尚未開放時，每張卡只通知一次。 */
  roleGate?: (card: Card) => string | undefined;
  onRejected?(card: Card, reason: string): unknown;
}

/**
 * 排程器：`tick()` 每次最多啟動一張卡，上一張還沒結束就不啟動新的；這個程序已經試過的卡不重試
 * （要重試請重啟 bridge 或把卡片重新設成 ready 並重啟）。政策檔有問題時不撿任何卡。
 */
export function createAutopicker(deps: AutopickerDeps) {
  const attempted = new Set<string>();
  const rejected = new Set<string>();
  let running: Promise<void> | undefined;
  return {
    get busy(): boolean {
      return running !== undefined;
    },
    tick(): Promise<void> | undefined {
      if (running) return undefined;
      const loaded = deps.policy();
      if (loaded.status !== "loaded") return undefined;
      const cards = deps.readyCards();
      for (const card of cards) {
        if (!eligibleAutopickProject(loaded.policy, card)) continue;
        const reason =
          leadRejection(loaded.policy, card, deps.leadGate) ??
          deps.roleGate?.(card);
        // 以卡片加原因當 key：政策每次掃描都重讀，原因換了要重新通報。
        const key = `${card.id}\n${reason}`;
        if (reason && !rejected.has(key)) {
          if (deps.onRejected?.(card, reason) !== false) rejected.add(key);
        }
      }
      const job = pickNext(
        loaded.policy,
        cards,
        attempted,
        deps.leadGate,
        deps.roleGate,
      );
      if (!job) return undefined;
      attempted.add(job.card.id);
      running = (async () => {
        try {
          try {
            await deps.onPicked?.(job);
          } catch {
            /* notification failure cannot stop work */
          }
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

/** Shared visible rejection template; feeds card show and existing failed-event notifications. */
export function leadRejectionEvent(
  reason: string,
  time: string,
  eventId: string,
): CardEvent {
  return {
    event: "failed",
    code: "autopick_stopped",
    reason: reason.slice(0, 200),
    time,
    eventId,
  };
}
