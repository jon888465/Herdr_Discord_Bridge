// 卡片流程事件的主動通知：Discord 來源送到原 thread，Agent 來源送進原本下任務的 pane。
// 事件來自卡片的流程紀錄（ledger）；通知的認領、去重與結果也寫在同一份 ledger，bridge 重啟不會重送。
// 通知失敗一律不影響 autopick、card loop、card merge。

import { createHash } from "node:crypto";
import { isCardId, parseNotifyTarget, type Card } from "./card.js";
import type { LogEntry } from "./card-ledger.js";
import type { CardStore } from "./card-store.js";
import type { AgentRecord } from "./types.js";

export interface NotifyDeps {
  store: CardStore;
  now(): string;
  /** 這個 notifier 開始運作的時間；更早的事件不回溯處理（沒有通知對象的舊卡不會被寫入紀錄）。 */
  startedAt: string;
  prUrl(id: string): string | undefined;
  discord(thread: string, text: string): Promise<void>;
  pane(
    id: string,
  ): Promise<
    | Pick<AgentRecord, "pane_id" | "terminal_id" | "agent" | "agent_status">
    | undefined
  >;
  agent(pane: string, text: string): Promise<void>;
  log(text: string): void;
}

/** Shared by normal ledger notifications and malformed-card diagnostics. */
export interface NotificationPanePort {
  listAgents(): Promise<AgentRecord[]>;
  readAgent(id: string, source: "visible", lines: number): Promise<string>;
}
export async function readNotificationPane(
  port: NotificationPanePort,
  id: string,
): Promise<AgentRecord | undefined> {
  const pane = (await port.listAgents()).find((p) => p.pane_id === id);
  if (!pane || !["idle", "done"].includes(pane.agent_status)) return pane;
  const screen = await port.readAgent(id, "visible", 80);
  if (
    /trust|permission|approval|allow once|skip until next version|Do you want|是否允許|信任|選擇.*選項/i.test(
      screen,
    )
  )
    return { ...pane, agent_status: "blocked" };
  // Reading the screen is asynchronous: never return an identity that changed meanwhile.
  const current = (await port.listAgents()).find((p) => p.pane_id === id);
  if (
    !current ||
    current.terminal_id !== pane.terminal_id ||
    current.agent !== pane.agent
  )
    return undefined;
  return current;
}
export async function assertNotificationTargetReady(
  port: NotificationPanePort,
  target: { pane: string; terminal: string; agent: string },
): Promise<void> {
  for (let check = 0; check < 2; check++) {
    const pane = await readNotificationPane(port, target.pane);
    if (
      !pane ||
      pane.pane_id !== target.pane ||
      pane.terminal_id !== target.terminal ||
      pane.agent !== target.agent ||
      !["idle", "done"].includes(pane.agent_status)
    )
      throw new Error(
        "notification target unavailable, replaced or blocked; retry later",
      );
  }
}

const EVENTS = new Set([
  "autopick_picked",
  "pr_opened",
  "review_verdict",
  "ci_result",
  "merged",
  "failed",
  "autopick_stopped",
  "merge_blocked",
  "loop_stopped",
]);

/** 只告知進度、過期就沒有行動價值的事件；failed、autopick_stopped、merge_blocked、loop_stopped、merged 需要人看，不在此列（ISSUE-148）。 */
const PROGRESS_EVENTS = new Set(["autopick_picked", "pr_opened", "review_verdict", "ci_result"]);
/** Agent 通知超過這個時間還沒送出（收件 Agent 一直忙碌），進度類事件就放棄，不佔用收件 Agent 的回合。 */
const AGENT_PROGRESS_STALE_MS = 30 * 60 * 1000;

const MAX_WRITE_FAILURES = 3;
const MAX_DISCORD_ATTEMPTS = 3;

const SAFE_ROLE_REJECTION_REASONS: readonly RegExp[] = [
  /^必須是非空 inline map$/,
  /^未知角色$/,
  /^必須是 machine:agent:model 字串$/,
  /^不可全部省略$/,
  /^不合法 machine$/,
  /^不允許 agent$/,
  /^不合法 model（英數起頭、最多80字）$/,
  /^不合法角色欄位$/,
  /^agent (?:claude|codex|agy|pi|候選) 未開放（需要已配置可用 profile；pi Worker 尚未開放）$/,
  /^profile [A-Za-z0-9_.-]{1,64} 的 model／modelFlag 不合法$/,
  /^CLI agent (?:claude|codex|agy|pi) 與卡片 (?:claude|codex|agy|pi) 衝突$/,
  /^沒有符合 agent (?:claude|codex|agy|pi|預設)／model 的可用 profile$/,
];

/** 角色拒絕原因只回傳固定分類標籤或受驗證結構，絕不直接切片事件／卡片原文。 */
export function classifyRoleRejection(text: string): string {
  const marker = "卡片角色指定無效：";
  const index = text.indexOf(marker);
  if (index < 0) return "卡片角色指定無效";
  const tail = text.slice(index + marker.length).split("；")[0] ?? "";
  const match =
    /^(roles|implement|diagnose|review|verify|reviewer|fixer)：(.+)$/.exec(
      tail,
    );
  if (!match) return "卡片角色指定無效";
  const [, role, detail] = match;
  if (SAFE_ROLE_REJECTION_REASONS.some((pattern) => pattern.test(detail!)))
    return `卡片角色指定無效：${role}：${detail}`;
  if (detail!.startsWith("不存在 machine "))
    return `卡片角色指定無效：${role}：不存在 machine`;
  for (const label of [
    "remote 寫入尚未支援",
    "remote verify 不可用",
    "machine 未開放卡片 review",
  ])
    if (detail!.startsWith(label)) return `卡片角色指定無效：${role}：${label}`;
  if (detail!.startsWith("卡片流程尚未支援 machine "))
    return `卡片角色指定無效：${role}：尚未支援遠端 machine`;
  if (detail!.startsWith("派工不符：machine "))
    return `卡片角色指定無效：${role}：派工不符：machine`;
  if (detail!.startsWith("派工不符：agent "))
    return `卡片角色指定無效：${role}：派工不符：agent`;
  if (detail!.startsWith("派工不符：model "))
    return `卡片角色指定無效：${role}：派工不符：model`;
  if (detail!.startsWith("不允許 agent"))
    return `卡片角色指定無效：${role}：不允許 agent`;
  if (detail!.startsWith("不合法 model"))
    return `卡片角色指定無效：${role}：不合法 model`;
  return `卡片角色指定無效：${role}`;
}

/** 通知只放分類過的一句原因，不放流程紀錄原文（可能含卡片內容或 finding 全文）。 */
export function notificationReason(event: LogEntry): string {
  if (event.event === "failed" && event.text.includes("卡片角色指定無效："))
    return classifyRoleRejection(event.text);
  if (event.event === "review_verdict")
    return (
      /changes_requested|inconclusive|pass/.exec(event.text)?.[0] ??
      "review 已結束"
    );
  if (event.event === "ci_result")
    return (
      /success|failure|cancelled|timed_out|neutral|skipped|action_required/.exec(
        event.text,
      )?.[0] ?? "CI 已結束"
    );
  if (event.event === "autopick_picked") return "bridge 已撿起卡片";
  if (event.event === "pr_opened") return "PR 已開出";
  if (event.event === "merged") return "PR 已合併";
  // ISSUE-124：回合逾時導致的失敗（文字同時含 blocked 等字樣）要明確分類為等待逾時。
  if (event.event === "failed" && event.text.includes("等待逾時"))
    return "等待逾時";
  if (/Lead「[^」]+」(不在政策候選清單內|尚未開放)/.test(event.text))
    return "Lead 不可用";
  // ISSUE-133：autopick 因敏感路徑停下時，原因文字常帶著 review／head 字樣（loop 輸出的摘要），
  // 不能再標成 review、版本條件；只限這個事件，其他事件的分類維持原本（可同時命中多類）。
  if (
    event.event === "failed" &&
    event.text.includes("autopick_stopped") &&
    /敏感|sensitive/.test(event.text)
  )
    return "敏感路徑未滿足";
  const categories: string[] = [];
  for (const [pattern, label] of [
    [/敏感|sensitive/, "敏感路徑"],
    [/政策|L[012]/, "專案政策"],
    [/CI|checks/, "CI 條件"],
    [/review|finding/, "review 條件"],
    [/head|commit/, "版本條件"],
    [/conflict|衝突|DIRTY/, "分支衝突"],
    [/blocked|權限|信任/, "等待人工處理"],
    [/取消|停止|cancel/, "停止要求"],
    [/timeout|逾時|時限/, "等待逾時"],
    [/狀態|draft|CLOSED|OPEN/, "狀態條件"],
    [/連線|connection|unavailable/, "連線不可用"],
  ] as const)
    if (pattern.test(event.text)) categories.push(label);
  return categories.length
    ? `${categories.join("、")}未滿足`
    : "流程未完成，原因已記錄於卡片";
}

function message(
  card: Card,
  event: LogEntry,
  prUrl: string | undefined,
): string {
  const id = isCardId(card.id) ? card.id : "unknown-card";
  const link =
    prUrl &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(
      prUrl,
    )
      ? prUrl
      : undefined;
  const name =
    event.event === "failed" && event.text.includes("autopick_stopped")
      ? "autopick_stopped"
      : event.event;
  return `[bridge 通知] ${id} · ${name} · ${notificationReason(event)}${link ? `\n${link}` : ""}`;
}

export function createCardNotifier(deps: NotifyDeps) {
  let running = false;
  const writeFailures = new Map<string, number>();
  const log = (text: string) => {
    try {
      deps.log(text);
    } catch {
      /* diagnostic only */
    }
  };
  // 寫不進認領紀錄就不送：沒有持久的認領，重啟後會重送。
  const record = (id: string, eventId: string, text: string): boolean => {
    const key = id + eventId;
    const count = writeFailures.get(key) ?? 0;
    if (count >= MAX_WRITE_FAILURES) return false;
    try {
      if (
        deps.store.appendLog(id, [
          { time: deps.now(), event: "notification", eventId, text },
        ]).ok
      )
        return true;
    } catch {
      /* no durable claim, no send */
    }
    writeFailures.set(key, count + 1);
    log(`卡片 ${id} 通知紀錄失敗（最多三次）`);
    return false;
  };

  const tick = async () => {
    if (running) return;
    running = true;
    const usedPanes = new Set<string>();
    try {
      for (const { card } of deps.store.list().cards) {
        const ledger = deps.store.readLog(card.id);
        if (!ledger.ok) continue;
        const seen = new Set(ledger.entries.map((e) => e.eventId));
        events: for (const event of ledger.entries.filter((e) =>
          EVENTS.has(e.event),
        )) {
          const key =
            "notify-" +
            createHash("sha256")
              .update(event.eventId)
              .digest("hex")
              .slice(0, 40);
          const done = `${key}-done`;
          if (seen.has(done)) continue;
          const finish = (reason: string) => {
            log(`卡片 ${card.id} ${event.event}：${reason}`);
            record(card.id, done, reason);
          };
          const captured = ledger.entries.find(
            (e) => e.eventId === `${key}-target`,
          );
          const destination = captured?.text ?? card.notify;
          const target = destination
            ? parseNotifyTarget(destination)
            : undefined;
          if (!target) {
            // 沒有通知對象：不猜、不送。只處理 notifier 開始運作之後的事件，
            // 舊卡的歷史事件不回溯（否則每張舊卡的每筆事件都會被寫一筆紀錄）。
            if (event.time >= deps.startedAt) finish("沒有通知對象");
            continue;
          }
          if (!captured && !record(card.id, `${key}-target`, destination!))
            continue;
          const text = message(
            card,
            event,
            deps.prUrl(card.id) ??
              /https:\/\/github\.com\/[^\s]+\/pull\/[0-9]+/.exec(
                event.text,
              )?.[0],
          );

          if (target.kind === "discord") {
            let attempt = 1;
            while (
              seen.has(`${key}-try${attempt}`) &&
              seen.has(`${key}-error${attempt}`)
            )
              attempt++;
            // 有認領但沒有明確的失敗結果：結果不明，絕不重送。
            if (seen.has(`${key}-try${attempt}`)) continue;
            if (attempt > MAX_DISCORD_ATTEMPTS) {
              finish("Discord 通知重試已達上限");
              continue;
            }
            if (
              !record(
                card.id,
                `${key}-try${attempt}`,
                `Discord sending ${attempt}：已認領`,
              )
            )
              continue;
            try {
              await deps.discord(target.thread, text);
              finish("Discord 通知已送出");
            } catch {
              log(
                `卡片 ${card.id} Discord 通知失敗（${attempt}/${MAX_DISCORD_ATTEMPTS}）`,
              );
              record(
                card.id,
                `${key}-error${attempt}`,
                "Discord failed：可重試",
              );
            }
            continue;
          }

          // 進度類事件排隊太久就過期：舊事件不再叫醒收件 Agent（ISSUE-148）。
          if (
            PROGRESS_EVENTS.has(event.event) &&
            Date.parse(deps.now()) - Date.parse(event.time) > AGENT_PROGRESS_STALE_MS
          ) {
            finish("放棄通知：進度事件已過期");
            continue;
          }
          if (usedPanes.has(target.pane)) continue;
          try {
            // 送出前讀兩次，確認 pane 仍在、身分一致、Agent 閒置；工作中或等待提示就排隊，不打斷。
            for (let check = 0; check < 2; check++) {
              const pane = await deps.pane(target.pane);
              if (
                !pane ||
                pane.pane_id !== target.pane ||
                pane.terminal_id !== target.terminal ||
                pane.agent !== target.agent
              ) {
                finish("放棄通知：pane 不在或身分不符");
                continue events;
              }
              if (
                pane.agent_status !== "idle" &&
                pane.agent_status !== "done"
              ) {
                if (!seen.has(`${key}-queued`))
                  record(card.id, `${key}-queued`, "Agent 忙碌，通知排隊");
                continue events;
              }
            }
            // 先認領再送：結果不明時不重送。
            if (!record(card.id, done, "Agent sending：已認領，結果不明不重送"))
              continue;
            usedPanes.add(target.pane);
            try {
              await deps.agent(target.pane, text);
              record(card.id, `${key}-sent`, "Agent 通知已送出");
            } catch {
              log(`卡片 ${card.id} Agent 通知不確定，不重送`);
              record(card.id, `${key}-error`, "Agent 通知不確定，不重送");
            }
          } catch {
            log(`卡片 ${card.id} pane 讀取失敗，通知排隊`);
          }
        }
      }
    } catch {
      log("卡片通知掃描失敗，流程不受影響");
    } finally {
      running = false;
    }
  };
  return { tick };
}
