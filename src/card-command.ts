// `card` 指令（ADR-0002 階段 2a）：list、show、import。Discord 與本機 console 共用
// handleCommand 的同一個入口；授權沿用既有的 allowedUserIds（在 handleCommand 之前已檢查）。
// 這一階段的指令不會啟動任何 Agent。

import fs from "node:fs";
import {
  CARD_STATUSES,
  IMPORT_MAX_FILE_BYTES,
  LEDGER_MAX_FILE_BYTES,
  isCardId,
} from "./card.js";
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
}

const USAGE =
  "usage: card list [status] | card show <id> | card import [--slug <名稱>] [<本機路徑，僅 console>]（Discord 請附上 .md 檔） | card assign <id>（尚未實作）";
const MAX_LIST_LINES = 30;
const MAX_LIST_ERRORS = 5;
const TITLE_CHARS = 50;
const BODY_CHARS = 1200;
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

  // 只顯示人寫的部分；流程紀錄另外列出最新的幾筆。
  const logStart = card.body.search(/^## 流程紀錄[ \t]*$/m);
  const human = (
    logStart < 0 ? card.body : card.body.slice(0, logStart)
  ).trim();
  const humanChars = Array.from(human);
  lines.push("", "── 內容 ──");
  lines.push(
    humanChars.length > BODY_CHARS
      ? `${humanChars.slice(0, BODY_CHARS).join("")}\n…（已截斷，共 ${humanChars.length} 字）`
      : human,
  );

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
    case "import":
      text = await importCardText(rest, deps);
      break;
    case "assign":
      text =
        "`card assign` 尚未實作（階段 2b）。目前卡片只能列出、查看與匯入。";
      break;
    default:
      throw new Error(USAGE);
  }
  // 卡片可能來自 Mantis 等外部內容；顯示到 Discord 前一律過機敏遮蔽。
  return redactSecrets(text);
}
