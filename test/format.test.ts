import test from "node:test";
import assert from "node:assert/strict";
import {
  agentHeader,
  codeBlock,
  splitDiscordText,
  stripAnsi,
} from "../src/format.js";
import { parseCommandText } from "../src/discord.js";

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

test("agent header identifies the Agent, workspace, and pane", () => {
  const rendered = agentHeader("codex", "project-backend", "w1:p2", "backend");
  assert.match(rendered, /🤖 codex · backend/);
  assert.match(rendered, /Workspace: project-backend/);
  assert.match(rendered, /Pane: w1:p2/);
});

test("mention-only commands and prefixed commands share the same parser", () => {
  assert.deepEqual(parseCommandText("agents", "/herdr", true, true), {
    rest: "agents",
  });
  assert.deepEqual(parseCommandText("/herdr agents", "/herdr", true, true), {
    rest: "agents",
  });
  assert.equal(parseCommandText("agents", "/herdr", false, true), null);
  assert.equal(
    parseCommandText("please inspect auth", "/herdr", true, true),
    null,
  );
});
