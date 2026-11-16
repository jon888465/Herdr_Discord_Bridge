import fs from "node:fs";
import { stripJsonComments } from "./config.js";
import { validateMachines, type MachineConfig } from "./machines.js";
import { firstVisible, truncateToWidth, visibleRows } from "./card-board.js";

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
  "Tab/m/c 切換檢視  j/k 移動  PgUp/PgDn 翻頁  Home/End 頭尾  q 離開";

export interface MachineViewState {
  machines: MachineConfig[];
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
  const hint = truncateToWidth(MACHINE_HINT, max);
  const lines = [boardHeader("machines", state.machines.length, width)];
  if (state.error) lines.push(truncateToWidth(state.error, max));
  else {
    // 列表只能用掉標題、訊息與提示之外的列；visibleRows 最少 3，高度很小時會超出（review round 3，F4）。
    const fixed = 2 + (state.message ? 1 : 0);
    const room = Math.max(0, Math.min(visibleRows(height), height - fixed));
    if (room > 0)
      lines.push(...machineLines(state.machines, state.cursor, width, room));
  }
  if (state.message) lines.push(truncateToWidth(state.message, max));
  lines.push(hint);
  // 高度小到連固定列都放不下時，保留最上面幾列與提示，總列數不超過高度。
  if (lines.length > height)
    return height > 1 ? [...lines.slice(0, height - 1), hint] : [hint];
  return lines;
}

export function machineLines(
  machines: MachineConfig[],
  cursor: number,
  width: number,
  room: number,
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
          `${first + offset === cursor ? ">" : " "} ${machine.id}  ${machine.ssh}  ${machine.socket}`,
        ),
        width - 1,
      ),
    );
}
