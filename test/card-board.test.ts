import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import {
  applyEdit,
  boardRows,
  createDraft,
  editability,
  markReady,
  parseEditorText,
  splitBody,
  toEditorText,
} from "../src/card-board.js";

function setup(): { store: CardStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-board-"));
  return { store: new CardStore(dir), dir };
}

function put(
  dir: string,
  id: string,
  status: string,
  extra = "",
  body = "\n# 標題\n\n## 描述\n\n原文\n",
): void {
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nid: ${id}\ntype: requirement\nstatus: ${status}\ntitle: 標題\nversion: 1\ncreated: 2026-11-01\nupdated: 2026-11-01\n${extra}---\n${body}`,
  );
}

const ID = "REQ-20261101-board";
const LOG =
  "\n## 流程紀錄\n\n- 2026-11-13T07:23:44Z | started | 開始 | ev:one\n";

test("editability：draft 類可編輯可放行，排隊與執行中唯讀", () => {
  for (const status of ["draft", "discussing", "refined", "recorded"])
    assert.deepEqual(editability({ status }, undefined), {
      editable: true,
      kind: "draft",
      canMarkReady: true,
    });
  for (const status of ["ready", "in_progress", "done", "cancelled"])
    assert.equal(editability({ status }, "started").editable, false);
});

test("editability：停手的 ready／in_progress 可改文字但不能放行", () => {
  for (const status of ["ready", "in_progress"])
    for (const event of ["failed", "autopick_stopped", "loop_stopped"])
      assert.deepEqual(editability({ status }, event), {
        editable: true,
        kind: "stopped",
        canMarkReady: false,
      });
  assert.equal(editability({ status: "done" }, "failed").editable, false);
});

test("splitBody：流程紀錄以後歸 bridge", () => {
  const { human, bridge } = splitBody(`\n# t\n\n文字\n${LOG}\n## 異動專案\n`);
  assert.equal(human, "\n# t\n\n文字\n\n");
  assert.ok(
    bridge.startsWith("\n## 流程紀錄") || bridge.startsWith("## 流程紀錄"),
  );
  assert.ok(bridge.includes("## 異動專案"));
});

test("編輯 draft：改標題與正文，流程紀錄原封不動", () => {
  const { store, dir } = setup();
  put(dir, ID, "draft", "", `\n# 標題\n\n## 描述\n\n原文\n${LOG}`);
  const card = store.read(ID);
  assert.ok(card.ok);
  const parsed = parseEditorText(
    toEditorText(card.card)
      .replace("title: 標題", "title: 新標題")
      .replace("原文", "新文"),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(applyEdit(store, ID, parsed.edit, "2026-11-14"), {
    ok: true,
  });
  const after = store.read(ID);
  assert.ok(after.ok);
  assert.equal(after.card.title, "新標題");
  assert.ok(after.card.body.includes("新文"));
  assert.ok(after.card.body.includes("| started | 開始 | ev:one"));
  assert.equal(after.card.updated, "2026-11-14");
});

test("唯讀的卡：編輯與放行都拒絕且檔案不變", () => {
  const { store, dir } = setup();
  put(dir, ID, "in_progress", "", `\n# 標題\n${LOG}`);
  const before = fs.readFileSync(path.join(dir, `${ID}.md`), "utf8");
  const edit = { title: "改", human: "\n新\n\n" };
  assert.equal(applyEdit(store, ID, edit, "2026-11-14").ok, false);
  assert.equal(markReady(store, ID, "2026-11-14").ok, false);
  assert.equal(fs.readFileSync(path.join(dir, `${ID}.md`), "utf8"), before);
});

test("停手的卡：可改文字，不能放行", () => {
  const { store, dir } = setup();
  put(dir, ID, "ready", "", `\n# 標題\n${LOG}`);
  const appended = store.recordEvent(ID, {
    event: "failed",
    code: "autopick_stopped",
    reason: "x",
    time: "2026-11-13T08:00:00Z",
    eventId: "ev-stop-1",
  });
  assert.ok(appended.ok, JSON.stringify(appended));
  assert.deepEqual(
    applyEdit(store, ID, { title: "修過", human: "\n補充\n\n" }, "2026-11-14"),
    { ok: true },
  );
  const result = markReady(store, ID, "2026-11-14");
  assert.equal(result.ok, false);
});

test("放行：沒有 notify 拒絕，有 notify 才變 ready", () => {
  const { store, dir } = setup();
  put(dir, ID, "draft");
  const refused = markReady(store, ID, "2026-11-14");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /notify/);
  put(dir, "REQ-20261101-noted", "refined", "notify: discord:123\n");
  assert.deepEqual(markReady(store, "REQ-20261101-noted", "2026-11-14"), {
    ok: true,
  });
  const read = store.read("REQ-20261101-noted");
  assert.ok(read.ok);
  assert.equal(read.card.status, "ready");
});

test("新增 draft：id 帶日期與 slug，已存在不覆蓋", () => {
  const { store } = setup();
  const edit = {
    title: "新卡",
    notify: "discord:1",
    human: "\n## 描述\n\n字\n\n",
  };
  const made = createDraft(store, "new-card", edit, "2026-11-14");
  assert.deepEqual(made, { ok: true, id: "REQ-20261114-new-card" });
  assert.equal(createDraft(store, "new-card", edit, "2026-11-14").ok, false);
  assert.equal(createDraft(store, "Bad Slug", edit, "2026-11-14").ok, false);
  const rows = boardRows(store).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "draft");
});

test("parseEditorText：缺分隔線或空標題拒絕", () => {
  assert.equal(parseEditorText("title: x\nnotify: \n").ok, false);
  assert.equal(parseEditorText("title: \nnotify: \n---\nbody").ok, false);
});
