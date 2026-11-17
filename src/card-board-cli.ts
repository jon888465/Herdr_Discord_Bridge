#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDirectory,
  stateDirectory,
  stripJsonComments,
} from "./config.js";
import { LEDGER_MAX_FILE_BYTES } from "./card.js";
import { CardStore } from "./card-store.js";
import { ensureCardsDirectory } from "./card-directory.js";
import { boardEditingMarker } from "./card-board-open.js";
import {
  applyEdit,
  boardKeyAction,
  boardRows,
  createDraft,
  markReady,
  moveCursor,
  newCardTemplate,
  parseEditorText,
  toEditorText,
  type BoardRow,
} from "./card-board.js";

import {
  machineControlKey,
  machineControlResult,
  withStatusOverrides,
  type MachineControlUi,
  type StatusOverride,
  machineEditorText,
  parseMachineEditorText,
  cardRoom,
  cardViewLines,
  machineRoom,
  machineViewLines,
  applyStatusOverride,
  readMachinesSection,
  toggleView,
  viewKeyAction,
  type BoardView,
} from "./card-board-machines.js";
import {
  readMachineStatus,
  MACHINE_STATUS_MAX_AGE_MS,
  type MachineStatus,
} from "./machine-status-file.js";
import {
  readMachinesSnapshot,
  saveMachinesConfig,
} from "./machines-config-write.js";
import { validateMachines, type MachineConfig } from "./machines.js";
import { sendMachineControl } from "./machine-control-channel.js";

// Herdr plugin pane：卡片看板。只編輯 draft 類與已停手的卡，其餘唯讀。
const rootDir = path.join(stateDirectory(), "cards");
const check = ensureCardsDirectory(rootDir, { create: true });
if (!check.ok) {
  console.error(check.error);
  process.exit(1);
}
const store = new CardStore(rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
const today = (): string => new Date().toISOString().slice(0, 10);

let rows: BoardRow[] = [];
let errors = 0;
let cursor = 0;
let message = "";
let editing = false;
let view: BoardView = "cards";
let machines: MachineConfig[] = [];
let machineCursor = 0;
let statuses = new Map<string, MachineStatus>();
let machineError = "";
let control: MachineControlUi = { pending: false };
const statusOverrides = new Map<string, StatusOverride>();

function reloadMachines(): void {
  statuses = readMachineStatus(
    path.join(stateDirectory(), "machine-status.json"),
    new Date(),
    MACHINE_STATUS_MAX_AGE_MS,
  );
  const result = readMachinesSection(
    path.join(configDirectory(), "config.json"),
  );
  machines = result.ok ? result.machines : [];
  machineError = result.ok ? "" : result.reason;
  machineCursor = Math.min(machineCursor, Math.max(0, machines.length - 1));
}

function reload(): void {
  reloadMachines();
  const board = boardRows(store);
  rows = board.rows;
  errors = board.errors;
  cursor = Math.min(cursor, Math.max(0, rows.length - 1));
}

function render(): void {
  if (editing) return;
  const height = process.stdout.rows || 24;
  const width = process.stdout.columns || 80;
  if (view === "machines") {
    // 標題、錯誤、訊息與提示都截斷成一列，加上列表不超過終端機高度（review round 2，F3）。
    process.stdout.write(
      `\x1b[2J\x1b[H${machineViewLines(
        {
          machines,
          statuses: withStatusOverrides(statuses, statusOverrides, Date.now()),
          cursor: machineCursor,
          error: machineError,
          message,
        },
        width,
        height,
      ).join("\n")}`,
    );
    return;
  }
  process.stdout.write(
    `\x1b[2J\x1b[H${cardViewLines({ rows, cursor, errors, message }, width, height).join("\n")}`,
  );
}

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** 離開 raw mode 開 $EDITOR，結束後回來；沒改或編輯器失敗回傳 undefined。 */
function editText(initial: string, filename = "card.md"): string | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-card-board-"));
  const file = path.join(dir, filename);
  fs.writeFileSync(file, initial, { mode: 0o600 });
  editing = true;
  // bridge 啟動時會把舊看板換成新的；留下標記讓它知道這裡正在編輯，不要關掉（ISSUE-160）。
  const marker = boardEditingMarker(stateDirectory());
  try {
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
  } catch {
    // 寫不出標記只代表 bridge 可能在編輯中重開看板，不影響編輯本身。
  }
  process.stdin.setRawMode(false);
  process.stdout.write(LEAVE_ALT_SCREEN);
  try {
    const editor = process.env.EDITOR || "vi";
    const run = spawnSync(`${editor} "${file}"`, {
      stdio: "inherit",
      shell: true,
    });
    if (run.status !== 0) return undefined;
    const text = fs.readFileSync(file, "utf8");
    return text === initial ? undefined : text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
    process.stdout.write(ENTER_ALT_SCREEN);
    process.stdin.setRawMode(true);
    editing = false;
  }
}

function editSelected(): void {
  const row = rows[cursor];
  if (!row) return;
  if (!row.editability.editable) {
    message = `不能編輯：${row.editability.reason}`;
    return;
  }
  const read = store.read(row.id);
  if (!read.ok) {
    message = read.error;
    return;
  }
  const text = editText(toEditorText(read.card));
  if (text === undefined) {
    message = "沒有修改";
    return;
  }
  const parsed = parseEditorText(text);
  if (!parsed.ok) {
    message = parsed.error;
    return;
  }
  const result = applyEdit(store, row.id, parsed.edit, today());
  message = result.ok ? `已儲存 ${row.id}` : `未儲存：${result.error}`;
}

function editMachine(): void {
  const machine = machines[machineCursor];
  if (!machine) return;
  const file = path.join(configDirectory(), "config.json");
  const snapshot = readMachinesSnapshot(file);
  if (!snapshot.ok) {
    message = "未儲存：config.json 寫入失敗";
    return;
  }
  let text: string | undefined;
  try {
    const source = JSON.parse(
      stripJsonComments(snapshot.value.bytes.toString("utf8")),
    ) as { machines: unknown };
    const current = validateMachines(source.machines).find(
      (m) => m.id === machine.id,
    );
    if (!current) {
      message = "未儲存：SSH 連線設定不合法";
      return;
    }
    text = editText(machineEditorText(current), "machine.json");
  } catch {
    message = "未儲存：config.json 寫入失敗";
    return;
  }
  if (text === undefined) {
    message = "沒有修改";
    return;
  }
  const parsed = parseMachineEditorText(text);
  if (!parsed.ok) {
    message = parsed.message;
    return;
  }
  const result = saveMachinesConfig(
    file,
    snapshot.value,
    machine.id,
    parsed.fields,
  );
  message = result.ok
    ? result.value === "unchanged"
      ? "沒有修改"
      : "已儲存；重啟 bridge 後生效"
    : result.reason === "conflict"
      ? "未儲存：config.json 已變更，請重新編輯"
      : result.reason === "invalid"
        ? "未儲存：SSH 連線設定不合法"
        : "未儲存：config.json 寫入失敗";
}

function newCard(): void {
  const text = editText(
    newCardTemplate(`local:${path.basename(process.cwd())}`),
  );
  if (text === undefined) {
    message = "沒有新增";
    return;
  }
  const parsed = parseEditorText(text);
  if (!parsed.ok) {
    message = parsed.error;
    return;
  }
  const slug = parsed.edit.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 41);
  const result = createDraft(
    store,
    slug.length >= 2 ? slug : `card-${Date.now().toString(36)}`,
    parsed.edit,
    today(),
  );
  message = result.ok
    ? `已新增 ${result.id}（draft）`
    : `未新增：${result.error}`;
}

function readySelected(): void {
  const row = rows[cursor];
  if (!row) return;
  const result = markReady(store, row.id, today());
  message = result.ok
    ? `${row.id} 已設為 ready${result.warning ? `。⚠ ${result.warning}` : ""}`
    : `未放行：${result.error}`;
}

reload();
// 備用螢幕：Herdr 只把 PageUp／PageDown 轉給備用螢幕的程式，否則拿去捲 pane 歷史（ISSUE-160）。
process.stdout.write(ENTER_ALT_SCREEN);
process.on("exit", () => process.stdout.write(LEAVE_ALT_SCREEN));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
const timer = setInterval(() => {
  if (editing) return;
  reload();
  render();
}, 3000);
/** 送出 o／x 請求；等待期間 control.pending 擋下其他按鍵，q／Ctrl-C 仍會直接離開。 */
function sendControl(command: Parameters<typeof sendMachineControl>[0]): void {
  void sendMachineControl(command).then((response) => {
    const result = machineControlResult(
      command.machineId,
      response,
      Date.now(),
    );
    control = result.ui;
    message = result.message;
    applyStatusOverride(statusOverrides, command.machineId, result.override);
    reloadMachines();
    render();
  });
}

process.stdin.on("data", (key: string) => {
  if (editing) return;
  const decision = machineControlKey(
    control,
    key,
    view,
    machines[machineCursor]?.id,
  );
  control = decision.ui;
  const outcome = decision.outcome;
  // quit 與 pass 交給下面既有的處理（q／Ctrl-C 在那裡離開）。
  if (outcome.kind === "ignore") return;
  if (outcome.kind === "message" || outcome.kind === "send") {
    message = outcome.message;
    render();
    if (outcome.kind === "send") sendControl(outcome.command);
    return;
  }
  message = "";
  if (key === "q" || key === "\x03") {
    clearInterval(timer);
    process.exit(0);
  }
  if (viewKeyAction(key)) {
    view = key === "m" ? "machines" : key === "c" ? "cards" : toggleView(view);
    reloadMachines();
    render();
    return;
  }
  const action = boardKeyAction(key);
  if (view === "machines") {
    if (action)
      machineCursor = moveCursor(
        action,
        machineCursor,
        machines.length,
        // 翻頁一頁的列數與畫面實際能顯示的列數共用同一個計算（review round 5，F8）。
        Math.max(
          1,
          machineRoom(
            { error: machineError, message: "" },
            process.stdout.rows || 24,
          ),
        ),
      );
    else if (["e", "\r", "\n"].includes(key)) editMachine();
    else if (["n", "r"].includes(key))
      message = "Machine 檢視不支援新增或設為 ready";
    reloadMachines();
    render();
    return;
  }
  if (action)
    cursor = moveCursor(
      action,
      cursor,
      rows.length,
      Math.max(
        1,
        cardRoom({ rows, cursor, errors }, process.stdout.rows || 24),
      ),
    );
  else if (key === "e" || key === "\r") editSelected();
  else if (key === "n") newCard();
  else if (key === "r") readySelected();
  reload();
  render();
});
render();
