import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeStreams, streamAgent } from "../src/main.js";
import { hookEvents } from "../src/hook-events.js";
import { StreamResumeStore } from "../src/stream-resume.js";

test("ISSUE-126: lost progress still delivers a later trusted Stop to the original thread", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "resume-lost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StreamResumeStore(join(dir, "active.json"));
  store.add({
    terminalId: "lost",
    paneId: "w:p",
    channelId: "thread",
    progressMessageId: "deleted",
    prompt: "q",
    baselineOutput: "",
    startedAt: Date.now() - 10,
  });
  const sent: string[] = [];
  const runtime = {
    streamResume: store,
    activeStreams: new Set<string>(),
    config: { hookTransport: {} },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [
        { terminal_id: "lost", pane_id: "w:p", agent: "claude" },
      ],
    },
    discord: {
      fetchMessage: async () => undefined,
      postRecoveredOutput: async (channel: string, text: string) => {
        assert.equal(channel, "thread");
        sent.push(text);
      },
    },
  } as unknown as Parameters<typeof resumeStreams>[0];
  const task = resumeStreams(runtime);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    t.mock.timers.tick(10000);
  }
  await task;
  hookEvents.record({
    event: "Stop",
    sessionId: "lost-session",
    paneId: "w:p",
    message: "final answer",
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /bridge 重啟後補送/);
  assert.match(sent[0]!, /final answer/);
});

import {
  relayRecoveredStreams,
  STREAM_RESUME_FETCH_ATTEMPTS,
  STREAM_RESUME_RETRY_MS,
} from "../src/main.js";

function fixture(t: import("node:test").TestContext, name: string) {
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  const dir = mkdtempSync(join(tmpdir(), "resume-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "active.json");
  const store = new StreamResumeStore(path);
  const agent = {
    terminal_id: name,
    pane_id: name,
    workspace_id: "w",
    tab_id: "tab",
    agent: "claude",
    agent_status: "working",
  };
  store.add({
    terminalId: name,
    paneId: name,
    channelId: "original-thread",
    progressMessageId: "progress",
    prompt: "q",
    baselineOutput: "",
    startedAt: Date.now() - 10,
  });
  const sent: string[] = [];
  const runtime = {
    streamResume: store,
    activeStreams: new Set<string>(),
    config: { hookTransport: {}, streamIntervalMs: 2000, outputLines: 40 },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [agent],
      readAgent: async () => "",
    },
    discord: {
      fetchMessage: async (): Promise<unknown> => undefined,
      postRecoveredOutput: async (channel: string, text: string) => {
        assert.equal(channel, "original-thread");
        sent.push(text);
      },
      editProgress: async () => {},
    },
  };
  const typed = runtime as unknown as Parameters<typeof resumeStreams>[0];
  return {
    runtime,
    typed,
    store,
    path,
    agent,
    sent,
    logs,
    stop: (message = "answer") =>
      hookEvents.record({
        event: "Stop",
        sessionId: name,
        paneId: name,
        message,
      }),
  };
}

test("temporary errors exhaust exactly three attempts with bounded delays; no final means no send", async (t) => {
  const f = fixture(t, "exhaust");
  let calls = 0;
  const waits: number[] = [];
  f.runtime.discord.fetchMessage = async () => {
    calls++;
    throw new Error("Gateway not ready");
  };
  await resumeStreams(f.typed, async (ms) => {
    waits.push(ms);
  });
  assert.equal(STREAM_RESUME_FETCH_ATTEMPTS, 3);
  assert.equal(STREAM_RESUME_RETRY_MS, 2000);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok(
    f.logs.some(
      (s) =>
        s.includes("terminal=exhaust pane=exhaust") &&
        s.includes("retry exhausted"),
    ),
  );
  assert.equal(f.store.list()[0]?.recovery, "pending");
  assert.deepEqual(f.sent, []);
  f.stop();
  await relayRecoveredStreams(f.typed);
  await relayRecoveredStreams(f.typed);
  assert.equal(f.sent.length, 1);
  const restarted = { ...f.typed, streamResume: new StreamResumeStore(f.path) };
  await resumeStreams(restarted, async () => {});
  f.stop();
  await relayRecoveredStreams(restarted);
  assert.equal(f.sent.length, 1);
});

test("Unknown Message and HTTP 404 are definitive, with logs and no retry", async (t) => {
  for (const error of [
    { code: 10008 },
    { status: 404 },
    new Error("Unknown Message"),
  ]) {
    const f = fixture(t, `missing-${JSON.stringify(error)}`);
    let calls = 0;
    f.runtime.discord.fetchMessage = async () => {
      calls++;
      throw error;
    };
    await resumeStreams(f.typed, async () => {
      assert.fail("must not wait");
    });
    assert.equal(calls, 1);
    assert.ok(
      f.logs.some(
        (s) =>
          s.includes(
            `terminal=${f.agent.terminal_id} pane=${f.agent.pane_id}`,
          ) && s.includes("Unknown Message/404"),
      ),
    );
  }
});

test("missing agent and already-running stream each log their reason", async (t) => {
  const f = fixture(t, "absent");
  f.runtime.herdr.listAgentsWithWorkspaceNames = async () => [];
  await resumeStreams(f.typed, async () => {});
  assert.ok(
    f.logs.some((s) =>
      s.includes("terminal=absent pane=absent: agent not found"),
    ),
  );
  f.stop();
  await relayRecoveredStreams(f.typed);
  assert.deepEqual(f.sent, []);
  const running = fixture(t, "running");
  running.runtime.activeStreams.add("running");
  await resumeStreams(running.typed, async () => {});
  assert.ok(
    running.logs.some((s) =>
      s.includes("terminal=running pane=running: stream already running"),
    ),
  );
  assert.equal(running.store.list()[0]?.recovery, undefined);
});

test("untrusted codex hook and blank Stop never recover output", async (t) => {
  const f = fixture(t, "untrusted");
  f.agent.agent = "codex";
  await resumeStreams(f.typed, async () => {});
  f.stop();
  await relayRecoveredStreams(f.typed);
  assert.deepEqual(f.sent, []);
  const blank = fixture(t, "blank");
  await resumeStreams(blank.typed, async () => {});
  blank.stop("   ");
  await relayRecoveredStreams(blank.typed);
  assert.deepEqual(blank.sent, []);
});

test("temporary failure followed by success resumes the ordinary stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, "retry-success");
  let calls = 0;
  f.runtime.discord.fetchMessage = async () => {
    if (++calls === 1) throw new Error("rate limit");
    return {};
  };
  const waits: number[] = [];
  await resumeStreams(f.typed, async (ms) => {
    waits.push(ms);
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.ok(f.runtime.activeStreams.has("retry-success"));
  assert.ok(
    f.logs.some((s) =>
      s.includes("Resuming stream terminal=retry-success pane=retry-success"),
    ),
  );
  assert.deepEqual(f.sent, []);
  // End the background watcher by replacing its identity.
  f.runtime.herdr.listAgentsWithWorkspaceNames = async () => [
    { ...f.agent, terminal_id: "replaced" },
  ];
  t.mock.timers.tick(2000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(!f.runtime.activeStreams.has("retry-success"));
});

test("failed recovery logs and does not prevent another stream's recovery", async (t) => {
  const f = fixture(t, "send-failure");
  await resumeStreams(f.typed, async () => {});
  f.runtime.discord.postRecoveredOutput = async () => {
    throw new Error("offline");
  };
  f.stop();
  await relayRecoveredStreams(f.typed);
  assert.ok(
    f.logs.some((s) =>
      s.includes(
        "Stream recovery failed terminal=send-failure pane=send-failure",
      ),
    ),
  );
  const other = fixture(t, "other-recovery");
  await resumeStreams(other.typed, async () => {});
  other.stop();
  await relayRecoveredStreams(other.typed);
  assert.equal(other.sent.length, 1);
});

import { DiscordAdapter } from "../src/discord.js";
import { RoutingStore } from "../src/routing.js";

test("Discord recovery chunks long output, disables mentions, and preserves fetch errors", async (t) => {
  const f = fixture(t, "adapter");
  const adapter = new DiscordAdapter(
    {
      enabled: true,
      botToken: "",
      allowedGuildIds: [],
      allowedChannelIds: [],
      allowedUserIds: [],
      messageContent: true,
      commandPrefix: "/herdr",
      requireMention: true,
      soloThreadNoMention: false,
    },
    new RoutingStore(join(tmpdir(), "unused-recovery-routing.json")),
  );
  const chunks: Array<{
    content: string;
    allowedMentions: { parse: string[] };
  }> = [];
  const fetch = t.mock.method(
    adapter["client"].channels,
    "fetch",
    async () => ({
      send: async (payload: (typeof chunks)[number]) => {
        chunks.push(payload);
      },
    }),
  );
  const content = "bridge 重啟後補送\n" + "答案😀 @everyone ".repeat(600);
  await adapter.postRecoveredOutput("thread", content);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 2000);
    assert.deepEqual(chunk.allowedMentions, { parse: [] });
    assert.ok(!chunk.content.includes("\uFFFD"));
  }
  const transient = new Error("Gateway unavailable");
  fetch.mock.mockImplementation(async () => {
    throw transient;
  });
  await assert.rejects(
    adapter.fetchMessage("thread", "id"),
    (error) => error === transient,
  );
  const unknown = { code: 10008, status: 404 };
  fetch.mock.mockImplementation(async () => {
    throw unknown;
  });
  await assert.rejects(
    adapter.fetchMessage("thread", "id"),
    (error) => error === unknown,
  );
  assert.deepEqual(f.sent, []);
});

for (const boundary of ["fetch", "sleep", "lookup"] as const) {
  test(`f1: new turn during ${boundary} keeps ownership and never relays to old thread`, async (t) => {
    const f = fixture(t, `race-${boundary}`);
    const replacement = {
      ...f.store.list()[0]!,
      startedAt: Date.now() + 1,
      channelId: "new-thread",
    };
    const replace = () => {
      f.store.add(replacement);
      f.runtime.activeStreams.add(f.agent.terminal_id);
    };
    if (boundary === "fetch")
      f.runtime.discord.fetchMessage = async () => {
        replace();
        return undefined;
      };
    if (boundary === "lookup")
      f.runtime.herdr.listAgentsWithWorkspaceNames = async () => {
        replace();
        return [f.agent];
      };
    await resumeStreams(f.typed, async () => {
      if (boundary === "sleep") replace();
    });
    assert.equal(f.store.list()[0], replacement);
    f.stop("new turn final");
    await relayRecoveredStreams(f.typed);
    assert.deepEqual(f.sent, []);
    assert.ok(
      f.logs.some(
        (s) =>
          s.includes(
            `terminal=${f.agent.terminal_id} pane=${f.agent.pane_id}`,
          ) && /ownership|already running/.test(s),
      ),
    );
  });
}

test("f1: recovery refuses an active stream and rechecks ownership after lookup", async (t) => {
  const f = fixture(t, "recovery-race");
  await resumeStreams(f.typed, async () => {});
  f.runtime.activeStreams.add(f.agent.terminal_id);
  f.stop();
  await relayRecoveredStreams(f.typed);
  assert.deepEqual(f.sent, []);
  assert.ok(
    f.logs.some(
      (s) =>
        s.includes("terminal=recovery-race pane=recovery-race") &&
        s.includes("already running"),
    ),
  );
  f.runtime.activeStreams.clear();
  const replacement = {
    ...f.store.list()[0]!,
    startedAt: Date.now() + 1,
    recovery: undefined,
  };
  f.runtime.herdr.listAgentsWithWorkspaceNames = async () => {
    f.store.add(replacement);
    return [f.agent];
  };
  await relayRecoveredStreams(f.typed);
  assert.equal(f.store.list()[0], replacement);
  assert.deepEqual(f.sent, []);
  assert.ok(
    f.logs.some(
      (s) =>
        s.includes("terminal=recovery-race pane=recovery-race") &&
        s.includes("ownership"),
    ),
  );
});

for (const kind of ["fences", "emoji"] as const) {
  test(`f2: recovery preserves ${kind} across final chunks`, async (t) => {
    fixture(t, `format-${kind}`);
    const chunks: Array<{
      content: string;
      allowedMentions: { parse: string[] };
    }> = [];
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.defineProperty(adapter, "client", {
      value: {
        channels: {
          fetch: async () => ({
            send: async (payload: (typeof chunks)[number]) => {
              chunks.push(payload);
            },
          }),
        },
      },
    });
    const header = "bridge 重啟後補送\n";
    const content =
      kind === "fences"
        ? "```ts\n" + "const x = '😀';\n".repeat(400) + "```"
        : "x" + "😀".repeat(3000);
    await adapter.postRecoveredOutput("thread", header + content);
    assert.ok(chunks.length > 1);
    assert.ok(chunks[0]!.content.startsWith(header.trimEnd()));
    for (const { content: chunk, allowedMentions } of chunks) {
      assert.ok(chunk.length < 1900);
      assert.deepEqual(allowedMentions, { parse: [] });
      assert.equal((chunk.match(/^```/gm) || []).length % 2, 0);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
    }
    if (kind === "emoji")
      assert.equal(chunks.map((c) => c.content).join(""), header + content);
  });
}

test("f3: exactly 24-hour-old records expire with terminal, pane and reason logged", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(t, "expired");
  const record = f.store.list()[0]!;
  f.store.add({ ...record, startedAt: Date.now() - 86400000 });
  await resumeStreams(f.typed, async () => {});
  assert.deepEqual(f.store.list(), []);
  assert.ok(
    f.logs.some(
      (s) =>
        s.includes("terminal=expired pane=expired") && s.includes("紀錄逾期"),
    ),
  );
  f.store.add({ ...record, startedAt: Date.now() - 86400000 + 1 });
  assert.equal(f.store.list().length, 1);
});

test("f1: a session switched in the same pane never recovers into the old thread", async (t) => {
  const f = fixture(t, "switched");
  const a = f.agent as Record<string, unknown>;
  a.agent_session = { kind: "id", value: "old-session" };
  f.store.add({
    terminalId: "switched",
    paneId: "switched",
    channelId: "original-thread",
    progressMessageId: "progress",
    prompt: "q",
    baselineOutput: "",
    startedAt: Date.now() - 10,
    sessionKey: "id:old-session",
  });
  await resumeStreams(f.typed, async () => {});
  a.agent_session = { kind: "id", value: "new-session" };
  hookEvents.record({
    event: "Stop",
    sessionId: "new-session",
    paneId: "switched",
    message: "other session answer",
  });
  await relayRecoveredStreams(f.typed);
  assert.deepEqual(f.sent, []);
  assert.ok(f.logs.some((l) => /agent session changed/.test(l)));
  a.agent_session = { kind: "id", value: "old-session" };
  hookEvents.record({
    event: "Stop",
    sessionId: "old-session",
    paneId: "switched",
    message: "original answer",
  });
  await relayRecoveredStreams(f.typed);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /original answer/);
});

function addRecord(
  f: ReturnType<typeof fixture>,
  name: string,
  sessionKey?: string,
) {
  f.store.add({
    terminalId: name,
    paneId: name,
    channelId: "original-thread",
    progressMessageId: "progress",
    prompt: "q",
    baselineOutput: "",
    startedAt: Date.now() - 10,
    ...(sessionKey === undefined ? {} : { sessionKey }),
  });
}

test("f2: updateSession persists a legal session transfer and ignores a no-op", (t) => {
  const f = fixture(t, "persist");
  addRecord(f, "persist", "");
  f.store.updateSession("persist", "id:first");
  f.store.updateSession("missing", "id:x");
  assert.equal(
    new StreamResumeStore(f.path).list()[0]?.sessionKey,
    "id:first",
  );
});

test("f3: a first session registered while the bridge was down is recovered without streamAgent sync", async (t) => {
  const f = fixture(t, "first");
  const a = f.agent as Record<string, unknown>;
  addRecord(f, "first", ""); // 送出時沒有 session
  await resumeStreams(f.typed, async () => {});
  a.agent_session = { kind: "id", value: "first" };
  f.stop("answer after first registration");
  await relayRecoveredStreams(f.typed);
  assert.equal(f.sent.length, 1);
  assert.equal(
    new StreamResumeStore(f.path).list()[0]?.sessionKey,
    "id:first",
  );
  assert.match(f.sent[0]!, /answer after first registration/);
});

test("f2: a legacy record without sessionKey does not reject an Agent that has a session", async (t) => {
  const f = fixture(t, "legacy");
  const a = f.agent as Record<string, unknown>;
  a.agent_session = { kind: "id", value: "legacy" };
  addRecord(f, "legacy"); // 舊版紀錄：沒有 sessionKey 欄位
  await resumeStreams(f.typed, async () => {});
  f.stop("legacy answer");
  await relayRecoveredStreams(f.typed);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /legacy answer/);
});

test("f2: streamAgent persists a first session registered during the turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, "follow");
  const agent = f.agent as Record<string, unknown>;
  addRecord(f, "follow", "");
  const runtime = {
    ...f.runtime,
    config: { streamIntervalMs: 2000, outputLines: 40, hookTransport: {} },
    discord: {
      ...f.runtime.discord,
      postOutput: async () => {},
    },
  } as unknown as Parameters<typeof streamAgent>[2];
  const task = streamAgent(
    { ...agent } as never,
    {} as Parameters<typeof streamAgent>[1],
    runtime,
    "q",
    "",
  );
  agent.agent_session = { kind: "id", value: "follow" };
  f.stop("final");
  t.mock.timers.tick(2000);
  await task;
  assert.equal(
    new StreamResumeStore(f.path).list()[0]?.sessionKey,
    "id:follow",
  );
});
