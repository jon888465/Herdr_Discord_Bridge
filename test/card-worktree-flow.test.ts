import test from "node:test";
import assert from "node:assert/strict";
import { HerdrError } from "../src/herdr.js";
import {
  WorktreePartialError,
  agentNameForCard,
  cleanupCardWorktree,
  prepareCardWorktree,
  type CleanupDeps,
  type PrepareDeps,
} from "../src/card-worktree-flow.js";
import type { CardWorktree } from "../src/card-worktrees.js";
import type { AgentRecord } from "../src/types.js";

const CARD = "REQ-20261103-one";
const lead: AgentRecord = {
  pane_id: "w3:p1",
  terminal_id: "t-lead",
  workspace_id: "w3",
  tab_id: "w3:t1",
  agent: "claude",
  agent_status: "idle",
  foreground_cwd: "/Users/example/git_wk/repo/src",
};
const started: AgentRecord = {
  ...lead,
  pane_id: "w9:p1",
  terminal_id: "t-new",
  workspace_id: "w9",
  tab_id: "w9:t1",
};
const created = {
  type: "worktree_created",
  workspace: { workspace_id: "w9" },
  worktree: {
    path: "/Users/example/.herdr/worktrees/repo/card-req-20261103-one",
    branch: `card/${CARD}`,
  },
  root_pane: { pane_id: "w9:p1" },
  tab: { tab_id: "w9:t1" },
};

function setup(overrides: Partial<PrepareDeps> = {}) {
  const log: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const recorded: Array<Omit<CardWorktree, "createdAt" | "removedAt">> = [];
  const deps: PrepareDeps = {
    port: {
      async request<T>(method: string, params?: Record<string, unknown>) {
        requests.push({ method, params });
        log.push(method);
        if (method === "ping") return { version: "0.9.1" } as T;
        if (method === "worktree.create") return created as T;
        throw new Error(`unexpected ${method}`);
      },
    },
    lead,
    sourceWorkspaceId: "w3",
    repoRoot: async (dir) => {
      log.push(`repoRoot:${dir}`);
      return "/Users/example/git_wk/repo";
    },
    headSha: async () => "0123456789abcdef0123456789abcdef01234567",
    startAgent: async (input) => {
      log.push(`startAgent:${input.kind}@${input.paneId}`);
      return started;
    },
    worktrees: {
      active: () => undefined,
      record: (entry) => {
        log.push("record");
        recorded.push(entry);
      },
    },
    authorize: (id) => log.push(`authorize:${id}`),
    switchRoute: (id, agent) => log.push(`switch:${id}:${agent.pane_id}`),
    now: () => "2026-11-03T08:00:00Z",
    ...overrides,
  };
  return { deps, log, requests, recorded };
}

test("prepare creates the worktree, records it, starts the same kind of Agent, authorizes and switches the route — in that order", async () => {
  const { deps, log, requests, recorded } = setup();
  const result = await prepareCardWorktree(deps, CARD);
  assert.deepEqual(log, [
    "repoRoot:/Users/example/git_wk/repo/src",
    "ping",
    "worktree.create",
    "record",
    "authorize:w9",
    "startAgent:claude@w9:p1",
    "switch:w9:w9:p1",
  ]);
  assert.deepEqual(requests[1], {
    method: "worktree.create",
    params: {
      cwd: "/Users/example/git_wk/repo",
      branch: `card/${CARD}`,
      focus: false,
    },
  });
  assert.deepEqual(recorded, [
    {
      cardId: CARD,
      workspaceId: "w9",
      sourceWorkspaceId: "w3",
      path: created.worktree.path,
      repoPath: "/Users/example/git_wk/repo",
      branch: `card/${CARD}`,
    },
  ]);
  assert.deepEqual(result, {
    workspaceId: "w9",
    path: created.worktree.path,
    branch: `card/${CARD}`,
    repoPath: "/Users/example/git_wk/repo",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    agent: started,
    agentReady: true,
  });
});

test("a missing base sha does not stop the preparation", async () => {
  const { deps } = setup({ headSha: async () => undefined });
  const result = await prepareCardWorktree(deps, CARD);
  assert.equal(result.baseSha, undefined);
});

test("preparation is refused before anything is created when it cannot work", async () => {
  const cases: Array<[string, Partial<PrepareDeps>, RegExp]> = [
    [
      "card already has a worktree",
      { worktrees: { active: () => ({}) as CardWorktree, record: () => {} } },
      /已有.*worktree/,
    ],
    [
      "Agent has no working directory",
      { lead: { ...lead, foreground_cwd: undefined, cwd: undefined } },
      /工作目錄/,
    ],
    ["Agent has no kind", { lead: { ...lead, agent: undefined } }, /種類/],
    ["not inside a git repository", { repoRoot: async () => undefined }, /git/],
    [
      "Herdr too old",
      {
        port: {
          async request<T>() {
            return { version: "0.8.0" } as T;
          },
        },
      },
      /0\.9\.1/,
    ],
  ];
  for (const [name, patch, message] of cases) {
    const { deps, log } = setup(patch);
    await assert.rejects(prepareCardWorktree(deps, CARD), message, name);
    assert.equal(log.includes("worktree.create"), false, name);
    assert.equal(log.includes("record"), false, name);
  }
});

test("a failed worktree creation records nothing", async () => {
  const { deps, log } = setup({
    port: {
      async request<T>(method: string) {
        if (method === "ping") return { version: "0.9.1" } as T;
        throw new HerdrError(
          "worktree.create",
          "worktree_create_failed",
          "fatal: already exists",
        );
      },
    },
  });
  await assert.rejects(prepareCardWorktree(deps, CARD), /already exists/);
  assert.equal(log.includes("record"), false);
  assert.equal(
    log.some((entry) => entry.startsWith("authorize")),
    false,
  );
});

test("if the Agent cannot start the worktree stays recorded and authorized, the route is not switched, and the error says where it is", async () => {
  const { deps, log } = setup({
    startAgent: async () => {
      throw new Error("agent did not become ready");
    },
  });
  await assert.rejects(
    prepareCardWorktree(deps, CARD),
    (error: unknown) =>
      error instanceof WorktreePartialError &&
      error.workspaceId === "w9" &&
      error.path === created.worktree.path &&
      /did not become ready/.test(error.message),
  );
  assert.ok(log.includes("record"));
  assert.ok(log.includes("authorize:w9"));
  assert.equal(
    log.some((entry) => entry.startsWith("switch")),
    false,
  );
});

test("if recording the index fails the worktree is reported instead of being lost", async () => {
  const { deps, log } = setup({
    worktrees: {
      active: () => undefined,
      record: () => {
        throw new Error("disk full");
      },
    },
  });
  await assert.rejects(
    prepareCardWorktree(deps, CARD),
    (error: unknown) =>
      error instanceof WorktreePartialError &&
      error.workspaceId === "w9" &&
      /disk full/.test(error.message),
  );
  assert.equal(
    log.some((entry) => entry.startsWith("startAgent")),
    false,
  );
});

function cleanupSetup(
  reply: (method: string) => unknown,
  active: CardWorktree | null = {
    cardId: CARD,
    workspaceId: "w9",
    sourceWorkspaceId: "w3",
    path: created.worktree.path,
    repoPath: "/Users/example/git_wk/repo",
    branch: `card/${CARD}`,
    createdAt: "2026-11-03T08:00:00Z",
  },
) {
  const log: string[] = [];
  const deps: CleanupDeps = {
    port: {
      async request<T>(method: string, params?: Record<string, unknown>) {
        log.push(`${method}:${JSON.stringify(params)}`);
        return (await reply(method)) as T;
      },
    },
    worktrees: {
      active: () => active ?? undefined,
      markRemoved: (id) => log.push(`markRemoved:${id}`),
    },
    deauthorize: (id) => log.push(`deauthorize:${id}`),
    now: () => "2026-11-03T09:00:00Z",
  };
  return { deps, log };
}

test("cleanup removes a clean worktree, marks it removed and withdraws the authorization", async () => {
  const { deps, log } = cleanupSetup(() => ({
    type: "worktree_removed",
    forced: false,
  }));
  const result = await cleanupCardWorktree(deps, CARD);
  assert.deepEqual(result, {
    removed: true,
    workspaceId: "w9",
    path: created.worktree.path,
    branch: `card/${CARD}`,
    repoPath: "/Users/example/git_wk/repo",
  });
  assert.deepEqual(log, [
    'worktree.remove:{"workspace_id":"w9"}',
    `markRemoved:${CARD}`,
    "deauthorize:w9",
  ]);
});

test("cleanup keeps a worktree with uncommitted changes and changes nothing else", async () => {
  const { deps, log } = cleanupSetup(() => {
    throw new HerdrError(
      "worktree.remove",
      "dirty_worktree_requires_force",
      "dirty",
    );
  });
  const result = await cleanupCardWorktree(deps, CARD);
  assert.deepEqual(result, {
    removed: false,
    reason: "dirty_worktree",
    workspaceId: "w9",
    path: created.worktree.path,
    branch: `card/${CARD}`,
    repoPath: "/Users/example/git_wk/repo",
  });
  assert.deepEqual(log, ['worktree.remove:{"workspace_id":"w9"}']);
});

test("cleanup refuses a card without a worktree and passes other errors through untouched", async () => {
  const none = cleanupSetup(() => ({}), null);
  await assert.rejects(cleanupCardWorktree(none.deps, CARD), /沒有.*worktree/);
  assert.deepEqual(none.log, []);

  const broken = cleanupSetup(() => {
    throw new HerdrError("worktree.remove", "workspace_not_found", "gone");
  });
  await assert.rejects(
    cleanupCardWorktree(broken.deps, CARD),
    /workspace_not_found/,
  );
  assert.equal(
    broken.log.some((entry) => entry.startsWith("markRemoved")),
    false,
  );
});

test("a started Agent that is blocked is reported as not ready, but the route still moves to the new workspace", async () => {
  const { deps, log } = setup({
    startAgent: async () => ({ ...started, agent_status: "blocked" }),
  });
  const result = await prepareCardWorktree(deps, CARD);
  assert.equal(result.agentReady, false);
  assert.equal(result.agent.agent_status, "blocked");
  assert.ok(log.includes("switch:w9:w9:p1"));
  assert.ok(log.includes("record"));
});

// Herdr 的 agent.start 只接受 1–32 字元、小寫字母開頭、只含小寫字母、數字、`-`、`_`（ISSUE-072）。
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

test("a short card id keeps the readable name card-<id> unchanged (ISSUE-072)", () => {
  assert.equal(agentNameForCard("REQ-20261103-one"), "card-req-20261103-one");
  assert.equal(
    agentNameForCard("REQ-20261103-agy-cancel"),
    "card-req-20261103-agy-cancel",
  );
});

test("a name that is exactly 32 characters is not shortened (ISSUE-072)", () => {
  const id = "REQ-20261103-abcdefghijklmn"; // card-req-20261103-abcdefghijklmn = 32
  const name = agentNameForCard(id);
  assert.equal(name.length, 32);
  assert.equal(name, `card-${id.toLowerCase()}`);
});

test("a long card id is shortened to 32 characters with a 4-character hash and stays valid for Herdr (ISSUE-072)", () => {
  const name = agentNameForCard("REQ-20261104-sensitive-accept");
  assert.equal(name.length, 32);
  assert.match(name, HERDR_AGENT_NAME);
  assert.match(name, /^card-req-20261104-sensitiv[a-z0-9-]*-[0-9a-f]{4}$/);
});

test("the longest possible card id still produces a valid name (ISSUE-072)", () => {
  const id = `REQ-20261104-${"a".repeat(41)}`;
  const name = agentNameForCard(id);
  assert.ok(name.length <= 32, name);
  assert.match(name, HERDR_AGENT_NAME);
});

test("two long ids sharing the same prefix get different names, and the same id always gets the same name (ISSUE-072)", () => {
  const a = agentNameForCard("REQ-20261104-sensitive-accept-one");
  const b = agentNameForCard("REQ-20261104-sensitive-accept-two");
  assert.notEqual(a, b);
  assert.equal(a, agentNameForCard("REQ-20261104-sensitive-accept-one"));
});

test("the prefix never ends with a dash right before the hash (ISSUE-072)", () => {
  // card-req-20261104-abcd-efg- is 27 characters and ends with a dash.
  const dashed = agentNameForCard("REQ-20261104-abcd-efg-hijklmnop");
  assert.doesNotMatch(dashed, /--/);
  assert.match(dashed, HERDR_AGENT_NAME);
});

test("prepare starts the Agent with a Herdr-valid name even for a long card id (ISSUE-072)", async () => {
  const names: string[] = [];
  const { deps } = setup({
    startAgent: async (input) => {
      names.push(input.name);
      return started;
    },
  });
  await prepareCardWorktree(deps, "REQ-20261104-sensitive-accept");
  assert.equal(names.length, 1);
  assert.match(names[0], HERDR_AGENT_NAME);
});

// codex 當 Lead 時，新 workspace 的 Agent 啟動回來還是 working（REQ-20261109-codex-lead-agy）。
test("an Agent that is still working at start is awaited, and the ready one is used", async () => {
  const working = { ...started, agent_status: "working" };
  const ready = { ...started, agent_status: "idle" };
  const { deps, log } = setup({
    startAgent: async () => working,
    awaitReady: async (agent) => {
      log.push(`await:${agent.agent_status}`);
      return ready;
    },
  });
  const result = await prepareCardWorktree(deps, CARD);
  assert.equal(result.agentReady, true);
  assert.equal(result.agent, ready);
  assert.ok(log.includes("await:working"));
});

test("an Agent that never becomes ready keeps the not-ready result instead of failing, and a done Agent counts as ready", async () => {
  const working = { ...started, agent_status: "working" };
  for (const awaitReady of [
    async () => undefined,
    async () => {
      throw new Error("boom");
    },
  ]) {
    const { deps } = setup({ startAgent: async () => working, awaitReady });
    const result = await prepareCardWorktree(deps, CARD);
    assert.equal(result.agentReady, false);
    assert.equal(result.agent, working);
  }
  const { deps } = setup({
    startAgent: async () => ({ ...started, agent_status: "done" }),
  });
  assert.equal((await prepareCardWorktree(deps, CARD)).agentReady, true);
});

test("an Agent that starts blocked on a skippable prompt is awaited the same way as a working one", async () => {
  const blocked = { ...started, agent_status: "blocked" };
  const ready = { ...started, agent_status: "idle" };
  const seen: string[] = [];
  const { deps } = setup({
    startAgent: async () => blocked,
    awaitReady: async (agent) => {
      seen.push(agent.agent_status);
      return ready;
    },
  });
  const result = await prepareCardWorktree(deps, CARD);
  assert.deepEqual(seen, ["blocked"]);
  assert.equal(result.agentReady, true);
});

import { doneAsReady, waitUntilReady } from "../src/agent-ready.js";

// ISSUE-142：與 main 相同的 awaitReady（waitUntilReady(doneAsReady(port))、真的 matchUpdatePrompt）先跳過，才算 agentReady。
test("a codex update prompt on the new Agent is skipped before agentReady is computed", async (t) => {
  t.mock.method(console, "log", () => {});
  const update = [
    "  Update available · 0.166.0 → 0.167.0",
    "  Release notes: https://github.com/openai/codex/releases/latest",
    "",
    "› 1. Update now (runs `brew upgrade --cask codex`)",
    "  2. Skip",
    "  3. Skip until next version",
    "",
    "  enter continue · esc skip",
  ].join("\n");
  const screens = [update, "› Ready"];
  // PR #211 之後送鍵前會重驗 pane 此刻真的是 blocked：第一次列出回 blocked，之後回 idle。
  const statuses = ["blocked", "idle"];
  const { deps, log } = setup({
    lead: { ...lead, agent: "codex" },
    startAgent: async () => ({ ...started, agent: "codex", agent_status: "blocked" }),
  });
  const panePort = doneAsReady({
    request: async (m, p) => (log.push(`${m}${p?.keys ?? ""}`), m === "agent.read" ? { read: { text: screens.shift() } } : {}),
    listAgentsWithWorkspaceNames: async () => [{ ...started, agent: "codex", agent_status: statuses.length > 1 ? statuses.shift()! : statuses[0] }],
  });
  deps.awaitReady = async (a) => {
    const ready = await waitUntilReady({ panePort, readyPollMs: 1 }, { paneId: a.pane_id, terminalId: a.terminal_id }, a);
    return ready.ok ? ready.agent : undefined;
  };
  assert.equal((await prepareCardWorktree(deps, CARD)).agentReady, true);
  assert.deepEqual(log.slice(-4), ["agent.read", "pane.send_keys2", "agent.read", "switch:w9:w9:p1"]);
});
