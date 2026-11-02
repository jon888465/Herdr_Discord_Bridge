import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { CardStore } from "../src/card-store.js";
import { runCardCommand, type CardCommandDeps } from "../src/card-command.js";

const cat = (...parts: string[]): string => parts.join("");

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
