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

test("a file over 256 KiB is refused without being parsed", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "REQ-20261101-huge.md"),
    card("REQ-20261101-huge") + "a".repeat(300 * 1024),
  );
  const store = new CardStore(root);
  assert.match(store.list().errors[0].error, /256 KiB/);
  const read = store.read("REQ-20261101-huge");
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.code, "too_large");
});

import { serializeCard } from "../src/card-serialize.js";
import type { Card } from "../src/card.js";

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
