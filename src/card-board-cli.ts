#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDirectory, stateDirectory } from "./config.js";
import { LEDGER_MAX_FILE_BYTES } from "./card.js";
import { CardStore } from "./card-store.js";
import { ensureCardsDirectory } from "./card-directory.js";
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
  cardRoom,
  cardViewLines,
  machineRoom,
  machineViewLines,
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
import type { MachineConfig } from "./machines.js";

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
          statuses,
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
function editText(initial: string): string | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-card-board-"));
  const file = path.join(dir, "card.md");
  fs.writeFileSync(file, initial, { mode: 0o600 });
  editing = true;
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
process.stdin.on("data", (key: string) => {
  if (editing) return;
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
    else if (["e", "\r", "\n", "n", "r"].includes(key))
      message = "Machine 檢視唯讀，本階段不支援編輯";
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
