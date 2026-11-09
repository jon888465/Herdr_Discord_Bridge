import test from "node:test";
import assert from "node:assert/strict";
import { passiveUsage } from "../src/cli-adapter.js";
import { usageTable } from "../src/usage.js";
import { handleCommand } from "../src/main.js";
import { createConsoleContext, parseConsoleCommand } from "../src/console.js";
import { SHORT_COMMANDS } from "../src/discord.js";
import type { AgentRecord } from "../src/types.js";

const pane: AgentRecord = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  terminal_id: "t1",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "working",
};
const status = "5h 35% left · weekly 85% left";
test("Codex parses only the complete bottom status line and preserves wording", () => {
  assert.equal(
    passiveUsage("codex", `answer\n\x1b[32m${status}\x1b[0m\n`),
    status,
  );
  for (const text of [
    "",
    `quoted ${status}`,
    `${status} account@example.com`,
    "5h 101% left · weekly 85% left",
  ])
    assert.equal(passiveUsage("codex", text), undefined);
  for (const kind of ["claude", "agy", "pi", "other"])
    assert.equal(passiveUsage(kind, status), undefined);
  const bad = {
    toLowerCase() {
      throw new Error("parse failure");
    },
  };
  assert.equal(passiveUsage(bad as unknown as string, status), undefined);
});
test("Codex real bottom layout: model prefix and a hint line below the usage row", () => {
  // 2026-11-08 從真實 codex pane 讀到的底部三行。
  const real = [
    "› Ask Codex to do anything",
    "",
    "  GPT-6.1-Sol low · 5h 64% left · weekly 67% left",
    "  ← for agents · ? for shortcuts                       ⚠ 3 warnings · f2 to view",
  ].join("\n");
  assert.equal(passiveUsage("codex", real), "5h 64% left · weekly 67% left");
  // 用量行被推到太上面（超過底部 4 行）或夾在對話文字裡，不採用。
  assert.equal(
    passiveUsage("codex", `GPT-6.1-Sol low · ${status}\na\nb\nc\nd\n`),
    undefined,
  );
  assert.equal(
    passiveUsage("codex", `I said: GPT-6.1-Sol low · ${status} ok\n`),
    undefined,
  );
});
test("working, blocked and idle queries have only a visible-read port; failures stay per-row", async () => {
  const reads: string[] = [];
  const output = await usageTable({
    agents: [
      pane,
      { ...pane, pane_id: "w1:p2", agent_status: "blocked" },
      { ...pane, pane_id: "w1:p3", agent_status: "idle" },
    ],
    workspace: "w1",
    profiles: [{ id: "helper", kind: "claude" }],
    machines: [{ id: "remote", reachable: false }],
    read: async (id) => {
      reads.push(id);
      if (id === "w1:p2") throw new Error("secret credential");
      return id === "w1:p1" ? status : "no status";
    },
  });
  assert.deepEqual(reads, ["w1:p1", "w1:p2", "w1:p3"]);
  assert.match(output, /bottom status line/);
  assert.match(output, /unknown \(current screen unavailable; agent busy/);
  assert.match(output, /profile:helper/);
  assert.match(output, /unknown \(unreachable\)/);
  assert.doesNotMatch(output, /secret credential/);
});
test("usage routes from console and Discord and reuses selected workspace authorization", async () => {
  assert.deepEqual(parseConsoleCommand("usage w1:p1", "/herdr"), {
    command: "usage",
    args: ["w1:p1"],
  });
  assert.deepEqual(parseConsoleCommand("/herdr usage", "/herdr"), {
    command: "usage",
    args: [],
  });
  assert.ok(SHORT_COMMANDS.has("usage"));
  for (const source of ["console", undefined] as const) {
    const context = { ...createConsoleContext(() => {}), source };
    const replies: string[] = [];
    let workspace: string | undefined = "w1";
    const runtime = {
      config: { allowedWorkspaceIds: ["w1"], agentProfiles: [] },
      routing: {
        resolve: () => (workspace ? { workspaceId: workspace } : undefined),
      },
      herdr: {
        listAgentsWithWorkspaceNames: async () => [
          pane,
          { ...pane, pane_id: "w2:p1", workspace_id: "w2" },
        ],
        readAgent: async (...args: unknown[]) => {
          assert.deepEqual(args, ["w1:p1", "visible", 80]);
          return status;
        },
      },
      discord: {
        reply: async (_: unknown, text: string) => {
          replies.push(text);
        },
      },
    } as unknown as Parameters<typeof handleCommand>[3];
    await handleCommand("usage", [], context, runtime);
    assert.match(replies.join(""), /w1:p1/);
    assert.doesNotMatch(replies.join(""), /w2:p1/);
    await assert.rejects(
      handleCommand("usage", ["w2:p1"], context, runtime),
      /another workspace/,
    );
    workspace = "w2";
    await assert.rejects(
      handleCommand("usage", [], context, runtime),
      /not authorized/,
    );
    workspace = undefined;
    await assert.rejects(
      handleCommand("usage", [], context, runtime),
      /select a workspace/,
    );
  }
});

test("remote cached metadata is never read as current usage; bound profiles use the matching pane", async () => {
  let reads = 0;
  const remote = {
    ...pane,
    pane_id: "remote:w1:p1",
    workspace_id: "remote:w1",
  };
  const output = await usageTable({
    agents: [remote],
    workspace: "remote:w1",
    profiles: [],
    machines: [{ id: "remote", reachable: false }],
    read: async () => {
      reads++;
      return status;
    },
  });
  assert.equal(reads, 0);
  assert.match(output, /unreachable; cached pane metadata only/);
  const bound = await usageTable({
    agents: [pane],
    workspace: "w1",
    target: "helper",
    profiles: [{ id: "helper", kind: "codex" }],
    machines: [],
    profilePane: () => pane,
    read: async () => status,
  });
  assert.match(bound, /profile:helper \(w1:p1\).*5h 35% left/);
});
