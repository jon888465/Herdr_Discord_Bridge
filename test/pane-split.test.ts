import test from "node:test";
import assert from "node:assert/strict";
import { chooseSplitTarget, directionFor } from "../src/pane-split.js";
import { openReviewerPane } from "../src/review-pane.js";
import type { AgentStartPort } from "../src/agent-start.js";

const pane = (id: string, width: number, height: number) => ({
  pane_id: id,
  rect: { width, height },
});

test("split only when both resulting panes retain the minimum dimensions", () => {
  assert.equal(directionFor({ width: 200, height: 40 }), "right");
  assert.equal(directionFor({ width: 100, height: 40 }), "down");
  assert.equal(directionFor({ width: 81, height: 29 }), undefined);
  assert.equal(directionFor({ width: 81, height: 13 }), undefined);
  assert.equal(directionFor({ width: 60, height: 10 }), undefined);
});

// ISSUE-094：profile Worker 一路從 Lead 的 pane 分割出去，Lead 的 pane 只剩 6 列，reviewer 分割不出來。
test("a base pane that is big enough is used as before", () => {
  assert.deepEqual(
    chooseSplitTarget([pane("p1", 162, 31), pane("p2", 81, 40)], "p1"),
    { paneId: "p1", direction: "right", fellBack: false },
  );
});

test("a base pane that was cut down too small falls back to the largest pane that can still be split", () => {
  const panes = [
    pane("p1", 81, 6), // Lead：被切到只剩 6 列
    pane("p2", 81, 40),
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
          pane: {
            pane_id: "w5:p9",
            workspace_id: "w5",
            terminal_id: "term_new",
          },
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
    pane("w5:p2", 81, 40),
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

// ISSUE-108: a wide but short pane must never be split again.
test("ISSUE-108: splitting preserves usable height and width for both agents", () => {
  for (const rect of [
    { width: 200, height: 8 },
    { width: 81, height: 29 },
    { width: 100, height: 36 },
  ]) {
    assert.equal(directionFor(rect), undefined);
  }
  assert.equal(directionFor({ width: 121, height: 18 }), "right");
  assert.equal(directionFor({ width: 100, height: 37 }), "down");
});

test("ISSUE-108: crowded reviewer layout opens a tab without shrinking the Lead", async () => {
  const calls: Array<{
    method: string;
    params?: Record<string, unknown>;
    retries?: number;
  }> = [];
  const port: AgentStartPort = {
    request: async (method, params, options) => {
      calls.push({ method, params, retries: options?.retries });
      if (method === "pane.layout")
        return {
          layout: { panes: [pane("w5:p1", 81, 6), pane("w5:p2", 81, 7)] },
        };
      if (method === "tab.create")
        return {
          root_pane: {
            pane_id: "w5:p9",
            workspace_id: "w5",
            terminal_id: "term_new",
          },
        };
      throw new Error(`unexpected ${method}`);
    },
    listAgentsWithWorkspaceNames: async () => [],
  };
  assert.deepEqual(
    await openReviewerPane(port, {
      basePaneId: "w5:p1",
      workspaceId: "w5",
      cwd: "/x",
    }),
    { paneId: "w5:p9", terminalId: "term_new" },
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["pane.layout", "tab.create"],
  );
  assert.deepEqual(calls[1].params, {
    workspace_id: "w5",
    cwd: "/x",
    focus: false,
  });
  assert.equal(calls[1].retries, 0);
});

test("ISSUE-108: tab creation rejects invalid identity and never tries another mutation after failure", async () => {
  for (const response of [
    undefined,
    {},
    { root_pane: { pane_id: "w6:p1", workspace_id: "w6", terminal_id: "t" } },
    { root_pane: { pane_id: "w5:p9", workspace_id: "w5" } },
  ]) {
    const calls: string[] = [];
    const port: AgentStartPort = {
      request: async (method, _params, options) => {
        calls.push(method);
        if (method === "pane.layout")
          return { layout: { panes: [pane("w5:p1", 81, 6)] } };
        assert.equal(method, "tab.create");
        assert.equal(options?.retries, 0);
        if (response === undefined) throw new Error("uncertain delivery");
        return response;
      },
      listAgentsWithWorkspaceNames: async () => [],
    };
    await assert.rejects(
      openReviewerPane(port, {
        basePaneId: "w5:p1",
        workspaceId: "w5",
        cwd: "/x",
      }),
      /identity|uncertain/,
    );
    assert.deepEqual(calls, ["pane.layout", "tab.create"]);
  }
});

test("ISSUE-108: missing base geometry fails before creating a tab", async () => {
  const { port, calls } = layoutPort([pane("w5:p2", 200, 40)]);
  await assert.rejects(
    openReviewerPane(port, {
      basePaneId: "w5:p1",
      workspaceId: "w5",
      cwd: "/x",
    }),
    /版面資訊/,
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["pane.layout"],
  );
});
