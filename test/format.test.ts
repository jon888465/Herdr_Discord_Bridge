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

test("splitDiscordText preserves long agent responses across all chunks", () => {
  const response = "response line\n".repeat(300);
  const chunks = splitDiscordText(codeBlock(response));

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.equal(
    chunks.join("").replace(/\s/g, ""),
    codeBlock(response).replace(/\s/g, ""),
  );
});

test("codeBlock neutralizes nested fences", () => {
  const rendered = codeBlock("a```b");
  assert.ok(rendered.startsWith("```text\n"));
  assert.equal((rendered.match(/```/g) || []).length, 2);
});

test("agent header identifies the Agent, workspace, and pane", () => {
  const rendered = agentHeader("codex", "w1", "w1:p2", "backend", "review");
  assert.match(rendered, /🤖 codex · backend/);
  assert.match(rendered, /WK: w1 · review/);
  assert.match(rendered, /Pane: w1:p2/);
});

test("agent header is one unframed line and shows the machine only through the pane id", () => {
  const local = agentHeader("codex", "w1", "w1:p2", "backend", "review");
  assert.equal(local.split("\n").length, 3);
  assert.doesNotMatch(local, /[┌└│]\s*$|─/);
  assert.match(local, /🤖 codex · backend │ WK: w1 · review │ Pane: w1:p2/);
  const remote = agentHeader(
    "agy",
    "agy-pod:w2",
    "agy-pod:w2:p1",
    "agy",
    "agy-pod:~",
  );
  assert.match(remote, /🤖 agy │ WK: w2 · ~ │ Pane: agy-pod:w2:p1/);
});

test("agent header (reviewed with agy-pod): clean before comparing, per-field limits, safe separators", () => {
  // ANSI／換行不會讓同名 kind 被當成不同。
  assert.match(
    agentHeader("agy\n", "w1", "w1:p1", "\u001b[1magy", "w1"),
    /🤖 agy │ WK: w1 │ Pane: w1:p1/,
  );
  // 長且含反引號的 workspace 名稱：Pane 仍完整，且不會破壞程式碼區塊。
  const long = agentHeader(
    "bot",
    "m:w1",
    "m:w1:p1",
    "",
    "m:feat-```-long".repeat(25),
  );
  assert.match(long, /Pane: m:w1:p1$/m);
  assert.equal((long.match(/```/g) || []).length, 2);
  // 名稱含 │ 不混淆欄位；截斷以字元計，不切壞 emoji。
  assert.match(agentHeader("a│b", "w1", "w1:p1"), /🤖 a\|b │ WK: w1/);
  const emoji = agentHeader("x", "w1", "w1:p1", "", "😀".repeat(40));
  assert.doesNotMatch(emoji, /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // 機器名與 workspace 前綴重複時只顯示一次。
  assert.match(
    agentHeader("agy", "dev:w1", "dev:w1:p2", "", "dev:ops:test"),
    /🤖 agy │ WK: w1 · ops:test │ Pane: dev:w1:p2/,
  );
});

test("mention-only commands and prefixed commands share the same parser", () => {
  assert.deepEqual(parseCommandText("agents", "/herdr", true, true), {
    rest: "agents",
  });
  assert.deepEqual(parseCommandText("/herdr agents", "/herdr", true, true), {
    rest: "agents",
  });
  assert.deepEqual(parseCommandText("current", "/herdr", true, true), {
    rest: "current",
  });
  assert.deepEqual(parseCommandText("agent use w2:p4", "/herdr", true, true), {
    rest: "agent use w2:p4",
  });
  assert.deepEqual(parseCommandText("wk", "/herdr", true, true), {
    rest: "wk",
  });
  assert.equal(parseCommandText("agents", "/herdr", false, true), null);
  assert.equal(
    parseCommandText("please inspect auth", "/herdr", true, true),
    null,
  );
});
