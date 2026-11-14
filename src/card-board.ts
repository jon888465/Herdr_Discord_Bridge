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
  /** 人寫的正文（不含流程紀錄）。 */
  human: string;
}

/** 編輯器裡看到的文字：前兩行是欄位，`---` 之後是正文。 */
export function toEditorText(card: Card): string {
  const { human } = splitBody(card.body);
  return `title: ${card.title}\nnotify: ${card.notify ?? ""}\n---\n${human.replace(/^\n+/, "")}`;
}

export type ParsedEdit =
  { ok: true; edit: HumanEdit } | { ok: false; error: string };

export function parseEditorText(text: string): ParsedEdit {
  const separator = text.indexOf("\n---\n");
  if (separator < 0)
    return { ok: false, error: "找不到 `---` 分隔線，已放棄這次修改" };
  const header = text.slice(0, separator).split("\n");
  const fields = new Map<string, string>();
  for (const line of header) {
    const match = /^(title|notify):[ \t]*(.*)$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!.trim());
  }
  const title = fields.get("title");
  if (!title) return { ok: false, error: "title 不能是空的" };
  const notify = fields.get("notify");
  return {
    ok: true,
    edit: {
      title,
      ...(notify ? { notify } : {}),
      human: `\n${text.slice(separator + 5).replace(/\s+$/, "")}\n\n`,
    },
  };
}

export type BoardResult = { ok: true } | { ok: false; error: string };

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
    return next;
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 把 draft 類的卡設成 ready；沒有 notify 不放行（AGENTS.md、ISSUE-121）。 */
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
  if (!current.card.notify)
    return {
      ok: false,
      error:
        "沒有 notify：先填 notify（discord:<thread id> 或 agent:<pane id>:<terminal id>:<agent>）再放行",
    };
  const result = store.update(id, current.hash, (card) => ({
    ...card,
    status: "ready",
    updated: today > card.updated ? today : card.updated,
  }));
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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

export function newCardTemplate(): string {
  return `title: \nnotify: \n---\n\n## 描述\n\n\n## 驗收條件\n\n- \n`;
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
    body: `\n# ${edit.title}\n${edit.human}`,
  };
  const result = store.create(card);
  return result.ok ? { ok: true, id } : { ok: false, error: result.error };
}
