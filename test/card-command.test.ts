import { createCardNotifier } from "../src/card-notify.js";
import { appendLogEntries } from "../src/card-ledger.js";
import { serializeCard } from "../src/card-serialize.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { CardStore } from "../src/card-store.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { CardAssignment } from "../src/card-assignments.js";
import { buildAssignmentPrompt } from "../src/card-handoff.js";
import { syncCards } from "../src/card-sync.js";
import { runCardCommand, type CardCommandDeps } from "../src/card-command.js";

const cat = (...parts: string[]): string => parts.join("");

function fakeAssignments(initial: CardAssignment[] = []) {
  const items = [...initial];
  return {
    items,
    record(
      input: { taskId: string; cardId: string; type: string },
      at: string,
    ) {
      if (items.some((item) => item.taskId === input.taskId)) return;
      items.push({ ...input, assignedAt: at });
    },
    forCard: (cardId: string) => items.filter((item) => item.cardId === cardId),
  };
}

function setup(overrides: Partial<CardCommandDeps> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "card-command-"));
  const rootDir = path.join(base, "cards");
  const store = new CardStore(rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const deps: CardCommandDeps = {
    rootDir,
    today: () => "2026-11-02",
    source: "discord",
    attachments: [],
    download: async () => {
      throw new Error("download was not expected");
    },
    readLocalFile: () => {
      throw new Error("readLocalFile was not expected");
    },
    now: () => "2026-11-02T08:15:00Z",
    assignments: fakeAssignments(),
    taskInfo: () => undefined,
    openPullRequest: async () => {
      throw new Error("openPullRequest was not expected");
    },
    policy: () => ({
      status: "missing" as const,
      policy: DEFAULT_POLICY,
      file: "/cfg/policy.yml",
    }),
    prepareWorktree: async () => {
      throw new Error("prepareWorktree was not expected");
    },
    cleanupWorktree: async () => {
      throw new Error("cleanupWorktree was not expected");
    },
    reviewPullRequest: async () => {
      throw new Error("reviewPullRequest was not expected");
    },
    fixCard: async () => {
      throw new Error("fixCard was not expected");
    },
    mergePullRequest: async () => {
      throw new Error("mergePullRequest was not expected");
    },
    waitForCi: async () => {
      throw new Error("waitForCi was not expected");
    },
    startTask: async () => {
      throw new Error("startTask was not expected");
    },
    ...overrides,
  };
  const run = (...args: string[]) => runCardCommand(args, deps);
  return { base, rootDir, store, deps, run };
}

const card = (id: string, patch: Partial<Card> = {}): Card => ({
  id,
  type: "requirement",
  status: "draft",
  title: `標題 ${id}`,
  version: 1,
  created: "2026-11-01",
  updated: "2026-11-01",
  body: `# 標題 ${id}\n\n## 描述\n內容 ${id}\n`,
  ...patch,
});

test("card list on a missing or empty directory says there are no cards and creates nothing", async () => {
  const { rootDir, run } = setup();
  assert.match(await run("list"), /沒有卡片/);
  assert.equal(fs.existsSync(rootDir), false);
});

test("card list shows id, status, type and title in file-name order", async () => {
  const { store, run } = setup();
  store.create(card("REQ-20261102-bravo", { status: "ready" }));
  store.create(card("TKT-20261102-alpha", { type: "ticket" }));
  store.create(card("REQ-20261102-alpha", { title: "第一張" }));
  const text = await run("list");
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(lines, [
    "- REQ-20261102-alpha · draft · requirement · 第一張",
    "- REQ-20261102-bravo · ready · requirement · 標題 REQ-20261102-bravo",
    "- TKT-20261102-alpha · draft · ticket · 標題 TKT-20261102-alpha",
  ]);
  assert.match(text, /共 3 張/);
});

test("card list filters by status and rejects an unknown status", async () => {
  const { store, run } = setup();
  store.create(card("REQ-20261102-aaa", { status: "ready" }));
  store.create(card("REQ-20261102-bbb"));
  const ready = await run("list", "ready");
  assert.match(ready, /REQ-20261102-aaa/);
  assert.doesNotMatch(ready, /REQ-20261102-bbb/);
  await assert.rejects(run("list", "bogus"), /status/);
});

test("card list shortens long titles and caps the number of lines", async () => {
  const { store, run } = setup();
  store.create(card("REQ-20261102-long", { title: "長".repeat(80) }));
  for (let i = 0; i < 34; i++)
    store.create(card(`REQ-20261102-n${String(i).padStart(2, "0")}`));
  const text = await run("list");
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 30);
  assert.match(text, /還有 5 張/);
  const longLine = (await run("list", "draft"))
    .split("\n")
    .find((l) => l.includes("REQ-20261102-long"));
  assert.ok(longLine === undefined || longLine.endsWith("…"));
});

test("card list reports invalid files separately, at most five", async () => {
  const { rootDir, store, run } = setup();
  store.create(card("REQ-20261102-good"));
  for (let i = 0; i < 7; i++)
    fs.writeFileSync(
      path.join(rootDir, `REQ-20261102-bad${i}.md`),
      "no frontmatter\n",
    );
  const text = await run("list");
  assert.match(text, /共 1 張/);
  assert.match(text, /不合格的檔案（7）/);
  assert.equal(
    text.split("\n").filter((l) => l.includes("frontmatter")).length,
    5,
  );
  assert.match(text, /另有 2 個/);
});

test(
  "card list refuses a cards directory that others can read",
  { skip: process.platform === "win32" },
  async () => {
    const { rootDir, store, run } = setup();
    store.create(card("REQ-20261102-aaa"));
    fs.chmodSync(rootDir, 0o755);
    await assert.rejects(run("list"), /chmod 700/);
  },
);

test("card show prints the summary, the human text and the five newest log entries", async () => {
  const { store, run } = setup();
  store.create(
    card("REQ-20261102-show", {
      status: "ready",
      source: "與使用者討論",
      projects: ["local:Foo"],
    }),
  );
  for (let i = 1; i <= 7; i++)
    store.recordEvent("REQ-20261102-show", {
      time: `2026-11-02T08:0${i}:00Z`,
      eventId: `ev000${i}`,
      event: "started",
      taskId: `task-${i}`,
    });
  const text = await run("show", "REQ-20261102-show");
  assert.match(text, /^REQ-20261102-show · requirement · ready（版本 1）/);
  assert.match(text, /標題 REQ-20261102-show/);
  assert.match(text, /建立 2026-11-01 · 更新 2026-11-02/);
  assert.match(text, /專案：local:Foo/);
  assert.match(text, /來源：與使用者討論/);
  assert.match(text, /內容 REQ-20261102-show/);
  const logLines = text
    .split("\n")
    .filter((l) => l.startsWith("- 2026-11-02T"));
  assert.equal(logLines.length, 5);
  assert.ok(logLines[0].includes("task-3") && logLines[4].includes("task-7"));
  assert.equal(text.includes("task-2"), false);
});

test("card show redacts secrets and shortens a long body", async () => {
  const { store, run } = setup();
  const token = cat("gh", "p_", "FAKEFAKEFAKE0123456789ABCD");
  store.create(
    card("REQ-20261102-secret", {
      body: `# t\n\n密鑰 ${token}\n\n${"字".repeat(3000)}\n`,
    }),
  );
  const text = await run("show", "REQ-20261102-secret");
  assert.equal(text.includes(token), false);
  assert.match(text, /\[redacted token\]/);
  assert.match(text, /已截斷，共 \d+ 字/);
  assert.ok(Array.from(text).length < 2500);
});

test("card show reports an unknown card, a malformed id and a missing id", async () => {
  const { store, run } = setup();
  store.create(card("REQ-20261102-aaa"));
  await assert.rejects(run("show", "REQ-20261102-missing"), /找不到/);
  await assert.rejects(run("show", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("show"), /usage/);
});

test("card with no or an unknown subcommand prints usage", async () => {
  const { run } = setup();
  await assert.rejects(run(), /usage/);
  await assert.rejects(run("frobnicate"), /usage/);
});

import { IMPORT_MAX_FILE_BYTES } from "../src/card.js";
import { readLocalCardFile } from "../src/card-command.js";

const foreignCard = `---
id: REQ-20261101-imported
type: requirement
status: in_progress
title: 外部來源的卡片
version: 3
created: 2026-10-01
updated: 2026-10-20
external: { notion: "page-1", github: null, mantis: null }
---

# 外部來源的卡片
`;
const withoutId = foreignCard.replace(/^id: .*\n/m, "");
const attachment = (name = "card.md", size = 200) => ({
  url: "https://cdn.discordapp.com/attachments/1/2/card.md",
  size,
  name,
});

function importSetup(text: string, extra: Partial<CardCommandDeps> = {}) {
  const downloads: Array<{ size: number; limit: number }> = [];
  const s = setup({
    attachments: [attachment()],
    download: async (item, limit) => {
      downloads.push({ size: item.size, limit });
      return text;
    },
    ...extra,
  });
  return { ...s, downloads };
}

test("importing an attached .md file stores a draft, reports what changed and asks for a review", async () => {
  const { rootDir, store, run, downloads } = importSetup(foreignCard);
  const reply = await run("import");
  assert.deepEqual(downloads, [{ size: 200, limit: IMPORT_MAX_FILE_BYTES }]);
  assert.match(reply, /已匯入 REQ-20261101-imported（draft）/);
  assert.match(reply, /status in_progress -> draft/);
  assert.match(reply, /審閱/);
  const read = store.read("REQ-20261101-imported");
  assert.equal(read.ok && read.card.status, "draft");
  assert.equal(read.ok && read.card.external, undefined);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(rootDir).mode & 0o777, 0o700);
    assert.equal(
      fs.statSync(path.join(rootDir, "REQ-20261101-imported.md")).mode & 0o777,
      0o600,
    );
  }
});

test("a card without an id needs --slug, which names the new id with today's date", async () => {
  const noSlug = importSetup(withoutId);
  await assert.rejects(noSlug.run("import"), /slug/);
  assert.deepEqual(
    fs.existsSync(noSlug.rootDir) ? fs.readdirSync(noSlug.rootDir) : [],
    [],
  );

  const withSlug = importSetup(withoutId);
  const reply = await withSlug.run("import", "--slug", "my-note");
  assert.match(reply, /REQ-20261102-my-note/);
  assert.equal(withSlug.store.read("REQ-20261102-my-note").ok, true);
});

test("on Discord exactly one .md attachment is required and nothing is downloaded otherwise", async () => {
  for (const attachments of [
    [],
    [attachment(), attachment()],
    [attachment("notes.txt")],
    [{ ...attachment(), name: null }],
    [attachment("card.md", IMPORT_MAX_FILE_BYTES + 1)],
    [attachment("card.md", 0)],
  ]) {
    const { run, downloads } = importSetup(foreignCard, { attachments });
    await assert.rejects(
      run("import"),
      /附上|\.md|大小|512/,
      JSON.stringify(attachments),
    );
    assert.equal(downloads.length, 0, JSON.stringify(attachments));
  }
});

test("on Discord a path argument is refused and no local file is read", async () => {
  let read = 0;
  const { run } = importSetup(foreignCard, {
    readLocalFile: () => {
      read++;
      return foreignCard;
    },
  });
  await assert.rejects(run("import", "/etc/passwd.md"), /路徑/);
  await assert.rejects(run("import", "../../secret.md"), /路徑/);
  assert.equal(read, 0);
});

test("in the console a local .md path is read, and attachments and missing paths are not used", async () => {
  const files: Record<string, string> = { "/tmp/card.md": foreignCard };
  const { run, store, downloads } = importSetup(foreignCard, {
    source: "console",
    attachments: [attachment()],
    readLocalFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  });
  await assert.rejects(run("import"), /usage/);
  await assert.rejects(run("import", "/tmp/card.txt"), /\.md/);
  await assert.rejects(run("import", "/tmp/missing.md"), /ENOENT/);
  const reply = await run("import", "/tmp/card.md");
  assert.match(reply, /已匯入/);
  assert.equal(store.read("REQ-20261101-imported").ok, true);
  assert.equal(downloads.length, 0);
});

test("an id that already exists is not overwritten, and an invalid card is rejected with the reason", async () => {
  const dup = importSetup(foreignCard);
  dup.store.create(card("REQ-20261101-imported", { title: "原本的卡片" }));
  await assert.rejects(dup.run("import"), /已存在|exists/);
  const kept = dup.store.read("REQ-20261101-imported");
  assert.equal(kept.ok && kept.card.title, "原本的卡片");

  const bad = importSetup("no frontmatter\n");
  await assert.rejects(bad.run("import"), /匯入失敗.*frontmatter/);
  assert.deepEqual(
    fs.existsSync(bad.rootDir) ? fs.readdirSync(bad.rootDir) : [],
    [],
  );
});

test(
  "import refuses a cards directory that others can read and an unknown option",
  { skip: process.platform === "win32" },
  async () => {
    const { rootDir, run } = importSetup(foreignCard);
    fs.mkdirSync(rootDir, { mode: 0o700 });
    fs.chmodSync(rootDir, 0o755);
    await assert.rejects(run("import"), /chmod 700/);
    assert.deepEqual(fs.readdirSync(rootDir), []);
    fs.chmodSync(rootDir, 0o700);
    await assert.rejects(run("import", "--frob"), /usage/);
  },
);

test("readLocalCardFile reads a regular UTF-8 .md file and refuses symlinks, directories, big and non-text files", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "card-local-"));
  const file = path.join(base, "card.md");
  fs.writeFileSync(file, "# 卡片\n");
  assert.equal(readLocalCardFile(file), "# 卡片\n");

  fs.symlinkSync(file, path.join(base, "link.md"));
  assert.throws(
    () => readLocalCardFile(path.join(base, "link.md")),
    /symbolic link/,
  );
  fs.mkdirSync(path.join(base, "dir.md"));
  assert.throws(
    () => readLocalCardFile(path.join(base, "dir.md")),
    /regular file/,
  );
  fs.writeFileSync(
    path.join(base, "big.md"),
    "a".repeat(IMPORT_MAX_FILE_BYTES + 1),
  );
  assert.throws(() => readLocalCardFile(path.join(base, "big.md")), /512 KiB/);
  fs.writeFileSync(path.join(base, "bin.md"), Buffer.from([0x23, 0xff, 0xfe]));
  assert.throws(() => readLocalCardFile(path.join(base, "bin.md")), /UTF-8/);
  assert.throws(() => readLocalCardFile(path.join(base, "none.md")), /ENOENT/);
});

const assignable = (id = "REQ-20261102-work", patch: Partial<Card> = {}) =>
  card(id, {
    status: "ready",
    body: "# 做事\n\n## 描述\n把報表匯出成 CSV。\n\n## 驗收條件\n- 可以下載\n",
    ...patch,
  });

const started = (taskId = "task-1111-aaaa") => ({
  taskId,
  lead: { agent: "codex", machine: "local" },
});

function assignSetup(overrides: Partial<CardCommandDeps> = {}) {
  const calls: Array<{ prompt: string; coding: boolean }> = [];
  const s = setup({
    startTask: async (prompt, options) => {
      calls.push({ prompt, coding: options.coding });
      return started();
    },
    ...overrides,
  });
  return { ...s, calls };
}

test("assign hands the card to a Team task, then records the task, the status and two log entries", async () => {
  const { store, run, calls } = assignSetup();
  store.create(assignable());
  const reply = await run("assign", "REQ-20261102-work");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].coding, false);
  assert.match(calls[0].prompt, /把報表匯出成 CSV。/);
  assert.match(reply, /已指派 REQ-20261102-work/);
  assert.match(reply, /task-1111-aaaa/);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.deepEqual(read.ok && read.card.tasks, ["task-1111-aaaa"]);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(
    log.ok && log.entries.map((e) => [e.event, e.text, e.eventId]),
    [
      ["assigned", "指派給 codex（local）", "task-1111-aaaa-assigned"],
      ["started", "開始執行 task task-1111-aaaa", "task-1111-aaaa-started"],
    ],
  );
});

test("assign --coding passes the coding flag, and extra arguments are refused", async () => {
  const { store, run, calls } = assignSetup();
  store.create(assignable());
  await assert.rejects(run("assign", "REQ-20261102-work", "--oops"), /usage/);
  await assert.rejects(run("assign"), /usage/);
  assert.equal(calls.length, 0);
  await run("assign", "REQ-20261102-work", "--coding");
  assert.equal(calls[0].coding, true);
});

test("only ready cards can be assigned, and a refusal changes nothing", async () => {
  for (const status of [
    "draft",
    "discussing",
    "refined",
    "in_progress",
    "done",
  ]) {
    const { store, run, calls, rootDir } = assignSetup();
    store.create(assignable("REQ-20261102-work", { status }));
    const file = path.join(rootDir, "REQ-20261102-work.md");
    const before = fs.readFileSync(file, "utf8");
    await assert.rejects(
      run("assign", "REQ-20261102-work"),
      new RegExp(`${status}.*ready|ready.*${status}`),
      status,
    );
    assert.equal(calls.length, 0, status);
    assert.equal(fs.readFileSync(file, "utf8"), before, status);
  }
});

test("assign refuses an invalid or unknown id and a missing directory without starting anything", async () => {
  const { run, calls } = assignSetup();
  await assert.rejects(run("assign", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("assign", "REQ-20261102-none"), /找不到卡片/);
  assert.equal(calls.length, 0);
});

test("a card without a description is refused before a task starts", async () => {
  const { store, run, calls } = assignSetup();
  store.create(assignable("REQ-20261102-work", { body: "# 只有標題\n" }));
  await assert.rejects(run("assign", "REQ-20261102-work"), /描述/);
  assert.equal(calls.length, 0);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "ready");
});

test("when the task cannot start the error reaches the caller and the card stays ready", async () => {
  const { store, run } = assignSetup({
    startTask: async () => {
      throw new Error("select a workspace first");
    },
  });
  store.create(assignable());
  await assert.rejects(
    run("assign", "REQ-20261102-work"),
    /select a workspace/,
  );
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "ready");
  assert.equal(read.ok && read.card.tasks, undefined);
});

test("if the card cannot be updated after the task started, the reply warns instead of failing", async () => {
  const { store, rootDir, run } = assignSetup({
    startTask: async () => {
      fs.rmSync(path.join(rootDir, "REQ-20261102-work.md"));
      return started();
    },
  });
  store.create(assignable());
  const reply = await run("assign", "REQ-20261102-work");
  assert.match(reply, /任務已啟動/);
  assert.match(reply, /卡片更新失敗/);
  assert.match(reply, /task-1111-aaaa/);
});

test("two assigns of the same card at once start only one task", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let starts = 0;
  const { store, run } = assignSetup({
    startTask: async () => {
      starts++;
      await gate;
      return started();
    },
  });
  store.create(assignable());
  const first = run("assign", "REQ-20261102-work");
  await assert.rejects(run("assign", "REQ-20261102-work"), /指派中/);
  release();
  await first;
  assert.equal(starts, 1);
  await assert.rejects(run("assign", "REQ-20261102-work"), /in_progress/);
});

test("the agent and machine written to the log come from the started task", async () => {
  const { store, run } = assignSetup({
    startTask: async () => ({
      taskId: "task-2222",
      lead: { agent: "claude", machine: "agy-pod" },
    }),
  });
  store.create(assignable());
  await run("assign", "REQ-20261102-work");
  const log = store.readLog("REQ-20261102-work");
  assert.equal(log.ok && log.entries[0].text, "指派給 claude（agy-pod）");
});

test("assign records which card the task came from, and a failure to record only warns", async () => {
  const assignments = fakeAssignments();
  const { store, run } = assignSetup({ assignments });
  store.create(assignable());
  await run("assign", "REQ-20261102-work");
  assert.deepEqual(
    assignments.items.map((a) => [a.taskId, a.cardId, a.type, a.assignedAt]),
    [
      [
        "task-1111-aaaa",
        "REQ-20261102-work",
        "requirement",
        "2026-11-02T08:15:00Z",
      ],
    ],
  );

  const broken = assignSetup({
    assignments: {
      ...fakeAssignments(),
      record: () => {
        throw new Error("disk full");
      },
    },
  });
  broken.store.create(assignable());
  const reply = await broken.run("assign", "REQ-20261102-work");
  assert.match(reply, /已指派/);
  assert.match(reply, /disk full/);
  assert.match(reply, /刪除/);
});

const recreateId = "REQ-20261102-work";
function recreateSetup(
  extra: Partial<CardCommandDeps> = {},
  taskIds = ["task-old"],
) {
  const prompt = buildAssignmentPrompt(
    assignable(recreateId, { title: "原本的標題" }),
  );
  assert.equal(prompt.ok, true);
  const assignments = fakeAssignments(
    taskIds.map((taskId, i) => ({
      taskId,
      cardId: recreateId,
      type: "ticket",
      assignedAt: `2026-11-02T08:0${i}:00Z`,
    })),
  );
  const s = setup({
    assignments,
    taskInfo: (taskId) => ({
      originalPrompt: prompt.ok ? prompt.prompt : "",
      lead: { agent: "claude", machine: "local" },
      state: taskId === "task-old" ? "running" : "running",
    }),
    ...extra,
  });
  return { ...s, assignments };
}

test("recreate rebuilds a deleted card from the task record as an in-progress card with the task attached", async () => {
  const { store, run } = recreateSetup();
  const reply = await run("recreate", recreateId);
  const read = store.read(recreateId);
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.equal(read.ok && read.card.type, "ticket");
  assert.equal(read.ok && read.card.title, "原本的標題");
  assert.deepEqual(read.ok && read.card.tasks, ["task-old"]);
  assert.equal(read.ok && read.card.created, "2026-11-02");
  assert.ok(read.ok && read.card.body.includes("## 描述\n把報表匯出成 CSV。"));
  assert.ok(read.ok && read.card.body.includes("## 驗收條件\n- 可以下載"));
  assert.ok(read.ok && read.card.body.includes("重建"));
  const log = store.readLog(recreateId);
  assert.deepEqual(log.ok && log.entries.map((e) => e.eventId), [
    "task-old-assigned",
    "task-old-started",
  ]);
  assert.match(reply, /已重建 REQ-20261102-work/);
  assert.match(reply, /無法還原/);
});

test("recreate attaches every task of the card and rebuilds from the latest one", async () => {
  const { store, run } = recreateSetup({}, ["task-old", "task-new"]);
  await run("recreate", recreateId);
  const read = store.read(recreateId);
  assert.deepEqual(read.ok && read.card.tasks, ["task-old", "task-new"]);
  const log = store.readLog(recreateId);
  assert.deepEqual(log.ok && log.entries.map((e) => e.eventId), [
    "task-new-assigned",
    "task-new-started",
  ]);
});

test("recreate refuses when the card exists, when nothing is known about it, or when the record is unusable", async () => {
  const existing = recreateSetup();
  existing.store.create(assignable(recreateId, { title: "還在的卡片" }));
  const file = path.join(existing.rootDir, `${recreateId}.md`);
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(existing.run("recreate", recreateId), /已存在/);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const unknown = recreateSetup();
  await assert.rejects(
    unknown.run("recreate", "REQ-20261102-other"),
    /沒有.*任務/,
  );

  const gone = recreateSetup({ taskInfo: () => undefined });
  await assert.rejects(gone.run("recreate", recreateId), /任務紀錄/);
  assert.equal(
    fs.existsSync(path.join(gone.rootDir, `${recreateId}.md`)),
    false,
  );

  const garbled = recreateSetup({
    taskInfo: () => ({
      originalPrompt: "不是卡片 prompt",
      lead: { agent: "claude", machine: "local" },
      state: "running",
    }),
  });
  await assert.rejects(garbled.run("recreate", recreateId), /資料區塊/);

  await assert.rejects(unknown.run("recreate", "../x"), /不是合法的卡片 id/);
  await assert.rejects(unknown.run("recreate"), /usage/);
  await assert.rejects(unknown.run("recreate", recreateId, "extra"), /usage/);
});

test("recreate creates the cards directory when it is gone, and refuses an unsafe one", async () => {
  const fresh = recreateSetup();
  assert.equal(fs.existsSync(fresh.rootDir), false);
  await fresh.run("recreate", recreateId);
  assert.equal(
    fs.existsSync(path.join(fresh.rootDir, `${recreateId}.md`)),
    true,
  );

  if (process.platform === "win32") return;
  const unsafe = recreateSetup();
  fs.mkdirSync(unsafe.rootDir, { mode: 0o700 });
  fs.chmodSync(unsafe.rootDir, 0o755);
  await assert.rejects(unsafe.run("recreate", recreateId), /chmod 700/);
});

const preparedWorktree = {
  workspaceId: "w9",
  path: "/Users/jon/.herdr/worktrees/repo/card-req-20261102-work",
  branch: "card/REQ-20261102-work",
  repoPath: "/Users/jon/git_wk/repo",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  agent: { agent: "claude", pane_id: "w9:p1", agent_status: "idle" },
  agentReady: true,
};

function worktreeSetup(overrides: Partial<CardCommandDeps> = {}) {
  const prepared: string[] = [];
  const s = assignSetup({
    prepareWorktree: async (card) => {
      prepared.push(card.id);
      return preparedWorktree as never;
    },
    ...overrides,
  });
  return { ...s, prepared };
}

test("assign --worktree prepares the worktree first, records the project and the event, then starts the task", async () => {
  const { store, run, calls, prepared } = worktreeSetup();
  store.create(assignable());
  const reply = await run("assign", "REQ-20261102-work", "--worktree");
  assert.deepEqual(prepared, ["REQ-20261102-work"]);
  assert.equal(calls.length, 1);
  assert.match(reply, /已指派 REQ-20261102-work/);
  assert.match(reply, /card-req-20261102-work/);
  assert.match(reply, /w9/);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "in_progress");
  assert.deepEqual(read.ok && read.card.projects, ["local:repo"]);
  assert.ok(
    read.ok &&
      read.card.body.includes(
        "- worktree：/Users/jon/.herdr/worktrees/repo/card-req-20261102-work",
      ),
  );
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.event), [
    "worktree_created",
    "assigned",
    "started",
  ]);
});

test("assign without --worktree never touches worktrees, and --worktree combines with --coding", async () => {
  const plain = worktreeSetup();
  plain.store.create(assignable());
  await plain.run("assign", "REQ-20261102-work");
  assert.deepEqual(plain.prepared, []);

  const both = worktreeSetup();
  both.store.create(assignable());
  await both.run("assign", "REQ-20261102-work", "--worktree", "--coding");
  assert.deepEqual(both.prepared, ["REQ-20261102-work"]);
  assert.equal(both.calls[0].coding, true);
});

test("--worktree on a card that cannot be assigned prepares nothing", async () => {
  const { store, run, prepared } = worktreeSetup();
  store.create(assignable("REQ-20261102-work", { status: "draft" }));
  await assert.rejects(
    run("assign", "REQ-20261102-work", "--worktree"),
    /ready/,
  );
  store.create(assignable("REQ-20261102-nodesc", { body: "# t\n" }));
  await assert.rejects(
    run("assign", "REQ-20261102-nodesc", "--worktree"),
    /描述/,
  );
  assert.deepEqual(prepared, []);
});

test("if the worktree cannot be prepared the error reaches the caller and the card is untouched", async () => {
  const { store, run, calls } = worktreeSetup({
    prepareWorktree: async () => {
      throw new Error("目前 Agent 的工作目錄 /x 不在 git repository 內");
    },
  });
  store.create(assignable());
  await assert.rejects(
    run("assign", "REQ-20261102-work", "--worktree"),
    /不在 git/,
  );
  assert.equal(calls.length, 0);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "ready");
  assert.equal(read.ok && read.card.projects, undefined);
});

test("if the task cannot start after the worktree exists the error says where the worktree is and how to continue", async () => {
  const { store, run } = worktreeSetup({
    startTask: async () => {
      throw new Error("Lead pane is busy");
    },
  });
  store.create(assignable());
  await assert.rejects(
    run("assign", "REQ-20261102-work", "--worktree"),
    (error: unknown) =>
      error instanceof Error &&
      /Lead pane is busy/.test(error.message) &&
      /card-req-20261102-work/.test(error.message) &&
      /card assign REQ-20261102-work/.test(error.message) &&
      /card cleanup/.test(error.message),
  );
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "ready");
  assert.deepEqual(read.ok && read.card.projects, ["local:repo"]);
});

test("a missing base sha still records the project but skips the worktree event", async () => {
  const { store, run } = worktreeSetup({
    prepareWorktree: async () =>
      ({ ...preparedWorktree, baseSha: undefined }) as never,
  });
  store.create(assignable());
  await run("assign", "REQ-20261102-work", "--worktree");
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.event), [
    "assigned",
    "started",
  ]);
  const read = store.read("REQ-20261102-work");
  assert.deepEqual(read.ok && read.card.projects, ["local:repo"]);
});

const cleanedUp = {
  removed: true as const,
  workspaceId: "w9",
  path: preparedWorktree.path,
  branch: preparedWorktree.branch,
  repoPath: preparedWorktree.repoPath,
};

test("cleanup reports the removal, keeps the branch and the source workspace, and logs cleanup_done", async () => {
  const { store, run } = setup({ cleanupWorktree: async () => cleanedUp });
  store.create(assignable("REQ-20261102-work", { status: "in_progress" }));
  const reply = await run("cleanup", "REQ-20261102-work");
  assert.match(reply, /已移除 worktree/);
  assert.match(reply, /分支 card\/REQ-20261102-work 仍保留/);
  assert.match(reply, /來源 repo 的 workspace/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.text]), [
    ["cleanup_done", "清理完成：removed"],
  ]);
});

test("cleanup keeps a worktree with uncommitted changes, says so, and logs cleanup_pending", async () => {
  const { store, run } = setup({
    cleanupWorktree: async () => ({
      removed: false as const,
      reason: "dirty_worktree" as const,
      workspaceId: "w9",
      path: preparedWorktree.path,
      branch: preparedWorktree.branch,
      repoPath: preparedWorktree.repoPath,
    }),
  });
  store.create(assignable("REQ-20261102-work", { status: "in_progress" }));
  const reply = await run("cleanup", "REQ-20261102-work");
  assert.match(reply, /未提交/);
  assert.match(reply, /保留/);
  assert.match(reply, /card-req-20261102-work/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.text]), [
    ["cleanup_pending", "清理待處理：dirty_worktree"],
  ]);
});

test("cleanup validates its arguments, passes errors through, and still reports when the card is gone", async () => {
  const { run } = setup({ cleanupWorktree: async () => cleanedUp });
  await assert.rejects(run("cleanup"), /usage/);
  await assert.rejects(run("cleanup", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("cleanup", "REQ-20261102-work", "x"), /usage/);
  assert.match(await run("cleanup", "REQ-20261102-work"), /已移除 worktree/);

  const failing = setup({
    cleanupWorktree: async () => {
      throw new Error("卡片 REQ-20261102-work 沒有作用中的 worktree");
    },
  });
  await assert.rejects(
    failing.run("cleanup", "REQ-20261102-work"),
    /沒有作用中/,
  );
});

test("when the new Agent is blocked the worktree is recorded on the card, no task starts, and the reply says what to do", async () => {
  const { store, run, calls } = worktreeSetup({
    prepareWorktree: async () =>
      ({
        ...preparedWorktree,
        agent: { agent: "claude", pane_id: "w9:p1", agent_status: "blocked" },
        agentReady: false,
      }) as never,
  });
  store.create(assignable());
  const reply = await run("assign", "REQ-20261102-work", "--worktree");
  assert.equal(calls.length, 0);
  assert.match(reply, /blocked/);
  assert.match(reply, /信任/);
  assert.match(reply, /card assign REQ-20261102-work/);
  assert.match(reply, /card cleanup REQ-20261102-work/);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "ready");
  assert.deepEqual(read.ok && read.card.projects, ["local:repo"]);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.event), [
    "worktree_created",
  ]);
});

test("the card shows the worktree as active after assign and as removed or kept after cleanup, in place", async () => {
  const { store, run } = worktreeSetup({
    cleanupWorktree: async () => cleanedUp,
  });
  store.create(assignable());
  await run("assign", "REQ-20261102-work", "--worktree");
  const active = store.read("REQ-20261102-work");
  assert.ok(active.ok && active.card.body.includes("- worktree 狀態：作用中"));
  assert.match(await run("show", "REQ-20261102-work"), /worktree 狀態：作用中/);

  await run("cleanup", "REQ-20261102-work");
  const removed = store.read("REQ-20261102-work");
  assert.ok(
    removed.ok &&
      removed.card.body.includes("- worktree 狀態：已清理（分支保留）"),
  );
  assert.equal(removed.ok && removed.card.body.includes("作用中"), false);
  assert.equal(
    removed.ok && removed.card.body.split("- worktree 狀態：").length - 1,
    1,
  );
});

test("a kept dirty worktree is visible on the card", async () => {
  const { store, run } = setup({
    cleanupWorktree: async () => ({
      removed: false as const,
      reason: "dirty_worktree" as const,
      workspaceId: "w9",
      path: preparedWorktree.path,
      branch: preparedWorktree.branch,
      repoPath: preparedWorktree.repoPath,
    }),
  });
  store.create(assignable("REQ-20261102-work", { status: "in_progress" }));
  await run("cleanup", "REQ-20261102-work");
  assert.match(
    await run("show", "REQ-20261102-work"),
    /worktree 狀態：保留（有未提交修改）/,
  );
});

const withDecision = (decision: string) =>
  assignable("REQ-20261102-work", {
    body: `# 做事\n\n## 描述\n把報表匯出成 CSV。\n\n## 決議\n${decision}\n\n## 驗收條件\n- 可以下載\n`,
  });

test("card show prints the free-text decisions on their own, once, and redacts secrets", async () => {
  const { store, run } = setup();
  const token = cat("ghp_", "d".repeat(36));
  store.create(
    withDecision(
      `- 2026-11-03 Agent：改用串流輸出，避免大檔 OOM\n- 連線用 ${token}`,
    ),
  );
  const text = await run("show", "REQ-20261102-work");
  assert.match(text, /── 決議 ──\n- 2026-11-03 Agent：改用串流輸出/);
  assert.equal(text.split("改用串流輸出").length - 1, 1);
  assert.equal(text.includes(token), false);
  assert.match(text, /把報表匯出成 CSV。/);
  assert.match(text, /可以下載/);
});

test("a long decision section is cut with a notice, and a card without one shows no decision header", async () => {
  const { store, run } = setup();
  store.create(withDecision("決".repeat(1500)));
  const long = await run("show", "REQ-20261102-work");
  assert.match(long, /…（已截斷，共 1500 字；完整內容請開卡片檔）/);

  const plain = setup();
  plain.store.create(assignable("REQ-20261102-work"));
  assert.equal(
    (await plain.run("show", "REQ-20261102-work")).includes("決議"),
    false,
  );
});

const loadedPolicy = (
  status: "loaded" | "missing" | "invalid" | "unsafe",
  policy = DEFAULT_POLICY,
  error?: string,
) => ({ status, policy, file: "/cfg/policy.yml", ...(error ? { error } : {}) });

test("card policy says the file is missing and that every project is L0", async () => {
  const { run } = setup({ policy: () => loadedPolicy("missing") });
  const text = await run("policy");
  assert.match(text, /不存在/);
  assert.match(text, /\/cfg\/policy\.yml/);
  assert.match(text, /預設等級：L0/);
  assert.match(text, /尚未有任何動作依政策行為/);
});

test("card policy lists the loaded default and projects, and one project's effective level", async () => {
  const policy = {
    default: "L0" as const,
    projects: { "local:Foo": "L1" as const, "agy-pod:Bar": "L2" as const },
  };
  const { run } = setup({ policy: () => loadedPolicy("loaded", policy) });
  const text = await run("policy");
  assert.match(text, /已載入/);
  assert.match(text, /- local:Foo → L1/);
  assert.match(text, /- agy-pod:Bar → L2/);
  assert.match(await run("policy", "local:Foo"), /local:Foo → L1/);
  assert.match(
    await run("policy", "local:Unlisted"),
    /local:Unlisted → L0（沒列出，用預設等級）/,
  );
  await assert.rejects(run("policy", "bad name"), /專案名稱/);
  await assert.rejects(run("policy", "local:Foo", "extra"), /usage/);
});

test("card policy shows which projects are opted in to auto-pick, with the repo, the Lead kind and the level", async () => {
  const policy = {
    default: "L0" as const,
    projects: { "local:Foo": "L2" as const },
    autopick: { "local:Foo": "/Users/jon/git_wk/Foo" },
    autopickLead: "codex" as const,
  };
  const { run } = setup({ policy: () => loadedPolicy("loaded", policy) });
  const text = await run("policy");
  assert.match(text, /自動撿卡（Lead：codex；一次一張/);
  assert.match(text, /- local:Foo → \/Users\/jon\/git_wk\/Foo（L2）/);

  const plain = setup({ policy: () => loadedPolicy("loaded") });
  assert.doesNotMatch(await plain.run("policy"), /自動撿卡/);
});

test("card policy reports an invalid or unsafe file and that the safe default is in use", async () => {
  for (const status of ["invalid", "unsafe"] as const) {
    const { run } = setup({
      policy: () =>
        loadedPolicy(status, DEFAULT_POLICY, "line 3: invalid level"),
    });
    const text = await run("policy");
    assert.match(text, /line 3: invalid level/, status);
    assert.match(text, /全部 L0/, status);
    assert.match(await run("policy", "local:Foo"), /local:Foo → L0/, status);
  }
});

const prOutcome = {
  created: true,
  number: 42,
  url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  base: "main",
  branch: "card/REQ-20261102-work",
  repo: "jon888465/Herdr_Discord_Bridge",
  repoPath: "/Users/jon/git_wk/Herdr_Discord_Bridge",
  sensitivePaths: [] as string[] | null,
};

test("card pr opens the pull request, prints its full URL, and records it on the card", async () => {
  const seen: string[] = [];
  const { store, run } = setup({
    openPullRequest: async (card) => {
      seen.push(`${card.id}:${card.status}`);
      return prOutcome;
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("pr", "REQ-20261102-work");
  assert.deepEqual(seen, ["REQ-20261102-work:done"]);
  assert.match(
    reply,
    /https:\/\/github\.com\/jon888465\/Herdr_Discord_Bridge\/pull\/42/,
  );
  assert.match(reply, /#42/);
  assert.match(reply, /main/);
  assert.match(reply, /CI/);
  const read = store.read("REQ-20261102-work");
  assert.ok(
    read.ok &&
      read.card.body.includes(
        "- PR：https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
      ),
  );
  assert.ok(read.ok && read.card.body.includes("- head：0123456789ab"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.eventId]), [
    ["pr_opened", "pr-42-opened"],
  ]);
  assert.match(
    (log.ok && log.entries[0].text) || "",
    /^PR #42 0123456789ab https:\/\/github\.com\//,
  );
});

test("card pr syncs a completed task before reading its stale in_progress card", async () => {
  const seen: string[] = [];
  const { store, rootDir, run } = setup({
    syncCard: (id) => {
      seen.push(`sync:${id}`);
      return syncCards({
        rootDir,
        cardId: id,
        tasks: {
          get: () => ({
            state: "completed",
            finishedAt: "2026-11-06T01:00:00Z",
          }),
        },
        now: () => "2026-11-06T01:00:00Z",
      });
    },
    openPullRequest: async (card) => {
      seen.push(`open:${card.status}`);
      if (card.status !== "done") throw new Error("只有 done 的卡片可以開 PR");
      return prOutcome;
    },
  });
  store.create(
    assignable("REQ-20261102-work", {
      status: "in_progress",
      tasks: ["task-a"],
    }),
  );
  await run("pr", "REQ-20261102-work");
  assert.deepEqual(seen, ["sync:REQ-20261102-work", "open:done"]);
  const read = store.read("REQ-20261102-work");
  assert.equal(read.ok && read.card.status, "done");
});

test("card pr still refuses a stale card whose task is running", async () => {
  const { store, rootDir, run } = setup({
    syncCard: (id) =>
      syncCards({
        rootDir,
        cardId: id,
        tasks: { get: () => ({ state: "running" }) },
        now: () => "2026-11-06T01:00:00Z",
      }),
    openPullRequest: async (card) => {
      if (card.status !== "done")
        throw new Error(
          `卡片 ${card.id} 的狀態是 ${card.status}；只有 done 的卡片可以開 PR`,
        );
      return prOutcome;
    },
  });
  store.create(
    assignable("REQ-20261102-work", {
      status: "in_progress",
      tasks: ["task-a"],
    }),
  );
  await assert.rejects(
    run("pr", "REQ-20261102-work"),
    /狀態是 in_progress；只有 done 的卡片可以開 PR/,
  );
});

test("card pr ignores sync exceptions and reported problems before the existing status refusal", async () => {
  for (const syncCard of [
    () => {
      throw new Error("sync failed");
    },
    () => ({ updated: [], missing: [], problems: ["sync failed"] }),
  ]) {
    const { store, run } = setup({
      syncCard,
      openPullRequest: async (card) => {
        if (card.status !== "done")
          throw new Error(
            `卡片 ${card.id} 的狀態是 ${card.status}；只有 done 的卡片可以開 PR`,
          );
        return prOutcome;
      },
    });
    store.create(
      assignable("REQ-20261102-work", {
        status: "in_progress",
        tasks: ["task-a"],
      }),
    );
    await assert.rejects(
      run("pr", "REQ-20261102-work"),
      /狀態是 in_progress；只有 done 的卡片可以開 PR/,
    );
  }
});

test("card pr on a branch that already had an open PR says it only pushed, and logs no new pr_opened", async () => {
  const { store, run } = setup({
    openPullRequest: async () => ({ ...prOutcome, created: false, base: "" }),
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("pr", "REQ-20261102-work");
  assert.match(reply, /已有.*PR #42/);
  assert.match(reply, /push/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("card pr passes the flow's refusals through and changes nothing on the card", async () => {
  const { store, run, rootDir } = setup({
    openPullRequest: async () => {
      throw new Error("專案 local:repo 的政策等級是 L0（不 push）");
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const file = path.join(rootDir, "REQ-20261102-work.md");
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(run("pr", "REQ-20261102-work"), /L0/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("card pr validates its arguments and the card", async () => {
  const { run } = setup({
    openPullRequest: async () => {
      throw new Error("openPullRequest was not expected");
    },
  });
  await assert.rejects(run("pr"), /usage/);
  await assert.rejects(run("pr", "REQ-20261102-work", "x"), /usage/);
  await assert.rejects(run("pr", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("pr", "REQ-20261102-none"), /找不到卡片/);
});

test("cleanup refuses while the card's latest task is still running and does not touch the worktree", async () => {
  let removed = false;
  const assignments = fakeAssignments([
    {
      taskId: "task-old",
      cardId: "REQ-20261102-work",
      type: "requirement",
      assignedAt: "2026-11-02T08:00:00Z",
    },
    {
      taskId: "task-live",
      cardId: "REQ-20261102-work",
      type: "requirement",
      assignedAt: "2026-11-02T09:00:00Z",
    },
  ]);
  for (const state of ["planning", "running", "synthesizing", "cancelling"]) {
    const { run } = setup({
      assignments,
      taskInfo: (taskId) => ({
        originalPrompt: "",
        lead: { agent: "agy", machine: "local" },
        state: taskId === "task-live" ? state : "completed",
      }),
      cleanupWorktree: async () => {
        removed = true;
        return cleanedUp;
      },
    });
    await assert.rejects(
      run("cleanup", "REQ-20261102-work"),
      /任務 task-live（.*）尚未結束/,
    );
  }
  assert.equal(removed, false);
});

test("cleanup proceeds once the latest task reached a terminal or blocked state", async () => {
  for (const state of ["completed", "failed", "cancelled", "blocked"]) {
    const assignments = fakeAssignments([
      {
        taskId: "task-1",
        cardId: "REQ-20261102-work",
        type: "requirement",
        assignedAt: "2026-11-02T09:00:00Z",
      },
    ]);
    const { run } = setup({
      assignments,
      taskInfo: () => ({
        originalPrompt: "",
        lead: { agent: "agy", machine: "local" },
        state,
      }),
      cleanupWorktree: async () => cleanedUp,
    });
    assert.match(await run("cleanup", "REQ-20261102-work"), /已移除 worktree/);
  }
});

test("card pr warns when the PR touches sensitive paths, listing them, and says this changes nothing yet (F6)", async () => {
  const { store, run } = setup({
    openPullRequest: async () => ({
      ...prOutcome,
      sensitivePaths: [".github/workflows/ci.yml", "SPEC.md"],
    }),
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("pr", "REQ-20261102-work");
  assert.match(reply, /敏感路徑/);
  assert.match(reply, /\.github\/workflows\/ci\.yml/);
  assert.match(reply, /SPEC\.md/);
  assert.match(reply, /L2/);
});

test("card pr says nothing about sensitive paths when there are none", async () => {
  const { store, run } = setup({ openPullRequest: async () => prOutcome });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  assert.doesNotMatch(await run("pr", "REQ-20261102-work"), /敏感路徑/);
});

test("card pr says when it could not check the PR's files, and that this counts as sensitive later", async () => {
  const { store, run } = setup({
    openPullRequest: async () => ({ ...prOutcome, sensitivePaths: null }),
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("pr", "REQ-20261102-work");
  assert.match(reply, /無法確認/);
  assert.match(reply, /敏感/);
});

test("the sensitive-path warning also shows when an existing PR got new commits", async () => {
  const { store, run } = setup({
    openPullRequest: async () => ({
      ...prOutcome,
      created: false,
      base: "",
      sensitivePaths: ["package.json"],
    }),
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  assert.match(
    await run("pr", "REQ-20261102-work"),
    /敏感路徑.*package\.json/s,
  );
});

const FINDING_HEAD = "0123456789abcdef0123456789abcdef01234567";
const findingOf = (summary: string, severity: "high" | "medium" | "low" = "high") => ({
  severity,
  path: "src/foo.ts",
  lineStart: 12,
  lineEnd: 20,
  summary,
});

test("card show lists the findings counts and the open findings in their own block, not inside the content (F8)", async () => {
  const { store, run } = setup();
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const recorded = store.recordFindings(
    "REQ-20261102-work",
    {
      round: 1,
      scope: "whole",
      headSha: FINDING_HEAD,
      verdict: "changes_requested",
      findings: [findingOf("缺少錯誤處理"), findingOf("命名不清楚", "low")],
    },
    "2026-11-04",
  );
  assert.ok(recorded.ok);
  store.setFindingStatus("REQ-20261102-work", "F2", "resolved", "2026-11-04");
  const reply = await run("show", "REQ-20261102-work");
  assert.match(reply, /── Review 發現/);
  assert.match(reply, /共 2 筆/);
  assert.match(reply, /open 1/);
  assert.match(reply, /resolved 1/);
  assert.match(reply, /- F1 · high · src\/foo\.ts:12-20 · 缺少錯誤處理（第 1 輪）/);
  assert.equal(reply.includes("命名不清楚"), false); // 已 resolved 的不列
  const content = reply.slice(reply.indexOf("── 內容 ──"), reply.indexOf("── Review 發現"));
  assert.equal(content.includes("F1 |"), false);
  assert.equal(reply.split("F1 ·").length, 2);
});

test("card show caps the open findings it lists and says how many more there are", async () => {
  const { store, run } = setup();
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  store.recordFindings(
    "REQ-20261102-work",
    {
      round: 1,
      scope: "whole",
      headSha: FINDING_HEAD,
      verdict: "changes_requested",
      findings: Array.from({ length: 13 }, (_, i) => findingOf(`問題 ${i + 1}`)),
    },
    "2026-11-04",
  );
  const reply = await run("show", "REQ-20261102-work");
  assert.match(reply, /共 13 筆/);
  assert.match(reply, /問題 10/);
  assert.equal(reply.includes("問題 11"), false);
  assert.match(reply, /還有 3 筆 open/);
});

test("card show without findings has no findings block", async () => {
  const { store, run } = setup();
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  assert.doesNotMatch(await run("show", "REQ-20261102-work"), /Review 發現/);
});

// ---- card review（F5 階段 3d）----

const REVIEW_HEAD = "0123456789abcdef0123456789abcdef01234567";
const reviewOk = (patch: Record<string, unknown> = {}, round = 1) => ({
  pr: {
    number: 42,
    url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
    headSha: REVIEW_HEAD,
  },
  result: {
    ok: true as const,
    batch: {
      round,
      scope: "whole",
      headSha: REVIEW_HEAD,
      verdict: "changes_requested" as const,
      findings: [
        { severity: "high" as const, path: "src/export.ts", lineStart: 3, lineEnd: 9, summary: "缺少錯誤處理" },
      ],
    },
    criteria: [{ index: 1, criterion: "可以下載", status: "unmet" as const }],
    reviewerKind: "codex",
    sameKind: false,
    omitted: 0,
    closed: true,
    ...patch,
  },
});

function reviewSetup(overrides: Partial<CardCommandDeps> = {}) {
  const calls: Array<{ id: string; agent?: string; round: number }> = [];
  const s = setup({
    reviewPullRequest: async (card, options) => {
      calls.push({ id: card.id, agent: options.agent, round: options.round });
      return reviewOk({}, options.round);
    },
    ...overrides,
  });
  s.store.create(assignable("REQ-20261102-work", { status: "done" }));
  return { ...s, calls };
}

test("card review validates its arguments and the card id", async () => {
  const { run } = reviewSetup();
  await assert.rejects(run("review"), /usage/);
  await assert.rejects(run("review", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("review", "REQ-20261102-work", "--agent"), /usage/);
  await assert.rejects(run("review", "REQ-20261102-work", "--bogus"), /usage/);
  await assert.rejects(run("review", "REQ-20261102-work", "extra"), /usage/);
  await assert.rejects(run("review", "REQ-20261102-missing"), /找不到卡片/);
});

test("card review runs the review, writes the findings and a review_verdict event to the card, and replies with the PR URL", async () => {
  const { store, run, calls } = reviewSetup();
  const reply = await run("review", "REQ-20261102-work");
  assert.deepEqual(calls, [{ id: "REQ-20261102-work", agent: undefined, round: 1 }]);
  assert.match(reply, /https:\/\/github\.com\/jon888465\/Herdr_Discord_Bridge\/pull\/42/);
  assert.match(reply, /F1 · high · src\/export\.ts:3-9 · 缺少錯誤處理/);
  assert.match(reply, /已寫入卡片/);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("## Review 發現"));
  assert.ok(read.ok && read.card.body.includes("- F1 | high | open | src/export.ts:3-9 | 缺少錯誤處理"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.text]), [
    ["review_verdict", "review reviewer 第 1 輪：changes_requested"],
  ]);
});

test("card review passes --agent through and counts rounds up on each run", async () => {
  const { store, run, calls } = reviewSetup();
  await run("review", "REQ-20261102-work", "--agent", "codex");
  await run("review", "REQ-20261102-work");
  assert.deepEqual(calls, [
    { id: "REQ-20261102-work", agent: "codex", round: 1 },
    { id: "REQ-20261102-work", agent: undefined, round: 2 },
  ]);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.text), [
    "review reviewer 第 1 輪：changes_requested",
    "review reviewer 第 2 輪：changes_requested",
  ]);
});

test("an inconclusive review is recorded too, as an empty batch and a verdict event, with its reason in the reply", async () => {
  const { store, run } = reviewSetup({
    reviewPullRequest: async (_card, options) => {
      const base = reviewOk({}, options.round);
      return {
        ...base,
        result: {
          ...base.result,
          batch: { ...base.result.batch, verdict: "inconclusive" as const, findings: [] },
          criteria: [],
          inconclusiveReason: "reviewer 沒有就緒（狀態 blocked）",
        },
      };
    },
  });
  const reply = await run("review", "REQ-20261102-work");
  assert.match(reply, /inconclusive/);
  assert.match(reply, /沒有就緒/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.text), ["review reviewer 第 1 輪：inconclusive"]);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("### 第 1 輪 · 整體 · head 0123456789ab · inconclusive"));
});

test("a review that never started changes nothing on the card and says which stage stopped", async () => {
  const { store, run } = reviewSetup({
    reviewPullRequest: async () => ({
      pr: reviewOk().pr,
      result: { ok: false as const, stage: "start" as const, error: "agent.start: unsupported_agent_kind" },
    }),
  });
  await assert.rejects(run("review", "REQ-20261102-work"), /start.*unsupported_agent_kind/s);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && !read.card.body.includes("Review 發現"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("a precondition refusal from the flow is passed through and the card is untouched", async () => {
  const { store, run } = reviewSetup({
    reviewPullRequest: async () => {
      throw new Error("卡片 REQ-20261102-work 沒有開著的 PR（先 `card pr`）");
    },
  });
  await assert.rejects(run("review", "REQ-20261102-work"), /沒有開著的 PR/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("only one review per card runs at a time, and the card can be reviewed again afterwards", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const { run } = reviewSetup({
    reviewPullRequest: async (_card, options) => {
      if (first) {
        first = false;
        await gate;
      }
      return reviewOk({}, options.round);
    },
  });
  const running = run("review", "REQ-20261102-work");
  await assert.rejects(run("review", "REQ-20261102-work"), /正在 review/);
  release();
  await running;
  await run("review", "REQ-20261102-work");
});

test("when the findings cannot be written the verdict is still logged, the reply says it was not written, and nothing is thrown", async () => {
  const { store, run } = reviewSetup();
  for (let round = 1; round <= 4; round++)
    store.recordFindings(
      "REQ-20261102-work",
      {
        round,
        scope: "whole",
        headSha: REVIEW_HEAD,
        verdict: "changes_requested",
        findings: Array.from({ length: 25 }, () => ({ severity: "low" as const, path: "src/a.ts", summary: "x" })),
      },
      "2026-11-04",
    );
  const reply = await run("review", "REQ-20261102-work");
  assert.match(reply, /沒有寫入卡片/);
  assert.match(reply, /100/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.event), ["review_verdict"]);
});

// ---- card fix（F5 的 loop 手動版）----

const FIX_A = "a".repeat(40);
const FIX_B = "b".repeat(40);

function fixSetup(overrides: Partial<CardCommandDeps> = {}, reviewRound = 1) {
  const calls: Array<{ agent?: string; round: number; ids: string[] }> = [];
  const s = setup({
    fixCard: async (_card, options) => {
      calls.push({
        agent: options.agent,
        round: options.round,
        ids: options.findings.map((f) => f.id),
      });
      return {
        ok: true as const,
        fixerKind: "claude",
        closed: true,
        outcome: {
          kind: "fixed" as const,
          fixed: options.findings.map((f) => f.id),
          skipped: [],
          headBefore: FIX_A,
          headAfter: FIX_B,
          files: ["src/export.ts"],
          sensitivePaths: [],
        },
      };
    },
    ...overrides,
  });
  s.store.create(assignable("REQ-20261102-work", { status: "done" }));
  for (let round = 1; round <= reviewRound; round++)
    s.store.recordFindings(
      "REQ-20261102-work",
      {
        round,
        scope: "whole",
        headSha: REVIEW_HEAD,
        verdict: "changes_requested",
        findings: [
          { severity: "high", path: "src/export.ts", lineStart: 3, lineEnd: 9, summary: `缺少錯誤處理 ${round}` },
          { severity: "low", path: "test/export.test.ts", summary: `命名 ${round}` },
        ],
      },
      "2026-11-04",
    );
  return { ...s, calls };
}

test("card fix validates its arguments and the card id", async () => {
  const { run } = fixSetup();
  await assert.rejects(run("fix"), /usage/);
  await assert.rejects(run("fix", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("fix", "REQ-20261102-work", "--agent"), /usage/);
  await assert.rejects(run("fix", "REQ-20261102-work", "--bogus"), /usage/);
  await assert.rejects(run("fix", "REQ-20261102-work", "extra"), /usage/);
  await assert.rejects(run("fix", "REQ-20261102-missing"), /找不到卡片/);
});

test("card fix refuses when there is nothing to fix, and never calls the flow", async () => {
  let called = false;
  const { store, run } = setup({
    fixCard: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  await assert.rejects(run("fix", "REQ-20261102-work"), /card review/);
  assert.equal(called, false);
});

test("card fix hands the open findings to the flow, marks them fixed, logs fix_applied, and says to push and review again", async () => {
  const { store, run, calls } = fixSetup();
  const reply = await run("fix", "REQ-20261102-work");
  assert.deepEqual(calls, [{ agent: undefined, round: 1, ids: ["F1", "F2"] }]);
  assert.match(reply, /已標為 fixed：F1、F2/);
  assert.match(reply, /card pr REQ-20261102-work/);
  assert.match(reply, /card review REQ-20261102-work/);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | fixed |"));
  assert.ok(read.ok && read.card.body.includes("- F2 | low | fixed |"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.text]), [
    ["fix_applied", "修正 第 1 圈：2 筆標為 fixed、0 筆略過，head bbbbbbbbbbbb"],
  ]);
});

test("card fix passes --agent through", async () => {
  const { run, calls } = fixSetup();
  await run("fix", "REQ-20261102-work", "--agent", "codex");
  assert.equal(calls[0].agent, "codex");
});

test("a partial fix marks only the fixed findings and leaves the skipped ones open", async () => {
  const { store, run } = fixSetup({
    fixCard: async () => ({
      ok: true as const,
      fixerKind: "claude",
      closed: true,
      outcome: {
        kind: "fixed" as const,
        fixed: ["F1"],
        skipped: [{ id: "F2", reason: "需要人決定" }],
        headBefore: FIX_A,
        headAfter: FIX_B,
        files: ["src/export.ts"],
        sensitivePaths: [],
      },
    }),
  });
  const reply = await run("fix", "REQ-20261102-work");
  assert.match(reply, /略過.*F2.*需要人決定/s);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | fixed |"));
  assert.ok(read.ok && read.card.body.includes("- F2 | low | open |"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.text), ["修正 第 1 圈：1 筆標為 fixed、1 筆略過，head bbbbbbbbbbbb"]);
});

test("a failed round changes nothing on the card and says why", async () => {
  const { store, run } = fixSetup({
    fixCard: async () => ({
      ok: true as const,
      fixerKind: "claude",
      closed: true,
      outcome: { kind: "failed" as const, reason: "作者回報修好了，但 worktree 沒有新的 commit", skipped: [] },
    }),
  });
  const reply = await run("fix", "REQ-20261102-work");
  assert.match(reply, /沒有被採用/);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | open |"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("a fix that never started changes nothing on the card and says which stage stopped", async () => {
  const { store, run } = fixSetup({
    fixCard: async () => ({ ok: false as const, stage: "start" as const, error: "agent.start: unsupported_agent_kind" }),
  });
  await assert.rejects(run("fix", "REQ-20261102-work"), /start.*unsupported_agent_kind/s);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | open |"));
});

test("a precondition refusal from the flow is passed through and the card is untouched", async () => {
  const { store, run } = fixSetup({
    fixCard: async () => {
      throw new Error("最後一個作者的 pane（w7:p1）已不在");
    },
  });
  await assert.rejects(run("fix", "REQ-20261102-work"), /已不在/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("the loop stops after the third review round and the flow is not called", async () => {
  const { run, calls } = fixSetup({}, 3);
  await assert.rejects(run("fix", "REQ-20261102-work"), /3.*人工|人工.*3/s);
  assert.deepEqual(calls, []);
});

test("a fix and a review of the same card never run at the same time", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { run } = fixSetup({
    fixCard: async (_card, options) => {
      await gate;
      return {
        ok: true as const,
        fixerKind: "claude",
        closed: true,
        outcome: {
          kind: "fixed" as const,
          fixed: options.findings.map((f) => f.id),
          skipped: [],
          headBefore: FIX_A,
          headAfter: FIX_B,
          files: ["src/a.ts"],
          sensitivePaths: [],
        },
      };
    },
  });
  const running = run("fix", "REQ-20261102-work");
  await assert.rejects(run("fix", "REQ-20261102-work"), /正在 review 或修正/);
  await assert.rejects(run("review", "REQ-20261102-work"), /正在 review 或修正/);
  release();
  await running;
});

// ---- card review：通過時把先前標為 fixed 的 finding 標為 resolved ----

test("a passing review marks the findings that were fixed as resolved, and says so", async () => {
  const { store, run } = reviewSetup({
    reviewPullRequest: async (_card, options) => {
      const base = reviewOk({}, options.round);
      return {
        ...base,
        result: {
          ...base.result,
          batch: { ...base.result.batch, verdict: "pass" as const, findings: [] },
          criteria: [],
        },
      };
    },
  });
  store.recordFindings(
    "REQ-20261102-work",
    {
      round: 1,
      scope: "whole",
      headSha: REVIEW_HEAD,
      verdict: "changes_requested",
      findings: [
        { severity: "high", path: "src/a.ts", summary: "a" },
        { severity: "low", path: "src/b.ts", summary: "b" },
      ],
    },
    "2026-11-04",
  );
  store.setFindingStatus("REQ-20261102-work", "F1", "fixed", "2026-11-04");
  const reply = await run("review", "REQ-20261102-work");
  assert.match(reply, /已標為 resolved：F1/);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | resolved |"));
  assert.ok(read.ok && read.card.body.includes("- F2 | low | open |"));
});

test("a review that still asks for changes leaves the fixed findings as they are", async () => {
  const { store, run } = reviewSetup();
  store.recordFindings(
    "REQ-20261102-work",
    {
      round: 1,
      scope: "whole",
      headSha: REVIEW_HEAD,
      verdict: "changes_requested",
      findings: [{ severity: "high", path: "src/a.ts", summary: "a" }],
    },
    "2026-11-04",
  );
  store.setFindingStatus("REQ-20261102-work", "F1", "fixed", "2026-11-04");
  const reply = await run("review", "REQ-20261102-work");
  assert.equal(reply.includes("resolved"), false);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | fixed |"));
});

// ---- card loop（F5-loop：review → fix → push → review 的自動版）----

type LoopPlan = "pass" | "changes_requested" | "inconclusive";

function loopSetup(
  reviews: LoopPlan[],
  options: {
    sensitive?: string[];
    fixFails?: boolean;
    gate?: Promise<void>;
    /** 額外的依賴；拿到共用的時間線 `calls`，這樣 waitCi／merge 與 review／fix／push 排在同一條線上。 */
    overrides?: (calls: string[]) => Partial<CardCommandDeps>;
  } = {},
) {
  const notices: string[] = [];
  const calls: string[] = [];
  const reviewAgents: Array<string | undefined> = [];
  const fixAgents: Array<string | undefined> = [];
  const plans = [...reviews];
  const s = setup({
    notify: async (text) => {
      notices.push(text);
    },
    reviewPullRequest: async (_card, opts) => {
      calls.push("review");
      reviewAgents.push(opts.agent);
      if (options.gate && calls.filter((c) => c === "review").length === 1) await options.gate;
      const verdict = plans.shift() ?? "pass";
      const base = reviewOk({}, opts.round);
      return {
        ...base,
        result: {
          ...base.result,
          batch: {
            ...base.result.batch,
            verdict,
            findings:
              verdict === "changes_requested"
                ? [{ severity: "high" as const, path: "src/export.ts", summary: `問題 ${opts.round}` }]
                : [],
          },
          criteria: [],
        },
      };
    },
    fixCard: async (_card, opts) => {
      calls.push("fix");
      fixAgents.push(opts.agent);
      if (options.fixFails)
        return {
          ok: true as const,
          fixerKind: "claude",
          closed: true,
          outcome: { kind: "failed" as const, reason: "沒有新的 commit", skipped: [] },
        };
      return {
        ok: true as const,
        fixerKind: "claude",
        closed: true,
        outcome: {
          kind: "fixed" as const,
          fixed: opts.findings.map((f) => f.id),
          skipped: [],
          headBefore: FIX_A,
          headAfter: FIX_B,
          files: ["src/export.ts"],
          sensitivePaths: options.sensitive ?? [],
        },
      };
    },
    openPullRequest: async () => {
      calls.push("push");
      return { ...prOutcome, created: false, base: "" };
    },
    ...options.overrides?.(calls),
  });
  s.store.create(assignable("REQ-20261102-work", { status: "done" }));
  return { ...s, notices, calls, reviewAgents, fixAgents };
}

test("card loop validates its arguments, the card id and the card", async () => {
  const { run } = loopSetup([]);
  await assert.rejects(run("loop"), /usage/);
  await assert.rejects(run("loop", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("loop", "REQ-20261102-work", "--agent"), /usage/);
  await assert.rejects(run("loop", "REQ-20261102-work", "--fix-agent"), /usage/);
  await assert.rejects(run("loop", "REQ-20261102-work", "--bogus"), /usage/);
  await assert.rejects(run("loop", "REQ-20261102-work", "extra"), /usage/);
  await assert.rejects(run("loop", "stop"), /usage/);
  await assert.rejects(run("loop", "REQ-20261102-missing"), /找不到卡片/);
});

test("a first review that passes ends the loop with a summary, and nothing is fixed or pushed", async () => {
  const { run, calls, notices } = loopSetup(["pass"]);
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review"]);
  assert.match(reply, /通過/);
  assert.match(reply, /merge 由你決定/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /review 完成/);
});

test("changes requested is fixed, pushed to the existing PR and reviewed again, with every step reported and the card updated", async () => {
  const { store, run, calls, notices } = loopSetup(["changes_requested", "pass"]);
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "fix", "push", "review"]);
  assert.match(reply, /通過/);
  assert.equal(notices.length, 4);
  assert.match(notices[0], /changes_requested/);
  assert.match(notices[1], /修正完成/);
  assert.match(notices[2], /已把新的 commit push 上去/);
  assert.match(notices[3], /通過|pass/);
  const read = store.read("REQ-20261102-work");
  assert.ok(read.ok && read.card.body.includes("- F1 | high | resolved |"));
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => e.event), ["review_verdict", "fix_applied", "review_verdict"]);
});

test("--agent goes to every review and --fix-agent to every fix", async () => {
  const { run, reviewAgents, fixAgents } = loopSetup(["changes_requested", "pass"]);
  await run("loop", "REQ-20261102-work", "--agent", "codex", "--fix-agent", "claude");
  assert.deepEqual(reviewAgents, ["codex", "codex"]);
  assert.deepEqual(fixAgents, ["claude"]);
});

test("the loop stops at the review limit and hands the card back, saying so in the reply", async () => {
  const { run, calls } = loopSetup(["changes_requested", "changes_requested", "changes_requested"]);
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "fix", "push", "review", "fix", "push", "review"]);
  assert.match(reply, /退回人工|停下/);
  assert.match(reply, /總上限 3/);
});

test("two inconclusive reviews of the same head stop the loop", async () => {
  const { run, calls } = loopSetup(["inconclusive", "inconclusive"]);
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "review"]);
  assert.match(reply, /inconclusive/);
});

test("a fix that touches sensitive paths is never pushed, and the reply names them", async () => {
  const { run, calls } = loopSetup(["changes_requested"], { sensitive: ["SPEC.md"] });
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "fix"]);
  assert.match(reply, /敏感路徑.*SPEC\.md/s);
  assert.match(reply, /沒有 push/);
});

test("a failed fix round stops the loop without pushing", async () => {
  const { run, calls } = loopSetup(["changes_requested"], { fixFails: true });
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "fix"]);
  assert.match(reply, /沒有被採用/);
});

test("a refusal from a step stops the loop with its message", async () => {
  const { store, run } = setup({
    notify: async () => undefined,
    reviewPullRequest: async () => {
      throw new Error("卡片 REQ-20261102-work 沒有開著的 PR；請先 `card pr`");
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("loop", "REQ-20261102-work");
  assert.match(reply, /沒有開著的 PR/);
  assert.match(reply, /review/);
});

test("a stop request ends the loop between steps, and only one loop, review or fix runs per card", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { run, calls } = loopSetup(["changes_requested", "pass"], { gate });
  const running = run("loop", "REQ-20261102-work");
  await assert.rejects(run("loop", "REQ-20261102-work"), /正在 review 或修正/);
  await assert.rejects(run("review", "REQ-20261102-work"), /正在 review 或修正/);
  const stopped = await run("loop", "stop", "REQ-20261102-work");
  assert.match(stopped, /停止/);
  release();
  const reply = await running;
  assert.deepEqual(calls, ["review"]);
  assert.match(reply, /使用者要求停止/);
});

test("stopping a card that has no loop running says so", async () => {
  const { run } = loopSetup([]);
  await assert.rejects(run("loop", "stop", "REQ-20261102-work"), /沒有在跑/);
});

// ---- card loop --merge（review 通過後等 CI、全綠再 merge）----

function loopMergeSetup(
  reviews: LoopPlan[],
  options: {
    ci?: "success" | "failure" | "timeout" | "cancelled";
    mergeError?: string;
  } = {},
) {
  return loopSetup(reviews, {
    overrides: (calls) => ({
      waitForCi: async () => {
        calls.push("waitCi");
        const state = options.ci ?? "success";
        return { state, text: `ci ${state}` };
      },
      mergePullRequest: async (_card, opts) => {
        calls.push("merge");
        if (options.mergeError) throw new Error(options.mergeError);
        return {
          pr: {
            number: 42,
            url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
            headSha: REVIEW_HEAD,
          },
          method: (opts.method ?? "squash") as "squash" | "merge" | "rebase",
        };
      },
    }),
  });
}

test("card loop without --merge never waits for CI or merges", async () => {
  const { run, calls } = loopMergeSetup(["pass"]);
  const reply = await run("loop", "REQ-20261102-work");
  assert.deepEqual(calls, ["review"]);
  assert.match(reply, /merge 由你決定/);
});

test("card loop --merge reviews, waits for CI, merges last, and says it merged", async () => {
  const { run, calls } = loopMergeSetup(["pass"]);
  const reply = await run("loop", "REQ-20261102-work", "--merge");
  assert.deepEqual(calls, ["review", "waitCi", "merge"]);
  assert.match(reply, /已 merge/);
  assert.match(reply, /pull\/42/);
});

test("card loop --merge accepts the other flags in either order", async () => {
  const { run, calls } = loopMergeSetup(["pass"]);
  await run("loop", "--merge", "REQ-20261102-work");
  assert.deepEqual(calls, ["review", "waitCi", "merge"]);
  const second = loopMergeSetup(["pass"]);
  await second.run("loop", "REQ-20261102-work", "--merge", "--agent", "codex");
  assert.deepEqual(second.calls, ["review", "waitCi", "merge"]);
});

test("card loop --merge with a red CI does not merge and tells the user why", async () => {
  const { run, calls } = loopMergeSetup(["pass"], { ci: "failure" });
  const reply = await run("loop", "REQ-20261102-work", "--merge");
  assert.deepEqual(calls, ["review", "waitCi"]);
  assert.match(reply, /停下來了/);
  assert.match(reply, /CI/);
  assert.doesNotMatch(reply, /已 merge/);
});

test("card loop --merge hands back the reasons when card merge refuses", async () => {
  const { run, calls } = loopMergeSetup(["pass"], {
    mergeError: "不 merge PR #42（1 項條件不成立）：\n- 專案政策是 L1",
  });
  const reply = await run("loop", "REQ-20261102-work", "--merge");
  assert.deepEqual(calls, ["review", "waitCi", "merge"]);
  assert.match(reply, /停下來了/);
  assert.match(reply, /專案政策是 L1/);
});

test("card loop --merge cannot be combined with a repeated flag", async () => {
  const { run } = loopMergeSetup([]);
  await assert.rejects(run("loop", "REQ-20261102-work", "--merge", "--merge"), /usage/);
});

// ---- card merge（L2，G7）----

function mergeSetup(overrides: Partial<CardCommandDeps> = {}) {
  const calls: Array<{ id: string; method?: string }> = [];
  const s = setup({
    mergePullRequest: async (card, options) => {
      calls.push({ id: card.id, method: options.method });
      return {
        pr: {
          number: 42,
          url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
          headSha: REVIEW_HEAD,
        },
        method: (options.method ?? "squash") as "squash" | "merge" | "rebase",
      };
    },
    ...overrides,
  });
  s.store.create(assignable("REQ-20261102-work", { status: "done" }));
  return { ...s, calls };
}

test("card merge validates its arguments, the card id and the card", async () => {
  const { run } = mergeSetup();
  await assert.rejects(run("merge"), /usage/);
  await assert.rejects(run("merge", "../x"), /不是合法的卡片 id/);
  await assert.rejects(run("merge", "REQ-20261102-work", "--method"), /usage/);
  await assert.rejects(run("merge", "REQ-20261102-work", "--bogus"), /usage/);
  await assert.rejects(run("merge", "REQ-20261102-work", "extra"), /usage/);
  await assert.rejects(run("merge", "REQ-20261102-work", "--method", "squash", "--method", "merge"), /usage/);
  await assert.rejects(run("merge", "REQ-20261102-missing"), /找不到卡片/);
});

test("card merge reports the merged PR with its full URL, the method and the head, and says what the bridge does next", async () => {
  const { run, calls } = mergeSetup();
  const reply = await run("merge", "REQ-20261102-work");
  assert.deepEqual(calls, [{ id: "REQ-20261102-work", method: undefined }]);
  assert.match(reply, /https:\/\/github\.com\/jon888465\/Herdr_Discord_Bridge\/pull\/42/);
  assert.match(reply, /#42/);
  assert.match(reply, /squash/);
  assert.match(reply, /0123456789ab/);
  assert.match(reply, /merged/);
  assert.match(reply, /worktree/);
  assert.match(reply, /不部署|不重啟/);
});

test("card merge passes --method through", async () => {
  const { run, calls } = mergeSetup();
  const reply = await run("merge", "REQ-20261102-work", "--method", "rebase");
  assert.equal(calls[0].method, "rebase");
  assert.match(reply, /rebase/);
});

test("a refusal lists the reasons and only appends its bounded merge-blocked flow record", async () => {
  const { store, run } = mergeSetup({
    mergePullRequest: async () => {
      throw new Error(
        "不 merge PR #42（2 項條件不成立）：\n- 專案政策是 L1\n- CI 有檢查失敗",
      );
    },
  });
  const before = store.read("REQ-20261102-work");
  await assert.rejects(
    run("merge", "REQ-20261102-work"),
    /2 項條件不成立.*L1.*CI/s,
  );
  const after = store.read("REQ-20261102-work");
  assert.ok(before.ok && after.ok);
  const log = store.readLog("REQ-20261102-work");
  assert.ok(log.ok);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].event, "merge_blocked");
  assert.equal(log.entries[0].text, "專案政策、CI 條件未滿足");
  assert.match(log.entries[0].eventId, /^merge_blocked-/);
  const expected = appendLogEntries(before.card.body, log.entries);
  assert.ok(expected.ok);
  assert.deepEqual(after.card, {
    ...before.card,
    updated: "2026-11-02",
    body: expected.body,
  });
});

test("a merge never runs while a review, a fix or a loop of the same card is running, and not twice at once", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { run } = mergeSetup({
    mergePullRequest: async () => {
      await gate;
      return {
        pr: { number: 42, url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42", headSha: REVIEW_HEAD },
        method: "squash" as const,
      };
    },
  });
  const running = run("merge", "REQ-20261102-work");
  await assert.rejects(run("merge", "REQ-20261102-work"), /正在 review、修正或 merge/);
  await assert.rejects(run("review", "REQ-20261102-work"), /正在 review/);
  await assert.rejects(run("loop", "REQ-20261102-work"), /正在 review/);
  release();
  await running;
  await run("merge", "REQ-20261102-work");
});

const commitOutcome = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  branch: "card/REQ-20261102-work",
  files: ["docs/note.md"],
  fingerprint: "f".repeat(64),
  taskId: "task-9",
};

test("card commit records the commit on the card and points to the next step, without pushing", async () => {
  const seen: string[] = [];
  const { store, run } = setup({
    commitVerified: async (card) => {
      seen.push(card.id);
      return commitOutcome;
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  const reply = await run("commit", "REQ-20261102-work");
  assert.deepEqual(seen, ["REQ-20261102-work"]);
  assert.match(reply, /0123456789ab/);
  assert.match(reply, /docs\/note\.md/);
  assert.match(reply, /沒有 push/);
  assert.match(reply, /card pr REQ-20261102-work/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries.map((e) => [e.event, e.eventId]), [
    ["committed", "commit-0123456789ab"],
  ]);
  assert.match(
    (log.ok && log.entries[0].text) || "",
    /^commit 分支 card\/REQ-20261102-work，head 0123456789ab（task task-9）/,
  );
});

test("card commit surfaces the reason when the version cannot be committed, and records nothing", async () => {
  const { store, run } = setup({
    commitVerified: async () => {
      throw new Error("worktree 的內容和通過驗證的版本不同（驗證之後被改動過）");
    },
  });
  store.create(assignable("REQ-20261102-work", { status: "done" }));
  await assert.rejects(run("commit", "REQ-20261102-work"), /驗證之後被改動/);
  const log = store.readLog("REQ-20261102-work");
  assert.deepEqual(log.ok && log.entries, []);
});

test("card commit validates its arguments and the card", async () => {
  const { run } = setup({ commitVerified: async () => commitOutcome });
  await assert.rejects(run("commit"), /usage: card commit <id>/);
  await assert.rejects(run("commit", "nope"), /不是合法的卡片 id/);
  await assert.rejects(run("commit", "REQ-20261102-missing"), /找不到卡片/);
});

test("Discord import and assignment persist only their explicit originating thread",async()=>{
  const id="REQ-20261107-origin";
  const s=setup({source:"console",readLocalFile:()=>{const out=serializeCard(card(id,{notify:"agent:w4:p2:term:codex"}));assert.ok(out.ok);return out.text;}});
  await s.run("import","/tmp/card.md");s.deps.source="discord";s.deps.notifyThread="12345";
  const current=s.store.read(id);assert.ok(current.ok);s.store.update(id,current.hash,c=>({...c,status:"ready"}));
  s.deps.startTask=async()=>({taskId:"task-notify",lead:{agent:"codex",machine:"local"}});
  await s.run("assign",id);const read=s.store.read(id);assert.ok(read.ok);assert.equal(read.card.notify,"discord:12345");
});

test("notification failure cannot change card loop or card merge results", async () => {
  const loop = loopMergeSetup(["pass"], { ci: "failure" });
  loop.deps.notify = async () => {
    throw Error("Discord down");
  };
  const reply = await loop.run("loop", "REQ-20261102-work", "--merge");
  assert.match(reply, /loop 停/);
  assert.deepEqual(loop.calls, ["review", "waitCi"]);
  const history = loop.store.readLog("REQ-20261102-work");
  assert.ok(history.ok);
  assert.ok(history.entries.some((e) => e.event === "loop_stopped"));
  for (const target of ["discord:12345", "agent:w4:p2:term:codex"]) {
    const merge = mergeSetup(); let failures=0;
    const notifier = commandNotifier(merge.store,target,async()=>{failures++;throw Error("notification down");});
    const original=merge.deps.mergePullRequest;
    merge.deps.mergePullRequest=async(...args)=>{await notifier.tick();return original(...args);};
    const out = await merge.run("merge", "REQ-20261102-work");
    assert.match(out, /已 merge/); assert.equal(failures,1); assert.equal(merge.calls.length,1);
  }
});

function commandNotifier(store: CardStore,target: string,fail:()=>Promise<void>,send?: (text:string)=>void) {
  const id="REQ-20261102-work",read=store.read(id);assert.ok(read.ok);
  store.update(id,read.hash,c=>({...c,notify:target}));
  store.appendLog(id,[{event:"pr_opened",eventId:"notify-pr",time:"2026-11-02T08:15:00Z",text:"PR opened"}]);
  return createCardNotifier({store,now:()=>"2026-11-02T08:15:00Z",startedAt:"2026-11-02T00:00:00Z",prUrl:()=>undefined,
    discord:async(_id,text)=>{if(send)send(text);else await fail();},pane:async()=>{await fail();return undefined;},agent:fail,log:()=>{}});
}

test("mutual exclusion logs and notifies merge_blocked while preserving refusal",async()=>{
  const s=mergeSetup();const sent:string[]=[];const notifier=commandNotifier(s.store,"discord:12345",async()=>{},t=>sent.push(t));
  await notifier.tick();sent.length=0;
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});const original=s.deps.mergePullRequest;
  s.deps.mergePullRequest=async(...args)=>{await wait;return original(...args);};
  const running=s.run("merge","REQ-20261102-work");
  try {
    await assert.rejects(s.run("merge","REQ-20261102-work"),{message:"卡片 REQ-20261102-work 正在 review、修正或 merge 中"});
    const log=s.store.readLog("REQ-20261102-work");assert.ok(log.ok);assert.equal(log.entries.filter(e=>e.event==="merge_blocked").length,1);
    await notifier.tick();assert.equal(sent.length,1);assert.match(sent[0],/merge_blocked/);
  } finally {release();await running;}
});
