import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { displayWidth, truncateToWidth } from "../src/card-board.js";
import {
  boardEditingMarker,
  ensureCardBoardPane,
  isBoardEditing,
} from "../src/card-board-open.js";

function fakeHerdr(panes: object[], calls: string[][]) {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "get")
      return JSON.stringify({
        result: { pane: { pane_id: args[2], workspace_id: "w9" } },
      });
    if (args[0] === "pane" && args[1] === "list")
      return JSON.stringify({ result: { panes } });
    return "{}";
  };
}

test("沒有看板就在 bridge 的 workspace 另開 tab，不搶焦點", async () => {
  const calls: string[][] = [];
  const result = await ensureCardBoardPane(fakeHerdr([], calls), {
    HERDR_PANE_ID: "w9:p1",
  });
  assert.match(result, /另開 tab/);
  const open = calls.find((c) => c[0] === "plugin");
  assert.ok(open);
  assert.deepEqual(
    open.slice(open.indexOf("--placement"), open.indexOf("--placement") + 2),
    ["--placement", "tab"],
  );
  assert.equal(open[open.indexOf("--workspace") + 1], "w9");
  assert.ok(open.includes("--no-focus"));
});

test("同 workspace 已有舊看板：先關掉舊的，再開新的（舊看板跑的是重啟前的程式）", async () => {
  const calls: string[][] = [];
  const result = await ensureCardBoardPane(
    fakeHerdr(
      [{ pane_id: "w9:p5", workspace_id: "w9", label: "Card board" }],
      calls,
    ),
    { HERDR_WORKSPACE_ID: "w9" },
  );
  assert.match(result, /換成新的/);
  const close = calls.findIndex((c) => c[0] === "pane" && c[1] === "close");
  const open = calls.findIndex((c) => c[0] === "plugin");
  assert.deepEqual(calls[close], ["pane", "close", "w9:p5"]);
  assert.ok(close >= 0 && open > close, "要先關舊的再開新的");
});

test("同 workspace 有多個舊看板：全部關掉，只開一個新的", async () => {
  const calls: string[][] = [];
  await ensureCardBoardPane(
    fakeHerdr(
      [
        { pane_id: "w9:p5", workspace_id: "w9", label: "Card board" },
        { pane_id: "w9:p6", workspace_id: "w9", label: "Card board" },
        { pane_id: "w9:p7", workspace_id: "w9", label: "Discord bridge" },
      ],
      calls,
    ),
    { HERDR_WORKSPACE_ID: "w9" },
  );
  assert.deepEqual(
    calls.filter((c) => c[1] === "close").map((c) => c[2]),
    ["w9:p5", "w9:p6"],
  );
  assert.equal(calls.filter((c) => c[0] === "plugin").length, 1);
});

test("看板正在編輯卡片：不關也不開，避免丟掉沒存的內容", async () => {
  const calls: string[][] = [];
  const result = await ensureCardBoardPane(
    fakeHerdr(
      [{ pane_id: "w9:p5", workspace_id: "w9", label: "Card board" }],
      calls,
    ),
    { HERDR_WORKSPACE_ID: "w9" },
    { isEditing: () => true },
  );
  assert.match(result, /正在編輯/);
  assert.equal(
    calls.some((c) => c[1] === "close" || c[0] === "plugin"),
    false,
  );
});

test("沒有看板時，就算有編輯標記也照常開新的", async () => {
  const calls: string[][] = [];
  await ensureCardBoardPane(
    fakeHerdr([], calls),
    { HERDR_WORKSPACE_ID: "w9" },
    { isEditing: () => true },
  );
  assert.equal(
    calls.some((c) => c[0] === "plugin"),
    true,
  );
});

test("isBoardEditing：只有標記存在且程序還活著才算編輯中", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-marker-"));
  try {
    const file = boardEditingMarker(dir);
    assert.equal(isBoardEditing(file), false, "沒有標記");
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
    assert.equal(isBoardEditing(file), true, "自己的 pid 還活著");
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 31 - 2 }));
    assert.equal(isBoardEditing(file), false, "程序已不存在（殘留標記）");
    for (const bad of [
      "{",
      "null",
      "[]",
      '{"pid":"1"}',
      '{"pid":0}',
      '{"pid":-5}',
      '{"pid":1.5}',
    ])
      assert.equal(
        (fs.writeFileSync(file, bad), isBoardEditing(file)),
        false,
        bad,
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("別的 workspace 的看板不算，仍會開", async () => {
  const calls: string[][] = [];
  await ensureCardBoardPane(
    fakeHerdr(
      [{ pane_id: "w2:p5", workspace_id: "w2", label: "Card board" }],
      calls,
    ),
    { HERDR_WORKSPACE_ID: "w9" },
  );
  assert.equal(
    calls.some((c) => c[0] === "plugin"),
    true,
  );
});

test("不在 Herdr pane 內就略過，不呼叫 herdr", async () => {
  const calls: string[][] = [];
  const result = await ensureCardBoardPane(fakeHerdr([], calls), {});
  assert.match(result, /略過/);
  assert.equal(calls.length, 0);
});

test("herdr 失敗會丟出錯誤，由呼叫端記錄", async () => {
  await assert.rejects(
    ensureCardBoardPane(
      async () => {
        throw new Error("boom");
      },
      { HERDR_WORKSPACE_ID: "w9" },
    ),
    /boom/,
  );
});

test("displayWidth／truncateToWidth：CJK 與 emoji 算兩格，不切斷字元", () => {
  assert.equal(displayWidth("ab中文"), 6);
  assert.equal(displayWidth("🔒 x"), 4);
  assert.equal(truncateToWidth("abc", 5), "abc");
  const cut = truncateToWidth("中文標題很長", 7);
  assert.ok(displayWidth(cut) <= 7);
  assert.ok(cut.endsWith("…"));
});
