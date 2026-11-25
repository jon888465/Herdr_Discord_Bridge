import type { Card } from "./card.js";
import { isCardDate } from "./card.js";
import type { CardStore } from "./card-store.js";

/** 人還在寫的卡：bridge 不會撿，隨時可編輯、可設成 ready。 */
export const DRAFT_STATUSES: readonly string[] = [
  "draft",
  "discussing",
  "refined",
  "recorded",
];

/** 卡片最後一筆流程紀錄是這些事件，表示 bridge 已停手、等人處理（失敗或停止）。 */
export const STOP_EVENTS: readonly string[] = [
  "failed",
  "autopick_stopped",
  "loop_stopped",
];

export type Editability =
  | { editable: true; kind: "draft" | "stopped"; canMarkReady: boolean }
  | { editable: false; reason: string };

/**
 * 看板能不能編輯這張卡。其餘狀態（排隊中、執行中、完成、取消）一律唯讀，
 * 因為 bridge 會寫同一個檔，而且正在跑的任務不會讀到改過的描述。
 * 停手的卡（ready／in_progress 且最後事件是失敗／停止）只開放改文字欄位，不開放改 status。
 */
export function editability(
  card: Pick<Card, "status">,
  lastEvent: string | undefined,
): Editability {
  if (DRAFT_STATUSES.includes(card.status))
    return { editable: true, kind: "draft", canMarkReady: true };
  if (
    (card.status === "ready" || card.status === "in_progress") &&
    lastEvent !== undefined &&
    STOP_EVENTS.includes(lastEvent)
  )
    return { editable: true, kind: "stopped", canMarkReady: false };
  if (card.status === "ready")
    return { editable: false, reason: "ready：等 bridge 撿卡，唯讀" };
  if (card.status === "in_progress")
    return { editable: false, reason: "執行中，唯讀" };
  return { editable: false, reason: `${card.status}，唯讀` };
}

const LOG_HEADING = /^## 流程紀錄[ \t]*$/m;

/** 人寫的部分（流程紀錄之前）與 bridge 寫的部分（從「## 流程紀錄」起，含其後的區塊）。 */
export function splitBody(body: string): { human: string; bridge: string } {
  const at = body.search(LOG_HEADING);
  if (at < 0) return { human: body, bridge: "" };
  return { human: body.slice(0, at), bridge: body.slice(at) };
}

export interface HumanEdit {
  title: string;
  notify?: string;
  /** `<機器>:<repo 目錄名>`；bridge 只自動撿宣告了 project 且政策選用的卡（ISSUE-161）。 */
  project?: string;
  /** `readonly`＝只讀任務，自動撿卡不建 worktree、不走 coding（ISSUE-162）；留空＝一般任務。 */
  mode?: "readonly";
  /** 人寫的正文（不含流程紀錄）。 */
  human: string;
}

/** 編輯器裡看到的文字：前四行是欄位，`---` 之後是正文。 */
export function toEditorText(card: Card): string {
  const { human } = splitBody(card.body);
  return `title: ${card.title}\nnotify: ${card.notify ?? ""}\nproject: ${card.project ?? ""}\nmode: ${card.mode ?? ""}\n---\n${human.replace(/^\n+/, "")}`;
}

export type ParsedEdit =
  { ok: true; edit: HumanEdit } | { ok: false; error: string };

const PROJECT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,80}$/;

export function parseEditorText(text: string): ParsedEdit {
  const separator = text.indexOf("\n---\n");
  if (separator < 0)
    return { ok: false, error: "找不到 `---` 分隔線，已放棄這次修改" };
  const header = text.slice(0, separator).split("\n");
  const fields = new Map<string, string>();
  for (const line of header) {
    const match = /^(title|notify|project|mode):[ \t]*(.*)$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!.trim());
  }
  const title = fields.get("title");
  if (!title) return { ok: false, error: "title 不能是空的" };
  const notify = fields.get("notify");
  const project = fields.get("project");
  if (project && !PROJECT_PATTERN.test(project))
    return {
      ok: false,
      error: "project 要寫成 <機器>:<repo 目錄名>，例如 local:my-repo",
    };
  const mode = fields.get("mode");
  if (mode && mode !== "readonly")
    return { ok: false, error: "mode 只能留空或寫 readonly" };
  return {
    ok: true,
    edit: {
      title,
      ...(notify ? { notify } : {}),
      ...(project ? { project } : {}),
      ...(mode ? { mode: "readonly" as const } : {}),
      human: `\n${text.slice(separator + 5).replace(/\s+$/, "")}\n\n`,
    },
  };
}

export type BoardResult =
  { ok: true; warning?: string } | { ok: false; error: string };

function lastEventOf(store: CardStore, id: string): string | undefined {
  const log = store.readLog(id);
  if (!log.ok) return undefined;
  return log.entries[log.entries.length - 1]?.event;
}

/** 套用人的編輯：只改 title、notify 與流程紀錄之前的正文；寫入前重讀並重新檢查可編輯性。 */
export function applyEdit(
  store: CardStore,
  id: string,
  edit: HumanEdit,
  today: string,
): BoardResult {
  if (!isCardDate(today)) return { ok: false, error: "today 不是有效日期" };
  const current = store.read(id);
  if (!current.ok) return { ok: false, error: current.error };
  const verdict = editability(current.card, lastEventOf(store, id));
  if (!verdict.editable) return { ok: false, error: verdict.reason };
  const result = store.update(id, current.hash, (card) => {
    const { bridge } = splitBody(card.body);
    const next: Card = {
      ...card,
      title: edit.title,
      body: `${edit.human}${bridge}`,
      updated: today > card.updated ? today : card.updated,
    };
    if (edit.notify) next.notify = edit.notify;
    else delete next.notify;
    if (edit.project) next.project = edit.project;
    else delete next.project;
    if (edit.mode) next.mode = edit.mode;
    else delete next.mode;
    return next;
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 把 draft 類的卡設成 ready；沒有 notify 或 project 仍放行，只回傳警告（ISSUE-121、ISSUE-215）。 */
export function markReady(
  store: CardStore,
  id: string,
  today: string,
): BoardResult {
  if (!isCardDate(today)) return { ok: false, error: "today 不是有效日期" };
  const current = store.read(id);
  if (!current.ok) return { ok: false, error: current.error };
  const verdict = editability(current.card, lastEventOf(store, id));
  if (!verdict.editable) return { ok: false, error: verdict.reason };
  if (!verdict.canMarkReady)
    return {
      ok: false,
      error: "停手的卡不能由看板改成 ready；請改完內容後照既有流程重送",
    };
  const result = store.update(id, current.hash, (card) => ({
    ...card,
    status: "ready",
    updated: today > card.updated ? today : card.updated,
  }));
  if (!result.ok) return { ok: false, error: result.error };
  const warnings: string[] = [];
  if (!current.card.project && !current.card.projects?.length)
    warnings.push(
      "這張卡沒有 project，bridge 不會自動撿卡（要自動撿請先填 project）",
    );
  if (!current.card.notify)
    warnings.push(
      "沒有 notify，進度與失敗都不會通知任何人（之後補填也不會補發已處理的事件）",
    );
  return warnings.length
    ? { ok: true, warning: warnings.join("；") }
    : { ok: true };
}

const STATUS_ORDER = [
  "in_progress",
  "ready",
  "recorded",
  "refined",
  "discussing",
  "draft",
  "done",
  "cancelled",
];

export interface BoardRow {
  id: string;
  title: string;
  status: string;
  editability: Editability;
}

/** 依狀態排序（進行中在前、done 在後），同狀態依 id。 */
export function boardRows(store: CardStore): {
  rows: BoardRow[];
  errors: number;
} {
  const listed = store.list();
  const rows = listed.cards.map(({ card }) => ({
    id: card.id,
    title: card.title,
    status: card.status,
    editability: editability(card, lastEventOf(store, card.id)),
  }));
  rows.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.id.localeCompare(b.id),
  );
  return { rows, errors: listed.errors.length };
}

export function newCardTemplate(defaultProject = ""): string {
  return `title: \nnotify: \nproject: ${defaultProject}\nmode: \n---\n\n## 描述\n\n\n## 驗收條件\n\n- \n`;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** 新增一張 draft 卡；id 為 REQ-<日期>-<slug>，不覆蓋既有檔案。 */
export function createDraft(
  store: CardStore,
  slug: string,
  edit: HumanEdit,
  today: string,
): BoardResult & { id?: string } {
  if (!isCardDate(today)) return { ok: false, error: "today 不是有效日期" };
  if (!SLUG.test(slug))
    return { ok: false, error: "slug 只能用小寫英數與連字號，2 到 41 字元" };
  const id = `REQ-${today.replaceAll("-", "")}-${slug}`;
  const card: Card = {
    id,
    type: "requirement",
    status: "draft",
    title: edit.title,
    version: 1,
    created: today,
    updated: today,
    ...(edit.notify ? { notify: edit.notify } : {}),
    ...(edit.project ? { project: edit.project } : {}),
    ...(edit.mode ? { mode: edit.mode } : {}),
    body: `\n# ${edit.title}\n${edit.human}`,
  };
  const result = store.create(card);
  return result.ok ? { ok: true, id } : { ok: false, error: result.error };
}

function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
    return 2;
  return 1;
}

/** 終端機顯示寬度（CJK、全形與 emoji 算 2 格）。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/** 依顯示寬度截斷，不切斷字元；超過上限時結尾補「…」。 */
export function truncateToWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const char of text) {
    const next = charWidth(char.codePointAt(0) ?? 0);
    if (width + next > max - 1) break;
    out += char;
    width += next;
  }
  return `${out}…`;
}

export type BoardKeyAction =
  "up" | "down" | "pageUp" | "pageDown" | "home" | "end";

const KEY_ACTIONS: Readonly<Record<string, BoardKeyAction>> = {
  k: "up",
  "\x1b[A": "up",
  j: "down",
  "\x1b[B": "down",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  "\x1b[H": "home",
  "\x1b[1~": "home",
  "\x1b[7~": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1b[4~": "end",
  "\x1b[8~": "end",
  "\x1bOF": "end",
};

/** 看板移動鍵對應的動作；終端機送的 Home／End 序列不只一種，都要認得。 */
export function boardKeyAction(key: string): BoardKeyAction | undefined {
  return Object.hasOwn(KEY_ACTIONS, key) ? KEY_ACTIONS[key] : undefined;
}

/** 終端機高度扣掉標題、錯誤、選取 id 與提示列後，能顯示的卡片列數。 */
export function visibleRows(height: number): number {
  return Math.max(3, height - 5);
}

/** 移動後的游標；一頁至少 1 列，結果夾在清單範圍內，空清單一律回 0。 */
export function moveCursor(
  action: BoardKeyAction,
  cursor: number,
  count: number,
  pageSize: number,
): number {
  if (count <= 0) return 0;
  const page = Math.max(1, pageSize);
  const next = {
    up: cursor - 1,
    down: cursor + 1,
    pageUp: cursor - page,
    pageDown: cursor + page,
    home: 0,
    end: count - 1,
  }[action];
  return Math.min(count - 1, Math.max(0, next));
}

/** 讓選取列保持在視窗內，盡可能置中。 */
export function firstVisible(
  cursor: number,
  total: number,
  room: number,
): number {
  return Math.max(0, Math.min(cursor - Math.floor(room / 2), total - room));
}
