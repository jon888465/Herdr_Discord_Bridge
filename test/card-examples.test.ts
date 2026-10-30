import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCard } from "../src/card.js";
import { importCard } from "../src/card-import.js";
import { serializeCard } from "../src/card-serialize.js";

const directory = path.resolve("docs/card-examples");
const files = fs.existsSync(directory)
  ? fs.readdirSync(directory).filter((name) => /^(REQ|TKT)-.*\.md$/.test(name))
  : [];

test("the examples directory ships a requirement, a Mantis ticket and a minimal card", () => {
  assert.deepEqual(files.sort(), [
    "REQ-20261030-example-feature.md",
    "REQ-20261030-example-minimal.md",
    "TKT-20261030-example-mantis-bug.md",
  ]);
});

for (const name of files) {
  const text = fs.readFileSync(path.join(directory, name), "utf8");

  test(`${name} parses under the strict subset and matches its filename`, () => {
    const result = parseCard(text, name);
    assert.deepEqual(result.ok ? null : result.error, null);
  });

  test(`${name} survives serialize and parse unchanged`, () => {
    const first = parseCard(text, name);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const written = serializeCard(first.card);
    assert.equal(written.ok, true);
    if (!written.ok) return;
    const second = parseCard(written.text, name);
    assert.deepEqual(second.ok ? second.card : second.error, first.card);
  });

  test(`${name} imports as a draft`, () => {
    const result = importCard(text, {
      today: "2026-10-30",
      existingIds: new Set<string>(),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.card.status, "draft");
  });
}

test("the Mantis example keeps the Mantis number in external.mantis", () => {
  const text = fs.readFileSync(
    path.join(directory, "TKT-20261030-example-mantis-bug.md"),
    "utf8",
  );
  const result = parseCard(text, "TKT-20261030-example-mantis-bug.md");
  assert.equal(result.ok && result.card.type, "ticket");
  assert.equal(result.ok && typeof result.card.external?.mantis, "string");
});
