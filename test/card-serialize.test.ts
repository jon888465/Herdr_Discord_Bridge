import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { parseCard, type Card } from "../src/card.js";
import { serializeCard } from "../src/card-serialize.js";

const minimal: Card = {
  id: "REQ-20261030-example",
  type: "requirement",
  status: "draft",
  title: "範例卡片",
  version: 1,
  created: "2026-10-30",
  updated: "2026-10-30",
  body: "# 範例卡片\n\n## 描述\n內容\n",
};

const minimalText = `---
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

test("a minimal card serializes to the canonical text and reads back equal", () => {
  const result = serializeCard(minimal);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, minimalText);
  const reread = parseCard(result.text, "REQ-20261030-example.md");
  assert.deepEqual(reread.ok ? reread.card : null, minimal);
});

for (const title of [
  "含: 冒號",
  "a # b",
  '"引號"',
  "back\\slash",
  "null",
  "123",
  "-5",
  " leading",
  "trailing ",
  "[x]",
  "{y}",
  "-dash",
  "a,b",
  "&anchor",
  "*star",
  "!tag",
  "|pipe",
  ">fold",
  "#hash",
  "50% done",
  "結尾冒號:",
  "已經沒事的普通標題",
]) {
  test(`title ${JSON.stringify(title)} survives a serialize and parse round trip`, () => {
    const card = { ...minimal, title };
    const result = serializeCard(card);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const reread = parseCard(result.text, "REQ-20261030-example.md");
    assert.deepEqual(reread.ok ? reread.card.title : reread.error, title);
  });
}

test("a plain title stays unquoted for readability", () => {
  const result = serializeCard({
    ...minimal,
    title: "卡片驅動：從工作單到 PR／CI",
  });
  assert.equal(
    result.ok && result.text.includes("\ntitle: 卡片驅動：從工作單到 PR／CI\n"),
    true,
  );
});

test("values other YAML tools would misread are quoted as well", () => {
  for (const title of ["#hash", "-dash", "%pct", "@at", "`tick", "?q"]) {
    const result = serializeCard({ ...minimal, title });
    assert.equal(result.ok, true, title);
    if (!result.ok) continue;
    assert.ok(
      result.text.includes(`\ntitle: ${JSON.stringify(title)}\n`),
      title,
    );
  }
});

const full: Card = {
  ...minimal,
  source: "與使用者討論",
  project: "Herdr_Discord_Bridge",
  links: {
    related_docs: ["docs/a.md", "docs/b.md"],
    related_issues: ["ISSUE-025"],
    parent: "REQ-20261030-parent",
  },
  external: {
    notion: null,
    github: "https://github.com/o/r/pull/1",
    mantis: null,
  },
};

test("optional fields are written in a fixed order and read back equal", () => {
  const result = serializeCard(full);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const frontmatter = result.text.split("\n---\n")[0];
  assert.equal(
    frontmatter.split("\n").slice(8).join("\n"),
    [
      "source: 與使用者討論",
      "project: Herdr_Discord_Bridge",
      "links: { related_docs: [docs/a.md, docs/b.md], related_issues: [ISSUE-025], parent: REQ-20261030-parent }",
      "external: { notion: null, github: https://github.com/o/r/pull/1, mantis: null }",
    ].join("\n"),
  );
  const reread = parseCard(result.text, "REQ-20261030-example.md");
  assert.deepEqual(reread.ok ? reread.card : reread.error, full);
});

test("output does not depend on the property order of the input object", () => {
  const shuffled = {
    body: full.body,
    external: { mantis: null, github: full.external?.github, notion: null },
    links: {
      parent: full.links?.parent,
      related_docs: full.links?.related_docs,
    },
    project: full.project,
    updated: full.updated,
    created: full.created,
    version: full.version,
    title: full.title,
    status: full.status,
    type: full.type,
    id: full.id,
    source: full.source,
  } as Card;
  const a = serializeCard(shuffled);
  const b = serializeCard({
    ...full,
    links: {
      related_docs: full.links?.related_docs,
      parent: full.links?.parent,
    },
  });
  assert.equal(a.ok && b.ok && a.text === b.text, true);
});

test("empty arrays and partial links or external round trip", () => {
  const card: Card = {
    ...minimal,
    links: { related_docs: [] },
    external: { mantis: "MANTIS-12" },
  };
  const result = serializeCard(card);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.text.includes("\nlinks: { related_docs: [] }\n"));
  assert.ok(result.text.includes("\nexternal: { mantis: MANTIS-12 }\n"));
  const reread = parseCard(result.text, "REQ-20261030-example.md");
  assert.deepEqual(reread.ok ? reread.card : reread.error, card);
});

for (const [name, card] of [
  ["a title with a newline", { ...minimal, title: "第一行\n第二行" }],
  ["an unknown status", { ...minimal, status: "bogus" }],
  ["a malformed id", { ...minimal, id: "not-an-id" }],
  ["a non-integer version", { ...minimal, version: 1.5 }],
  ["an over-long title", { ...minimal, title: "字".repeat(121) }],
  [
    "a body that would change on reading (CR)",
    { ...minimal, body: "a\r\nb\n" },
  ],
  ["an invalid date", { ...minimal, created: "2026-02-30" }],
] as const) {
  test(`${name} is refused instead of writing a file that cannot be read back`, () => {
    const result = serializeCard(card);
    assert.equal(result.ok, false);
  });
}

test("every card in docs/cards survives parse, serialize and parse again", () => {
  const directory = path.resolve("docs/cards");
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".md"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const first = parseCard(
      fs.readFileSync(path.join(directory, name), "utf8"),
      name,
    );
    assert.equal(first.ok, true, name);
    if (!first.ok) continue;
    const written = serializeCard(first.card);
    assert.equal(written.ok, true, name);
    if (!written.ok) continue;
    const second = parseCard(written.text, name);
    assert.deepEqual(second.ok ? second.card : second.error, first.card, name);
    const again = serializeCard(first.card);
    assert.equal(again.ok && again.text === written.text, true, name);
  }
});
