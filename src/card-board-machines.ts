import fs from "node:fs";
import { stripJsonComments } from "./config.js";
import { sshConfigHasHostCached, sshTargetLabel, validateMachines, type MachineConfig } from "./machines.js";
import {
  firstVisible,
  truncateToWidth,
  visibleRows,
  type BoardRow,
} from "./card-board.js";

import type { MachineStatus } from "./machine-status-file.js";
import type { MachineControlResult } from "./machines.js";
import type { MachineControlCommand } from "./machine-control-channel.js";

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
  "設定改動重啟 bridge 後生效；狀態＝執行中 bridge 的觀測 | Tab/m/c 切換  j/k 移動  PgUp/PgDn 翻頁  Home/End 頭尾  e/Enter 編輯  o 連線  x 斷線  R 重啟 bridge  q 離開";

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
  hasConfiguredHost: (alias: string) => boolean = sshConfigHasHostCached,
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
          `${first + offset === cursor ? ">" : " "} ${machine.id}  ${sshTargetLabel(machine, hasConfiguredHost)}  ${statusLabel(statuses.get(machine.id))}  ${machine.socket}`,
        ),
        width - 1,
      ),
    );
}

export function machineEditorText(machine: MachineConfig): string {
  return (
    JSON.stringify(
      {
        user: machine.user ?? "",
        host: machine.host ?? "",
        port: machine.port ?? 22,
      },
      null,
      2,
    ) + "\n"
  );
}

export function parseMachineEditorText(
  text: string,
):
  | { ok: true; fields: { user?: string; host?: string; port?: number } }
  | { ok: false; message: string } {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error();
    value = parsed;
    if (
      Object.keys(value).length !== 3 ||
      Object.keys(value).some((k) => !["user", "host", "port"].includes(k)) ||
      typeof value.user !== "string" ||
      typeof value.host !== "string" ||
      typeof value.port !== "number"
    )
      throw new Error();
  } catch {
    return { ok: false, message: "未儲存：SSH 編輯格式不對" };
  }
  const { user, host, port } = value as {
    user: string;
    host: string;
    port: number;
  };
  if (!host) {
    // 沒有 host：只有 port 可以單獨設定（給 ssh alias 用，存檔時再驗證 machine 是否有 ssh）。
    if (user) return { ok: false, message: "未儲存：SSH 連線設定不合法" };
    if (port === 22) return { ok: true, fields: {} };
    try {
      validateMachines([{ id: "edited", ssh: "alias", socket: "/unused", port }]);
      return { ok: true, fields: { port } };
    } catch {
      return { ok: false, message: "未儲存：SSH 連線設定不合法" };
    }
  }
  const fields = { ...(user ? { user } : {}), host, port };
  try {
    validateMachines([{ id: "edited", socket: "/unused", ...fields }]);
    return { ok: true, fields };
  } catch {
    return { ok: false, message: "未儲存：SSH 連線設定不合法" };
  }
}

function statusLabel(status: MachineStatus | undefined): string {
  return status === "disconnected" ? "已斷線" : (status ?? "未知");
}

export const MACHINE_CONTROL_PENDING = "處理中…";
export const MACHINE_CONTROL_NO_SELECTION = "沒有選取 machine";

/** 看板 o／x 操作的狀態：等待回應中，以及上一個結果要求強制斷線的 machine。 */
export interface MachineControlUi {
  pending: boolean;
  /** 上一個結果帶結構化 needsForce:true 的 machine；只有緊接著對同一台按 x 才送 force。 */
  confirmFor?: string;
  /** 已按過一次 R；緊接著再按 R 才送出重啟（任何其他按鍵都取消）。 */
  restartConfirm?: boolean;
  /** 上一個結果帶結構化 needsRemoteRestart:true 的 machine；只有緊接著對同一台再按 o 才送出「重啟遠端 server」（ISSUE-177）。 */
  remoteRestartFor?: string;
}

/** 要求使用者確認重啟遠端 Herdr server 的提示：寫清楚會中斷什麼，以及遠端的 bridge 會一併重開（階段 2）。 */
export const REMOTE_RESTART_CONFIRM =
  "Herdr 要求先重啟這台的遠端 server 才能更新側邊欄的埠；這會中斷它上面所有 pane 的行程（shell、agent、測試）；遠端若跑著 bridge，換埠成功後會一併重開。再按一次 o 確認重啟（其他鍵取消）";

export const BRIDGE_RESTART_CONFIRM = "再按一次 R 確認重啟 bridge（其他鍵取消）";

export type MachineKeyOutcome =
  | { kind: "quit" }
  /** 等待回應中，其他按鍵都不處理。 */
  | { kind: "ignore" }
  | { kind: "message"; message: string }
  | { kind: "send"; command: MachineControlCommand; message: string }
  /** 交給既有按鍵處理（Card 檢視的所有按鍵、Machine 檢視的移動／編輯等）。 */
  | { kind: "pass" };

/**
 * 每個按鍵先經過這裡：q／Ctrl-C 一律離開；等待回應時擋下其他按鍵；Machine 檢視的 o／x 送出請求。
 * 除了「緊接著對同一台再按 x」以外，任何按鍵都清掉強制斷線的確認（換台要按移動鍵，所以也會清掉）。
 */
export function machineControlKey(
  ui: MachineControlUi,
  key: string,
  view: BoardView,
  selectedId: string | undefined,
): { ui: MachineControlUi; outcome: MachineKeyOutcome } {
  if (key === "q" || key === "\x03") return { ui, outcome: { kind: "quit" } };
  if (ui.pending) return { ui, outcome: { kind: "ignore" } };
  if (view === "machines" && key === "R") {
    if (!ui.restartConfirm)
      return {
        ui: { pending: false, restartConfirm: true },
        outcome: { kind: "message", message: BRIDGE_RESTART_CONFIRM },
      };
    return {
      ui: { pending: true },
      outcome: {
        kind: "send",
        command: { action: "restart", machineId: "" },
        message: MACHINE_CONTROL_PENDING,
      },
    };
  }
  if (view !== "machines" || (key !== "o" && key !== "x"))
    return { ui: { pending: false }, outcome: { kind: "pass" } };
  if (selectedId === undefined)
    return {
      ui: { pending: false },
      outcome: { kind: "message", message: MACHINE_CONTROL_NO_SELECTION },
    };
  const force = key === "x" && ui.confirmFor === selectedId;
  const restartRemote = key === "o" && ui.remoteRestartFor === selectedId;
  return {
    ui: { pending: true },
    outcome: {
      kind: "send",
      command: {
        action: key === "o" ? "connect" : "disconnect",
        machineId: selectedId,
        ...(force ? { force: true } : {}),
        ...(restartRemote ? { restartRemote: true } : {}),
      },
      message: MACHINE_CONTROL_PENDING,
    },
  };
}

/** 「重啟 bridge」的回應：成功只提示重啟中，失敗顯示固定短句。 */
export function bridgeRestartResult(result: MachineControlResult): {
  ui: MachineControlUi;
  message: string;
} {
  const text = result.ok
    ? (result.note ?? "bridge 重啟中")
    : sanitizeForTerminal(result.reason);
  return { ui: { pending: false }, message: `bridge：${sanitizeForTerminal(text)}` };
}

/** 本機暫時蓋過狀態檔的顯示：斷線成功立即顯示「已斷線」、連線成功先顯示「未知」，直到 bridge 寫入新狀態。 */
export interface StatusOverride {
  status: MachineStatus | "unknown";
  untilMs: number;
}

/** 略長於 bridge 寫狀態檔的間隔（5 秒），之後改看狀態檔。 */
export const STATUS_OVERRIDE_MS = 6000;

/** 收到回應：解除等待；只依結構化的 needsForce:true 記下確認對象，不比對文案。 */
export function machineControlResult(
  machineId: string,
  result: MachineControlResult,
  nowMs: number,
): { ui: MachineControlUi; message: string; override?: StatusOverride } {
  const label = sanitizeForTerminal(machineId);
  if (!result.ok)
    return {
      ui:
        result.needsForce === true
          ? { pending: false, confirmFor: machineId }
          : { pending: false },
      message: `${label}：${sanitizeForTerminal(result.reason)}`,
    };
  const note = result.note ? sanitizeForTerminal(result.note) : undefined;
  const herdr = result.herdr ? `；${sanitizeForTerminal(result.herdr)}` : "";
  // 只依結構化的 needsRemoteRestart:true：連線本身成功，但要使用者確認才重啟遠端 server（ISSUE-177）。
  if (result.needsRemoteRestart === true)
    return {
      ui: { pending: false, remoteRestartFor: machineId },
      message: `${label}：${note ?? "已開始連線"}${herdr}；${REMOTE_RESTART_CONFIRM}`,
    };
  return {
    ui: { pending: false },
    message: `${label}：${note ?? (result.status === "disconnected" ? "已斷線" : "已開始連線")}${herdr}`,
    // 「已在連線中」沒有改變狀態，不必蓋過狀態檔。
    ...(result.status === "connected" && result.note
      ? {}
      : {
          override: {
            status:
              result.status === "disconnected" ? "disconnected" : "unknown",
            untilMs: nowMs + STATUS_OVERRIDE_MS,
          },
        }),
  };
}

/** 背景重啟遠端 server 的進度要顯示多久（完成或失敗後）。 */
export const REMOTE_RESTART_SHOW_MS = 60_000;

/**
 * 看板定期重讀狀態檔時用：進度有變化才回傳要顯示的訊息（一次），沒變就不再蓋掉使用者其他操作的訊息；
 * 完成或失敗超過 REMOTE_RESTART_SHOW_MS 不再顯示。`shown` 是這次看過的簽章，下次傳回來。
 */
export function remoteRestartMessage(
  status: { machineId: string; state: string; note: string; updatedAt: number } | undefined,
  nowMs: number,
  lastShown: string,
): { message?: string; shown: string } {
  if (!status) return { shown: lastShown };
  const signature = `${status.machineId}:${status.state}:${status.updatedAt}`;
  if (signature === lastShown) return { shown: lastShown };
  if (status.state !== "running" && nowMs - status.updatedAt > REMOTE_RESTART_SHOW_MS) return { shown: signature };
  return { message: `${sanitizeForTerminal(status.machineId)}：${sanitizeForTerminal(status.note)}`, shown: signature };
}

/** 套用一次控制回應的覆寫：有新的就取代；沒有就保留尚未到期的舊值（到期由 `withStatusOverrides` 略過，review F3）。 */
export function applyStatusOverride(
  overrides: Map<string, StatusOverride>,
  id: string,
  next: StatusOverride | undefined,
): void {
  if (next) overrides.set(id, next);
}

export function withStatusOverrides(
  statuses: Map<string, MachineStatus>,
  overrides: Map<string, StatusOverride>,
  nowMs: number,
): Map<string, MachineStatus> {
  const merged = new Map(statuses);
  for (const [id, override] of overrides) {
    if (override.untilMs <= nowMs) continue;
    if (override.status === "unknown") merged.delete(id);
    else merged.set(id, override.status);
  }
  return merged;
}
