import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import {
  applyEdit,
  createDraft,
  markReady,
  newCardTemplate,
  parseEditorText,
  toEditorText,
} from "../src/card-board.js";
import { eligibleAutopickProject } from "../src/autopick.js";

function setup(): CardStore {
  return new CardStore(fs.mkdtempSync(path.join(os.tmpdir(), "board-proj-")));
}

const edit = {
  title: "新卡",
  notify: "discord:1",
  project: "local:my-repo",
  human: "\n## 描述\n\n字\n\n",
};

test("新增卡帶 project，才符合自動撿卡的專案條件", () => {
  const store = setup();
  assert.ok(createDraft(store, "with-project", edit, "2026-11-16").ok);
  assert.ok(
    createDraft(
      store,
      "no-project",
      { ...edit, project: undefined },
      "2026-11-16",
    ).ok,
  );
  const withProject = store.read("REQ-20261116-with-project");
  const without = store.read("REQ-20261116-no-project");
  assert.ok(withProject.ok && without.ok);
  assert.equal(withProject.card.project, "local:my-repo");
  assert.equal(without.card.project, undefined);
  const policy = {
    default: "L0",
    projects: { "local:my-repo": "L2" },
    autopick: { "local:my-repo": "/repo" },
  } as const;
  const ready = (card: typeof withProject.card) => ({
    ...card,
    status: "ready",
  });
  assert.ok(eligibleAutopickProject(policy as never, ready(withProject.card)));
  assert.equal(
    eligibleAutopickProject(policy as never, ready(without.card)),
    undefined,
  );
});

test("編輯範本有 project 行，可預設帶入", () => {
  assert.match(newCardTemplate("local:my-repo"), /^project: local:my-repo$/m);
  assert.match(newCardTemplate(), /^project: $/m);
});

test("parseEditorText：project 格式錯誤拒絕，空白視為沒有", () => {
  const bad = parseEditorText("title: x\nnotify: \nproject: no-colon\n---\nb");
  assert.equal(bad.ok, false);
  const blank = parseEditorText("title: x\nnotify: \nproject: \n---\nb");
  assert.ok(blank.ok);
  assert.equal(blank.edit.project, undefined);
  const good = parseEditorText(
    "title: x\nnotify: \nproject: local:my-repo\n---\nb",
  );
  assert.ok(good.ok);
  assert.equal(good.edit.project, "local:my-repo");
});

test("編輯：補上 project 並可往返；清空則移除", () => {
  const store = setup();
  assert.ok(
    createDraft(
      store,
      "round-trip",
      { ...edit, project: undefined },
      "2026-11-16",
    ).ok,
  );
  const id = "REQ-20261116-round-trip";
  const before = store.read(id);
  assert.ok(before.ok);
  const parsed = parseEditorText(
    toEditorText(before.card).replace("project: ", "project: local:my-repo"),
  );
  assert.ok(parsed.ok);
  assert.equal(applyEdit(store, id, parsed.edit, "2026-11-16").ok, true);
  const after = store.read(id);
  assert.ok(after.ok);
  assert.equal(after.card.project, "local:my-repo");
  const cleared = parseEditorText(
    toEditorText(after.card).replace("local:my-repo", ""),
  );
  assert.ok(cleared.ok);
  assert.equal(applyEdit(store, id, cleared.edit, "2026-11-16").ok, true);
  const last = store.read(id);
  assert.ok(last.ok);
  assert.equal(last.card.project, undefined);
});

test("放行：沒有 project 仍可放行但附警告，有 project 沒警告", () => {
  const store = setup();
  createDraft(store, "warn", { ...edit, project: undefined }, "2026-11-16");
  const warned = markReady(store, "REQ-20261116-warn", "2026-11-16");
  assert.ok(warned.ok);
  assert.match(warned.warning ?? "", /project/);
  createDraft(store, "fine", edit, "2026-11-16");
  assert.deepEqual(markReady(store, "REQ-20261116-fine", "2026-11-16"), {
    ok: true,
  });
});
