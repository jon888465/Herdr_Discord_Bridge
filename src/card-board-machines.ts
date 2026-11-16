import fs from "node:fs";
import { stripJsonComments } from "./config.js";
import { validateMachines, type MachineConfig } from "./machines.js";
import { firstVisible, truncateToWidth } from "./card-board.js";

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
