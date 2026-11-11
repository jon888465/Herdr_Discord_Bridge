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

import { runCardCommand, type CardCommandDeps } from "../src/card-command.js";
import { CardStore } from "../src/card-store.js";
import { prepareCardWorktree, type PrepareDeps } from "../src/card-worktree-flow.js";
import { doneAsReady, waitUntilReady } from "../src/agent-ready.js";
import type { AgentRecord } from "../src/types.js";

// ISSUE-142：codex Lead 的新 worktree Agent 停在更新提示。與 main 相同的組合（prepareCardWorktree＋
// waitUntilReady(doneAsReady(port))＋真的 matchUpdatePrompt）：先跳過、再判斷就緒、才啟動 task。
test("ISSUE-142: a codex update prompt on the worktree Lead is skipped before assign starts the task", async (t) => {
  t.mock.method(console, "log", () => {});
  const id = "REQ-20261111-update-lead";
  const order: string[] = [];
  const agent = (agent_status: string) => ({ pane_id: "w9:p1", terminal_id: "t9", workspace_id: "w9", agent: "codex", agent_status, foreground_cwd: "/r" }) as AgentRecord;
  const screens = ["Update available · 0.166.0 → 0.167.0\n  3. Skip until next version", "› Ready"];
  const panePort = doneAsReady({
    request: async (method, params) => (order.push(`${method}${params?.keys ?? ""}`), method === "agent.read" ? { read: { text: screens.shift() } } : {}),
    listAgentsWithWorkspaceNames: async () => [agent("idle")],
  });
  const rootDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "issue142-")), "cards");
  new CardStore(rootDir).create({ id, type: "requirement", status: "ready", title: "t", version: 1, created: "2026-11-11", updated: "2026-11-11", body: "# t\n\n## 描述\nx\n\n## 驗收條件\n- ok\n" });
  const prepare: PrepareDeps = {
    port: { request: async <T>(m: string) => (m === "ping" ? { version: "0.9.1" } : { worktree: { path: "/wt", branch: "b" }, workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } }) as T },
    lead: agent("idle"),
    sourceWorkspaceId: "w3",
    repoRoot: async () => "/r",
    headSha: async () => undefined,
    startAgent: async () => agent("blocked"),
    awaitReady: async (a) => {
      const ready = await waitUntilReady({ panePort, readyPollMs: 1 }, { paneId: a.pane_id, terminalId: a.terminal_id }, a);
      order.push(`ready:${ready.ok}`);
      return ready.ok ? ready.agent : undefined;
    },
    worktrees: { active: () => undefined, record: () => {} },
    authorize: () => {},
    switchRoute: () => {},
    now: () => "2026-11-11T00:00:00Z",
  };
  const deps = {
    rootDir, today: () => "2026-11-11", source: "console", attachments: [], now: () => "2026-11-11T00:00:00Z",
    assignments: { record: () => {}, forCard: () => [] }, taskInfo: () => undefined,
    prepareWorktree: (card: { id: string }) => prepareCardWorktree(prepare, card.id),
    startTask: async () => (order.push("startTask"), { taskId: "task-1111-aaaa", lead: { agent: "codex", machine: "local" } }),
  } as unknown as CardCommandDeps;
  const reply = await runCardCommand(["assign", id, "--worktree", "--coding"], deps);
  assert.deepEqual(order, ["agent.read", "pane.send_keys3", "agent.read", "ready:true", "startTask"]);
  assert.doesNotMatch(reply, /任務沒有啟動/);
  assert.match(reply, new RegExp(`已指派 ${id}`));
});
