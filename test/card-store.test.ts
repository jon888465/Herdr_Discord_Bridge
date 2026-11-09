import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.js";

function card(id: string, title = "範例卡片"): string {
  return `---
id: ${id}
type: requirement
status: draft
title: ${title}
version: 1
created: 2026-11-01
updated: 2026-11-01
---

# ${title}
`;
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "card-store-"));
}

test("list returns valid cards sorted by file name and ignores non-card files", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-bravo.md"),
    card("REQ-20261101-bravo"),
  );
  fs.writeFileSync(
    path.join(root, "REQ-20261101-alpha.md"),
    card("REQ-20261101-alpha"),
  );
  fs.writeFileSync(path.join(root, "README.md"), "# not a card\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "x");
  const result = new CardStore(root).list();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.cards.map((entry) => [entry.file, entry.card.id]),
    [
      ["REQ-20261101-alpha.md", "REQ-20261101-alpha"],
      ["REQ-20261101-bravo.md", "REQ-20261101-bravo"],
    ],
  );
});

test("read returns the card and a hash of the exact file content", () => {
  const root = tempRoot();
  const text = card("REQ-20261101-alpha");
  fs.writeFileSync(path.join(root, "REQ-20261101-alpha.md"), text);
  const result = new CardStore(root).read("REQ-20261101-alpha");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.title, "範例卡片");
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  const again = new CardStore(root).read("REQ-20261101-alpha");
  assert.equal(again.ok && again.hash, result.hash);
  fs.writeFileSync(
    path.join(root, "REQ-20261101-alpha.md"),
    text + "changed\n",
  );
  const changed = new CardStore(root).read("REQ-20261101-alpha");
  assert.notEqual(changed.ok && changed.hash, result.hash);
});

test("an invalid card is reported in errors and does not hide the valid ones", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-good.md"),
    card("REQ-20261101-good"),
  );
  fs.writeFileSync(
    path.join(root, "REQ-20261101-broken.md"),
    "no frontmatter\n",
  );
  const result = new CardStore(root).list();
  assert.deepEqual(
    result.cards.map((entry) => entry.file),
    ["REQ-20261101-good.md"],
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, "REQ-20261101-broken.md");
  assert.match(result.errors[0].error, /frontmatter/);
});

test("existingIds includes the id of an invalid card file so it cannot be overwritten", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-good.md"),
    card("REQ-20261101-good"),
  );
  fs.writeFileSync(
    path.join(root, "REQ-20261101-broken.md"),
    "no frontmatter\n",
  );
  fs.writeFileSync(path.join(root, "README.md"), "x");
  assert.deepEqual([...new CardStore(root).existingIds()].sort(), [
    "REQ-20261101-broken",
    "REQ-20261101-good",
  ]);
});

test("a missing directory lists nothing instead of throwing", () => {
  const store = new CardStore(path.join(tempRoot(), "does-not-exist"));
  assert.deepEqual(store.list(), { cards: [], errors: [] });
  assert.equal(store.existingIds().size, 0);
});

test("reading a card that does not exist reports not_found", () => {
  const result = new CardStore(tempRoot()).read("REQ-20261101-nothing");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "not_found");
});

test("reading a file that fails validation reports invalid with the reason", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-broken.md"),
    "no frontmatter\n",
  );
  const result = new CardStore(root).read("REQ-20261101-broken");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid");
    assert.match(result.error, /frontmatter/);
  }
});

test("an id that is not a well-formed card id never touches the file system", () => {
  const parent = tempRoot();
  const root = path.join(parent, "cards");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(parent, "outside"));
  fs.writeFileSync(
    path.join(parent, "outside", "REQ-20261101-secret.md"),
    card("REQ-20261101-secret"),
  );
  const store = new CardStore(root);
  for (const id of [
    "../outside/REQ-20261101-secret",
    "REQ-20261101-a/../../outside/REQ-20261101-secret",
    "/etc/passwd",
    "",
    "REQ-20261101-alpha.md",
    "req-20261101-alpha",
  ]) {
    const result = store.read(id);
    assert.equal(result.ok, false, id);
    if (!result.ok) assert.equal(result.code, "invalid", id);
  }
});

test("a symbolic link named like a card is refused, listed as an error, and still reserves its id", () => {
  const parent = tempRoot();
  const root = path.join(parent, "cards");
  fs.mkdirSync(root);
  const target = path.join(parent, "target.md");
  fs.writeFileSync(target, card("REQ-20261101-linked"));
  fs.symlinkSync(target, path.join(root, "REQ-20261101-linked.md"));
  const store = new CardStore(root);
  const listed = store.list();
  assert.deepEqual(listed.cards, []);
  assert.equal(listed.errors[0].file, "REQ-20261101-linked.md");
  assert.match(listed.errors[0].error, /symbolic link/);
  const read = store.read("REQ-20261101-linked");
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.code, "unsafe");
  assert.ok(store.existingIds().has("REQ-20261101-linked"));
});

test("a dangling symbolic link and a directory named like a card are refused", () => {
  const root = tempRoot();
  fs.symlinkSync(
    path.join(root, "gone.md"),
    path.join(root, "REQ-20261101-dangling.md"),
  );
  fs.mkdirSync(path.join(root, "REQ-20261101-folder.md"));
  const store = new CardStore(root);
  const listed = store.list();
  assert.deepEqual(listed.errors.map((entry) => entry.file).sort(), [
    "REQ-20261101-dangling.md",
    "REQ-20261101-folder.md",
  ]);
  for (const id of ["REQ-20261101-dangling", "REQ-20261101-folder"]) {
    const read = store.read(id);
    assert.equal(read.ok, false, id);
    if (!read.ok) assert.equal(read.code, "unsafe", id);
  }
});

test("a file over the import limit is refused without being parsed", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-huge.md"),
    card("REQ-20261101-huge") + "a".repeat(IMPORT_MAX_FILE_BYTES),
  );
  const store = new CardStore(root);
  assert.match(store.list().errors[0].error, /512 KiB/);
  const read = store.read("REQ-20261101-huge");
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.code, "too_large");
});

import { serializeCard } from "../src/card-serialize.js";
import { IMPORT_MAX_FILE_BYTES, type Card } from "../src/card.js";

const sample: Card = {
  id: "REQ-20261101-created",
  type: "requirement",
  status: "draft",
  title: "新建立的卡片",
  version: 1,
  created: "2026-11-01",
  updated: "2026-11-01",
  body: "# 新建立的卡片\n",
};

test("create writes the canonical text, returns its hash and leaves no temp files", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  const created = store.create(sample);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.file, "REQ-20261101-created.md");
  const serialized = serializeCard(sample);
  assert.equal(
    serialized.ok && serialized.text,
    fs.readFileSync(path.join(root, created.file), "utf8"),
  );
  const read = store.read(sample.id);
  assert.equal(read.ok && read.hash, created.hash);
  assert.deepEqual(read.ok && read.card, sample);
  assert.deepEqual(fs.readdirSync(root), ["REQ-20261101-created.md"]);
});

test("create makes the directory when it does not exist yet", () => {
  const root = path.join(tempRoot(), "nested", "cards");
  assert.equal(new CardStore(root).create(sample).ok, true);
  assert.ok(fs.existsSync(path.join(root, "REQ-20261101-created.md")));
});

test("create never overwrites an existing card, a broken file or a dangling link", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  fs.writeFileSync(
    path.join(root, "REQ-20261101-created.md"),
    "precious original\n",
  );
  const first = store.create(sample);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.code, "exists");
  assert.equal(
    fs.readFileSync(path.join(root, "REQ-20261101-created.md"), "utf8"),
    "precious original\n",
  );

  const outside = path.join(tempRoot(), "target.md");
  fs.symlinkSync(outside, path.join(root, "REQ-20261101-linked.md"));
  const linked = store.create({ ...sample, id: "REQ-20261101-linked" });
  assert.equal(linked.ok, false);
  if (!linked.ok) assert.equal(linked.code, "exists");
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(root).sort(), [
    "REQ-20261101-created.md",
    "REQ-20261101-linked.md",
  ]);
});

test("create refuses a card that could not be read back and writes nothing", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  for (const bad of [
    { ...sample, status: "bogus" },
    { ...sample, id: "../escape-20261101-x" },
    { ...sample, title: "第一行\n第二行" },
  ]) {
    const result = store.create(bad);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid");
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

function seeded(): { root: string; store: CardStore; hash: string } {
  const root = tempRoot();
  const store = new CardStore(root);
  const created = store.create(sample);
  assert.equal(created.ok, true);
  return { root, store, hash: created.ok ? created.hash : "" };
}

test("update with the current hash rewrites the card, returns the new hash and keeps the body", () => {
  const { root, store, hash } = seeded();
  const result = store.update(sample.id, hash, (current) => ({
    ...current,
    status: "ready",
    updated: "2026-11-02",
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.hash, hash);
  assert.equal(result.card.status, "ready");
  const read = store.read(sample.id);
  assert.equal(read.ok && read.hash, result.hash);
  assert.equal(read.ok && read.card.body, sample.body);
  assert.equal(read.ok && read.card.updated, "2026-11-02");
  assert.deepEqual(fs.readdirSync(root), ["REQ-20261101-created.md"]);
});

test("update with a stale hash is a conflict and leaves the file exactly as it was", () => {
  const { root, store, hash } = seeded();
  const file = path.join(root, "REQ-20261101-created.md");
  const edited = fs
    .readFileSync(file, "utf8")
    .replace("新建立的卡片", "人剛改過的標題");
  fs.writeFileSync(file, edited);
  const result = store.update(sample.id, hash, (current) => ({
    ...current,
    status: "ready",
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "conflict");
  assert.equal(fs.readFileSync(file, "utf8"), edited);
  assert.deepEqual(fs.readdirSync(root), ["REQ-20261101-created.md"]);
});

test("update refuses a change that renames the card or makes it invalid", () => {
  const { root, store, hash } = seeded();
  const file = path.join(root, "REQ-20261101-created.md");
  const before = fs.readFileSync(file, "utf8");
  for (const change of [
    (current: Card): Card => ({ ...current, id: "REQ-20261101-renamed" }),
    (current: Card): Card => ({ ...current, status: "bogus" }),
    (current: Card): Card => ({ ...current, title: "第一行\n第二行" }),
  ]) {
    const result = store.update(sample.id, hash, change);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid");
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(root), ["REQ-20261101-created.md"]);
});

test("a change callback that throws leaves the file and the directory untouched", () => {
  const { root, store, hash } = seeded();
  const file = path.join(root, "REQ-20261101-created.md");
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() =>
    store.update(sample.id, hash, () => {
      throw new Error("boom");
    }),
  );
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(root), ["REQ-20261101-created.md"]);
});

test("update reports not_found, invalid id, an invalid file and refuses a symbolic link without writing through it", () => {
  const { root, store, hash } = seeded();
  const keep = (current: Card): Card => current;
  const missing = store.update("REQ-20261101-missing", hash, keep);
  assert.equal(missing.ok === false && missing.code, "not_found");
  const traversal = store.update("../REQ-20261101-created", hash, keep);
  assert.equal(traversal.ok === false && traversal.code, "invalid");

  fs.writeFileSync(
    path.join(root, "REQ-20261101-broken.md"),
    "no frontmatter\n",
  );
  const brokenHash = createHash("sha256")
    .update("no frontmatter\n", "utf8")
    .digest("hex");
  const broken = store.update("REQ-20261101-broken", brokenHash, keep);
  assert.equal(broken.ok === false && broken.code, "invalid");

  const outsideDir = tempRoot();
  const outside = path.join(outsideDir, "victim.md");
  fs.writeFileSync(outside, "victim content\n");
  fs.symlinkSync(outside, path.join(root, "REQ-20261101-linked.md"));
  const linked = store.update("REQ-20261101-linked", hash, (current) => ({
    ...current,
    status: "ready",
  }));
  assert.equal(linked.ok === false && linked.code, "unsafe");
  assert.equal(fs.readFileSync(outside, "utf8"), "victim content\n");
});

const foreign = `---
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

test("importText stores an imported card as a draft without its external links", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  const result = store.importText(foreign, { today: "2026-11-01" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.file, "REQ-20261101-imported.md");
  assert.deepEqual(result.notes, [
    "status in_progress -> draft",
    "external cleared",
  ]);
  const read = store.read("REQ-20261101-imported");
  assert.equal(read.ok && read.card.status, "draft");
  assert.equal(read.ok && read.card.external, undefined);
  assert.equal(read.ok && read.hash, result.hash);
});

test("importText generates an id from the type, today and the given slug", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  const withoutId = foreign.replace(/^id: .*\n/m, "");
  const missingSlug = store.importText(withoutId, { today: "2026-11-01" });
  assert.equal(missingSlug.ok, false);
  if (!missingSlug.ok) assert.equal(missingSlug.code, "invalid");
  const result = store.importText(withoutId, {
    today: "2026-11-01",
    slug: "from-notion",
  });
  assert.equal(result.ok && result.file, "REQ-20261101-from-notion.md");
  assert.ok(fs.existsSync(path.join(root, "REQ-20261101-from-notion.md")));
});

test("importText never replaces a card, even a broken file that still reserves its id", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  fs.writeFileSync(
    path.join(root, "REQ-20261101-imported.md"),
    "precious broken file\n",
  );
  const result = store.importText(foreign, { today: "2026-11-01" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "exists");
  assert.equal(
    fs.readFileSync(path.join(root, "REQ-20261101-imported.md"), "utf8"),
    "precious broken file\n",
  );
});

test("importText rejects invalid text and writes nothing", () => {
  const root = tempRoot();
  const result = new CardStore(root).importText("not a card\n", {
    today: "2026-11-01",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid");
  assert.deepEqual(fs.readdirSync(root), []);
});

import { LEDGER_MAX_FILE_BYTES } from "../src/card.js";

const bigBody = (bytes: number): Card => ({
  ...sample,
  body: "a".repeat(bytes) + "\n",
});

test("a ledger store reads cards that the default store refuses", () => {
  const root = tempRoot();
  const ledger = new CardStore(root, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const created = ledger.create(bigBody(700 * 1024));
  assert.equal(created.ok, true);
  assert.equal(ledger.read(sample.id).ok, true);
  assert.equal(ledger.list().cards.length, 1);

  const standard = new CardStore(root);
  const refused = standard.read(sample.id);
  assert.equal(refused.ok === false && refused.code, "too_large");
  assert.match(standard.list().errors[0].error, /512 KiB/);
});

test("a store refuses to create or grow a card past its own limit and leaves files untouched", () => {
  const root = tempRoot();
  const standard = new CardStore(root);
  const tooBig = standard.create(bigBody(IMPORT_MAX_FILE_BYTES));
  assert.equal(tooBig.ok === false && tooBig.code, "too_large");
  assert.deepEqual(fs.readdirSync(root), []);

  const ledger = new CardStore(root, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const created = ledger.create(bigBody(900 * 1024));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const grown = ledger.update(sample.id, created.hash, (current) => ({
    ...current,
    body: current.body + "b".repeat(200 * 1024),
  }));
  assert.equal(grown.ok === false && grown.code, "too_large");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(root), [`${sample.id}.md`]);
});

test("importText keeps the import limit even when the store limit is higher", () => {
  const root = tempRoot();
  const ledger = new CardStore(root, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const result = ledger.importText(
    foreign + "a".repeat(IMPORT_MAX_FILE_BYTES),
    {
      today: "2026-11-01",
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid");
    assert.match(result.error, /512 KiB/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a store limit above 1 MiB is a programming error", () => {
  assert.throws(
    () =>
      new CardStore(tempRoot(), { maxFileBytes: LEDGER_MAX_FILE_BYTES + 1 }),
    RangeError,
  );
});

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;
const posixOnly = { skip: process.platform === "win32" };

test(
  "card files are written 0600 and a directory the store creates is 0700",
  posixOnly,
  () => {
    const root = path.join(tempRoot(), "nested", "cards");
    const store = new CardStore(root);
    const created = store.create(sample);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const file = path.join(root, `${sample.id}.md`);
    assert.equal(modeOf(file), 0o600);
    assert.equal(modeOf(root), 0o700);

    const updated = store.update(sample.id, created.hash, (current) => ({
      ...current,
      status: "ready",
    }));
    assert.equal(updated.ok, true);
    assert.equal(modeOf(file), 0o600);

    const imported = store.importText(foreign, { today: "2026-11-01" });
    assert.equal(imported.ok, true);
    assert.equal(modeOf(path.join(root, "REQ-20261101-imported.md")), 0o600);
  },
);

test(
  "update tightens a file that had looser permissions to 0600",
  posixOnly,
  () => {
    const root = tempRoot();
    const store = new CardStore(root);
    const created = store.create(sample);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const file = path.join(root, `${sample.id}.md`);
    fs.chmodSync(file, 0o644);
    assert.equal(modeOf(file), 0o644);
    const updated = store.update(sample.id, created.hash, (current) => ({
      ...current,
      status: "ready",
    }));
    assert.equal(updated.ok, true);
    assert.equal(modeOf(file), 0o600);
  },
);

import type { LogEntry } from "../src/card-ledger.js";

const ready: Card = { ...sample, status: "ready" };
const logA: LogEntry = {
  time: "2026-11-02T08:15:00Z",
  event: "started",
  text: "建立 worktree",
  eventId: "3f2a9c",
};
const logB: LogEntry = {
  time: "2026-11-03T09:00:00Z",
  event: "pr_opened",
  text: "PR 已開",
  eventId: "a1b2c3",
};

function seededReady(): { root: string; store: CardStore } {
  const root = tempRoot();
  const store = new CardStore(root);
  assert.equal(store.create(ready).ok, true);
  return { root, store };
}

test("setStatus moves ready to in_progress to done and changes only status and updated", () => {
  const { store } = seededReady();
  const started = store.setStatus(sample.id, "in_progress", "2026-11-02");
  assert.equal(started.ok, true);
  const afterStart = store.read(sample.id);
  assert.deepEqual(afterStart.ok && afterStart.card, {
    ...ready,
    status: "in_progress",
    updated: "2026-11-02",
  });
  const done = store.setStatus(sample.id, "done", "2026-11-03");
  assert.equal(done.ok, true);
  const afterDone = store.read(sample.id);
  assert.deepEqual(afterDone.ok && afterDone.card, {
    ...ready,
    status: "done",
    updated: "2026-11-03",
  });
});

test("setStatus is idempotent and never moves updated backwards", () => {
  const { root, store } = seededReady();
  const first = store.setStatus(sample.id, "in_progress", "2026-11-05");
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const again = store.setStatus(sample.id, "in_progress", "2026-11-05");
  assert.equal(again.ok && first.ok && again.hash === first.hash, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const older = store.setStatus(sample.id, "in_progress", "2026-11-01");
  assert.equal(older.ok, true);
  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.updated, "2026-11-05");
});

test("setStatus only allows the bridge statuses and the ready, in_progress, done order", () => {
  const { store } = seededReady();
  for (const status of ["draft", "ready", "cancelled", "refined", "bogus"]) {
    const result = store.setStatus(sample.id, status, "2026-11-02");
    assert.equal(result.ok === false && result.code, "invalid", status);
  }
  assert.equal(
    store.setStatus(sample.id, "done", "2026-11-02").ok === false,
    true,
    "ready cannot jump to done",
  );
  assert.equal(
    store.setStatus(sample.id, "in_progress", "2026-11-02").ok,
    true,
  );
  assert.equal(store.setStatus(sample.id, "done", "2026-11-02").ok, true);
  assert.equal(
    store.setStatus(sample.id, "in_progress", "2026-11-02").ok === false,
    true,
    "done cannot go back",
  );

  const draftRoot = tempRoot();
  const draftStore = new CardStore(draftRoot);
  draftStore.create(sample);
  const fromDraft = draftStore.setStatus(
    sample.id,
    "in_progress",
    "2026-11-02",
  );
  assert.equal(fromDraft.ok === false && fromDraft.code, "invalid");
  const badDate = store.setStatus(sample.id, "done", "2026-13-45");
  assert.equal(badDate.ok === false && badDate.code, "invalid");
});

test("setStatus reports not_found and rejects a malformed id", () => {
  const { store } = seededReady();
  const missing = store.setStatus("REQ-20261101-missing", "done", "2026-11-02");
  assert.equal(missing.ok === false && missing.code, "not_found");
  const bad = store.setStatus("../x", "done", "2026-11-02");
  assert.equal(bad.ok === false && bad.code, "invalid");
});

test("appendLog adds entries to the log section and leaves the human text byte for byte", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const result = store.appendLog(sample.id, [logA, logB]);
  assert.equal(result.ok && result.added, 2);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(
    after.includes(
      "- 2026-11-02T08:15:00Z | started | 建立 worktree | ev:3f2a9c\n",
    ),
  );
  assert.ok(
    after.includes(
      "- 2026-11-03T09:00:00Z | pr_opened | PR 已開 | ev:a1b2c3\n",
    ),
  );
  const body = before.slice(before.indexOf("# 新建立的卡片"));
  assert.ok(
    after.includes(body.trimEnd()),
    "the original body is still there, unchanged",
  );
  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.status, "ready");
  assert.equal(read.ok && read.card.title, ready.title);
  assert.equal(read.ok && read.card.updated, "2026-11-03");
  assert.equal(read.ok && read.hash, result.ok && result.hash);
});

test("appendLog is idempotent by event id and does not rewrite the file", () => {
  const { root, store } = seededReady();
  const first = store.appendLog(sample.id, [logA]);
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const again = store.appendLog(sample.id, [logA]);
  assert.equal(again.ok && again.added, 0);
  assert.equal(again.ok && first.ok && again.hash === first.hash, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("appendLog needs no hash and keeps a human edit made after the card was last read", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("新建立的卡片", "人剛改過的標題"),
  );
  const result = store.appendLog(sample.id, [logA]);
  assert.equal(result.ok, true);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("人剛改過的標題"));
  assert.ok(text.includes("ev:3f2a9c"));
});

test("appendLog retries a conflict and gives up with conflict after three attempts", () => {
  const { root, store } = seededReady();
  const original = store.update.bind(store);
  let calls = 0;
  store.update = (id, hash, change) =>
    calls++ < 1
      ? { ok: false, code: "conflict", error: "simulated" }
      : original(id, hash, change);
  assert.equal(store.appendLog(sample.id, [logA]).ok, true);
  assert.equal(calls, 2);

  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  let always = 0;
  store.update = () => {
    always++;
    return { ok: false, code: "conflict", error: "simulated" };
  };
  const gaveUp = store.appendLog(sample.id, [logB]);
  assert.equal(gaveUp.ok === false && gaveUp.code, "conflict");
  assert.equal(always, 3);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("appendLog rejects bad entries, broken cards and unknown ids without writing", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const bad = store.appendLog(sample.id, [{ ...logA, text: "a\nb" }]);
  assert.equal(bad.ok === false && bad.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);

  fs.writeFileSync(
    path.join(root, "REQ-20261101-broken.md"),
    "no frontmatter\n",
  );
  const broken = store.appendLog("REQ-20261101-broken", [logA]);
  assert.equal(broken.ok === false && broken.code, "invalid");
  const missing = store.appendLog("REQ-20261101-missing", [logA]);
  assert.equal(missing.ok === false && missing.code, "not_found");
  const traversal = store.appendLog("../x", [logA]);
  assert.equal(traversal.ok === false && traversal.code, "invalid");
});

test("known limitation: a bridge write keeps the body and every field value but normalises frontmatter formatting", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(
    file,
    text.replace("status: ready", "status: ready   # 人加的註解"),
  );
  assert.ok(fs.readFileSync(file, "utf8").includes("# 人加的註解"));
  assert.equal(store.appendLog(sample.id, [logA]).ok, true);
  const after = fs.readFileSync(file, "utf8");
  assert.equal(after.includes("# 人加的註解"), false);
  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.status, "ready");
  assert.equal(read.ok && read.card.title, ready.title);
  assert.ok(read.ok && read.card.body.startsWith("# 新建立的卡片\n"));
});

import { OMITTED_TEXT, type CardEvent } from "../src/card-events.js";

const startedEvent: CardEvent = {
  time: "2026-11-02T08:15:00Z",
  eventId: "ev0001",
  event: "started",
  taskId: "task-42",
};

test("recordEvent writes the templated line, is idempotent by event id and bumps updated", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const first = store.recordEvent(sample.id, startedEvent);
  assert.equal(first.ok && first.added, 1);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(
    text.includes(
      "- 2026-11-02T08:15:00Z | started | 開始執行 task task-42 | ev:ev0001\n",
    ),
  );
  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.updated, "2026-11-02");

  const again = store.recordEvent(sample.id, startedEvent);
  assert.equal(again.ok && again.added, 0);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("recordEvent appends events in order", () => {
  const { root, store } = seededReady();
  store.recordEvent(sample.id, startedEvent);
  store.recordEvent(sample.id, {
    time: "2026-11-02T09:00:00Z",
    eventId: "ev0002",
    event: "blocked",
    reason: "quota",
  });
  const text = fs.readFileSync(path.join(root, `${sample.id}.md`), "utf8");
  const first = text.indexOf("ev:ev0001");
  const second = text.indexOf("ev:ev0002");
  assert.ok(first > 0 && second > first);
});

test("a suspected secret never reaches the file: the event is kept with the fixed message", () => {
  const { root, store } = seededReady();
  const secret = ["gh", "p_", "FAKEFAKEFAKE0123456789ABCD"].join("");
  const result = store.recordEvent(sample.id, {
    time: "2026-11-02T08:15:00Z",
    eventId: "ev0003",
    event: "failed",
    code: "push_rejected",
    reason: `remote said token ${secret}`,
  });
  assert.equal(result.ok && result.added, 1);
  const text = fs.readFileSync(path.join(root, `${sample.id}.md`), "utf8");
  assert.equal(text.includes(secret), false);
  assert.ok(
    text.includes(
      `- 2026-11-02T08:15:00Z | failed | ${OMITTED_TEXT} | ev:ev0003\n`,
    ),
  );
});

test("recordEvent rejects an invalid event, an unknown card and a malformed id without writing", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const invalid = store.recordEvent(sample.id, {
    ...startedEvent,
    taskId: "has space",
  });
  assert.equal(invalid.ok === false && invalid.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const missing = store.recordEvent("REQ-20261101-missing", startedEvent);
  assert.equal(missing.ok === false && missing.code, "not_found");
  const traversal = store.recordEvent("../x", startedEvent);
  assert.equal(traversal.ok === false && traversal.code, "invalid");
});

import type { ProjectInfo } from "../src/card-projects.js";

const fooInfo: ProjectInfo = {
  machine: "local",
  repoPath: "/Users/example/git_wk/Foo",
  branch: "card/REQ-20261101-created",
};

test("recordProject writes the section, adds the name to projects and bumps updated", () => {
  const { root, store } = seededReady();
  const result = store.recordProject(sample.id, fooInfo, "2026-11-03");
  assert.equal(result.ok && result.name, "local:Foo");
  assert.deepEqual(result.ok && result.omitted, []);
  const read = store.read(sample.id);
  assert.deepEqual(read.ok && read.card.projects, ["local:Foo"]);
  assert.equal(read.ok && read.card.updated, "2026-11-03");
  assert.ok(
    read.ok &&
      read.card.body.includes(
        "## 異動專案\n\n### local:Foo\n\n- 機器：local\n- repo：/Users/example/git_wk/Foo\n- 分支：card/REQ-20261101-created\n",
      ),
  );
  assert.ok(read.ok && read.card.body.startsWith("# 新建立的卡片\n"));
  if (process.platform !== "win32")
    assert.equal(modeOf(path.join(root, `${sample.id}.md`)), 0o600);
});

test("recordProject is idempotent and does not rewrite the file", () => {
  const { root, store } = seededReady();
  const first = store.recordProject(sample.id, fooInfo, "2026-11-03");
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const again = store.recordProject(sample.id, fooInfo, "2026-11-09");
  assert.equal(again.ok && first.ok && again.hash === first.hash, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a second project and later updates keep both, change only the given fields and never duplicate a name", () => {
  const { store } = seededReady();
  store.recordProject(sample.id, fooInfo, "2026-11-03");
  store.recordProject(
    sample.id,
    { machine: "agy-pod", repoPath: "/srv/Bar" },
    "2026-11-03",
  );
  store.recordProject(
    sample.id,
    {
      ...fooInfo,
      headSha: "abcdef1234567890",
      prUrl: "https://github.com/o/r/pull/9",
    },
    "2026-11-04",
  );
  const read = store.read(sample.id);
  assert.deepEqual(read.ok && read.card.projects, ["local:Foo", "agy-pod:Bar"]);
  const body = read.ok ? read.card.body : "";
  assert.equal(body.split("### local:Foo").length, 2);
  assert.ok(
    body.includes(
      "- head：abcdef123456\n- PR：https://github.com/o/r/pull/9\n",
    ),
  );
  assert.ok(
    body.includes("### agy-pod:Bar\n\n- 機器：agy-pod\n- repo：/srv/Bar\n"),
  );
  assert.equal(read.ok && read.card.updated, "2026-11-04");
});

test("recordProject keeps the legacy project field and the human text", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  store.create({ ...sample, status: "ready", project: "Legacy" });
  assert.equal(store.recordProject(sample.id, fooInfo, "2026-11-03").ok, true);
  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.project, "Legacy");
  assert.ok(read.ok && read.card.body.startsWith("# 新建立的卡片\n"));
});

test("recordProject rejects bad input, an unknown card and a malformed id without writing", () => {
  const { root, store } = seededReady();
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const badInfo = store.recordProject(
    sample.id,
    { ...fooInfo, repoPath: "relative" },
    "2026-11-03",
  );
  assert.equal(badInfo.ok === false && badInfo.code, "invalid");
  const badDate = store.recordProject(sample.id, fooInfo, "2026-13-45");
  assert.equal(badDate.ok === false && badDate.code, "invalid");
  const missing = store.recordProject(
    "REQ-20261101-missing",
    fooInfo,
    "2026-11-03",
  );
  assert.equal(missing.ok === false && missing.code, "not_found");
  const traversal = store.recordProject("../x", fooInfo, "2026-11-03");
  assert.equal(traversal.ok === false && traversal.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a suspected secret omits only that field and never reaches the file", () => {
  const { root, store } = seededReady();
  const token = ["gh", "p_", "FAKEFAKEFAKE0123456789ABCD"].join("");
  const result = store.recordProject(
    sample.id,
    { ...fooInfo, branch: token },
    "2026-11-03",
  );
  assert.deepEqual(result.ok && result.omitted, ["branch"]);
  const text = fs.readFileSync(path.join(root, `${sample.id}.md`), "utf8");
  assert.equal(text.includes(token), false);
  assert.ok(text.includes("- 分支：（已省略：疑似含機敏資料）\n"));
});

test("a card cannot hold more than 20 projects and a failed write leaves it untouched", () => {
  const { root, store } = seededReady();
  for (let i = 0; i < 20; i++)
    assert.equal(
      store.recordProject(
        sample.id,
        { machine: "local", repoPath: `/r/p${i}` },
        "2026-11-03",
      ).ok,
      true,
      `project ${i}`,
    );
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const extra = store.recordProject(
    sample.id,
    { machine: "local", repoPath: "/r/p20" },
    "2026-11-03",
  );
  assert.equal(extra.ok === false && extra.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

import { parseLogLine } from "../src/card-ledger.js";

const stamp = (n: number): string =>
  new Date(Date.UTC(2026, 10, 2, 8, 0, n)).toISOString().slice(0, 19) + "Z";
const rotEntry = (n: number): LogEntry => ({
  time: stamp(n),
  event: "started",
  text: `第 ${n} 筆 ${"x".repeat(60)}`,
  eventId: `e${String(n).padStart(4, "0")}`,
});
const rotEntries = (from: number, to: number): LogEntry[] =>
  Array.from({ length: to - from + 1 }, (_, i) => rotEntry(from + i));
const ids = (from: number, to: number): string[] =>
  rotEntries(from, to).map((entry) => entry.eventId);
const idsOfText = (text: string): string[] =>
  text
    .split("\n")
    .map(parseLogLine)
    .filter((entry): entry is LogEntry => entry !== null)
    .map((entry) => entry.eventId);

function smallStore() {
  const root = tempRoot();
  const store = new CardStore(root, { maxFileBytes: 4096 });
  assert.equal(store.create({ ...sample, status: "ready" }).ok, true);
  const cardFile = path.join(root, `${sample.id}.md`);
  const sideDir = path.join(root, "logs", sample.id);
  return { root, store, cardFile, sideDir };
}

test("rotation keeps the newest 5 entries in the card and moves the rest to logs/<id>/0001.md", () => {
  const { store, cardFile, sideDir } = smallStore();
  const result = store.appendLog(sample.id, rotEntries(1, 40));
  assert.equal(result.ok && result.added, 40);

  const card = fs.readFileSync(cardFile, "utf8");
  assert.deepEqual(idsOfText(card), ids(36, 40));
  assert.ok(
    card.includes(`\n> 較早紀錄已移到 logs/${sample.id}/0001.md（只增不改）\n`),
  );
  assert.ok(Buffer.byteLength(card) <= 4096);

  const side = fs.readFileSync(path.join(sideDir, "0001.md"), "utf8");
  assert.deepEqual(idsOfText(side), ids(1, 35));
  assert.ok(side.startsWith(`# ${sample.id} 流程紀錄（旁檔 0001）\n\n`));
  assert.deepEqual(fs.readdirSync(sideDir), ["0001.md"]);

  const read = store.read(sample.id);
  assert.equal(read.ok && read.card.updated, "2026-11-02");
});

test("side files and their directory are private and are not mistaken for cards", () => {
  const { root, store } = smallStore();
  store.appendLog(sample.id, rotEntries(1, 40));
  if (process.platform !== "win32") {
    assert.equal(modeOf(path.join(root, "logs")), 0o700);
    assert.equal(modeOf(path.join(root, "logs", sample.id)), 0o700);
    assert.equal(modeOf(path.join(root, "logs", sample.id, "0001.md")), 0o600);
  }
  const listed = store.list();
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(
    listed.cards.map((entry) => entry.file),
    [`${sample.id}.md`],
  );
  assert.deepEqual([...store.existingIds()], [sample.id]);
});

test("readLog returns every entry in order across side files and the card, without duplicates", () => {
  const { store } = smallStore();
  store.appendLog(sample.id, rotEntries(1, 40));
  const log = store.readLog(sample.id);
  assert.deepEqual(
    log.ok && log.entries.map((entry) => entry.eventId),
    ids(1, 40),
  );
  assert.deepEqual(log.ok && log.entries[0], rotEntry(1));
});

test("a second rotation adds 0002, updates the single pointer and keeps every entry", () => {
  const { store, cardFile, sideDir } = smallStore();
  store.appendLog(sample.id, rotEntries(1, 40));
  store.appendLog(sample.id, rotEntries(41, 80));
  const card = fs.readFileSync(cardFile, "utf8");
  assert.deepEqual(idsOfText(card), ids(76, 80));
  assert.equal(card.split("較早紀錄已移到").length, 2);
  assert.ok(
    card.includes(
      `> 較早紀錄已移到 logs/${sample.id}/0001.md 到 0002.md（只增不改）`,
    ),
  );
  assert.deepEqual(fs.readdirSync(sideDir).sort(), ["0001.md", "0002.md"]);
  const log = store.readLog(sample.id);
  assert.deepEqual(
    log.ok && log.entries.map((entry) => entry.eventId),
    ids(1, 80),
  );
});

test("an event that was already rotated out is still recognised, so replaying it adds nothing", () => {
  const { store, cardFile, sideDir } = smallStore();
  const first = store.appendLog(sample.id, rotEntries(1, 40));
  const before = fs.readFileSync(cardFile, "utf8");
  const replay = store.appendLog(sample.id, [rotEntry(3), rotEntry(35)]);
  assert.equal(replay.ok && replay.added, 0);
  assert.equal(replay.ok && first.ok && replay.hash === first.hash, true);
  assert.equal(fs.readFileSync(cardFile, "utf8"), before);
  assert.deepEqual(fs.readdirSync(sideDir), ["0001.md"]);
});

test("a crash between the side file and the card leaves duplicates that are removed on read and reused on retry", () => {
  const { store, cardFile, sideDir } = smallStore();
  const cardBefore = fs.readFileSync(cardFile, "utf8");
  const original = store.update.bind(store);
  store.update = () => ({
    ok: false,
    code: "conflict",
    error: "simulated crash",
  });
  const failed = store.appendLog(sample.id, rotEntries(1, 40));
  assert.equal(failed.ok === false && failed.code, "conflict");
  assert.equal(fs.readFileSync(cardFile, "utf8"), cardBefore);
  assert.deepEqual(fs.readdirSync(sideDir), ["0001.md"]);
  const midway = store.readLog(sample.id);
  assert.deepEqual(
    midway.ok && midway.entries.map((entry) => entry.eventId),
    ids(1, 35),
  );

  store.update = original;
  const retried = store.appendLog(sample.id, rotEntries(1, 40));
  assert.equal(retried.ok && retried.added, 40);
  assert.deepEqual(fs.readdirSync(sideDir), ["0001.md"]);
  assert.deepEqual(idsOfText(fs.readFileSync(cardFile, "utf8")), ids(36, 40));
  const log = store.readLog(sample.id);
  assert.deepEqual(
    log.ok && log.entries.map((entry) => entry.eventId),
    ids(1, 40),
  );
});

test("when the card is too large to hold even the newest entries, the append is refused and nothing is written", () => {
  const root = tempRoot();
  const store = new CardStore(root, { maxFileBytes: 4096 });
  store.create({
    ...sample,
    status: "ready",
    body: "# 人寫的\n" + "字".repeat(1150) + "\n",
  });
  const cardFile = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(cardFile, "utf8");
  const result = store.appendLog(sample.id, rotEntries(1, 10));
  assert.equal(result.ok === false && result.code, "too_large");
  assert.equal(fs.readFileSync(cardFile, "utf8"), before);
  assert.equal(fs.existsSync(path.join(root, "logs")), false);
});

test("if the side file cannot be written the append is refused and the card is untouched", () => {
  const { root, store, cardFile } = smallStore();
  fs.writeFileSync(path.join(root, "logs"), "not a directory\n");
  const before = fs.readFileSync(cardFile, "utf8");
  const result = store.appendLog(sample.id, rotEntries(1, 40));
  assert.equal(result.ok === false && result.code, "io");
  assert.equal(fs.readFileSync(cardFile, "utf8"), before);
});

test("a symbolic link where the logs directory should be is refused and nothing is written through it", () => {
  const { root, store, cardFile } = smallStore();
  const outside = tempRoot();
  fs.symlinkSync(outside, path.join(root, "logs"));
  const before = fs.readFileSync(cardFile, "utf8");
  const result = store.appendLog(sample.id, rotEntries(1, 40));
  assert.equal(result.ok === false && result.code, "unsafe");
  assert.equal(fs.readFileSync(cardFile, "utf8"), before);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a card without a log has an empty readLog and unknown or malformed ids are reported", () => {
  const { store } = smallStore();
  const empty = store.readLog(sample.id);
  assert.deepEqual(empty.ok && empty.entries, []);
  const missing = store.readLog("REQ-20261101-missing");
  assert.equal(missing.ok === false && missing.code, "not_found");
  const bad = store.readLog("../x");
  assert.equal(bad.ok === false && bad.code, "invalid");
});

test("a card that stays below the threshold never creates a logs directory", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  store.create({ ...sample, status: "ready" });
  store.appendLog(sample.id, rotEntries(1, 20));
  assert.equal(fs.existsSync(path.join(root, "logs")), false);
  const log = store.readLog(sample.id);
  assert.deepEqual(
    log.ok && log.entries.map((entry) => entry.eventId),
    ids(1, 20),
  );
});

test("a single append is limited to 200 entries so a side file can never outgrow the absolute file limit", () => {
  const root = tempRoot();
  const store = new CardStore(root);
  store.create({ ...sample, status: "ready" });
  const file = path.join(root, `${sample.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const tooMany = store.appendLog(sample.id, rotEntries(1, 201));
  assert.equal(tooMany.ok === false && tooMany.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const exactly = store.appendLog(sample.id, rotEntries(1, 200));
  assert.equal(exactly.ok && exactly.added, 200);
});

test("side files are read with the absolute limit, so a rotation near a small store limit stays readable", () => {
  const { store } = smallStore();
  store.appendLog(sample.id, rotEntries(1, 40));
  // 旁檔約 4 KB，已超過這個 store 的 4096 位元組上限；仍必須能讀回並去重。
  const replay = store.appendLog(sample.id, [rotEntry(1)]);
  assert.equal(replay.ok && replay.added, 0);
  const log = store.readLog(sample.id);
  assert.equal(log.ok && log.entries.length, 40);
});

test("recordTask adds the task id to tasks, bumps updated and keeps the body", () => {
  const { root, store } = seededReady();
  const result = store.recordTask(ready.id, "task-aaa-1", "2026-11-03");
  assert.equal(result.ok, true);
  const read = store.read(ready.id);
  assert.deepEqual(read.ok && read.card.tasks, ["task-aaa-1"]);
  assert.equal(read.ok && read.card.updated, "2026-11-03");
  assert.equal(read.ok && read.card.body, ready.body);
  if (process.platform !== "win32")
    assert.equal(modeOf(path.join(root, `${ready.id}.md`)), 0o600);
});

test("recordTask is idempotent, keeps order, and refuses a bad id, a bad date or an unknown card", () => {
  const { root, store } = seededReady();
  store.recordTask(ready.id, "task-aaa-1", "2026-11-03");
  store.recordTask(ready.id, "task-bbb-2", "2026-11-03");
  const file = path.join(root, `${ready.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const again = store.recordTask(ready.id, "task-aaa-1", "2026-11-09");
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const read = store.read(ready.id);
  assert.deepEqual(read.ok && read.card.tasks, ["task-aaa-1", "task-bbb-2"]);

  assert.equal(store.recordTask(ready.id, "bad id", "2026-11-03").ok, false);
  assert.equal(store.recordTask(ready.id, "task-ccc", "yesterday").ok, false);
  const missing = store.recordTask(
    "REQ-20261101-nothing",
    "task-x",
    "2026-11-03",
  );
  assert.equal(!missing.ok && missing.code, "not_found");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("recordTask stops at 50 tasks without touching the file", () => {
  const { root, store } = seededReady();
  for (let i = 0; i < 50; i++)
    assert.equal(
      store.recordTask(ready.id, `task-${i}`, "2026-11-03").ok,
      true,
    );
  const file = path.join(root, `${ready.id}.md`);
  const before = fs.readFileSync(file, "utf8");
  const over = store.recordTask(ready.id, "task-50", "2026-11-03");
  assert.equal(!over.ok && over.code, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("bridge writes never rewrite a free-text decision section written by a person or an Agent", () => {
  const { store } = seededReady();
  const decisions =
    "## 決議\n\n- 2026-11-03 Agent：改用串流輸出\n  - 理由：大檔會 OOM\n- 2026-11-03 使用者：同意，先不做壓縮\n";
  const current = store.read(ready.id);
  assert.equal(current.ok, true);
  if (!current.ok) return;
  const body = `${current.card.body.trimEnd()}\n\n${decisions}`;
  const hash = current.hash;
  assert.equal(
    store.update(ready.id, hash, (card) => ({ ...card, body })).ok,
    true,
  );

  store.setStatus(ready.id, "in_progress", "2026-11-03");
  store.recordTask(ready.id, "task-x", "2026-11-03");
  store.recordProject(
    ready.id,
    {
      machine: "local",
      repoPath: "/a/Foo",
      branch: "card/ab",
      worktreeState: "active",
    },
    "2026-11-03",
  );
  store.recordEvent(ready.id, {
    time: "2026-11-03T08:00:00Z",
    eventId: "ev-decision-check",
    event: "resumed",
  });
  store.recordProject(
    ready.id,
    { machine: "local", repoPath: "/a/Foo", worktreeState: "removed" },
    "2026-11-03",
  );

  const after = store.read(ready.id);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.ok(after.card.body.includes(decisions), "decision section changed");
  assert.ok(after.card.body.includes("- worktree 狀態：已清理（分支保留）"));
  assert.ok(after.card.body.includes("## 流程紀錄"));
});
