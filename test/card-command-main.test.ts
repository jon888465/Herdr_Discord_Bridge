import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";

const card = `---
id: REQ-20261102-from-console
type: requirement
status: ready
title: 從 console 匯入
version: 1
created: 2026-11-02
updated: 2026-11-02
---

# 從 console 匯入
`;

async function withState<T>(
  body: (
    state: string,
    run: (...args: string[]) => Promise<string>,
  ) => Promise<T>,
): Promise<T> {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "card-main-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = state;
  const output: string[] = [];
  const context = createConsoleContext((text) => output.push(text));
  const runtime = {
    config: { discord: { commandPrefix: "herdr" } },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  const run = async (...args: string[]): Promise<string> => {
    output.length = 0;
    await handleCommand("card", args, context, runtime);
    return output.join("\n");
  };
  try {
    return await body(state, run);
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
  }
}

test("card commands run through handleCommand: import a local file in the console, then list and show it", async () => {
  await withState(async (state, run) => {
    const file = path.join(state, "incoming.md");
    fs.writeFileSync(file, card);
    assert.match(await run("list"), /沒有卡片/);
    assert.match(
      await run("import", file),
      /已匯入 REQ-20261102-from-console（draft）/,
    );
    assert.ok(
      fs.existsSync(path.join(state, "cards", "REQ-20261102-from-console.md")),
    );
    assert.match(
      await run("list"),
      /REQ-20261102-from-console · draft · requirement · 從 console 匯入/,
    );
    assert.match(
      await run("show", "REQ-20261102-from-console"),
      /從 console 匯入/,
    );
  });
});

test("card errors reach the caller instead of being swallowed", async () => {
  await withState(async (_state, run) => {
    await assert.rejects(run("bogus"), /usage: card/);
    await assert.rejects(run("show", "../etc/passwd"), /不是合法的卡片 id/);
  });
});
