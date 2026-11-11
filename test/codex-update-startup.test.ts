import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutopickSteps } from "../src/autopick-wiring.js";
import { AgentPool } from "../src/agent-pool.js";
import { startCardRoleSession } from "../src/card-role-session.js";
import type { AgentRecord } from "../src/types.js";
import type { Card } from "../src/card.js";

export const CODEX_UPDATE = [
  "Update available · 0.163.0 → 0.167.1",
  "Release notes: https://github.com/openai/codex/releases/latest",
  "› 1. Update now",
  "  2. Skip",
  "  3. Skip until next version",
  "enter continue · esc skip",
].join("\n");
const actor = (pane = "w1:p2"): AgentRecord => ({
  pane_id: pane,
  terminal_id: pane + "-term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "blocked",
});
const lead = { ...actor("w1:p1"), agent_status: "idle" };
const profile = { id: "codex", kind: "codex" };
const card = { id: "REQ-20261111-update", type: "requirement" } as Card;
function fixture(screen: string, failure = "") {
  let current = actor();
  let skipped = false;
  const calls: {
    method: string;
    params?: Record<string, unknown>;
    options?: { retries?: number };
  }[] = [];
  const port = {
    request: async (
      method: string,
      params?: Record<string, unknown>,
      options?: { retries?: number },
    ) => {
      calls.push({ method, params, options });
      if (method === "workspace.create")
        return {
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: current.pane_id },
        };
      if (method === "agent.read") {
        if (failure === "read" || (skipped && failure === "after-read"))
          throw new Error("read failed");
        return { text: skipped && failure !== "persistent" ? "ready" : screen };
      }
      if (method === "pane.send_keys") {
        assert.deepEqual(params, { pane_id: current.pane_id, keys: ["2"] });
        assert.equal(options?.retries, 0);
        assert.equal(skipped, false);
        skipped = true;
        if (failure === "send") throw new Error("delivery unknown");
        if (failure !== "persistent")
          current = { ...current, agent_status: "idle" };
      }
      if (method === "pane.get")
        return { pane: { terminal_id: current.terminal_id } };
      return {};
    },
    listAgentsWithWorkspaceNames: async () => [lead, current],
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      created: (id: string, terminal?: string) => void,
    ) => {
      created(current.pane_id, current.terminal_id);
      return { ...current };
    },
  };
  return { port, calls };
}
const cases = [
  ["exact update", CODEX_UPDATE, true],
  [
    "approval",
    "Would you like to run this command?\n1. Yes, proceed (y)\n2. No (esc)",
    false,
  ],
  ["question", "Choose a database\n1. SQLite\n2. Postgres", false],
  ["mixed question", CODEX_UPDATE + "\nChoose a database?", false],
  ["partial update", "Update available\n3. Skip until next version", false],
  [
    "different numbering",
    CODEX_UPDATE.replace("2. Skip", "2. Update now"),
    false,
  ],
] as const;
for (const entry of ["Lead", "fresh Worker", "pool Worker"] as const) {
  for (const [label, screen, succeeds] of cases) {
    test(`ISSUE-141 ${entry}: ${label}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-startup-"));
      const f = fixture(screen);
      const commands: string[] = [];
      let pool: AgentPool | undefined;
      const file = join(dir, "pool.json");
      try {
        const run = async () => {
          if (entry === "Lead") {
            const steps = createAutopickSteps({
              port: f.port,
              readyPollMs: 1,
              readyTimeoutMs: 30,
              command: async (text) => {
                commands.push(text);
                return "ok";
              },
              recordLeadWorkspace: (id) => assert.equal(id, card.id),
              taskIdForCard: () => undefined,
              taskState: () => undefined,
              cardStatus: () => "ready",
              allowedWorkspaceIds: [],
              sleep: async () => {},
              now: () => 0,
            });
            return steps.startLead({
              card,
              project: "local:repo",
              repoPath: dir,
              level: "L0",
              lead: "codex",
            });
          }
          if (entry === "fresh Worker")
            return startCardRoleSession(f.port, lead, profile, "fresh");
          pool = new AgentPool(file, [profile], f.port, [], 30);
          pool.select("w1", profile.id, true);
          return pool.acquire("w1", profile.id, lead, "task-test");
        };
        if (succeeds) {
          await run();
          assert.equal(
            f.calls.filter((c) => c.method === "pane.send_keys").length,
            1,
          );
          if (entry === "Lead")
            assert.deepEqual(commands, ["wk use w1", "agent use w1:p2"]);
        } else {
          await assert.rejects(run());
          assert.equal(
            f.calls.filter((c) => c.method === "pane.send_keys").length,
            0,
          );
          assert.deepEqual(commands, []);
          if (pool) {
            const binding = JSON.parse(readFileSync(file, "utf8")).sessions[
              "w1/codex"
            ];
            assert.equal(binding.uncertain, true);
            assert.equal(binding.agent, undefined);
            await assert.rejects(
              pool.acquire("w1", "codex", lead, "another"),
              /uncertain/,
            );
          }
          if (entry === "fresh Worker")
            assert.ok(!f.calls.some((c) => c.method === "pane.close"));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

for (const failure of ["read", "send", "after-read", "persistent"]) {
  test(`ISSUE-141 fresh Worker: ${failure} fails without returning acquisition or closing pane`, async () => {
    const f = fixture(CODEX_UPDATE, failure);
    await assert.rejects(
      startCardRoleSession(f.port, lead, profile, "failed"),
      /blocked/,
    );
    assert.ok(!f.calls.some((c) => c.method === "pane.close"));
    assert.equal(
      f.calls.filter((c) => c.method === "pane.send_keys").length,
      failure === "read" ? 0 : 1,
    );
  });
}

import { waitUntilReady, doneAsReady } from "../src/agent-ready.js";
for (const patch of [
  { terminal_id: "replacement" },
  { workspace_id: "other" },
  { agent: "claude" },
  { agent_status: "idle" },
  { agent_session: { kind: "id", value: "replacement" } },
]) {
  test(`ISSUE-141 replacement during screen read sends no input: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(CODEX_UPDATE);
    const started = {
      ...actor(),
      agent_session: { kind: "id", value: "original" },
    };
    f.port.listAgentsWithWorkspaceNames = async () => [
      { ...started, ...patch },
    ];
    const ready = await waitUntilReady(
      { panePort: f.port },
      { paneId: started.pane_id, terminalId: started.terminal_id },
      started,
    );
    assert.equal(ready.ok, false);
    assert.ok(!f.calls.some((c) => c.method === "pane.send_keys"));
  });
}

test("ISSUE-141 concurrent direct/adapted waits never retry an uncertain Skip", async () => {
  const f = fixture(CODEX_UPDATE, "send");
  const pane = { paneId: actor().pane_id, terminalId: actor().terminal_id };
  const results = await Promise.all([
    waitUntilReady({ panePort: f.port }, pane, actor()),
    waitUntilReady({ panePort: doneAsReady(f.port) }, pane, actor()),
  ]);
  assert.ok(results.every((r) => !r.ok));
  assert.equal(f.calls.filter((c) => c.method === "pane.send_keys").length, 1);
});

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TeamTaskStore } from "../src/team-task-store.js";
import { TeamTaskEngine } from "../src/team-task-engine.js";
import { CardStore } from "../src/card-store.js";
import { CardAssignmentStore } from "../src/card-assignments.js";
import { runCardCommand, type CardCommandDeps } from "../src/card-command.js";
import { syncCards, taskSourceFrom } from "../src/card-sync.js";
import { DEFAULT_POLICY } from "../src/policy.js";

function cardDeps(
  rootDir: string,
  assignments: CardAssignmentStore,
): CardCommandDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected external action");
  };
  return {
    rootDir,
    assignments,
    source: "console",
    attachments: [],
    today: () => "2026-11-11",
    now: () => "2026-11-11T00:00:00Z",
    download: unexpected,
    readLocalFile: () => {
      throw new Error("unexpected file read");
    },
    taskInfo: () => undefined,
    startTask: unexpected,
    prepareWorktree: unexpected,
    cleanupWorktree: unexpected,
    openPullRequest: unexpected,
    reviewPullRequest: unexpected,
    fixCard: unexpected,
    mergePullRequest: unexpected,
    waitForCi: unexpected,
    policy: () => ({
      status: "missing",
      file: "/unused",
      policy: DEFAULT_POLICY,
    }),
  };
}
const fullCard: Card = {
  ...card,
  status: "ready",
  title: "startup regression",
  version: 1,
  created: "2026-11-11",
  updated: "2026-11-11",
  notify: "discord:123456789012345678",
  body: "## 描述\nDiagnose startup.\n\n## 驗收條件\n- Report evidence.\n",
};
for (const fresh of [true, false]) {
  for (const succeeds of [true, false]) {
    test(`ISSUE-141 coding assignment/card journal: ${fresh ? "fresh" : "pool"}, startup ${succeeds ? "Skip" : "question"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-card-task-"));
      // A disposable repository, never the user's worktree or durable task directory.
      const repo = join(root, "repo");
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, "file.txt"), "baseline\n");
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args]);
      git("add", "file.txt");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "fixture baseline",
      );
      const f = fixture(
        succeeds ? CODEX_UPDATE : "Choose a database?\n1. SQLite\n2. Postgres",
      );
      const taskLead = { ...lead, cwd: repo };
      const prompts = new Map<string, string>();
      let planned = false;
      const port = {
        ...f.port,
        promptAgent: async (target: string, text: string) => {
          prompts.set(target, text);
        },
        waitAgent: async (target: string) => ({
          ...(target === lead.pane_id ? taskLead : actor()),
          agent_status: "done",
        }),
        readAgent: async (target: string) => {
          const prompt = prompts.get(target);
          if (!prompt) return "history";
          let body = "Partial report";
          if (prompt.includes("Do not modify files while planning")) {
            body = JSON.stringify({
              assignments: planned
                ? []
                : [
                    {
                      id: "diag",
                      workerPaneId: "profile:codex",
                      instruction: "Diagnose only",
                      role: "diagnose",
                      access: "read",
                    },
                  ],
            });
            planned = true;
          } else if (target !== lead.pane_id) {
            body = JSON.stringify({
              summary: "diagnosed",
              codingResult: {
                kind: "diagnose",
                summary: "diagnosed",
                findings: [],
              },
            });
          }
          return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
        },
        cancelAgent: async () => {},
      };
      const tasks = new TeamTaskStore(join(root, "tasks"));
      const pool = new AgentPool(
        join(root, "pool.json"),
        [profile],
        port,
        [],
        1000,
      );
      pool.select("w1", "codex", true);
      const engine = new TeamTaskEngine(tasks, port, new Set(), (id) =>
        pool.release(id),
      );
      const cards = new CardStore(join(root, "cards"));
      const assignments = new CardAssignmentStore(
        join(root, "assignments.json"),
      );
      const deps = cardDeps(join(root, "cards"), assignments);
      let running: ReturnType<typeof engine.run> | undefined;
      deps.startTask = async (prompt, options) => {
        assert.equal(options.cardId, card.id);
        assert.equal(options.coding, true);
        running = engine.run({
          taskId: "task-update-fixture",
          prompt,
          coding: true,
          replan: true,
          lead: taskLead,
          workers: [
            { ...actor("profile:codex"), agent_status: "idle", profile },
          ],
          acquireWorker: async () =>
            fresh
              ? startCardRoleSession(port, taskLead, profile, "coding-fresh")
              : pool.acquire("w1", "codex", taskLead, "task-update-fixture"),
          timeoutMs: 2000,
        });
        return {
          taskId: "task-update-fixture",
          lead: { agent: "codex", machine: "local" },
        };
      };
      try {
        assert.ok(cards.create(fullCard).ok);
        await runCardCommand(["assign", card.id, "--coding"], deps);
        const result = await running!;
        assert.equal(
          result.assignments[0]?.state,
          succeeds ? "done" : "failed",
        );
        assert.equal(prompts.has(actor().pane_id), succeeds);
        assert.equal(
          f.calls.filter((c) => c.method === "pane.send_keys").length,
          succeeds ? 1 : 0,
        );
        assert.equal(assignments.forCard(card.id)[0]?.taskId, result.taskId);
        const reloaded = new TeamTaskStore(join(root, "tasks")).get(
          result.taskId,
        );
        assert.equal(
          reloaded.assignments[0]?.plan.workerPaneId,
          "profile:codex",
        );
        // Diagnosis and Skip are not implementation/review/verification evidence.
        assert.notEqual(result.state, "completed");
        syncCards({
          rootDir: deps.rootDir,
          tasks: taskSourceFrom(tasks),
          assignments,
          now: deps.now,
        });
        const stored = cards.read(card.id);
        assert.ok(stored.ok);
        assert.deepEqual(stored.card.tasks, [result.taskId]);
        assert.equal(stored.card.status, "in_progress");
        if (!succeeds) {
          assert.equal(result.coding?.artifacts.length, 0);
          assert.ok(!f.calls.some((c) => c.method === "pane.close"));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const succeeds of [true, false]) {
  test(`ISSUE-141 worktree Lead/card assignment: ${succeeds ? "Skip then associate task" : "blocked leaves card ready"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-lead-card-"));
    const f = fixture(succeeds ? CODEX_UPDATE : "Trust this directory?");
    const assignments = new CardAssignmentStore(join(root, "assignments.json"));
    const deps = cardDeps(join(root, "cards"), assignments);
    const cards = new CardStore(deps.rootDir);
    let starts = 0;
    deps.prepareWorktree = async () => {
      const started = actor();
      const ready = await waitUntilReady(
        { panePort: doneAsReady(f.port), readyPollMs: 1, readyTimeoutMs: 1000 },
        { paneId: started.pane_id, terminalId: started.terminal_id },
        started,
      );
      return {
        workspaceId: "w1",
        path: root,
        branch: "card/fixture",
        repoPath: root,
        agent: ready.ok ? ready.agent : started,
        agentReady: ready.ok,
      };
    };
    deps.startTask = async () => {
      starts++;
      return {
        taskId: "task-lead-fixture",
        lead: { agent: "codex", machine: "local" },
      };
    };
    try {
      assert.ok(cards.create(fullCard).ok);
      const output = await runCardCommand(
        ["assign", card.id, "--coding", "--worktree"],
        deps,
      );
      const stored = cards.read(card.id);
      assert.ok(stored.ok);
      assert.equal(starts, succeeds ? 1 : 0);
      assert.equal(stored.card.status, succeeds ? "in_progress" : "ready");
      assert.equal(assignments.forCard(card.id).length, succeeds ? 1 : 0);
      assert.equal(stored.card.tasks?.length ?? 0, succeeds ? 1 : 0);
      assert.match(output, succeeds ? /task-lead-fixture/ : /任務沒有啟動/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
