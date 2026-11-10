import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startCardRoleSession } from "../src/card-role-session.js";
import { createAutopicker, type AutopickSteps } from "../src/autopick.js";
import { parsePolicy } from "../src/policy.js";
import { parseCard, type Card } from "../src/card.js";
import { runTeamTurn } from "../src/team-turn.js";
import { HerdrError } from "../src/herdr.js";
import type { AgentRecord } from "../src/types.js";
const actor = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w1:p2",
  terminal_id: "term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "idle",
  ...patch,
});
const lead = actor({ pane_id: "w1:p1", terminal_id: "lead" });
const card: Card = {
  id: "REQ-20261110-regression",
  type: "requirement",
  status: "ready",
  title: "regression",
  version: 1,
  created: "2026-11-10",
  updated: "2026-11-10",
  projects: ["local:repo"],
  roles: { implement: { agent: "codex" } },
  body: "## 描述\nwork\n",
};
function framed(prompt: string, body: string): string {
  return `${/Opening marker \(first line\): (BRIDGE_BEGIN_[a-f0-9]+)/.exec(prompt)?.[1]}\n${body}\n${/Closing marker \(last line\): (BRIDGE_END_[a-f0-9]+)/.exec(prompt)?.[1]}`;
}
test("r1-omitted-model: observed CLI default succeeds without closing fresh pane", async () => {
  let closed = 0;
  const actual = actor({ model: "cli-default" });
  const session = await startCardRoleSession(
    {
      request: async (method) => {
        if (method === "pane.get") return { pane: { terminal_id: "term" } };
        if (method === "pane.close") closed++;
        return {};
      },
      listAgentsWithWorkspaceNames: async () => [actual],
      startProfile: async (_lead, _profile, _name, created) => {
        created(actual.pane_id, actual.terminal_id);
        return actual;
      },
    },
    lead,
    { id: "codex", kind: "codex" },
    "default",
  );
  assert.equal(session.agent.model, "cli-default");
  assert.equal(session.agent.modelEvidence, "observed");
  assert.equal(closed, 0);
});
test("r1-ineligible-rejection: draft/done/unselected cards produce no rejection or notification", async () => {
  const parsed = parsePolicy(
    "version: 1\nprojects:\n  local:repo: L1\nautopick:\n  local:repo: /repo\n",
  );
  assert.ok(parsed.ok);
  let gates = 0;
  let events = 0;
  let notifications = 0;
  const steps: AutopickSteps = {
    startLead: async () => {
      throw new Error("not eligible");
    },
    command: async () => "",
    waitTask: async () => ({ completed: true, detail: "" }),
    waitCardDone: async () => true,
    loop: async () => ({ merged: true, text: "" }),
  };
  const picker = createAutopicker({
    policy: () => ({
      status: "loaded",
      policy: parsed.policy,
      file: "/policy",
    }),
    readyCards: () => [
      { ...card, status: "draft" },
      { ...card, status: "done" },
      { ...card, projects: ["local:unselected"] },
    ],
    roleGate: () => {
      gates++;
      return "invalid model";
    },
    onRejected: () => {
      events++;
      notifications++;
    },
    steps,
    onReport: () => {},
  });
  await picker.tick();
  assert.equal(gates, 0);
  assert.equal(events, 0);
  assert.equal(notifications, 0);
});
test("r1-retry-identity: changed identity during agent_not_ready wait prevents second prompt", async () => {
  let attempts = 0;
  let checks = 0;
  let dispatches = 0;
  let time = 0;
  let current = "expected";
  let prompt = "";
  const context = Object.assign(
    {
      beforeDispatch: () => {
        dispatches++;
      },
      promptRetry: {
        timeoutMs: 100,
        intervalMs: 1,
        clock: {
          now: () => time,
          sleep: async (ms: number) => {
            time += ms;
            current = "replacement";
          },
        },
      },
    },
    {
      beforePromptAttempt: async () => {
        checks++;
        if (current !== "expected")
          throw new Error("identity changed before retry");
      },
    },
  );
  await assert.rejects(
    runTeamTurn(
      actor(),
      "work",
      {
        promptAgent: async () => {},
        promptAgentAndWait: async (_id, text) => {
          prompt = text;
          attempts++;
          if (attempts === 1)
            throw new HerdrError(
              "agent.prompt",
              "agent_not_ready",
              "not ready",
            );
          return actor({ agent_status: "done" });
        },
        waitAgent: async () => actor(),
        readAgent: async () => (prompt ? framed(prompt, "done") : "history"),
      },
      500,
      20,
      context,
    ),
    /identity changed before retry/,
  );
  assert.equal(attempts, 1);
  assert.equal(checks, 2);
  assert.equal(dispatches, 1);
});
for (const file of [
  "docs/card-role-assignment.md",
  "README.md",
  "README.zh-TW.md",
])
  test(`r1-invalid-doc-example: roles example parses in ${file}`, () => {
    const document = fs.readFileSync(file, "utf8");
    const blocks = [...document.matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((m) => m[1]!)
      .filter((b) => /^roles:/m.test(b));
    assert.ok(blocks.length > 0);
    for (const block of blocks) {
      const text = `---\nid: ${card.id}\ntype: requirement\nstatus: ready\ntitle: example\nversion: 1\ncreated: 2026-11-10\nupdated: 2026-11-10\n${block}---\n\n## 描述\nwork\n`;
      const parsed = parseCard(text);
      assert.ok(parsed.ok, JSON.stringify(parsed));
    }
  });

test("r1-blocked-cleanup: blocked, timeout and uncertain keep pane; completed and predispatch failure close", async () => {
  for (const reason of [
    "blocked",
    "timeout",
    "uncertain",
    "completed",
    "before_dispatch_failure",
  ] as const) {
    let closed = 0;
    const actual = actor();
    const session = await startCardRoleSession(
      {
        request: async (method) => {
          if (method === "pane.get") return { pane: { terminal_id: "term" } };
          if (method === "pane.close") closed++;
          return {};
        },
        listAgentsWithWorkspaceNames: async () => [actual],
        startProfile: async (_lead, _profile, _name, created) => {
          created(actual.pane_id, actual.terminal_id);
          return actual;
        },
      },
      lead,
      { id: "codex", kind: "codex" },
      "cleanup",
    );
    await session.cleanup(reason);
    assert.equal(
      closed,
      ["completed", "before_dispatch_failure"].includes(reason) ? 1 : 0,
      reason,
    );
  }
});

import {
  runTeamTask,
  type OrchestrationPort,
} from "../src/team-orchestration.js";
import { TeamTaskEngine } from "../src/team-task-engine.js";
import { TeamTaskStore } from "../src/team-task-store.js";
import {
  assertNotificationTargetReady,
  readNotificationPane,
} from "../src/card-notify.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
function questionFixture() {
  let closed = 0;
  let worker = actor({
    agent_session: { kind: "id", value: "worker-session" },
  });
  const prompts = new Map<string, string>();
  const answers: string[] = [];
  const port = {
    listAgentsWithWorkspaceNames: async () =>
      closed ? [lead] : [lead, worker],
    request: async (method: string) => {
      if (method === "pane.get") return { pane: { terminal_id: "term" } };
      if (method === "pane.close") closed++;
      return {};
    },
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      created: (id: string, terminal?: string) => void,
    ) => {
      created(worker.pane_id, worker.terminal_id);
      return worker;
    },
    promptAgent: async (target: string, prompt: string) => {
      if (closed && target === worker.pane_id) throw new Error("pane closed");
      prompts.set(target, prompt);
      if (target === worker.pane_id)
        worker = { ...worker, agent_status: "blocked" };
    },
    waitAgent: async (target: string) =>
      target === lead.pane_id ? lead : worker,
    readAgent: async (target: string) => {
      if (target === worker.pane_id && worker.agent_status === "blocked")
        return "Allow operation?";
      const prompt = prompts.get(target);
      if (!prompt) return "history";
      return framed(
        prompt,
        target === lead.pane_id &&
          prompt.includes("Do not modify files while planning")
          ? JSON.stringify({
              assignments: [
                {
                  id: "inspect",
                  workerPaneId: actor().pane_id,
                  instruction: "Inspect",
                },
              ],
            })
          : "done",
      );
    },
    sendAgent: async (target: string, text: string) => {
      if (closed) throw new Error("pane closed");
      answers.push(`${target}:${text}`);
      worker = { ...worker, agent_status: "done" };
    },
    cancelAgent: async () => {},
  };
  return {
    port,
    closed: () => closed,
    answers,
    acquire: async () =>
      startCardRoleSession(
        port,
        lead,
        { id: "codex", kind: "codex" },
        "question",
      ),
  };
}
test("r1-blocked-cleanup: assignment returning blocked retains actual fresh session", async () => {
  const f = questionFixture();
  const result = await runTeamTask(
    {
      taskId: "blocked",
      prompt: "Inspect",
      lead,
      workers: [actor()],
      acquireWorker: f.acquire,
      timeoutMs: 1000,
    },
    f.port,
    () => {},
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.reports[0]!.state, "blocked");
  assert.equal(f.closed(), 0);
});
test("r1-blocked-cleanup: durable question remains replyable and original turn continues", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "role-r1-question-"));
  const f = questionFixture();
  const store = new TeamTaskStore(root);
  const engine = new TeamTaskEngine(store, f.port, new Set());
  const done = engine.run({
    taskId: "question",
    prompt: "Inspect",
    lead,
    workers: [actor()],
    acquireWorker: f.acquire,
    timeoutMs: 3000,
  });
  try {
    let question;
    for (let i = 0; i < 150; i++) {
      question = store
        .get("question")
        .questions?.find((q) => q.state === "pending");
      if (question) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(question);
    assert.equal(f.closed(), 0);
    await engine.reply("question", question.id, "Proceed");
    assert.equal((await done).state, "completed");
    assert.deepEqual(f.answers, ["w1:p2:Proceed"]);
    assert.equal(store.get("question").questions![0]!.state, "answered");
    assert.equal(f.closed(), 1);
  } finally {
    await engine.cancel("question");
    await done;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
for (const menu of [
  "allow once",
  "skip until next version",
  "Do you want to continue?",
  "選擇以下選項",
  "Trust workspace",
  "Permission required",
  "Approval",
  "是否允許執行",
])
  test(`r1-malformed-notify-gate: blocks ${menu}`, async () => {
    let sent = 0;
    const current = actor();
    const port = {
      listAgents: async () => [current],
      readAgent: async () => menu,
    };
    assert.equal(
      (await readNotificationPane(port, current.pane_id))!.agent_status,
      "blocked",
    );
    await assert.rejects(async () => {
      await assertNotificationTargetReady(port, {
        pane: current.pane_id,
        terminal: current.terminal_id,
        agent: "codex",
      });
      sent++;
    });
    assert.equal(sent, 0);
  });
for (const patch of [
  { terminal_id: "replacement" },
  { agent: "claude" },
  { agent_status: "working" },
  { agent_status: "blocked" },
])
  test(`r1-malformed-notify-gate: rechecks identity/status after screen ${JSON.stringify(patch)}`, async () => {
    let current = actor();
    let sent = 0;
    const port = {
      listAgents: async () => [current],
      readAgent: async () => {
        current = { ...current, ...patch };
        return "idle screen";
      },
    };
    await assert.rejects(async () => {
      await assertNotificationTargetReady(port, {
        pane: "w1:p2",
        terminal: "term",
        agent: "codex",
      });
      sent++;
    });
    assert.equal(sent, 0);
  });
test("r1-malformed-notify-gate: stable idle requires two complete checks", async () => {
  let reads = 0;
  let lists = 0;
  await assertNotificationTargetReady(
    {
      listAgents: async () => {
        lists++;
        return [actor()];
      },
      readAgent: async () => {
        reads++;
        return "idle";
      },
    },
    { pane: "w1:p2", terminal: "term", agent: "codex" },
  );
  assert.equal(reads, 2);
  assert.equal(lists, 4);
});

for (const failure of ["timeout", "uncertain"] as const)
  test(`r1-blocked-cleanup: executing ${failure} retains actual fresh pane`, async () => {
    const f = questionFixture();
    const port: OrchestrationPort = {
      ...f.port,
      waitAgent: async (target) => {
        if (target !== lead.pane_id)
          throw failure === "timeout"
            ? new HerdrError("agent.wait", "timeout", "timeout")
            : new Error("delivery acknowledgement lost");
        return lead;
      },
    };
    const result = await runTeamTask(
      {
        taskId: failure,
        prompt: "Inspect",
        lead,
        workers: [actor()],
        acquireWorker: f.acquire,
        timeoutMs: 1000,
      },
      port,
      () => {},
    );
    assert.equal(result.state, "failed");
    assert.equal(result.reports[0]!.state, "failed");
    assert.equal(f.closed(), 0);
  });

import { assertReadyIdentity } from "../src/card-role-session.js";
for (const patch of [
  { terminal_id: "other" },
  { agent_session: { kind: "id", value: "other" } },
  { model: "other" },
])
  test(`r1-retry-identity: retry checks ${JSON.stringify(patch)}`, async () => {
    const original = actor({
      model: "expected",
      agent_session: { kind: "id", value: "expected" },
    });
    let live = original;
    let attempts = 0;
    let dispatches = 0;
    let time = 0;
    await assert.rejects(
      runTeamTurn(
        original,
        "work",
        {
          promptAgent: async () => {},
          promptAgentAndWait: async () => {
            attempts++;
            throw new HerdrError(
              "agent.prompt",
              "agent_not_ready",
              "not ready",
            );
          },
          waitAgent: async () => original,
          readAgent: async () => "history",
        },
        100,
        20,
        {
          beforeDispatch: () => {
            dispatches++;
          },
          beforePromptAttempt: () => {
            assertReadyIdentity(original, live, "codex", "w1");
            if (live.model !== original.model) throw new Error("model changed");
          },
          promptRetry: {
            timeoutMs: 20,
            intervalMs: 1,
            clock: {
              now: () => time,
              sleep: async (ms) => {
                time += ms;
                live = { ...original, ...patch };
              },
            },
          },
        },
      ),
    );
    assert.equal(attempts, 1);
    assert.equal(dispatches, 1);
  });
