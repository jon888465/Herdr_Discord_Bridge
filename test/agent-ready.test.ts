import test from "node:test";
import assert from "node:assert/strict";
import { waitUntilReady } from "../src/agent-ready.js";
import type { AgentStartPort } from "../src/agent-start.js";
import type { AgentRecord } from "../src/types.js";

const pane = { paneId: "w5:p9", terminalId: "term_new" };
const update =
  "Update available · 0.166.0 → 0.167.0\n3. Skip until next version";
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
    listAgentsWithWorkspaceNames: async () => statuses,
  };
  return {
    deps: { panePort: port, readyPollMs: 1, readyTimeoutMs: 50 },
    calls,
  };
}

test("known update is skipped once and then readiness succeeds", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { deps, calls } = fixture([
    { read: { text: update } },
    { read: { text: "Ready" } },
  ]);
  const result = await waitUntilReady(deps, pane, agent());
  assert.equal(result.ok, true);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["已自動跳過 codex 的更新提示（pane w5:p9、按鍵 3）"]],
  );
  assert.deepEqual(
    calls.filter((c) => c.method === "pane.send_keys"),
    [
      {
        method: "pane.send_keys",
        params: { pane_id: pane.paneId, keys: ["3"] },
        options: { retries: 0 },
      },
    ],
  );
  assert.equal(calls.filter((c) => c.method === "agent.read").length, 2);
});

const blockedReason =
  "reviewer 卡在啟動提示（blocked）。常見原因：Agent 自己的更新提示或新資料夾的信任提示；bridge 不會替人確認，請先在要用的種類上處理一次";

test("persistent update fails blocked and never sends again for that pane", async () => {
  const { deps, calls } = fixture([{ text: update }]);
  assert.deepEqual(await waitUntilReady(deps, pane, agent()), {
    ok: false,
    reason: blockedReason,
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

for (const [kind, screen] of [
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
  ["claude", update],
  ["codex", "Update available\n2. Skip"],
]) {
  test(`${kind} guarded or unknown screen sends no keys: ${screen}`, async () => {
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

for (const screen of [new Error("read failed"), {}, { read: { text: 123 } }]) {
  test(`failed or invalid screen read keeps original blocked behavior: ${String(screen)}`, async () => {
    const { deps, calls } = fixture([screen]);
    assert.deepEqual(await waitUntilReady(deps, pane, agent()), {
      ok: false,
      reason: blockedReason,
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["agent.read"],
    );
  });
}

test("update encountered during startup polling is skipped too", async () => {
  const { deps, calls } = fixture([{ text: update }, { text: "Ready" }]);
  let polls = 0;
  deps.panePort.listAgentsWithWorkspaceNames = async () => [
    agent("codex", ++polls === 1 ? "blocked" : "idle"),
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

test("uncertain key delivery and failed post-send read are never retried", async () => {
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
    assert.deepEqual(await waitUntilReady(deps, pane, agent()), {
      ok: false,
      reason: blockedReason,
    });
    await waitUntilReady(deps, pane, agent());
    assert.equal(calls.filter((c) => c.method === "pane.send_keys").length, 1);
  }
});
