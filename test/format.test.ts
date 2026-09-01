import test from "node:test";
import assert from "node:assert/strict";
import { codeBlock, splitDiscordText, stripAnsi } from "../src/format.js";

test("stripAnsi removes terminal escape sequences and controls", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\n\u0000ok"), "red\nok");
});

test("splitDiscordText respects the Discord-safe limit and prefers lines", () => {
  const chunks = splitDiscordText(
    "first line\n" + "x".repeat(30) + "\nlast",
    20,
  );
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
  assert.equal(chunks[0], "first line");
  assert.ok(chunks.at(-1)?.endsWith("last"));
  assert.equal(
    chunks.join("").replace(/\s/g, ""),
    ("first line\n" + "x".repeat(30) + "\nlast").replace(/\s/g, ""),
  );
});

test("codeBlock neutralizes nested fences", () => {
  const rendered = codeBlock("a```b");
  assert.ok(rendered.startsWith("```text\n"));
  assert.equal((rendered.match(/```/g) || []).length, 2);
});
