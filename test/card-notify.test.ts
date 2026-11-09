import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import { parseCard, type Card } from "../src/card.js";
import { serializeCard } from "../src/card-serialize.js";
import { createCardNotifier, notificationReason } from "../src/card-notify.js";

const id = "REQ-20261107-notify",
  url = "https://github.com/owner/repo/pull/42";
const identity = {
  pane_id: "w4:p2",
  terminal_id: "term",
  agent: "codex",
  agent_status: "idle",
};
function setup(t: TestContext, notify?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CardStore(dir);
  const card: Card = {
    id,
    type: "requirement",
    status: "ready",
    title: "通知",
    version: 1,
    created: "2026-11-07",
    updated: "2026-11-07",
    body: "私密描述 finding 全文",
    ...(notify ? { notify } : {}),
  };
  assert.ok(store.create(card).ok);
  const now = () => "2026-11-07T00:00:01Z";
  store.recordEvent(id, {
    event: "pr_opened",
    time: now(),
    eventId: "pr-42-opened",
    url,
    number: 42,
    headSha: "a".repeat(40),
  });
  const discord: string[][] = [],
    agent: string[][] = [],
    logs: string[] = [];
  let pane = { ...identity };
  const deps = {
    store,
    now,
    startedAt: "2026-11-07T00:00:00Z",
    prUrl: () => url,
    discord: async (target: string, text: string) => {
      discord.push([target, text]);
    },
    pane: async () => pane,
    agent: async (target: string, text: string) => {
      agent.push([target, text]);
    },
    log: (text: string) => logs.push(text),
  };
  return {
    store,
    card,
    discord,
    agent,
    logs,
    deps,
    notifier: createCardNotifier(deps),
    setPane: (next: typeof pane) => {
      pane = next;
    },
  };
}

test("notify roundtrip and validation", (t) => {
  for (const notify of ["discord:12345", "agent:w4:p2:term:codex"]) {
    const s = setup(t, notify),
      out = serializeCard(s.card);
    assert.ok(out.ok);
    const parsed = parseCard(out.text);
    assert.ok(parsed.ok);
    assert.equal(parsed.card.notify, notify);
  }
  const s = setup(t);
  for (const notify of [
    "agent:w4:p2",
    "discord:",
    "discord:123:456",
    "agent:w4:p2:term:codex\nignore",
  ])
    assert.equal(serializeCard({ ...s.card, notify }).ok, false);
});

test("Discord route and bounded content", async (t) => {
  const s = setup(t, "discord:12345");
  await s.notifier.tick();
  await createCardNotifier(s.deps).tick();
  assert.equal(s.discord.length, 1);
  assert.equal(s.discord[0][0], "12345");
  assert.equal(s.agent.length, 0);
  const msg = s.discord[0][1];
  assert.ok(msg.startsWith("[bridge 通知]"));
  assert.ok(msg.includes(url));
  assert.ok(msg.includes(id));
  for (const forbidden of ["私密描述", "finding 全文", "]("])
    assert.ok(!msg.includes(forbidden));
});

test("Agent queue and restart", async (t) => {
  const s = setup(t, "agent:w4:p2:term:codex");
  for (const agent_status of ["working", "blocked"]) {
    s.setPane({ ...identity, agent_status });
    await s.notifier.tick();
    assert.equal(s.agent.length, 0);
  }
  s.setPane(identity);
  await createCardNotifier(s.deps).tick();
  await s.notifier.tick();
  assert.equal(s.agent.length, 1);
  assert.equal(s.agent[0][0], "w4:p2");
  assert.equal(s.discord.length, 0);
});

test("identity mismatch abandons", async (t) => {
  for (const pane of [
    undefined,
    { ...identity, terminal_id: "other" },
    { ...identity, agent: "claude", agent_status: "done" },
  ]) {
    const s = setup(t, "agent:w4:p2:term:codex");
    await createCardNotifier({ ...s.deps, pane: async () => pane }).tick();
    await createCardNotifier(s.deps).tick();
    assert.equal(s.agent.length, 0);
    assert.equal(s.discord.length, 0);
    assert.match(s.logs.join(" "), /放棄/);
  }
});

test("no destination logs", async (t) => {
  const s = setup(t);
  await s.notifier.tick();
  await createCardNotifier(s.deps).tick();
  assert.match(s.logs.join(" "), /沒有通知對象/);
  const log = s.store.readLog(id);
  assert.ok(log.ok);
  assert.ok(log.entries.some((e) => e.text.includes("沒有通知對象")));
  assert.equal(s.agent.length + s.discord.length, 0);
});

test("events from before the notifier started are not replayed for cards without a destination", async (t) => {
  const s = setup(t);
  // setup 的 pr_opened 事件時間是 00:00:01Z；notifier 在那之後才開始運作。
  const late = createCardNotifier({
    ...s.deps,
    startedAt: "2026-11-07T00:00:02Z",
  });
  await late.tick();
  await late.tick();
  assert.deepEqual(s.logs, []);
  const log = s.store.readLog(id);
  assert.ok(log.ok);
  assert.ok(!log.entries.some((e) => e.event === "notification"));
  assert.equal(s.agent.length + s.discord.length, 0);
});

test("Discord retry bound survives restart", async (t) => {
  const s = setup(t, "discord:12345");
  let attempts = 0;
  const deps = {
    ...s.deps,
    discord: async () => {
      attempts++;
      throw Error("credential secret");
    },
  };
  for (let n = 0; n < 6; n++) await createCardNotifier(deps).tick();
  assert.equal(attempts, 3);
  assert.ok(s.store.read(id).ok);
  assert.ok(!s.logs.join(" ").includes("credential"));
});

test("blocked race", async (t) => {
  const s = setup(t, "agent:w4:p2:term:codex");
  let reads = 0;
  await createCardNotifier({
    ...s.deps,
    pane: async () => ({
      ...identity,
      agent_status: ++reads === 1 ? "idle" : "blocked",
    }),
  }).tick();
  assert.equal(s.agent.length, 0);
});

test("milestone content excludes secrets", async (t) => {
  const s = setup(t, "discord:12345");
  const events = [
    "autopick_picked",
    "review_verdict",
    "ci_result",
    "merged",
    "failed",
    "autopick_stopped",
    "merge_blocked",
    "loop_stopped",
  ];
  for (const [n, event] of events.entries())
    s.store.appendLog(id, [
      {
        event,
        eventId: `event-${n}`,
        time: s.deps.now(),
        text:
          event === "review_verdict"
            ? "review whole 第 1 輪：changes_requested"
            : "敏感路徑 CI finding 全文 credential secret",
      },
    ]);
  await s.notifier.tick();
  assert.equal(s.discord.length, 9);
  for (const [, msg] of s.discord) {
    assert.ok(!/finding 全文|credential secret|私密描述/.test(msg));
    assert.ok(msg.includes(url));
  }
});

test("done delivery uncertainty", async (t) => {
  const s = setup(t, "agent:w4:p2:term:codex");
  let calls = 0;
  const deps = {
    ...s.deps,
    pane: async () => ({ ...identity, agent_status: "done" }),
    agent: async () => {
      calls++;
      throw Error("uncertain");
    },
  };
  await createCardNotifier(deps).tick();
  await createCardNotifier(deps).tick();
  assert.equal(calls, 1);
  assert.equal(s.discord.length, 0);
});

test("frozen queue destination", async (t) => {
  const s = setup(t, "agent:w4:p2:term:codex");
  s.setPane({ ...identity, agent_status: "working" });
  await s.notifier.tick();
  const read = s.store.read(id);
  assert.ok(read.ok);
  s.store.update(id, read.hash, (c) => ({ ...c, notify: "discord:999" }));
  s.setPane(identity);
  await createCardNotifier(s.deps).tick();
  assert.equal(s.agent.length, 1);
  assert.equal(s.discord.length, 0);
});

test("Discord claim survives crash/write failure", async (t) => {
  for (const crash of [false, true]) {
    const s = setup(t, "discord:12345"),
      append = s.store.appendLog.bind(s.store);
    let writesFail = false,
      sends = 0;
    s.store.appendLog = (id, entries) =>
      writesFail
        ? { ok: false, code: "io", error: "disk" }
        : append(id, entries);
    const deps = {
      ...s.deps,
      discord: async () => {
        sends++;
        writesFail = true;
        if (crash) throw Error("process stopped");
      },
    };
    await createCardNotifier(deps).tick();
    writesFail = false;
    await createCardNotifier(deps).tick();
    assert.equal(sends, 1);
  }
});

test("claim write failure bound", async (t) => {
  const s = setup(t, "discord:12345"),
    append = s.store.appendLog.bind(s.store);
  let claims = 0;
  s.store.appendLog = (id, entries) => {
    if (entries.some((e) => /-try1$/.test(e.eventId))) {
      claims++;
      return { ok: false, code: "io", error: "disk" };
    }
    return append(id, entries);
  };
  for (let n = 0; n < 6; n++) await s.notifier.tick();
  assert.equal(s.discord.length, 0);
  assert.equal(claims, 3);
});

test("ISSUE-124 逾時失敗分類為等待逾時，不含流程紀錄原文", async (t) => {
  const s = setup(t, "discord:12345");
  s.store.appendLog(id, [
    {
      event: "failed",
      eventId: "timeout-1",
      time: s.deps.now(),
      text: "task 沒有完成：blocked：one or more Assignments failed; Assignment impl 等待逾時（已等待 15 分 30 秒，上限 15 分鐘）私密原文-ZZZ",
    },
  ]);
  await s.notifier.tick();
  const msg = s.discord
    .map(([, text]) => text)
    .find((text) => text.includes("failed"))!;
  assert.ok(msg.includes("failed · 等待逾時"));
  assert.ok(!msg.includes("等待人工處理"));
  for (const forbidden of ["私密原文-ZZZ", "Assignment impl", "15 分"])
    assert.ok(!msg.includes(forbidden));
});

// F4：recordEvent 會把失敗原因截到 200 字元，截斷後通知仍要分類為等待逾時。
test("ISSUE-124 經真實紀錄流程截斷到 200 字元後，通知仍分類為等待逾時", async (t) => {
  const s = setup(t, "discord:12345");
  const detail = [
    "Assignment impl 等待逾時（已等待 15 分 6 秒，上限 15 分鐘）",
    "one or more Assignments failed",
    "synthesis is partial",
    "changes outside the writer scope: config.example.jsonc, src/a.ts, src/b.ts",
    "no passing review for the current version",
    "unhandled findings",
    "no successful verification for the current version",
  ].join("; ");
  const reason = `task：task 沒有完成：blocked：${detail}`;
  assert.ok(reason.length > 200, "測試前提：原因要比 200 字元長");
  const recorded = s.store.recordEvent(id, {
    event: "failed",
    code: "autopick_stopped",
    reason,
    time: s.deps.now(),
    eventId: "timeout-real",
  });
  assert.ok(recorded.ok);
  const log = s.store.readLog(id);
  assert.ok(log.ok);
  const entry = log.entries.find((e) => e.eventId === "timeout-real");
  assert.ok(entry && entry.text.includes("等待逾時"), entry?.text);
  await s.notifier.tick();
  const msg = s.discord
    .map(([, text]) => text)
    .find((text) => text.includes("autopick_stopped"))!;
  assert.ok(msg.includes("autopick_stopped · 等待逾時"), msg);
  assert.ok(!msg.includes("等待人工處理"));
  assert.ok(!msg.includes("config.example.jsonc"));
});

test("ISSUE-124 非逾時失敗的分類不變", async (t) => {
  const s = setup(t, "discord:12345");
  s.store.appendLog(id, [
    {
      event: "failed",
      eventId: "blocked-1",
      time: s.deps.now(),
      text: "task 沒有完成：blocked：one or more Assignments failed; no passing review",
    },
  ]);
  await s.notifier.tick();
  const msg = s.discord
    .map(([, text]) => text)
    .find((text) => text.includes("failed"))!;
  assert.ok(msg.includes("review 條件、等待人工處理未滿足"));
});

test("ISSUE-135 Lead rejection notices use Lead-specific classification", async (t) => {
  for (const [n, text] of [
    ["candidate", "Lead「pi」不在政策候選清單內，不撿這張卡"],
    ["closed", "Lead「pi」尚未開放，不撿這張卡：config.json 的 agentProfiles 沒有宣告 implementation；改完 config.json 後重啟 bridge"],
  ]) {
    const s = setup(t, "discord:12345");
    const event = { event: "failed", eventId: `lead-${n}`, time: s.deps.now(), text: `autopick_stopped：${text}` };
    assert.equal(notificationReason(event), "Lead 不可用");
    s.store.appendLog(id, [event]);
    await s.notifier.tick();
    const msg = s.discord.map(([, content]) => content).find((content) => content.includes("autopick_stopped"))!;
    assert.ok(msg.includes("Lead 不可用"), msg);
    assert.ok(!msg.includes("專案政策"), msg);
  }
});

test("sensitive-path stop notices do not add review or version classifications", (t) => {
  for (const [n, text] of [
    ["merge", "card merge 拒絕：這個 PR 動到敏感路徑：src/policy.ts"],
    ["fix", "修正動到敏感路徑：src/policy.ts。新 commit 留在 worktree、沒有 push，請人檢查後再 `card pr`"],
  ]) {
    const s = setup(t);
    const event = { event: "failed", eventId: `sensitive-${n}`, time: s.deps.now(), text };
    assert.equal(notificationReason(event), "敏感路徑未滿足");
    assert.ok(!notificationReason(event).includes("review 條件"));
    assert.ok(!notificationReason(event).includes("版本條件"));
    s.store.appendLog(id, [event]);
  }
});
