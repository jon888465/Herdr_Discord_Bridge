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
  try {
    const value =
      parsed && typeof parsed === "object" && "machines" in parsed
        ? parsed.machines
        : undefined;
    if (value !== undefined && !Array.isArray(value))
      return { ok: false, reason: "machines 設定格式不對" };
    return { ok: true, machines: validateMachines(value) };
  } catch {
    // 驗證錯誤可能含使用者輸入；只傳回固定短句。
    return { ok: false, reason: "machines 設定格式不對" };
  }
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
        `${first + offset === cursor ? ">" : " "} ${machine.id}  ${machine.ssh}  ${machine.socket}`,
        width - 1,
      ),
    );
}
