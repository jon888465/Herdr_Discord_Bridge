#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDirectory } from "./config.js";
import { LEDGER_MAX_FILE_BYTES } from "./card.js";
import { CardStore } from "./card-store.js";
import { ensureCardsDirectory } from "./card-directory.js";
import {
  applyEdit,
  boardRows,
  createDraft,
  markReady,
  newCardTemplate,
  parseEditorText,
  toEditorText,
  type BoardRow,
} from "./card-board.js";

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

function reload(): void {
  const board = boardRows(store);
  rows = board.rows;
  errors = board.errors;
  cursor = Math.min(cursor, Math.max(0, rows.length - 1));
}

function mark(row: BoardRow): string {
  if (!row.editability.editable) return "🔒";
  return row.editability.kind === "draft" ? "✎ " : "↺ ";
}

function render(): void {
  if (editing) return;
  const height = process.stdout.rows || 24;
  const width = process.stdout.columns || 80;
  const out = [`\x1b[2J\x1b[H\x1b[1mCard 看板\x1b[0m  (${rows.length})`];
  if (errors)
    out.push(`\x1b[33m${errors} 個檔案讀不到，請用 herdr-card-check\x1b[0m`);
  const room = Math.max(3, height - 5);
  const first = Math.max(
    0,
    Math.min(cursor - Math.floor(room / 2), rows.length - room),
  );
  for (let i = first; i < Math.min(rows.length, first + room); i++) {
    const row = rows[i]!;
    const line =
      `${i === cursor ? ">" : " "} ${mark(row)} ${row.status.padEnd(11)} ${row.title}`.slice(
        0,
        width - 1,
      );
    out.push(i === cursor ? `\x1b[7m${line}\x1b[0m` : line);
  }
  const selected = rows[cursor];
  if (selected)
    out.push(
      `\x1b[2m${selected.id}${selected.editability.editable ? "" : `：${selected.editability.reason}`}\x1b[0m`,
    );
  out.push(
    message || "\x1b[2mj/k 移動  e 編輯  n 新增  r 設為 ready  q 離開\x1b[0m",
  );
  process.stdout.write(out.join("\n"));
}

/** 離開 raw mode 開 $EDITOR，結束後回來；沒改或編輯器失敗回傳 undefined。 */
function editText(initial: string): string | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-card-board-"));
  const file = path.join(dir, "card.md");
  fs.writeFileSync(file, initial, { mode: 0o600 });
  editing = true;
  process.stdin.setRawMode(false);
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
  const text = editText(newCardTemplate());
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
  message = result.ok ? `${row.id} 已設為 ready` : `未放行：${result.error}`;
}

reload();
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
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  } else if (key === "j" || key === "\x1b[B")
    cursor = Math.min(rows.length - 1, cursor + 1);
  else if (key === "k" || key === "\x1b[A") cursor = Math.max(0, cursor - 1);
  else if (key === "e" || key === "\r") editSelected();
  else if (key === "n") newCard();
  else if (key === "r") readySelected();
  reload();
  render();
});
render();
