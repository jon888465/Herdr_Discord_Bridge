import test from "node:test";
import assert from "node:assert/strict";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";

async function list(options: { live?: string[]; allowed?: string[]; fail?: boolean } = {}) {
  const output: string[] = [];
  const ids = ["w-live", "w-deleted", "remote:w-offline"];
  const runtime = {
    config: { allowedWorkspaceIds: options.allowed ?? [] },
    herdr: {
      listAgentsWithWorkspaceNames: async () => [],
      listWorkspaces: async () => {
        if (options.fail) throw new Error("workspace lookup failed");
        return (options.live ?? ["w-live"]).map((workspace_id) => ({ workspace_id }));
      },
    },
    routing: {
      resolve: () => ({ workspaceId: "w-deleted", paneId: "w-deleted:p1" }),
      workspaceTeamIds: () => ids,
      workspaceTargets: (workspaceId: string) => [{ workspaceId, paneId: `${workspaceId}:p1`, agentName: "worker" }],
    },
    discord: { reply: async (_: unknown, text: string) => { output.push(text); } },
  } as unknown as Parameters<typeof handleCommand>[3];
  await handleCommand("team", ["list"], createConsoleContext(() => {}), runtime);
  assert.deepEqual(ids, ["w-live", "w-deleted", "remote:w-offline"]);
  return output.join("\n");
}

test("team list hides deleted local workspaces including the active route, but retains stale members and unverified remote Teams", async () => {
  const text = await list();
  assert.doesNotMatch(text, /w-deleted/);
  assert.match(text, /Workspace w-live/);
  assert.match(text, /stale/);
  assert.match(text, /remote:w-offline/);
});

test("team list still applies the workspace allowlist", async () => {
  const text = await list({ allowed: ["w-live"] });
  assert.match(text, /w-live/);
  assert.doesNotMatch(text, /remote:|w-deleted/);
});

test("team list reports no Teams when all configured local workspaces are gone", async () => {
  assert.match(await list({ live: [], allowed: ["w-deleted"] }), /No workspace Teams configured/);
});

test("workspace lookup failure is surfaced without treating Teams as deleted", async () => {
  await assert.rejects(list({ fail: true }), /workspace lookup failed/);
});
