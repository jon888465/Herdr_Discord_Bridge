import fs from "node:fs";
import { stripJsonComments } from "./config.js";
import { validateMachines, type MachineConfig } from "./machines.js";
import {
  firstVisible,
  truncateToWidth,
  visibleRows,
  type BoardRow,
} from "./card-board.js";

import type { MachineStatus } from "./machine-status-file.js";

export type BoardView = "cards" | "machines";

export function toggleView(view: BoardView): BoardView {
  return view === "cards" ? "machines" : "cards";
}

export function viewKeyAction(key: string): "toggle" | undefined {
  return key === "\t" || key === "m" || key === "c" ? "toggle" : undefined;
}

export function readMachinesSection(
  file: string,
): { ok: true; machines: MachineConfig[] } | { ok: false; reason: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, machines: [] };
    return { ok: false, reason: "config.json 讀不到" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return { ok: false, reason: "config.json 不是合法 JSON" };
  }
  if (!isPlainObject(parsed))
    return { ok: false, reason: "config.json 根節點不是物件" };
  const value = parsed.machines;
  if (value === undefined) return { ok: true, machines: [] };
  if (!Array.isArray(value))
    return { ok: false, reason: "machines 設定格式不對" };
  // validateMachines 會靜默略過 null、數字等非物件項目；看板要把它們當格式錯誤回報。
  if (!value.every(isPlainObject))
    return { ok: false, reason: "machines 內有不是物件的項目" };
  try {
    return { ok: true, machines: validateMachines(value) };
  } catch {
    // 驗證錯誤可能含使用者輸入；只傳回固定短句。
    return { ok: false, reason: "machines 設定格式不對" };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 合法 JSON 可含 ESC 等跳脫控制字元，validateMachines 不會拒絕，直接寫到終端會改變畫面或終端狀態；
 * 呈現前把 C0／DEL／C1 控制字元換成 U+FFFD。
 */
export function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
}

/** 看板標題列：標題粗體、後接筆數；整列依寬度截斷，確保只佔一列。 */
export function boardHeader(
  view: BoardView,
  count: number,
  width: number,
): string {
  const title = `Card 看板 [${view === "cards" ? "Card" : "Machine"}]`;
  const line = truncateToWidth(`${title}  (${count})`, width - 1);
  return line.startsWith(title)
    ? `\x1b[1m${title}\x1b[0m${line.slice(title.length)}`
    : `\x1b[1m${line}\x1b[0m`;
}

export const MACHINE_HINT =
  "Tab/m/c 切換檢視  o 連線 x 斷線  j/k 移動  PgUp/PgDn 翻頁  Home/End 頭尾  q 離開";

export interface MachineViewState {
  machines: MachineConfig[];
  statuses?: Map<string, MachineStatus>;
  cursor: number;
  /** readMachinesSection 的失敗原因；有值時不顯示列表。 */
  error: string;
  message: string;
}

/**
 * Machine 檢視整個畫面的各列（不含清屏控制碼）。標題、錯誤、訊息與提示都依寬度截斷成一列，
 * 列表列數沿用 visibleRows，所以總列數不會超過終端機高度（視窗很窄時也不會換行把頂部捲掉）。
 */
export function machineViewLines(
  state: MachineViewState,
  width: number,
  height: number,
): string[] {
  const max = width - 1;
  const lines = [boardHeader("machines", state.machines.length, width)];
  if (state.error) lines.push(truncateToWidth(state.error, max));
  else {
    const room = machineRoom(state, height);
    if (room > 0)
      lines.push(
        ...machineLines(
          state.machines,
          state.cursor,
          width,
          room,
          state.statuses,
        ),
      );
  }
  if (state.message) lines.push(truncateToWidth(state.message, max));
  lines.push(truncateToWidth(MACHINE_HINT, max));
  return clampToHeight(lines, height);
}

/**
 * 清單最多能用的列數：不超過 visibleRows，也不超過「高度減固定列」。Card、Machine 兩個檢視與翻頁共用這一個
 * 計算，畫面容量與翻頁一頁的列數才不會各算各的（review round 3／5，F4、F7、F8）。
 */
export function listRoom(height: number, fixedRows: number): number {
  return Math.max(0, Math.min(visibleRows(height), height - fixedRows));
}

/** Machine 檢視清單的列數：標題＋提示＋（有訊息時）訊息為固定列；有錯誤時不列機器。 */
export function machineRoom(
  state: { error: string; message: string },
  height: number,
): number {
  return state.error ? 0 : listRoom(height, 2 + (state.message ? 1 : 0));
}

/** 總列數超過高度時，保留最上面幾列與最後一列（提示），確保不超出畫面。 */
function clampToHeight(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  const last = lines[lines.length - 1]!;
  return height > 1 ? [...lines.slice(0, height - 1), last] : [last];
}

export const CARD_HINT =
  "Tab/m/c 切換檢視  j/k 移動  PgUp/PgDn 翻頁  Home/End 頭尾  e 編輯  n 新增  r 設為 ready  q 離開";

export interface CardViewState {
  rows: BoardRow[];
  cursor: number;
  /** 讀不到的卡片檔數。 */
  errors: number;
  message: string;
}

/** Card 檢視清單的列數：標題＋提示為固定列，另有「讀檔錯誤」與「選取卡片 id」兩列視情況出現。 */
export function cardRoom(
  state: Pick<CardViewState, "rows" | "cursor" | "errors">,
  height: number,
): number {
  const fixed = 2 + (state.errors ? 1 : 0) + (state.rows[state.cursor] ? 1 : 0);
  return listRoom(height, fixed);
}

function cardMark(row: BoardRow): string {
  if (!row.editability.editable) return "🔒";
  return row.editability.kind === "draft" ? "✎ " : "↺ ";
}

/**
 * Card 檢視整個畫面的各列（不含清屏控制碼）。每一列都依寬度截斷成一列（包含加長後的切換提示），
 * 清單列數與 Machine 檢視共用 listRoom，總列數不超過終端機高度。
 */
export function cardViewLines(
  state: CardViewState,
  width: number,
  height: number,
): string[] {
  const max = width - 1;
  const lines = [boardHeader("cards", state.rows.length, width)];
  if (state.errors)
    lines.push(
      `\x1b[33m${truncateToWidth(`${state.errors} 個檔案讀不到，請用 herdr-card-check`, max)}\x1b[0m`,
    );
  const room = cardRoom(state, height);
  const first = firstVisible(state.cursor, state.rows.length, room);
  for (let i = first; i < Math.min(state.rows.length, first + room); i++) {
    const row = state.rows[i]!;
    const line = truncateToWidth(
      `${i === state.cursor ? ">" : " "} ${cardMark(row)} ${row.status.padEnd(11)} ${row.title}`,
      max,
    );
    lines.push(i === state.cursor ? `\x1b[7m${line}\x1b[0m` : line);
  }
  const selected = state.rows[state.cursor];
  if (selected)
    lines.push(
      `\x1b[2m${truncateToWidth(`${selected.id}${selected.editability.editable ? "" : `：${selected.editability.reason}`}`, max)}\x1b[0m`,
    );
  lines.push(
    state.message
      ? truncateToWidth(state.message, max)
      : `\x1b[2m${truncateToWidth(CARD_HINT, max)}\x1b[0m`,
  );
  return clampToHeight(lines, height);
}

export function machineLines(
  machines: MachineConfig[],
  cursor: number,
  width: number,
  room: number,
  statuses: Map<string, MachineStatus> = new Map(),
): string[] {
  if (!machines.length)
    return [
      truncateToWidth(
        "沒有設定任何 machine（config.json 的 machines 為空）",
        width - 1,
      ),
    ];
  const first = firstVisible(cursor, machines.length, room);
  return machines
    .slice(first, first + room)
    .map((machine, offset) =>
      truncateToWidth(
        sanitizeForTerminal(
          `${first + offset === cursor ? ">" : " "} ${machine.id}  ${machine.ssh}  ${statuses.get(machine.id) === "disconnected" ? "已斷線" : (statuses.get(machine.id) ?? "未知")}  ${machine.socket}`,
        ),
        width - 1,
      ),
    );
}

/** A single pending operation and explicit same-machine second-press confirmation. */
export class MachineControlState {
  pending = false;
  private forceMachine: string | undefined;

  clearConfirmation(): void {
    this.forceMachine = undefined;
  }

  async run(
    key: "o" | "x",
    machineId: string | undefined,
    request: (request: {
      action: "connect" | "disconnect";
      machineId: string;
      force?: boolean;
    }) => Promise<import("./machines.js").MachineControlResult>,
    show: (message: string) => void,
  ): Promise<void> {
    if (this.pending) return;
    if (!machineId) {
      this.clearConfirmation();
      show("沒有選取 machine");
      return;
    }
    const force = key === "x" && this.forceMachine === machineId;
    this.clearConfirmation();
    this.pending = true;
    show("處理中…");
    try {
      const result = await request({
        action: key === "o" ? "connect" : "disconnect",
        machineId,
        ...(force ? { force: true } : {}),
      });
      if (!result.ok && result.needsForce === true)
        this.forceMachine = machineId;
      show(
        result.ok
          ? (result.note ??
              (result.status === "connected"
                ? "已開始連線，結果見狀態欄"
                : "已斷線"))
          : result.reason,
      );
    } catch {
      show("bridge 未連線");
    } finally {
      this.pending = false;
    }
  }
}

export function machineInputAction(
  key: string,
  pending: boolean,
): "quit" | "ignore" | "control" | "other" {
  if (key === "q" || key === "\x03") return "quit";
  if (pending) return "ignore";
  return key === "o" || key === "x" ? "control" : "other";
}
