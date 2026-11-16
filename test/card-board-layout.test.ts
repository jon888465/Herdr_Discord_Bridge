import assert from "node:assert/strict";
import test from "node:test";
import {
  cardRoom,
  cardViewLines,
  listRoom,
  machineRoom,
  machineViewLines,
} from "../src/card-board-machines.js";
import {
  displayWidth,
  moveCursor,
  visibleRows,
  type BoardRow,
} from "../src/card-board.js";

const machine = { id: "remote", ssh: "user@host", socket: "/tmp/herdr.sock" };

function cardRows(count: number): BoardRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `REQ-20261116-card${i}`,
    title: `卡片 ${i}`,
    status: i % 2 ? "draft" : "in_progress",
    editability:
      i % 2
        ? { editable: true, kind: "draft", canMarkReady: true }
        : { editable: false, reason: "執行中，唯讀" },
  }));
}

// 去掉 SGR 控制碼後的顯示寬度。
const visibleWidth = (line: string): number =>
  // eslint-disable-next-line no-control-regex
  displayWidth(line.replace(/\x1b\[[0-9;]*m/g, ""));

const HEIGHTS = [1, 2, 3, 4, 5, 6, 8, 10, 24, 40];
const WIDTHS = [10, 20, 30, 80];

test("Card 檢視在各種寬高、錯誤與訊息組合下列數與寬度都不超出（F7）", () => {
  for (const height of HEIGHTS)
    for (const width of WIDTHS)
      for (const errors of [0, 3])
        for (const message of [
          "",
          "已新增 REQ-20261116-some-card-title（draft）",
        ])
          for (const count of [0, 1, 5, 25])
            for (const cursor of [0, count - 1]) {
              const lines = cardViewLines(
                {
                  rows: cardRows(count),
                  cursor: Math.max(0, cursor),
                  errors,
                  message,
                },
                width,
                height,
              );
              const label = `h${height} w${width} e${errors} m${message ? 1 : 0} n${count} c${cursor}`;
              assert.ok(lines.length <= height, `${label}: ${lines.length} 列`);
              assert.ok(lines.length >= 1, label);
              for (const line of lines)
                assert.ok(
                  visibleWidth(line) <= width - 1,
                  `${label}: ${JSON.stringify(line)}`,
                );
            }
});

test("review 的 F7 重現案例：30 欄 24 列、至少 19 張卡且有讀檔錯誤，不超過 24 列", () => {
  const lines = cardViewLines(
    { rows: cardRows(25), cursor: 0, errors: 2, message: "" },
    30,
    24,
  );
  assert.ok(lines.length <= 24, `${lines.length} 列`);
  assert.ok(lines[lines.length - 1]!.includes("Tab/m/c"));
});

test("Machine 檢視在各種寬高、錯誤與訊息組合下列數與寬度都不超出", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...machine,
    id: `remote${i}`,
  }));
  for (const height of HEIGHTS)
    for (const width of WIDTHS)
      for (const error of ["", "machines 設定格式不對"])
        for (const message of ["", "Machine 檢視唯讀，第一階段不支援編輯"])
          for (const machines of [[], [machine], many])
            for (const cursor of [0, machines.length - 1]) {
              const lines = machineViewLines(
                {
                  machines,
                  statuses: new Map([
                    ["remote", "connected"],
                    ["remote0", "unreachable"],
                  ]),
                  cursor: Math.max(0, cursor),
                  error,
                  message,
                },
                width,
                height,
              );
              const label = `h${height} w${width} e${error ? 1 : 0} m${message ? 1 : 0} n${machines.length}`;
              assert.ok(lines.length <= height, `${label}: ${lines.length} 列`);
              for (const line of lines)
                assert.ok(
                  visibleWidth(line) <= width - 1,
                  `${label}: ${JSON.stringify(line)}`,
                );
              assert.ok(
                lines[lines.length - 1]!.startsWith("Tab/m/c") || height < 2,
                label,
              );
            }
});

test("翻頁一頁的列數等於畫面實際顯示的列數（F8）", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...machine,
    id: `remote${i}`,
  }));
  for (const height of [4, 5, 6, 8, 12, 24]) {
    const room = machineRoom({ error: "", message: "" }, height);
    const lines = machineViewLines(
      { machines: many, cursor: 0, error: "", message: "" },
      100,
      height,
    );
    // 標題與提示之外的列就是清單；一頁就是清單的列數。
    const shown = Math.max(0, lines.length - 2);
    assert.equal(shown, Math.min(room, many.length), `height ${height}`);
    if (room >= 1)
      assert.equal(
        moveCursor("pageDown", 0, many.length, Math.max(1, room)),
        Math.min(many.length - 1, Math.max(1, room)),
        `height ${height}`,
      );
  }
  // review 的重現案例：高度 4 實際顯示 2 台，PageDown 也只移動 2 台。
  assert.equal(machineRoom({ error: "", message: "" }, 4), 2);
  assert.equal(
    moveCursor(
      "pageDown",
      0,
      5,
      Math.max(1, machineRoom({ error: "", message: "" }, 4)),
    ),
    2,
  );
});

test("Card 檢視翻頁與畫面共用同一個容量計算", () => {
  for (const height of [4, 5, 6, 8, 12, 24]) {
    for (const errors of [0, 2]) {
      const state = { rows: cardRows(30), cursor: 0, errors };
      const room = cardRoom(state, height);
      const lines = cardViewLines({ ...state, message: "" }, 100, height);
      // 標題、（錯誤）、選取 id 與提示之外的列就是清單。
      const fixed = 3 + (errors ? 1 : 0);
      assert.equal(
        Math.max(0, lines.length - fixed),
        Math.min(room, 30),
        `height ${height} errors ${errors}`,
      );
    }
  }
});

test("一般終端尺寸不受影響：24 列時清單仍是 visibleRows，兩個檢視一致", () => {
  assert.equal(listRoom(24, 4), visibleRows(24));
  assert.equal(listRoom(24, 2), visibleRows(24));
  assert.equal(cardRoom({ rows: cardRows(30), cursor: 0, errors: 1 }, 24), 19);
  assert.equal(machineRoom({ error: "", message: "" }, 24), 19);
  // 高度不夠時才縮小，且不會是負數。
  assert.equal(listRoom(3, 4), 0);
  assert.equal(listRoom(1, 2), 0);
});
