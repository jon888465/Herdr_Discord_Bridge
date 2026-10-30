import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCard } from "../src/card.js";

const minimal = `---
id: REQ-20261030-example
type: requirement
status: draft
title: 範例卡片
version: 1
created: 2026-10-30
updated: 2026-10-30
---
# 範例卡片

## 描述
內容
`;

test("a minimal valid card parses into typed fields and keeps the body", () => {
  const result = parseCard(minimal, "REQ-20261030-example.md");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.id, "REQ-20261030-example");
  assert.equal(result.card.type, "requirement");
  assert.equal(result.card.status, "draft");
  assert.equal(result.card.title, "範例卡片");
  assert.equal(result.card.version, 1);
  assert.equal(result.card.created, "2026-10-30");
  assert.equal(result.card.updated, "2026-10-30");
  assert.match(result.card.body, /^# 範例卡片/);
  assert.match(result.card.body, /內容/);
});

for (const key of [
  "id",
  "type",
  "status",
  "title",
  "version",
  "created",
  "updated",
]) {
  test(`a card without required field "${key}" is rejected`, () => {
    const text = minimal
      .split("\n")
      .filter((line) => !line.startsWith(`${key}:`))
      .join("\n");
    const result = parseCard(text, "REQ-20261030-example.md");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, new RegExp(`"${key}"`));
  });
}

test("text without a frontmatter block is rejected", () => {
  const result = parseCard("# 只有內文\n", "REQ-20261030-example.md");
  assert.equal(result.ok, false);
});

test("an unterminated frontmatter block is rejected", () => {
  const result = parseCard(
    minimal.replace("\n---\n# 範例卡片", "\n# 範例卡片"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, false);
});

function withExtra(...extra: string[]): string {
  return minimal.replace(
    "\n---\n# 範例卡片",
    `\n${extra.join("\n")}\n---\n# 範例卡片`,
  );
}

test("a duplicate key is rejected", () => {
  const result = parseCard(
    withExtra("title: 另一個標題"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /duplicate/);
});

test("an unknown top-level key is rejected, including an x- prefixed one", () => {
  for (const line of ["owner: someone", "x-note: 自訂欄位"]) {
    const result = parseCard(withExtra(line), "REQ-20261030-example.md");
    assert.equal(result.ok, false, line);
    if (!result.ok) assert.match(result.error, /unknown key/, line);
  }
});

for (const [name, line] of [
  ["a block scalar", "source: |"],
  ["a folded scalar", "source: >"],
  ["an empty value that starts a block", "source:"],
  ["an indented continuation line", "  continued: value"],
  ["a list item line", "- item"],
  ["an anchor", "source: &anchor value"],
  ["an alias", "source: *anchor"],
  ["a tag", "source: !!str value"],
  ["a merge key", "<<: value"],
]) {
  test(`${name} is rejected`, () => {
    const result = parseCard(withExtra(line), "REQ-20261030-example.md");
    assert.equal(result.ok, false);
  });
}

test("blank lines and full-line comments inside frontmatter are ignored", () => {
  const result = parseCard(
    withExtra("", "# 只是註解"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
});

test("a trailing comment is stripped from an unquoted value", () => {
  const result = parseCard(
    minimal.replace("status: draft", "status: draft   # 說明"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.card.status, "draft");
});

test("a double-quoted value may contain a colon, a hash and an escaped quote", () => {
  const result = parseCard(
    minimal.replace("title: 範例卡片", 'title: "含: 冒號 # 井字 \\"引號\\""'),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.card.title, '含: 冒號 # 井字 "引號"');
});

test("an unquoted value containing a colon and a space is rejected", () => {
  const result = parseCard(
    withExtra("source: a: b"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, false);
});

test("an unterminated or badly escaped quoted value is rejected", () => {
  assert.equal(
    parseCard(withExtra('source: "未結束'), "REQ-20261030-example.md").ok,
    false,
  );
  assert.equal(
    parseCard(withExtra('source: "bad \\x escape"'), "REQ-20261030-example.md")
      .ok,
    false,
  );
  assert.equal(
    parseCard(withExtra('source: "ok" trailing'), "REQ-20261030-example.md").ok,
    false,
  );
});

test("source and project are plain strings", () => {
  const result = parseCard(
    withExtra("source: 與使用者討論", "project: Herdr_Discord_Bridge"),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.source, "與使用者討論");
  assert.equal(result.card.project, "Herdr_Discord_Bridge");
});

test("links accepts inline arrays and a parent id", () => {
  const result = parseCard(
    withExtra(
      "links: { related_docs: [docs/a.md, docs/b.md], related_issues: [ISSUE-025], parent: REQ-20261030-parent }",
    ),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.card.links, {
    related_docs: ["docs/a.md", "docs/b.md"],
    related_issues: ["ISSUE-025"],
    parent: "REQ-20261030-parent",
  });
});

test("external accepts strings and null", () => {
  const result = parseCard(
    withExtra(
      'external: { notion: null, github: "https://github.com/o/r/pull/1", mantis: null }',
    ),
    "REQ-20261030-example.md",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.card.external, {
    notion: null,
    github: "https://github.com/o/r/pull/1",
    mantis: null,
  });
});

for (const [name, line] of [
  ["an unknown links key", "links: { owner: someone }"],
  ["an unknown external key", "external: { jira: x }"],
  ["a nested object", "links: { parent: { a: b } }"],
  ["a nested array", "links: { related_docs: [[a]] }"],
  ["an unbalanced inline object", "links: { related_docs: [a]"],
  ["an unbalanced inline array", "links: { related_docs: [a }"],
  ["a top-level array for links", "links: [a, b]"],
  ["a non-string external value", "external: { notion: 5 }"],
  ["a bad parent id", "links: { parent: not-an-id }"],
]) {
  test(`${name} is rejected`, () => {
    assert.equal(
      parseCard(withExtra(line), "REQ-20261030-example.md").ok,
      false,
    );
  });
}

function withField(field: string, value: string): string {
  return minimal.replace(
    new RegExp(`^${field}: .*$`, "m"),
    `${field}: ${value}`,
  );
}

for (const id of [
  "REQ-20261030-Example",
  "REQ-20261030-a",
  "REQ-2026103-example",
  "BUG-20261030-example",
  "req-20261030-example",
  "REQ-20261030-" + "a".repeat(42),
]) {
  test(`id "${id}" is rejected`, () => {
    assert.equal(parseCard(withField("id", id)).ok, false);
  });
}

test("the filename must equal <id>.md, directories are ignored", () => {
  assert.equal(parseCard(minimal, "REQ-20261030-other.md").ok, false);
  assert.equal(parseCard(minimal, "REQ-20261030-example.txt").ok, false);
  assert.equal(
    parseCard(minimal, "/tmp/cards/REQ-20261030-example.md").ok,
    true,
  );
  assert.equal(parseCard(minimal).ok, true);
});

test("type must be requirement or ticket", () => {
  assert.equal(parseCard(withField("type", "ticket")).ok, true);
  assert.equal(parseCard(withField("type", "bug")).ok, false);
});

test("status must be one of the eight card statuses", () => {
  for (const status of [
    "draft",
    "discussing",
    "refined",
    "recorded",
    "ready",
    "in_progress",
    "done",
    "cancelled",
  ]) {
    assert.equal(parseCard(withField("status", status)).ok, true, status);
  }
  for (const status of ["DRAFT", "in-progress", "merged", "approved"]) {
    assert.equal(parseCard(withField("status", status)).ok, false, status);
  }
});

for (const date of [
  "2026-13-01",
  "2026-02-30",
  "2026/10/30",
  "26-10-30",
  "2026-1-5",
]) {
  test(`date "${date}" is rejected for created and updated`, () => {
    assert.equal(parseCard(withField("created", date)).ok, false);
    assert.equal(parseCard(withField("updated", date)).ok, false);
  });
}

test("version must be a positive integer", () => {
  assert.equal(parseCard(withField("version", "12")).ok, true);
  for (const version of ["0", "-1", '"1"', "1.5", "abc"]) {
    assert.equal(parseCard(withField("version", version)).ok, false, version);
  }
});

test("title must be 1 to 120 characters", () => {
  assert.equal(
    parseCard(withField("title", '"' + "字".repeat(120) + '"')).ok,
    true,
  );
  assert.equal(
    parseCard(withField("title", '"' + "字".repeat(121) + '"')).ok,
    false,
  );
  assert.equal(parseCard(withField("title", '""')).ok, false);
});

test("frontmatter over 8 KiB and files over 256 KiB are rejected", () => {
  const bigFrontmatter = parseCard(withExtra(`source: "${"a".repeat(8200)}"`));
  assert.equal(bigFrontmatter.ok, false);
  if (!bigFrontmatter.ok) assert.match(bigFrontmatter.error, /8 KiB/);
  const bigFile = parseCard(minimal + "a".repeat(256 * 1024));
  assert.equal(bigFile.ok, false);
  if (!bigFile.ok) assert.match(bigFile.error, /256 KiB/);
});

test("CRLF line endings and a leading BOM are accepted", () => {
  const crlf = minimal.replace(/\n/g, "\r\n");
  const result = parseCard("﻿" + crlf, "REQ-20261030-example.md");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.card.status, "draft");
});

test("the repository planning card parses under the strict subset", () => {
  const file = path.resolve("docs/cards/REQ-20261030-card-to-merge.md");
  const result = parseCard(fs.readFileSync(file, "utf8"), file);
  assert.deepEqual(result.ok ? null : result.error, null);
});
