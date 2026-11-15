import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth, truncateToWidth } from "../src/card-board.js";
import { ensureCardBoardPane } from "../src/card-board-open.js";

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

test("同 workspace 已有看板就不重複開", async () => {
  const calls: string[][] = [];
  const result = await ensureCardBoardPane(
    fakeHerdr(
      [{ pane_id: "w9:p5", workspace_id: "w9", label: "Card board" }],
      calls,
    ),
    { HERDR_WORKSPACE_ID: "w9" },
  );
  assert.match(result, /已開啟/);
  assert.equal(
    calls.some((c) => c[0] === "plugin"),
    false,
  );
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
