import test from "node:test";
import assert from "node:assert/strict";
import { importCard } from "../src/card-import.js";

const foreign = `---
id: REQ-20261030-example
type: requirement
status: in_progress
title: 外部來源的卡片
version: 2
created: 2026-10-01
updated: 2026-10-20
external: { notion: "page-1", github: null, mantis: null }
---
# 外部來源的卡片

內容
`;

const options = { today: "2026-10-30", existingIds: new Set<string>() };

test("an imported card is forced to draft and its external links are cleared", () => {
  const result = importCard(foreign, options);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.status, "draft");
  assert.equal(result.card.external, undefined);
  assert.equal(result.card.title, "外部來源的卡片");
  assert.equal(result.card.version, 2);
  assert.equal(result.filename, "REQ-20261030-example.md");
  assert.deepEqual(result.notes, [
    "status in_progress -> draft",
    "external cleared",
  ]);
});

test("a draft card with only null external links imports without notes", () => {
  const text = foreign
    .replace("status: in_progress", "status: draft")
    .replace(
      'external: { notion: "page-1", github: null, mantis: null }',
      "external: { notion: null, github: null, mantis: null }",
    );
  const result = importCard(text, options);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.notes, []);
  assert.equal(result.card.external, undefined);
});

test("a card whose id already exists is rejected, not overwritten", () => {
  const result = importCard(foreign, {
    ...options,
    existingIds: new Set(["REQ-20261030-example"]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /REQ-20261030-example/);
});

test("an invalid card is rejected with the parse error", () => {
  const result = importCard(foreign.replace(/^title: .*\n/m, ""), options);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /"title"/);
});

const withoutId = foreign.replace(/^id: .*\n/m, "");

test("a card without an id gets one from the type, today and the given slug", () => {
  const result = importCard(withoutId, { ...options, slug: "imported-note" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.id, "REQ-20261030-imported-note");
  assert.equal(result.filename, "REQ-20261030-imported-note.md");
  assert.ok(result.notes.includes("id generated: REQ-20261030-imported-note"));
  const ticket = importCard(
    withoutId.replace("type: requirement", "type: ticket"),
    {
      ...options,
      slug: "imported-note",
    },
  );
  assert.equal(ticket.ok ? ticket.card.id : null, "TKT-20261030-imported-note");
});

test("a card without an id and without a slug is rejected", () => {
  const result = importCard(withoutId, options);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /slug/);
});

for (const slug of ["Bad Slug", "a", "-leading", "x".repeat(42), "中文"]) {
  test(`slug "${slug}" is rejected`, () => {
    const result = importCard(withoutId, { ...options, slug });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /slug/);
  });
}

test("the slug is ignored when the card already has an id", () => {
  const result = importCard(foreign, { ...options, slug: "ignored-name" });
  assert.equal(result.ok ? result.card.id : null, "REQ-20261030-example");
});

test("a generated id that already exists is rejected", () => {
  const result = importCard(withoutId, {
    ...options,
    slug: "imported-note",
    existingIds: new Set(["REQ-20261030-imported-note"]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already exists/);
});

test("an id cannot be generated without a valid type or date", () => {
  const noType = importCard(withoutId.replace(/^type: .*\n/m, ""), {
    ...options,
    slug: "imported-note",
  });
  assert.equal(noType.ok, false);
  if (!noType.ok) assert.match(noType.error, /"type"/);
  const badDate = importCard(withoutId, {
    today: "2026-13-45",
    existingIds: new Set<string>(),
    slug: "imported-note",
  });
  assert.equal(badDate.ok, false);
  if (!badDate.ok) assert.match(badDate.error, /today/);
});

test("inherited object property names are not valid card types", () => {
  for (const type of ["constructor", "toString", "__proto__"]) {
    const result = importCard(
      withoutId.replace("type: requirement", `type: ${type}`),
      { ...options, slug: "imported-note" },
    );
    assert.equal(result.ok, false, type);
    if (!result.ok) assert.match(result.error, /"type"/, type);
  }
});
