import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { doneAsReady, waitUntilReady } from "../src/agent-ready.js";
import type { AgentStartPort } from "../src/agent-start.js";
import type { AgentRecord } from "../src/types.js";

const pane = { paneId: "w5:p9", terminalId: "term_new" };
const update =
  "Update available · 0.166.0 → 0.167.0\n1. Update now\n2. Skip\n3. Skip until next version";
function agent(kind = "codex", status = "blocked"): AgentRecord {
  return {
    pane_id: pane.paneId,
    terminal_id: pane.terminalId,
    workspace_id: "w5",
    tab_id: "t1",
    agent: kind,
    agent_status: status,
  };
}
// 自動跳過會 console.log；測試輸出不要混進 node:test 子行程的 stdout。
function quiet(t: TestContext) {
  return t.mock.method(console, "log", () => {});
}
function fixture(screens: unknown[], statuses = [agent("codex", "idle")]) {
  const calls: {
    method: string;
    params?: Record<string, unknown>;
    options?: unknown;
  }[] = [];
  const port: AgentStartPort = {
    request: async (method, params, options) => {
      calls.push({ method, params, options });
      if (method === "agent.read") {
        const screen = screens.length > 1 ? screens.shift() : screens[0];
        if (screen instanceof Error) throw screen;
        return screen;
      }
      if (method === "pane.send_keys") return {};
      throw new Error(`unexpected ${method}`);
    },
    listAgentsWithWorkspaceNames: async () =>
      calls.some((c) => c.method === "agent.read") &&
      !calls.some((c) => c.method === "pane.send_keys")
        ? [agent()]
        : statuses,
  };
  return {
    deps: { panePort: port, readyPollMs: 1, readyTimeoutMs: 1000 },
    calls,
  };
}

test("known update is skipped once and then readiness succeeds", async (t) => {
  const log = quiet(t);
  const { deps, calls } = fixture([
    { read: { text: update } },
    { read: { text: "Ready" } },
  ]);
  const result = await waitUntilReady(deps, pane, agent());
  assert.equal(result.ok, true);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["已自動跳過 codex 的更新提示（pane w5:p9、按鍵 2）"]],
  );
  assert.deepEqual(
    calls.filter((c) => c.method === "pane.send_keys"),
    [
      {
        method: "pane.send_keys",
        params: { pane_id: pane.paneId, keys: ["2"] },
        options: { retries: 0 },
      },
    ],
  );
  assert.equal(calls.filter((c) => c.method === "agent.read").length, 2);
});

const blockedReason =
  "reviewer 卡在啟動提示（blocked）。常見原因：Agent 自己的更新提示或新資料夾的信任提示；bridge 不會替人確認，請先在要用的種類上處理一次";

test("persistent update fails blocked and never sends again for that pane", async (t) => {
  quiet(t);
  const { deps, calls } = fixture([{ text: update }]);
  assert.deepEqual(await waitUntilReady(deps, pane, agent()), {
    ok: false,
    reason: blockedReason,
    updateSkip: { kind: "codex", paneId: pane.paneId, key: "2" },
  });
  assert.deepEqual(await waitUntilReady(deps, pane, agent()), {
    ok: false,
    reason: blockedReason,
  });
  assert.equal(calls.filter((c) => c.method === "pane.send_keys").length, 1);
  assert.equal(calls.filter((c) => c.method === "agent.read").length, 2);
  assert.ok(
    calls.every((c) => ["agent.read", "pane.send_keys"].includes(c.method)),
  );
});

const guardedScreens: [string, string][] = [
  ["agy", "Do you trust the contents of this project?"],
  ["claude", "Yes, I trust this folder"],
  ["codex", "Permission required: approve or allow this command"],
  ["codex", "Unknown startup menu"],
  ["codex", update + "\nDo you trust the contents of this project?"],
  ["codex", update + "\nI trust this folder"],
  ["codex", update + "\nPermission required"],
  ["codex", update + "\nApprove this action"],
  ["codex", update + "\nAllow this action"],
  ["codex", update + "\nLogin required"],
  ["codex", update + "\nYes, proceed (y)\nNo (esc)"],
  ["claude", update],
  ["codex", "Update available\n2. Skip"],
];
for (const [index, [kind, screen]] of guardedScreens.entries()) {
  test(`guarded or unknown screen #${index} (${kind}) sends no keys`, async (t) => {
    quiet(t);
    const { deps, calls } = fixture([{ read: { text: screen } }]);
    assert.deepEqual(await waitUntilReady(deps, pane, agent(kind)), {
      ok: false,
      reason: blockedReason,
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["agent.read"],
    );
  });
}

const badReads: unknown[] = [
  new Error("read failed"),
  {},
  { read: { text: 123 } },
];
for (const [index, screen] of badReads.entries()) {
  test(`failed or invalid screen read #${index} keeps original blocked behavior`, async (t) => {
    quiet(t);
    const { deps, calls } = fixture([screen]);
    const outcome = await waitUntilReady(deps, pane, agent());
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, blockedReason);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["agent.read"],
    );
  });
}

test("update encountered during startup polling is skipped too", async (t) => {
  quiet(t);
  const { deps, calls } = fixture([{ text: update }, { text: "Ready" }]);
  let polls = 0;
  deps.panePort.listAgentsWithWorkspaceNames = async () => [
    agent("codex", ++polls <= 2 ? "blocked" : "idle"),
  ];
  assert.equal(
    (await waitUntilReady(deps, pane, agent("codex", "working"))).ok,
    true,
  );
  assert.equal(calls.filter((c) => c.method === "pane.send_keys").length, 1);
});

test("idle returns without reading or sending input", async () => {
  const { deps, calls } = fixture([]);
  assert.equal(
    (await waitUntilReady(deps, pane, agent("codex", "idle"))).ok,
    true,
  );
  assert.deepEqual(calls, []);
});

test("uncertain key delivery and failed post-send read are never retried", async (t) => {
  quiet(t);
  for (const failSend of [true, false]) {
    const { deps, calls } = fixture([
      { text: update },
      new Error("post-send read failed"),
    ]);
    const request = deps.panePort.request;
    deps.panePort.request = async (...args) => {
      const result = await request(...args);
      if (failSend && args[0] === "pane.send_keys")
        throw new Error("delivery unknown");
      return result;
    };
    const outcome = await waitUntilReady(deps, pane, agent());
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, blockedReason);
    await waitUntilReady(deps, pane, agent());
    assert.equal(calls.filter((c) => c.method === "pane.send_keys").length, 1);
  }
});

test("a skipped update prompt is returned so callers can record it", async (t) => {
  quiet(t);
  const { deps } = fixture([{ text: update }, { text: "ready" }]);
  const result = await waitUntilReady(deps, pane, agent());
  assert.equal(result.ok, true);
  assert.deepEqual(result.updateSkip, {
    kind: "codex",
    paneId: pane.paneId,
    key: "2",
  });
});

// Lead 啟動後可能先 working、再直接變 done（REQ-20261109-codex-lead-agy，review F4）。
test("the plain wait never treats done as ready, but the done-as-ready adapter does after a working → done transition", async () => {
  const { deps } = fixture([{}], [agent("codex", "done")]);
  const plain = await waitUntilReady(deps, pane, agent("codex", "working"));
  assert.equal(plain.ok, false);
  const adapted = await waitUntilReady(
    { ...deps, panePort: doneAsReady(deps.panePort) },
    pane,
    agent("codex", "working"),
  );
  assert.equal(adapted.ok, true);
});

test("the done-as-ready adapter is one object per port, so the once-per-pane update guard keeps working", () => {
  const { deps } = fixture([{}]);
  assert.equal(doneAsReady(deps.panePort), doneAsReady(deps.panePort));
});

test("the role label replaces reviewer in the failure messages, and the default stays reviewer", async () => {
  const { deps } = fixture([{}], [agent("codex", "working")]);
  const lead = await waitUntilReady(
    { ...deps, role: "Lead" },
    pane,
    agent("codex", "working"),
  );
  assert.equal(lead.ok, false);
  assert.match(!lead.ok ? lead.reason : "", /^Lead 在 /);
  const reviewer = await waitUntilReady(deps, pane, agent("codex", "working"));
  assert.match(!reviewer.ok ? reviewer.reason : "", /^reviewer 在 /);
});

test("concurrent waits send the skip key once", async (t) => {
  quiet(t);
  const { deps, calls } = fixture([{ text: update }, { text: update }, { text: "Ready" }]);
  const results = await Promise.all([waitUntilReady(deps, pane, agent()), waitUntilReady(deps, pane, agent())]);
  assert.equal(calls.filter((c) => c.method === "pane.send_keys").length, 1);
  assert.equal(results.filter((r) => r.updateSkip).length, 1);
});
