import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  HookEventStore,
  hookEvents,
  parseHookEvent,
  sendHookEvent,
  startHookServer,
} from "../src/hook-events.js";
import { streamAgent } from "../src/main.js";

test("parseHookEvent accepts Stop and rejects malformed input (ISSUE-045)", () => {
  assert.deepEqual(
    parseHookEvent({
      event: "Stop",
      sessionId: "s1",
      message: "hi",
      paneId: "w1:p1",
    }),
    {
      event: "Stop",
      sessionId: "s1",
      paneId: "w1:p1",
      promptId: undefined,
      message: "hi",
      toolName: undefined,
      toolInput: undefined,
    },
  );
  assert.equal(
    parseHookEvent({ event: "Other", sessionId: "s", message: "" }),
    undefined,
  );
  assert.equal(
    parseHookEvent({ event: "Stop", sessionId: "", message: "" }),
    undefined,
  );
  assert.equal(parseHookEvent({ event: "Stop", sessionId: "s" }), undefined);
  assert.equal(parseHookEvent(null), undefined);
});

test("HookEventStore only returns events at or after the turn started", () => {
  const store = new HookEventStore();
  store.record({ event: "Stop", sessionId: "s1", message: "old" }, 1000);
  assert.equal(store.stopSince("s1", 2000), undefined);
  store.record({ event: "Stop", sessionId: "s1", message: "new" }, 3000);
  assert.equal(store.stopSince("s1", 2000)?.message, "new");
  assert.equal(store.stopSince("other", 0), undefined);
  assert.equal(store.stopSince(undefined, 0), undefined);
});

test("hook socket delivers a Stop event into the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-"));
  const path = join(dir, "h.sock");
  const store = new HookEventStore();
  const stop = await startHookServer(store, path);
  try {
    assert.equal(
      await sendHookEvent(
        { event: "Stop", sessionId: "sx", message: "答案" },
        path,
      ),
      true,
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.stopSince("sx", 0)?.message, "答案");
    assert.equal(
      await sendHookEvent(
        { event: "Stop", sessionId: "sx", message: "" },
        join(dir, "none.sock"),
      ),
      false,
    );
  } finally {
    stop();
  }
});

test("Claude Stop hook completes the stream without the screen footer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p1",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "claude",
    agent_status: "working",
    agent_session: { kind: "id", value: "sess-hook" },
  };
  const sent: string[] = [];
  const runtime = {
    config: { streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "❯ question\n\n⏺ partial",
    },
    discord: {
      editProgress: async () => {},
      postOutput: async (_m: unknown, text: string) => {
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const task = streamAgent(
    agent as never,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
  );
  hookEvents.record({
    event: "Stop",
    sessionId: "sess-hook",
    message: "hook final",
  });
  t.mock.timers.tick(2000);
  await task;
  assert.deepEqual(sent, ["hook final"]);
});

test("permissionDecisionFromText maps only explicit words (ISSUE-045)", async () => {
  const { permissionDecisionFromText } = await import("../src/hook-events.js");
  for (const t of ["allow", "Yes", " y ", "continue", "OK"])
    assert.equal(permissionDecisionFromText(t), "allow");
  for (const t of ["deny", "No", "n", "cancel"])
    assert.equal(permissionDecisionFromText(t), "deny");
  for (const t of ["1", "4", "yes please run it", ""])
    assert.equal(permissionDecisionFromText(t), undefined);
});

test("PermissionRequest hook waits for a Discord decision, cancel and drop leave TUI flow", async () => {
  const { PermissionBroker, requestPermission } =
    await import("../src/hook-events.js");
  const dir = mkdtempSync(join(tmpdir(), "hk-"));
  const path = join(dir, "p.sock");
  const store = new HookEventStore();
  const broker = new PermissionBroker();
  const stop = await startHookServer(store, path, broker);
  const event = {
    event: "PermissionRequest" as const,
    sessionId: "s",
    paneId: "w1:p1",
    message: "",
    toolName: "Bash",
  };
  try {
    const allowed = requestPermission(event, path, 5000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broker.peek("w1:p1")?.toolName, "Bash");
    assert.equal(broker.decide("w1:p1", "allow"), true);
    assert.equal(await allowed, "allow");
    assert.equal(broker.has("w1:p1"), false);
    assert.equal(broker.decide("w1:p1", "allow"), false);

    const cancelled = requestPermission(event, path, 5000);
    await new Promise((r) => setTimeout(r, 50));
    broker.cancel("w1:p1");
    assert.equal(await cancelled, undefined);

    // hook 行程自己結束（連線中斷）→ 不再保留等待項目
    const lost = requestPermission(event, path, 100);
    assert.equal(await lost, undefined);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broker.has("w1:p1"), false);

    // 沒有 pane id 的請求不等待
    assert.equal(
      await requestPermission({ ...event, paneId: undefined }, path, 5000),
      undefined,
    );
    assert.equal(store.stopSince("s", 0), undefined);
  } finally {
    stop();
  }
});

test("Codex Stop hook also completes the stream (ISSUE-045)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p2",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "codex",
    agent_status: "working",
    agent_session: { kind: "id", value: "sess-codex" },
  };
  const sent: string[] = [];
  const runtime = {
    config: { streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "› question\n• partial",
    },
    discord: {
      editProgress: async () => {},
      postOutput: async (_m: unknown, text: string) => {
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const task = streamAgent(
    agent as never,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
  );
  hookEvents.record({
    event: "Stop",
    sessionId: "sess-codex",
    message: "codex hook final",
  });
  t.mock.timers.tick(2000);
  await task;
  assert.deepEqual(sent, ["codex hook final"]);
});

test("hookTransport validation, mode lookup and status text (ISSUE-045)", async () => {
  const {
    validateHookTransport,
    hookModeFor,
    hookStatusText,
    registeredEvents,
  } = await import("../src/hook-status.js");
  assert.deepEqual(validateHookTransport(undefined), {
    claude: "auto",
    codex: "auto",
  });
  assert.deepEqual(validateHookTransport({ codex: "parser", agy: "auto" }), {
    claude: "auto",
    codex: "parser",
  });
  assert.throws(() => validateHookTransport({ claude: "hook" }), /auto/);
  assert.equal(hookModeFor({ claude: "parser" }, "claude"), "parser");
  assert.equal(hookModeFor({}, "claude"), "auto");
  assert.equal(hookModeFor(undefined, "codex"), "auto");
  assert.equal(hookModeFor({ claude: "auto" }, "agy"), "parser");

  const home = mkdtempSync(join(tmpdir(), "hk-home-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: "/x/scripts/herdr-discord-hook" }] }],
      },
    }),
  );
  assert.deepEqual(registeredEvents(join(home, ".claude", "settings.json")), {
    Stop: true,
    PermissionRequest: false,
  });
  const text = hookStatusText({ codex: "parser" }, home);
  assert.match(text, /claude\*\*：模式 `auto`｜Stop ✅｜PermissionRequest ❌/);
  assert.match(text, /codex\*\*：模式 `parser`｜Stop ❌/);
});

test("parser mode ignores a Claude Stop hook event (ISSUE-045)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const agent = {
    terminal_id: "term",
    pane_id: "w2:p3",
    workspace_id: "w2",
    tab_id: "w2:t1",
    agent: "claude",
    agent_status: "working",
    agent_session: { kind: "id", value: "sess-parser" },
  };
  const sent: string[] = [];
  const runtime = {
    config: {
      streamIntervalMs: 2000,
      outputLines: 40,
      hookTransport: { claude: "parser", codex: "auto" },
    },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "❯ question\n\n⏺ partial",
    },
    discord: {
      editProgress: async () => {},
      postOutput: async (_m: unknown, text: string) => {
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const task = streamAgent(
    agent as never,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "question",
    "",
  );
  hookEvents.record({
    event: "Stop",
    sessionId: "sess-parser",
    message: "hook final",
  });
  t.mock.timers.tick(2000);
  t.mock.timers.tick(2000);
  // 只有一次 tick 後仍未完成：hook 被忽略，沒有立即貼出
  assert.deepEqual(sent, []);
  agent.agent_status = "idle";
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    t.mock.timers.tick(2000);
    await Promise.resolve();
  }
  await task;
  assert.ok(sent.length > 0);
  assert.ok(!(sent as string[]).includes("hook final"));
});

test("Codex approval replies allow/deny become y/esc keys (ISSUE-045)", async () => {
  const { deliverApproval } = await import("../src/main.js");
  const agent = {
    terminal_id: "t1",
    pane_id: "w4:p1",
    workspace_id: "w4",
    agent: "codex",
    agent_status: "blocked",
  };
  const calls: string[] = [];
  const herdr = {
    listAgentsWithWorkspaceNames: async () => [agent],
    sendKeys: async (_t: string, keys: string[]) => {
      calls.push(`keys:${keys.join("+")}`);
    },
    sendAgent: async (_t: string, text: string) => {
      calls.push(`text:${text}`);
    },
  };
  const routing = { deactivateApproval: () => {} };
  const approval = {
    token: "x",
    terminalId: "t1",
    paneId: "w4:p1",
    workspaceId: "w4",
  };
  const run = (text: string) =>
    deliverApproval(
      approval as never,
      text,
      herdr as never,
      routing as never,
      {},
    );
  await run("allow");
  await run("deny");
  await run("2");
  assert.deepEqual(calls, ["keys:y", "keys:esc", "text:2"]);
  agent.agent = "agy";
  calls.length = 0;
  await run("allow");
  assert.deepEqual(calls, ["text:allow"]);
});
