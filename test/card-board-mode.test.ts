import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import {
  applyEdit,
  createDraft,
  newCardTemplate,
  parseEditorText,
  toEditorText,
} from "../src/card-board.js";

function setup(): CardStore {
  return new CardStore(fs.mkdtempSync(path.join(os.tmpdir(), "board-mode-")));
}

const edit = {
  title: "新卡",
  notify: "discord:1",
  project: "local:my-repo",
  human: "\n## 描述\n\n字\n\n",
};

test("新增範本有 mode 行，預設留空", () => {
  assert.match(newCardTemplate("local:x"), /\nmode: \n---\n/);
});

test("mode 只接受留空或 readonly，其他值拒絕", () => {
  const text = (mode: string) =>
    `title: t\nnotify: \nproject: \nmode: ${mode}\n---\n\n字\n`;
  const empty = parseEditorText(text(""));
  assert.ok(empty.ok);
  assert.equal(empty.edit.mode, undefined);
  const readonly = parseEditorText(text("readonly"));
  assert.ok(readonly.ok);
  assert.equal(readonly.edit.mode, "readonly");
  const bad = parseEditorText(text("write"));
  assert.equal(bad.ok, false);
});

test("新增帶 mode: readonly 的卡，編輯可清除，再補回", () => {
  const store = setup();
  assert.ok(
    createDraft(store, "ro", { ...edit, mode: "readonly" }, "2026-11-16").ok,
  );
  const id = "REQ-20261116-ro";
  const made = store.read(id);
  assert.ok(made.ok);
  assert.equal(made.card.mode, "readonly");
  assert.match(toEditorText(made.card), /\nmode: readonly\n---\n/);

  const cleared = parseEditorText(
    toEditorText(made.card).replace("mode: readonly", "mode: "),
  );
  assert.ok(cleared.ok);
  assert.equal(applyEdit(store, id, cleared.edit, "2026-11-16").ok, true);
  const after = store.read(id);
  assert.ok(after.ok);
  assert.equal(after.card.mode, undefined);

  const restored = parseEditorText(
    toEditorText(after.card).replace("mode: ", "mode: readonly"),
  );
  assert.ok(restored.ok);
  assert.equal(applyEdit(store, id, restored.edit, "2026-11-16").ok, true);
  const last = store.read(id);
  assert.ok(last.ok);
  assert.equal(last.card.mode, "readonly");
});

test("沒填 mode 的卡不會多出 mode 欄位", () => {
  const store = setup();
  assert.ok(createDraft(store, "plain", edit, "2026-11-16").ok);
  const read = store.read("REQ-20261116-plain");
  assert.ok(read.ok);
  assert.equal(read.card.mode, undefined);
});
