import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import { applyEdit, createDraft, newCardTemplate, parseEditorText, toEditorText } from "../src/card-board.js";
import { clampScroll, detailLines, detailRoom, cardFullText, scrollBy, wrapText } from "../src/card-board-detail.js";
import { displayWidth } from "../src/card-board.js";

const TODAY = "2026-11-27";

function makeStore(): CardStore {
  return new CardStore(fs.mkdtempSync(path.join(os.tmpdir(), "board-detail-")));
}

function draft(store: CardStore, extra = ""): string {
  const parsed = parseEditorText(`title: 測試卡\nnotify: \nproject: \nlead: \nroles: \nmode: \n---\n\n## 描述\n\n內容${extra}\n`);
  assert.ok(parsed.ok);
  const made = createDraft(store, "view-test", parsed.edit, TODAY);
  assert.ok(made.ok && made.id);
  return made.id;
}

test("檢視全文含 frontmatter 所有欄位、描述與流程紀錄", () => {
  const store = makeStore();
  const id = draft(store);
  const read = store.read(id);
  assert.ok(read.ok);
  const card = { ...read.card, notify: "discord:1", body: `${read.card.body}\n## 流程紀錄\n\n- 2026-11-27 ready\n` };
  const text = cardFullText(card);
  for (const needle of ["id: ", "status: ", "notify: ", "## 描述", "內容", "## 流程紀錄", "- 2026-11-27 ready"])
    assert.ok(text.includes(needle), needle);
});

test("wrapText：依顯示寬度折行、保留空行、控制字元換成 U+FFFD 而不吃掉換行", () => {
  const lines = wrapText("一二三四五六\n\nab\x1b[31mcd", 6);
  assert.deepEqual(lines, ["一二三", "四五六", "", "ab�[31", "mcd"]);
  for (const line of wrapText("很長的一行".repeat(30), 10)) assert.ok(displayWidth(line) <= 10);
  assert.deepEqual(wrapText("", 10), [""]);
});

test("捲動：夾在範圍內、翻頁一頁、Home／End", () => {
  assert.equal(clampScroll(99, 10, 4), 6);
  assert.equal(clampScroll(-3, 10, 4), 0);
  assert.equal(clampScroll(5, 3, 4), 0, "內容比一頁短不捲動");
  assert.equal(scrollBy("down", 0, 10, 4), 1);
  assert.equal(scrollBy("pageDown", 0, 10, 4), 4);
  assert.equal(scrollBy("pageDown", 5, 10, 4), 6);
  assert.equal(scrollBy("up", 0, 10, 4), 0);
  assert.equal(scrollBy("end", 0, 10, 4), 6);
  assert.equal(scrollBy("home", 6, 10, 4), 0);
});

test("detailLines：總列數不超過終端機高度、每列不超過寬度、矮窄終端機也不亂版", () => {
  const lines = wrapText(Array.from({ length: 200 }, (_, i) => `第 ${i} 行 ${"字".repeat(40)}`).join("\n"), 30);
  for (const [width, height] of [[40, 10], [20, 3], [80, 24], [5, 1]] as const) {
    const out = detailLines({ id: "REQ-1", title: "標題", editable: false, lines, scroll: 9999, message: "" }, width, height);
    assert.ok(out.length <= Math.max(3, height), `${width}x${height}`);
    assert.ok(out.length >= 2);
  }
  const page = detailLines({ id: "REQ-1", title: "T", editable: true, lines, scroll: 0, message: "" }, 80, 12);
  assert.equal(page.length, 12);
  assert.equal(detailRoom(12), 10);
  assert.match(page[0]!, /唯讀檢視/);
  assert.match(page[11]!, /Esc 返回/);
  assert.match(page[11]!, new RegExp(`1-10/${lines.length}`));
  const withMessage = detailLines({ id: "REQ-1", title: "T", editable: false, lines, scroll: 0, message: "不能編輯：done，唯讀" }, 80, 12);
  assert.match(withMessage[11]!, /不能編輯/);
});

test("編輯器文字含 lead 與 roles；新卡範本有這兩行；舊的欄位位置不變", () => {
  assert.match(newCardTemplate("local:x"), /\nproject: local:x\nlead: \nroles: \nmode: \n---\n/);
  const store = makeStore();
  const id = draft(store);
  const read = store.read(id);
  assert.ok(read.ok);
  assert.match(toEditorText(read.card), /^title: 測試卡\nnotify: \nproject: \nlead: \nroles: \nmode: \n---\n/);
});

test("e 編輯可以改 lead 與 roles：寫入、再讀回、清空會移除；不合法就拒絕且不寫入", () => {
  const store = makeStore();
  const id = draft(store);
  const before = store.read(id);
  assert.ok(before.ok);
  const text = toEditorText(before.card)
    .replace("lead: ", "lead: remote-b:agy:neon:medium")
    .replace("roles: ", "roles: reviewer=remote-a:codex:GPT-6.2-Astra:medium, verify=remote-a:pi");
  const parsed = parseEditorText(text);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.edit.roles, {
    reviewer: { machine: "remote-a", agent: "codex", model: "GPT-6.2-Astra", level: "medium" },
    verify: { machine: "remote-a", agent: "pi" },
  });
  assert.deepEqual(parsed.edit.lead, { kind: "agy", spec: { machine: "remote-b", agent: "agy", model: "neon", effort: "medium" } });
  assert.deepEqual(applyEdit(store, id, parsed.edit, TODAY), { ok: true });
  const after = store.read(id);
  assert.ok(after.ok);
  assert.equal(after.card.lead, "agy");
  assert.equal(after.card.leadSpec?.effort, "medium");
  assert.equal(after.card.roles?.verify?.agent, "pi");
  // 讀回來的編輯器文字可原樣再解析（round trip）。
  const again = parseEditorText(toEditorText(after.card));
  assert.ok(again.ok);
  assert.deepEqual(again.edit.roles, parsed.edit.roles);
  assert.deepEqual(again.edit.lead, parsed.edit.lead);

  // 只寫 agent 種類：不留舊的 leadSpec。
  const kindOnly = parseEditorText(toEditorText(after.card).replace(/^lead: .*$/m, "lead: codex"));
  assert.ok(kindOnly.ok);
  assert.ok(applyEdit(store, id, kindOnly.edit, TODAY).ok);
  const kindRead = store.read(id);
  assert.ok(kindRead.ok);
  assert.equal(kindRead.card.lead, "codex");
  assert.equal(kindRead.card.leadSpec, undefined);

  // 清空：移除 lead 與 roles。
  const cleared = parseEditorText(toEditorText(kindRead.card).replace(/^lead: .*$/m, "lead: ").replace(/^roles: .*$/m, "roles: "));
  assert.ok(cleared.ok);
  assert.ok(applyEdit(store, id, cleared.edit, TODAY).ok);
  const clearedRead = store.read(id);
  assert.ok(clearedRead.ok);
  assert.equal(clearedRead.card.lead, undefined);
  assert.equal(clearedRead.card.roles, undefined);

  for (const bad of ["lead: gpt", "roles: boss=a:claude", "roles: reviewer", "roles: reviewer=a:claude, reviewer=b:codex", "roles: reviewer=a:nope"]) {
    const result = parseEditorText(toEditorText(clearedRead.card).replace(new RegExp(`^${bad.split(":")[0]}: .*$`, "m"), bad));
    assert.equal(result.ok, false, bad);
  }
});

test("不能編輯的卡（done）套用編輯仍被擋下，lead／roles 也不例外", () => {
  const store = makeStore();
  const id = draft(store);
  const read = store.read(id);
  assert.ok(read.ok);
  assert.ok(store.update(id, read.hash, (card) => ({ ...card, status: "done" })).ok);
  const parsed = parseEditorText(toEditorText(read.card).replace("roles: ", "roles: verify=remote-a:pi"));
  assert.ok(parsed.ok);
  const result = applyEdit(store, id, parsed.edit, TODAY);
  assert.equal(result.ok, false);
  const after = store.read(id);
  assert.ok(after.ok);
  assert.equal(after.card.roles, undefined);
});
