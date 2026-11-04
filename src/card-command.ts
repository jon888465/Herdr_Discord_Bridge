// `card` 指令（ADR-0002 階段 2）：list、show、import、assign。Discord 與本機 console 共用
// handleCommand 的同一個入口；授權沿用既有的 allowedUserIds（在 handleCommand 之前已檢查）。
// 只有 assign 會啟動 Team 任務，且只接受 ready 的卡片。

import fs from "node:fs";
import {
  CARD_STATUSES,
  PROJECT_NAME,
  type CardType,
  IMPORT_MAX_FILE_BYTES,
  LEDGER_MAX_FILE_BYTES,
  isCardId,
} from "./card.js";
import type { CardAssignment } from "./card-assignments.js";
import { recordCleanupOnCard } from "./card-cleanup.js";
import { levelFor, type LoadedPolicy } from "./policy.js";
import type { Card } from "./card.js";
import type { CleanupResult, PreparedWorktree } from "./card-worktree-flow.js";
import type { PrOutcome } from "./card-pr-flow.js";
import { summarizeFindings } from "./card-findings.js";
import {
  formatReviewReply,
  nextReviewRound,
  type ReviewRun,
} from "./card-review-command.js";
import {
  buildAssignmentPrompt,
  parseAssignmentPrompt,
  section,
} from "./card-handoff.js";
import { ensureCardsDirectory } from "./card-directory.js";
import { CardStore } from "./card-store.js";
import { redactSecrets } from "./redact.js";

export interface CardCommandDeps {
  /** `<stateDirectory>/cards`。 */
  rootDir: string;
  today: () => string;
  source: "console" | "discord";
  attachments: Array<{ url: string; size: number; name?: string | null }>;
  /** 下載 Discord 附件並當成文字讀取，上限由呼叫端指定。 */
  download: (
    item: { url: string; size: number },
    limit: number,
  ) => Promise<string>;
  /** 只有 console 會用：讀本機檔案文字（Discord 使用者不能指定伺服器上的路徑）。 */
  readLocalFile: (path: string) => string;
  /** 事件時間，`YYYY-MM-DDTHH:MM:SSZ`（UTC）。 */
  now: () => string;
  /** 以卡片產生的 prompt 啟動 Team 任務；失敗要丟出錯誤（此時卡片不會被改動）。 */
  startTask: (
    prompt: string,
    options: { coding: boolean },
  ) => Promise<{ taskId: string; lead: { agent: string; machine: string } }>;
  /** 哪個任務由哪張卡指派的索引；卡片被刪除後靠它辨認進行中的任務（階段 2c）。 */
  assignments: {
    record(
      input: { taskId: string; cardId: string; type: string },
      at: string,
    ): void;
    forCard(cardId: string): CardAssignment[];
  };
  /** 查任務 journal：當初的 prompt、Lead 與目前狀態；找不到回傳 undefined。 */
  taskInfo: (taskId: string) =>
    | {
        originalPrompt: string;
        lead: { agent: string; machine: string };
        state: string;
      }
    | undefined;
  /**
   * `card review`（F5 階段 3d）：對卡片開著的 PR 做一次 review（取 PR 材料、開新 pane、啟動 reviewer、
   * 解析回覆、一定關閉 pane）。前提不符合要丟出說明原因的錯誤；流程本身的失敗以 `result.ok === false` 回傳。
   */
  reviewPullRequest: (
    card: Card,
    options: { agent?: string; round: number },
  ) => Promise<ReviewRun>;
  /** `card pr`：push 卡片分支並開 PR（或更新已開著的 PR）；不符合前提要丟出說明原因的錯誤。 */
  openPullRequest: (card: Card) => Promise<PrOutcome>;
  /** 專案政策（唯讀）：`<config dir>/policy.yml` 的載入結果。 */
  policy: () => LoadedPolicy;
  /** `card assign --worktree`：建立 worktree、啟動同種 Agent、切換路由；失敗要丟出說明原因的錯誤。 */
  prepareWorktree: (card: Card) => Promise<PreparedWorktree>;
  /** `card cleanup`：移除卡片的 worktree（永不強制）；髒檢出回報保留。 */
  cleanupWorktree: (cardId: string) => Promise<CleanupResult>;
}

const USAGE =
  "usage: card list [status] | card show <id> | card import [--slug <名稱>] [<本機路徑，僅 console>]（Discord 請附上 .md 檔） | card assign <id> [--coding] [--worktree] | card cleanup <id> | card policy [專案] | card pr <id> | card review <id> [--agent <種類>] | card recreate <id>（從任務紀錄重建被刪除的卡片）";
const MAX_LIST_LINES = 30;
const MAX_LIST_ERRORS = 5;
const TITLE_CHARS = 50;
const BODY_CHARS = 1200;
const DECISION_CHARS = 1000;
/** `card show` 最多列出幾筆 open 的 finding。 */
const FINDINGS_SHOWN = 10;
const RECENT_LOG = 5;

function shorten(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : value;
}

function openDirectory(deps: CardCommandDeps): CardStore | undefined {
  const check = ensureCardsDirectory(deps.rootDir, { create: false });
  if (!check.ok) throw new Error(check.error);
  if (!check.exists) return undefined;
  return new CardStore(deps.rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
}

function listCards(args: string[], deps: CardCommandDeps): string {
  const status = args[0];
  if (status !== undefined && !CARD_STATUSES.includes(status))
    throw new Error(
      `unknown status "${status}"; usage: card list [${CARD_STATUSES.join("|")}]`,
    );
  const store = openDirectory(deps);
  if (!store) return "目前沒有卡片。用 `card import` 匯入一張。";
  const { cards, errors } = store.list();
  const shown = status
    ? cards.filter((entry) => entry.card.status === status)
    : cards;

  const lines: string[] = [];
  if (shown.length === 0)
    lines.push(
      status
        ? `沒有狀態為 ${status} 的卡片。`
        : "目前沒有卡片。用 `card import` 匯入一張。",
    );
  else {
    lines.push(
      `卡片（${status ? `狀態 ${status}，` : ""}共 ${shown.length} 張）`,
    );
    for (const { card } of shown.slice(0, MAX_LIST_LINES))
      lines.push(
        `- ${card.id} · ${card.status} · ${card.type} · ${shorten(card.title, TITLE_CHARS)}`,
      );
    if (shown.length > MAX_LIST_LINES)
      lines.push(
        `…還有 ${shown.length - MAX_LIST_LINES} 張，可加上狀態篩選，例如 \`card list ready\`。`,
      );
  }
  if (errors.length) {
    lines.push("", `不合格的檔案（${errors.length}）：`);
    for (const { file, error } of errors.slice(0, MAX_LIST_ERRORS))
      lines.push(`- ${file}：${error}`);
    if (errors.length > MAX_LIST_ERRORS)
      lines.push(`（另有 ${errors.length - MAX_LIST_ERRORS} 個）`);
  }
  return lines.join("\n");
}

/** 移除「## <name>」到下一個「## 」之前的整段（含標題）。 */
function withoutSection(body: string, name: string): string {
  const heading = new RegExp(`^##[ \\t]+${name}[ \\t]*$`);
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.split("\n")) {
    if (heading.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^##[ \t]/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

function showCard(args: string[], deps: CardCommandDeps): string {
  const id = args[0];
  if (!id) throw new Error("usage: card show <id>");
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  const store = openDirectory(deps);
  const read = store?.read(id);
  if (!store || !read) throw new Error(`找不到卡片 ${id}`);
  if (!read.ok) {
    if (read.code === "not_found") throw new Error(`找不到卡片 ${id}`);
    throw new Error(read.error);
  }
  const { card } = read;

  const lines = [
    `${card.id} · ${card.type} · ${card.status}（版本 ${card.version}）`,
    card.title,
    `建立 ${card.created} · 更新 ${card.updated}`,
  ];
  if (card.projects?.length) lines.push(`專案：${card.projects.join("、")}`);
  if (card.source) lines.push(`來源：${card.source}`);
  // worktree 的狀況（作用中／已清理／保留）由 bridge 寫在 `## 異動專案`，內容很長時不會被截掉。
  const projectSection = section(card.body, "異動專案") ?? "";
  for (const match of projectSection.matchAll(/^- worktree 狀態：(.+)$/gm))
    lines.push(`worktree 狀態：${match[1]}`);

  // 只顯示人寫的部分；流程紀錄另外列出最新的幾筆。`## 決議` 是人或 Agent 自己寫的自由文字，
  // bridge 不會改寫它，在下面單獨顯示。
  const logStart = card.body.search(/^## 流程紀錄[ \t]*$/m);
  const human = withoutSection(
    withoutSection(
      logStart < 0 ? card.body : card.body.slice(0, logStart),
      "決議",
    ),
    "Review 發現",
  ).trim();
  const humanChars = Array.from(human);
  lines.push("", "── 內容 ──");
  lines.push(
    humanChars.length > BODY_CHARS
      ? `${humanChars.slice(0, BODY_CHARS).join("")}\n…（已截斷，共 ${humanChars.length} 字）`
      : human,
  );

  const decisions = section(card.body, "決議");
  if (decisions) {
    const chars = Array.from(decisions);
    lines.push("", "── 決議 ──");
    lines.push(
      chars.length > DECISION_CHARS
        ? `${chars.slice(0, DECISION_CHARS).join("")}\n…（已截斷，共 ${chars.length} 字；完整內容請開卡片檔）`
        : decisions,
    );
  }

  // F8：reviewer 的 findings 由 bridge 寫在 `## Review 發現`，這裡只列各狀態的數量與尚未處理的幾筆。
  const findings = summarizeFindings(card.body, FINDINGS_SHOWN);
  if (findings.total > 0) {
    const { counts } = findings;
    lines.push(
      "",
      `── Review 發現（共 ${findings.total} 筆：open ${counts.open}、fixed ${counts.fixed}、resolved ${counts.resolved}、dismissed ${counts.dismissed}）──`,
    );
    for (const item of findings.open) {
      const where =
        item.lineStart === undefined
          ? item.path
          : item.lineEnd === undefined
            ? `${item.path}:${item.lineStart}`
            : `${item.path}:${item.lineStart}-${item.lineEnd}`;
      lines.push(
        `- ${item.id} · ${item.severity} · ${where} · ${item.summary}（第 ${item.round} 輪）`,
      );
    }
    if (counts.open > findings.open.length)
      lines.push(`…還有 ${counts.open - findings.open.length} 筆 open，完整內容請開卡片檔`);
  }

  lines.push("", `── 最近紀錄（最多 ${RECENT_LOG} 筆）──`);
  const log = store.readLog(id);
  if (!log.ok) lines.push(`（紀錄讀取失敗：${log.error}）`);
  else if (log.entries.length === 0) lines.push("（尚無紀錄）");
  else
    for (const entry of log.entries.slice(-RECENT_LOG))
      lines.push(`- ${entry.time} · ${entry.event} · ${entry.text}`);
  return lines.join("\n");
}

/** console 用：讀本機 .md 卡片文字。拒絕符號連結、非一般檔案、超過匯入上限與非 UTF-8。 */
export function readLocalCardFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${file} is a symbolic link`);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  if (stat.size > IMPORT_MAX_FILE_BYTES)
    throw new Error(`${file} is larger than 512 KiB`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(file),
    );
  } catch {
    throw new Error(`${file} is not valid UTF-8`);
  }
}

// 同一個程序內正在指派的卡片：startTask 之後、卡片狀態更新之前有 await，
// 沒有這個保護時同時兩次 assign 都會看到 ready 而各啟動一個任務。
const assigning = new Set<string>();

async function assignCard(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  const coding = args.includes("--coding");
  const useWorktree = args.includes("--worktree");
  const rest = args.filter((arg) => arg !== "--coding" && arg !== "--worktree");
  if (rest.length !== 1 || rest[0].startsWith("--"))
    throw new Error("usage: card assign <id> [--coding] [--worktree]");
  const id = rest[0];
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  if (assigning.has(id)) throw new Error(`卡片 ${id} 正在指派中`);
  assigning.add(id);
  try {
    const store = openDirectory(deps);
    const read = store?.read(id);
    if (!store || !read || (!read.ok && read.code === "not_found"))
      throw new Error(`找不到卡片 ${id}`);
    if (!read.ok) throw new Error(read.error);
    const { card } = read;
    if (card.status !== "ready")
      throw new Error(
        `卡片 ${id} 的狀態是 ${card.status}；只有 ready 的卡片可以指派${card.status === "in_progress" ? "（已在進行中）" : ""}`,
      );
    const built = buildAssignmentPrompt(card);
    if (!built.ok) throw new Error(built.error);

    // worktree 先於任務：失敗時卡片完全不動；成功後即使任務沒啟動，worktree 也已記在索引與卡片上。
    let prepared: PreparedWorktree | undefined;
    const worktreeWarnings: string[] = [];
    if (useWorktree) {
      prepared = await deps.prepareWorktree(card);
      recordWorktreeOnCard(store, id, prepared, deps, worktreeWarnings);
      // Agent 還沒準備好（例如 Claude Code 在等你確認「信任這個資料夾」）：不替你確認，也不啟動任務。
      if (!prepared.agentReady)
        return [
          `已建立 worktree ${prepared.path}（分支 ${prepared.branch}，workspace ${prepared.workspaceId}），並在新 workspace 啟動了 ${prepared.agent.agent ?? "Agent"}，但它目前的狀態是 ${prepared.agent.agent_status}（常見原因：Claude Code 在等你確認信任這個資料夾；pane ${prepared.agent.pane_id}）。`,
          `任務沒有啟動，卡片仍是 ready。這個 thread 的路由已切到新 workspace；請到該 pane 處理後，再下 \`card assign ${id}\`（不帶 --worktree），或用 \`card cleanup ${id}\` 清掉。`,
          ...worktreeWarnings.map((warning) => `⚠️ ${warning}`),
        ].join("\n");
    }

    let task: Awaited<ReturnType<CardCommandDeps["startTask"]>>;
    try {
      task = await deps.startTask(built.prompt, { coding });
    } catch (error) {
      if (!prepared) throw error;
      throw new Error(
        `worktree 已建立（workspace ${prepared.workspaceId}，${prepared.path}）但任務沒有啟動：${error instanceof Error ? error.message : "unknown error"}。卡片仍是 ready；這個 thread 的路由已切到新 workspace，可直接再下 \`card assign ${id}\`（不帶 --worktree）重試，或用 \`card cleanup ${id}\` 清掉 worktree`,
      );
    }
    const assignedAt = deps.now();

    // 任務已經啟動：之後的卡片更新失敗只警告，不丟錯誤，否則使用者會以為沒指派而重複指派。
    const today = deps.now().slice(0, 10);
    const warnings: string[] = [...worktreeWarnings];
    const note = (what: string, error: string): void => {
      warnings.push(`${what}：${error}`);
    };
    try {
      deps.assignments.record(
        { taskId: task.taskId, cardId: id, type: card.type },
        assignedAt,
      );
    } catch (error) {
      note(
        "刪除偵測",
        `${error instanceof Error ? error.message : "unknown error"}（卡片若被刪除，bridge 不會主動通知）`,
      );
    }
    const status = store.setStatus(id, "in_progress", today);
    if (!status.ok) note("狀態", status.error);
    const recorded = store.recordTask(id, task.taskId, today);
    if (!recorded.ok) note("tasks", recorded.error);
    const events = [
      {
        event: "assigned" as const,
        machine: task.lead.machine,
        agent: task.lead.agent,
        eventId: `${task.taskId}-assigned`,
      },
      {
        event: "started" as const,
        taskId: task.taskId,
        eventId: `${task.taskId}-started`,
      },
    ];
    for (const event of events) {
      const result = store.recordEvent(id, { ...event, time: deps.now() });
      if (!result.ok) note(`紀錄 ${event.event}`, result.error);
    }

    const lines = [
      `已指派 ${id} 給 ${task.lead.agent}（${task.lead.machine}），task ${task.taskId}${coding ? "（--coding）" : ""}`,
    ];
    if (prepared)
      lines.push(
        `worktree：${prepared.path}（分支 ${prepared.branch}，workspace ${prepared.workspaceId}）；這個 thread 的路由已切到該 workspace，Agent 在那裡工作。`,
      );
    if (warnings.length)
      lines.push(
        `⚠️ 任務已啟動，但卡片更新失敗：${warnings.join("；")}。請不要重複指派；用 \`team status ${task.taskId}\` 查看任務。`,
      );
    else lines.push("卡片已設為 in_progress。");
    return lines.join("\n");
  } finally {
    assigning.delete(id);
  }
}

/** 把 worktree 記到卡片：`## 異動專案` 與 `worktree_created` 事件。失敗只警告（worktree 已經存在）。 */
function recordWorktreeOnCard(
  store: CardStore,
  id: string,
  prepared: PreparedWorktree,
  deps: CardCommandDeps,
  warnings: string[],
): void {
  const today = deps.now().slice(0, 10);
  const project = store.recordProject(
    id,
    {
      machine: "local",
      repoPath: prepared.repoPath,
      branch: prepared.branch,
      worktreePath: prepared.path,
      worktreeState: "active",
      ...(prepared.baseSha ? { baseSha: prepared.baseSha } : {}),
    },
    today,
  );
  if (!project.ok) warnings.push(`異動專案：${project.error}`);
  if (!prepared.baseSha) return;
  const logged = store.recordEvent(id, {
    event: "worktree_created",
    machine: "local",
    path: prepared.path,
    branch: prepared.branch,
    baseSha: prepared.baseSha,
    time: deps.now(),
    eventId: `${prepared.workspaceId}-worktree-created`,
  });
  if (!logged.ok) warnings.push(`紀錄 worktree_created：${logged.error}`);
}

/** `card pr <id>`：把卡片的分支 push 並開 PR，記錄到卡片（追蹤清單 F3，L1）。 */
async function pullRequestForCard(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  if (args.length !== 1) throw new Error("usage: card pr <id>");
  const id = args[0];
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  const store = openDirectory(deps);
  const read = store?.read(id);
  if (!store || !read || (!read.ok && read.code === "not_found"))
    throw new Error(`找不到卡片 ${id}`);
  if (!read.ok) throw new Error(read.error);

  const outcome = await deps.openPullRequest(read.card);

  // PR 已經存在於 GitHub：之後的卡片更新失敗只警告，不丟錯誤，否則使用者會以為沒開成。
  const warnings: string[] = [];
  const project = store.recordProject(
    id,
    {
      machine: "local",
      repoPath: outcome.repoPath,
      branch: outcome.branch,
      prUrl: outcome.url,
      headSha: outcome.headSha,
    },
    deps.now().slice(0, 10),
  );
  if (!project.ok) warnings.push(`異動專案：${project.error}`);
  if (outcome.created) {
    const logged = store.recordEvent(id, {
      event: "pr_opened",
      url: outcome.url,
      number: outcome.number,
      headSha: outcome.headSha,
      time: deps.now(),
      eventId: `pr-${outcome.number}-opened`,
    });
    if (!logged.ok) warnings.push(`紀錄 pr_opened：${logged.error}`);
  }
  const lines = outcome.created
    ? [
        `已開 PR #${outcome.number}：${outcome.url}`,
        `分支 ${outcome.branch} 已 push（head ${outcome.headSha.slice(0, 12)}），目標分支 ${outcome.base}。`,
        "bridge 會每分鐘檢查 CI，完成時在原 thread 通知；review 與 merge 由你決定。",
      ]
    : [
        `這個分支已有 PR #${outcome.number}：${outcome.url}`,
        `已把新的 commit push 上去（head ${outcome.headSha.slice(0, 12)}），沒有另外開新的 PR。`,
      ];
  // F6：敏感路徑。現在還沒有自動 merge，這只是提醒；將來 L2 遇到這類 PR 一律退回人工。
  if (outcome.sensitivePaths === null)
    lines.push(
      "⚠️ 無法確認這個 PR 動到哪些檔案；將來 L2 自動 merge 時會把它當作動到敏感路徑，一律由人 merge。",
    );
  else if (outcome.sensitivePaths.length > 0)
    lines.push(
      `⚠️ 這個 PR 動到敏感路徑：${outcome.sensitivePaths.join("、")}。目前 merge 本來就由你決定；將來即使政策是 L2，這類 PR 也一律由人 merge，請特別審查。`,
    );
  for (const warning of warnings) lines.push(`⚠️ 卡片更新失敗：${warning}`);
  return lines.join("\n");
}

/** 同一張卡同時只能有一個 review 在跑（reviewer 會開新 pane，重複執行會開出多個）。 */
const reviewing = new Set<string>();

function parseReviewArgs(args: string[]): { id: string; agent?: string } {
  const usage = "usage: card review <id> [--agent <種類>]";
  const [id, ...flags] = args;
  if (!id) throw new Error(usage);
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  let agent: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "--agent" || agent !== undefined) throw new Error(usage);
    agent = flags[++i];
    if (agent === undefined || agent.startsWith("-")) throw new Error(usage);
  }
  return { id, ...(agent !== undefined ? { agent } : {}) };
}

/**
 * `card review <id> [--agent <種類>]`（F5 階段 3d）：對卡片開著的 PR 做一次獨立 review。reviewer 是新開的
 * pane 與新 Agent，用完由流程關閉。結果寫進卡片的 `## Review 發現` 與一筆 `review_verdict` 流程紀錄；
 * 還沒開始就失敗的（前提不符、Agent 啟動失敗…）不動卡片。review 已經發生，之後的卡片寫入失敗只警告、不丟錯誤。
 */
async function reviewCard(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  const { id, agent } = parseReviewArgs(args);
  const store = openDirectory(deps);
  const read = store?.read(id);
  if (!store || !read || (!read.ok && read.code === "not_found"))
    throw new Error(`找不到卡片 ${id}`);
  if (!read.ok) throw new Error(read.error);
  if (reviewing.has(id)) throw new Error(`卡片 ${id} 正在 review 中`);
  reviewing.add(id);
  try {
    const round = nextReviewRound(read.card.body);
    const run = await deps.reviewPullRequest(read.card, {
      ...(agent !== undefined ? { agent } : {}),
      round,
    });
    if (!run.result.ok)
      throw new Error(
        `${formatReviewReply(id, run, undefined)}${run.result.closeNote ? `（${run.result.closeNote}）` : ""}`,
      );

    const warnings: string[] = [];
    const today = deps.now().slice(0, 10);
    const recorded = store.recordFindings(id, run.result.batch, today);
    if (!recorded.ok) warnings.push(`Review 發現：${recorded.error}`);
    const logged = store.recordEvent(id, {
      event: "review_verdict",
      role: "reviewer",
      verdict: run.result.batch.verdict,
      round: run.result.batch.round,
      time: deps.now(),
      eventId: `review-${run.pr.number}-r${run.result.batch.round}-${run.pr.headSha.slice(0, 12)}`,
    });
    if (!logged.ok) warnings.push(`紀錄 review_verdict：${logged.error}`);
    const text = formatReviewReply(
      id,
      run,
      recorded.ok
        ? { ids: recorded.ids, omitted: recorded.omitted }
        : undefined,
    );
    return [text, ...warnings.map((warning) => `⚠️ 卡片更新失敗：${warning}`)].join(
      "\n",
    );
  } finally {
    reviewing.delete(id);
  }
}

/** 唯讀：顯示專案政策（每個專案的自動化等級）。 */
function showPolicy(args: string[], deps: CardCommandDeps): string {
  if (args.length > 1)
    throw new Error("usage: card policy [<機器 id>:<專案目錄>]");
  const loaded = deps.policy();
  if (args.length === 1) {
    if (!PROJECT_NAME.test(args[0]))
      throw new Error(
        `${args[0]} 不是合法的專案名稱（格式：<機器 id>:<目錄名>，例如 local:Foo）`,
      );
    const level = levelFor(loaded.policy, args[0]);
    const listed = Object.hasOwn(loaded.policy.projects, args[0]);
    return `${args[0]} → ${level}${listed ? "" : "（沒列出，用預設等級）"}${loaded.status === "loaded" || loaded.status === "missing" ? "" : "；政策檔有問題，目前用安全預設（全部 L0）"}`;
  }
  const lines: string[] = [];
  if (loaded.status === "loaded")
    lines.push(`專案政策已載入（${loaded.file}）`);
  else if (loaded.status === "missing")
    lines.push(
      `專案政策檔不存在（${loaded.file}）：所有專案都是 L0（不 push）。`,
    );
  else
    lines.push(
      `專案政策檔${loaded.status === "invalid" ? "不合法" : "不安全"}（${loaded.file}）：${loaded.error ?? ""}`,
      "已改用安全預設（全部 L0），請修正檔案後重啟 bridge。",
    );
  lines.push(`預設等級：${loaded.policy.default}`);
  const names = Object.keys(loaded.policy.projects);
  if (names.length) {
    lines.push("專案：");
    for (const name of names)
      lines.push(`- ${name} → ${loaded.policy.projects[name]}`);
  }
  lines.push(
    "等級：L0 只在 worktree／分支工作、不 push；L1 push 分支並開 PR、由人 merge；L2 review、測試與 CI 都過後自動 merge。",
    "目前只有載入與查詢：尚未有任何動作依政策行為（還沒有 push／PR 功能）。政策檔只放在 plugin 設定目錄、由你手寫，bridge 不會寫它。",
  );
  return lines.join("\n");
}

/** 任務在這些狀態時可以清理 worktree（blocked 在等人處理，不擋清理，避免卡死）。 */
const CLEANUP_READY_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);

/** 移除卡片的 worktree。永不強制；有未提交修改就保留並說明；最新任務還在跑時拒絕。 */
async function cleanupCard(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  if (args.length !== 1) throw new Error("usage: card cleanup <id>");
  const id = args[0];
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  // ISSUE-070：最新任務還在跑，移除 worktree 會連 Agent 的 pane 一起拿掉。
  const known = deps.assignments.forCard(id);
  const latest = known[known.length - 1];
  const info = latest ? deps.taskInfo(latest.taskId) : undefined;
  if (latest && info && !CLEANUP_READY_STATES.has(info.state))
    throw new Error(
      `任務 ${latest.taskId}（${info.state}）尚未結束，不清理 worktree；請等它完成，或先 \`team cancel ${latest.taskId}\` 並確認收尾後再 \`card cleanup ${id}\`。`,
    );
  const result = await deps.cleanupWorktree(id);
  const lines: string[] = [];
  // 記到卡片（流程紀錄與 `## 異動專案` 的 worktree 狀態）；與 PR merge 後的自動清理共用。
  const recording = recordCleanupOnCard(
    openDirectory(deps),
    id,
    result,
    deps.now,
  );
  if (result.removed) {
    lines.push(
      `已移除 worktree ${result.path}（workspace ${result.workspaceId}）。`,
      `分支 ${result.branch} 仍保留（不自動刪分支）；來源 repo 的 workspace 也不會被關閉。`,
      "如果這個 thread 的路由還指向已移除的 workspace，請用 `wk use <workspace>` 切回。",
    );
  } else {
    lines.push(
      `worktree ${result.path} 有未提交的修改，已保留（bridge 永不強制移除，強制會永久丟失修改）。`,
      "請先在該 worktree 提交或處理修改，再重下 `card cleanup " + id + "`。",
    );
  }
  if (!recording.exists) lines.push("（卡片檔不存在，沒有寫入流程紀錄。）");
  else if (recording.logError) lines.push(`⚠️ 紀錄失敗：${recording.logError}`);
  if (recording.projectError)
    lines.push(`⚠️ 卡片的 worktree 狀態更新失敗：${recording.projectError}`);
  return lines.join("\n");
}

/** 卡片被刪除、任務還在跑時，由人決定要重建（ADR-0002 階段 2c，Q6）。 */
function recreateCard(args: string[], deps: CardCommandDeps): string {
  if (args.length !== 1) throw new Error("usage: card recreate <id>");
  const id = args[0];
  if (!isCardId(id)) throw new Error(`${id} 不是合法的卡片 id`);
  const known = deps.assignments.forCard(id);
  if (known.length === 0)
    throw new Error(`沒有找到由卡片 ${id} 指派過的任務，無法重建`);
  const latest = known[known.length - 1];
  const info = deps.taskInfo(latest.taskId);
  if (!info) throw new Error(`任務紀錄已不存在（${latest.taskId}），無法重建`);
  const parsed = parseAssignmentPrompt(info.originalPrompt, id);
  if (!parsed.ok) throw new Error(parsed.error);

  const check = ensureCardsDirectory(deps.rootDir, { create: true });
  if (!check.ok) throw new Error(check.error);
  const store = new CardStore(deps.rootDir, {
    maxFileBytes: LEDGER_MAX_FILE_BYTES,
  });
  const today = deps.now().slice(0, 10);
  const body = [
    `# ${parsed.title}`,
    "",
    "> 這張卡片是 bridge 從任務紀錄重建的（原卡片已被刪除）。只還原了當初交給 Agent 的標題、描述與驗收條件；背景、風險等其他段落無法還原。",
    "",
    "## 描述",
    parsed.description,
    ...(parsed.acceptance ? ["", "## 驗收條件", parsed.acceptance] : []),
    "",
  ].join("\n");
  const created = store.create({
    id,
    type: latest.type as CardType,
    status: "in_progress",
    title: parsed.title,
    version: 1,
    created: today,
    updated: today,
    tasks: known.map((entry) => entry.taskId),
    body,
  });
  if (!created.ok) {
    if (created.code === "exists")
      throw new Error(`卡片 ${id} 已存在，不需要重建`);
    throw new Error(`重建失敗：${created.error}`);
  }

  const warnings: string[] = [];
  const events = [
    {
      event: "assigned" as const,
      machine: info.lead.machine,
      agent: info.lead.agent,
      eventId: `${latest.taskId}-assigned`,
    },
    {
      event: "started" as const,
      taskId: latest.taskId,
      eventId: `${latest.taskId}-started`,
    },
  ];
  for (const event of events) {
    const logged = store.recordEvent(id, { ...event, time: latest.assignedAt });
    if (!logged.ok) warnings.push(`紀錄 ${event.event}：${logged.error}`);
  }
  const lines = [
    `已重建 ${id}（in_progress），任務 ${latest.taskId} 目前是 ${info.state}。內容是當初交給 Agent 的標題、描述與驗收條件（已遮蔽機敏內容，可能被截斷），其他段落無法還原。`,
    "任務結束後 bridge 會照常把結果同步回這張卡。",
  ];
  if (warnings.length) lines.push(`⚠️ ${warnings.join("；")}`);
  return lines.join("\n");
}

async function importCardText(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  let slug: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--slug") {
      slug = args[++i];
      if (slug === undefined) throw new Error(USAGE);
    } else if (arg.startsWith("--")) throw new Error(USAGE);
    else paths.push(arg);
  }
  if (paths.length > 1) throw new Error(USAGE);

  let text: string;
  if (deps.source === "discord") {
    if (paths.length)
      throw new Error(
        "Discord 不能指定伺服器上的路徑；請直接附上 .md 檔再下 `card import`",
      );
    if (deps.attachments.length !== 1)
      throw new Error("請附上恰好一個 .md 檔再下 `card import`");
    const item = deps.attachments[0];
    if (!item.name || !item.name.toLowerCase().endsWith(".md"))
      throw new Error("附件必須是 .md 檔");
    if (!(item.size > 0 && item.size <= IMPORT_MAX_FILE_BYTES))
      throw new Error("附件大小必須在 1 byte 到 512 KiB 之間");
    text = await deps.download(item, IMPORT_MAX_FILE_BYTES);
  } else {
    if (paths.length !== 1) throw new Error(USAGE);
    if (!paths[0].toLowerCase().endsWith(".md"))
      throw new Error("路徑必須是 .md 檔");
    text = deps.readLocalFile(paths[0]);
  }

  const check = ensureCardsDirectory(deps.rootDir, { create: true });
  if (!check.ok) throw new Error(check.error);
  const store = new CardStore(deps.rootDir, {
    maxFileBytes: LEDGER_MAX_FILE_BYTES,
  });
  const result = store.importText(text, { slug, today: deps.today() });
  if (!result.ok) {
    if (result.code === "exists")
      throw new Error(`匯入失敗：卡片已存在（${result.error}），不會覆蓋`);
    throw new Error(`匯入失敗：${result.error}`);
  }
  const lines = [`已匯入 ${result.card.id}（draft）`];
  if (result.notes.length) lines.push(`調整：${result.notes.join("；")}`);
  lines.push(
    "請審閱並編輯卡片檔案；確認後把 status 改成 ready，才能指派給 Agent。",
  );
  return lines.join("\n");
}

export async function runCardCommand(
  args: string[],
  deps: CardCommandDeps,
): Promise<string> {
  const [subcommand, ...rest] = args;
  let text: string;
  switch (subcommand) {
    case "list":
      text = listCards(rest, deps);
      break;
    case "show":
      text = showCard(rest, deps);
      break;
    case "pr":
      text = await pullRequestForCard(rest, deps);
      break;
    case "review":
      text = await reviewCard(rest, deps);
      break;
    case "policy":
      text = showPolicy(rest, deps);
      break;
    case "cleanup":
      text = await cleanupCard(rest, deps);
      break;
    case "recreate":
      text = recreateCard(rest, deps);
      break;
    case "import":
      text = await importCardText(rest, deps);
      break;
    case "assign":
      text = await assignCard(rest, deps);
      break;
    default:
      throw new Error(USAGE);
  }
  // 卡片可能來自 Mantis 等外部內容；顯示到 Discord 前一律過機敏遮蔽。
  return redactSecrets(text);
}
