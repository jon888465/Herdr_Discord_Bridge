import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseSplitTarget,
  createAgentPane,
  directionFor,
} from "../src/pane-split.js";
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
      if (method === "pane.split" || method === "tab.create")
        return {
          root_pane: {
            pane_id: "w5:p9",
            workspace_id: "w5",
            terminal_id: "term_new",
          },
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

test("a reviewer opens a tab rather than splitting another pane in the author's full tab", async () => {
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
  assert.equal(split, undefined);
  assert.deepEqual(calls.at(-1)?.params, {
    workspace_id: "w5",
    cwd: "/x",
    focus: false,
  });
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

test("two panes including a user pane force a fresh tab despite ample geometry", async () => {
  const calls: string[] = [];
  const port: AgentStartPort = {
    request: async (method) => {
      calls.push(method);
      if (method === "pane.layout")
        return {
          layout: { panes: [pane("lead", 400, 100), pane("user", 400, 100)] },
        };
      if (method === "tab.create")
        return {
          root_pane: { pane_id: "new", workspace_id: "w", terminal_id: "t" },
        };
      throw new Error(`unexpected ${method}`);
    },
    listAgentsWithWorkspaceNames: async () => [],
  };
  assert.deepEqual(
    await openReviewerPane(port, {
      basePaneId: "lead",
      workspaceId: "w",
      cwd: "/x",
    }),
    { paneId: "new", terminalId: "t" },
  );
  assert.deepEqual(calls, ["pane.layout", "tab.create"]);
});

// 使用者規則（2026-11-07）：連續建立 3 個 pane，第 1 個分割（tab 內變 2 個），第 2、3 個各開新 tab，
// 沒有任何 tab 的 pane 總數超過 2。
test("three consecutive panes: the first splits, the next two each open their own tab, no tab exceeds two panes", async () => {
  const tabs = new Map<string, string[]>([["t1", ["lead"]]]);
  const base = "lead";
  let n = 0;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const port = {
    request: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "pane.layout") {
        const [tabId] = [...tabs].find(([, ids]) => ids.includes(base))!;
        return {
          layout: {
            panes: tabs.get(tabId)!.map((id) => pane(id, 400, 100)),
          },
        };
      }
      const id = `new${++n}`;
      if (method === "pane.split") {
        tabs.get("t1")!.push(id);
        return { pane: { pane_id: id, workspace_id: "w", terminal_id: id } };
      }
      if (method === "tab.create") {
        tabs.set(`t${n + 1}`, [id]);
        return {
          tab: { tab_id: `t${n + 1}` },
          root_pane: { pane_id: id, workspace_id: "w", terminal_id: id },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const input = { basePaneId: base, workspaceId: "w", cwd: "/x" };
  const first = await createAgentPane(port, input);
  const second = await createAgentPane(port, input);
  const third = await createAgentPane(port, input);
  assert.deepEqual(
    calls.filter((c) => c.method !== "pane.layout").map((c) => c.method),
    ["pane.split", "tab.create", "tab.create"],
  );
  for (const ids of tabs.values()) assert.ok(ids.length <= 2, ids.join());
  // 只有自己建立的 tab 才回傳 tab id；分割出的 pane 沒有。
  assert.equal(first.tabId, undefined);
  assert.equal(second.tabId, "t3");
  assert.equal(third.tabId, "t4");
});

test("createAgentPane returns no tab id when the new pane is not in the expected workspace or has no tab id", async () => {
  const request = (root: unknown, tab: unknown) => async (method: string) => {
    if (method === "pane.layout")
      return { layout: { panes: [pane("a", 100, 10), pane("b", 100, 10)] } };
    return { tab, root_pane: root };
  };
  const good = { pane_id: "p", workspace_id: "w", terminal_id: "t" };
  const input = { basePaneId: "a", workspaceId: "w", cwd: "/x" };
  assert.equal(
    (
      await createAgentPane(
        { request: request(good, { tab_id: "w:t9" }) },
        input,
      )
    ).tabId,
    "w:t9",
  );
  assert.equal(
    (
      await createAgentPane(
        {
          request: request(
            { ...good, workspace_id: "other" },
            { tab_id: "w:t9" },
          ),
        },
        input,
      )
    ).tabId,
    undefined,
  );
  for (const tab of [undefined, {}, { tab_id: "" }, { tab_id: 5 }])
    assert.equal(
      (await createAgentPane({ request: request(good, tab) }, input)).tabId,
      undefined,
    );
});
