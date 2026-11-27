// 卡片看板的唯讀檢視頁（REQ-20261126-board-card-view）：Enter 開、Esc 返回、e 編輯。
// 這個模組只負責「把卡片全文排成一頁一頁的畫面」，沒有任何寫入路徑。

import { LEDGER_MAX_FILE_BYTES, type Card } from "./card.js";
import { serializeCard } from "./card-serialize.js";
import { displayWidth, truncateToWidth } from "./card-board.js";
import { sanitizeForTerminal } from "./card-board-machines.js";

export const DETAIL_HINT = "Esc 返回  j/k 捲動  PgUp/PgDn 翻頁  Home/End 頭尾  e 編輯  q 離開";

/** 卡片全文（frontmatter 全部欄位加正文，含流程紀錄）；讀不出來就回傳原因。 */
export function cardFullText(card: Card): string {
  const result = serializeCard(card, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  return result.ok ? result.text : `（無法序列化這張卡：${result.error}）\n\n${card.body}`;
}

/** 依顯示寬度折行（CJK 算 2 格）；先過控制字元處理，空行保留。 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const out: string[] = [];
  // 先依換行拆開再逐行處理控制字元（sanitizeForTerminal 也會把換行換掉）。
  for (const piece of text.replaceAll("\r\n", "\n").split("\n")) {
    const raw = sanitizeForTerminal(piece.replaceAll("\t", "  "));
    if (displayWidth(raw) <= limit) {
      out.push(raw);
      continue;
    }
    let line = "";
    let used = 0;
    for (const char of raw) {
      const w = displayWidth(char);
      if (used + w > limit) {
        out.push(line);
        line = "";
        used = 0;
      }
      line += char;
      used += w;
    }
    out.push(line);
  }
  return out;
}

/** 內文區能顯示的列數（扣掉標題列與提示／位置列）。 */
export function detailRoom(height: number): number {
  return Math.max(1, height - 2);
}

/** 捲動位置夾在 0 到「最後一頁起點」之間。 */
export function clampScroll(scroll: number, total: number, room: number): number {
  return Math.max(0, Math.min(scroll, Math.max(0, total - room)));
}

export type DetailScrollKey = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";

export function scrollBy(action: DetailScrollKey, scroll: number, total: number, room: number): number {
  const next = {
    up: scroll - 1,
    down: scroll + 1,
    pageUp: scroll - room,
    pageDown: scroll + room,
    home: 0,
    end: total,
  }[action];
  return clampScroll(next, total, room);
}

export interface DetailState {
  id: string;
  title: string;
  editable: boolean;
  /** 已折行的全文（寬度改變時由呼叫端重新折）。 */
  lines: string[];
  scroll: number;
  message: string;
}

/** 整頁畫面：標題列、內文（不超過 height − 2 列）、位置與提示列；總列數不超過 height。 */
export function detailLines(state: DetailState, width: number, height: number): string[] {
  const max = Math.max(1, width - 1);
  const room = detailRoom(height);
  const scroll = clampScroll(state.scroll, state.lines.length, room);
  const head = `\x1b[1m${truncateToWidth(`${sanitizeForTerminal(state.id)}  ${sanitizeForTerminal(state.title)}  ［唯讀檢視］`, max)}\x1b[0m`;
  const body = state.lines.slice(scroll, scroll + room).map((line) => truncateToWidth(line, max));
  const last = Math.min(state.lines.length, scroll + room);
  const position = `${state.lines.length ? scroll + 1 : 0}-${last}/${state.lines.length}`;
  const foot = state.message
    ? truncateToWidth(state.message, max)
    : `\x1b[2m${truncateToWidth(`${position}  ${DETAIL_HINT}${state.editable ? "" : "（此卡唯讀）"}`, max)}\x1b[0m`;
  return [head, ...body, foot];
}
