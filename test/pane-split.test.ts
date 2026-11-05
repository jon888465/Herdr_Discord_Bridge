import test from "node:test";
import assert from "node:assert/strict";
import { chooseSplitTarget, directionFor } from "../src/pane-split.js";
import { openReviewerPane } from "../src/review-pane.js";
import type { AgentStartPort } from "../src/agent-start.js";

const pane = (id: string, width: number, height: number) => ({
  pane_id: id,
  rect: { width, height },
});

test("the split thresholds are unchanged: wide panes go right (>= 80 cols), others go down (>= 16 rows), smaller ones are refused", () => {
  assert.equal(directionFor({ width: 200, height: 40 }), "right");
  assert.equal(directionFor({ width: 100, height: 40 }), "down");
  assert.equal(directionFor({ width: 81, height: 29 }), "down");
  assert.equal(directionFor({ width: 81, height: 13 }), undefined);
  assert.equal(directionFor({ width: 60, height: 10 }), undefined);
});

// ISSUE-094：profile Worker 一路從 Lead 的 pane 分割出去，Lead 的 pane 只剩 6 列，reviewer 分割不出來。
test("a base pane that is big enough is used as before", () => {
  assert.deepEqual(
    chooseSplitTarget([pane("p1", 162, 31), pane("p2", 81, 29)], "p1"),
    { paneId: "p1", direction: "right", fellBack: false },
  );
});

test("a base pane that was cut down too small falls back to the largest pane that can still be split", () => {
  const panes = [
    pane("p1", 81, 6), // Lead：被切到只剩 6 列
    pane("p2", 81, 29),
    pane("p3", 81, 13),
    pane("p4", 81, 6),
  ];
  assert.deepEqual(chooseSplitTarget(panes, "p1"), {
    paneId: "p2",
    direction: "down",
    fellBack: true,
  });
});

test("when no pane in the layout is big enough, or the base is not in the layout, nothing is chosen", () => {
  assert.equal(
    chooseSplitTarget([pane("p1", 81, 6), pane("p2", 81, 13)], "p1"),
    undefined,
  );
  assert.equal(chooseSplitTarget([pane("p2", 200, 40)], "p1"), undefined);
});

function layoutPort(panes: ReturnType<typeof pane>[]) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const port: AgentStartPort = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "pane.layout") return { layout: { panes } };
      if (method === "pane.split")
        return {
          pane: { pane_id: "w5:p9", workspace_id: "w5", terminal_id: "term_new" },
        };
      throw new Error(`unexpected ${method}`);
    },
    listAgentsWithWorkspaceNames: async () => [],
  };
  return { port, calls };
}

test("a reviewer pane is opened from another pane when the author's pane is too small", async () => {
  const { port, calls } = layoutPort([
    pane("w5:p1", 81, 6),
    pane("w5:p2", 81, 29),
  ]);
  const opened = await openReviewerPane(port, {
    basePaneId: "w5:p1",
    workspaceId: "w5",
    cwd: "/x",
  });
  assert.deepEqual(opened, { paneId: "w5:p9", terminalId: "term_new" });
  const split = calls.find((call) => call.method === "pane.split");
  assert.equal(split?.params?.target_pane_id, "w5:p2");
  assert.equal(split?.params?.direction, "down");
  assert.equal(split?.params?.workspace_id, "w5");
});

test("a reviewer pane is still refused, with nothing created, when no pane is big enough", async () => {
  const { port, calls } = layoutPort([
    pane("w5:p1", 81, 6),
    pane("w5:p2", 81, 12),
  ]);
  await assert.rejects(
    openReviewerPane(port, { basePaneId: "w5:p1", workspaceId: "w5", cwd: "/x" }),
    /too small|太小/,
  );
  assert.equal(calls.some((call) => call.method === "pane.split"), false);
});
