import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../src/types.js";
import {
  runTeamTask,
  parseAssignmentPlan,
  type OrchestrationEvent,
  type OrchestrationPort,
} from "../src/team-orchestration.js";

const lead: AgentRecord = {
  terminal_id: "term-lead",
  agent: "codex",
  agent_status: "idle",
  workspace_id: "w2",
  tab_id: "w2:t1",
  pane_id: "w2:p4",
};

const workerA: AgentRecord = {
  terminal_id: "term-a",
  agent: "agy",
  agent_status: "idle",
  workspace_id: "w2",
  tab_id: "w2:t1",
  pane_id: "w2:p6",
};

const workerB: AgentRecord = {
  terminal_id: "term-b",
  agent: "opencode",
  agent_status: "idle",
  workspace_id: "w2",
  tab_id: "w2:t1",
  pane_id: "w2:p8",
};

function framed(prompt: string, body: string): string {
  const begin = prompt.match(
    /Opening marker \(first line\): (BRIDGE_BEGIN_[a-f0-9]+)/,
  )?.[1];
  const end = prompt.match(
    /Closing marker \(last line\): (BRIDGE_END_[a-f0-9]+)/,
  )?.[1];
  return begin && end ? `${begin}\n${body}\n${end}` : body;
}

function latestPrompt(
  prompts: Array<[string, string]>,
  target: string,
): string {
  return [...prompts].reverse().find(([pane]) => pane === target)?.[1] || "";
}

test("ISSUE-013 prompt echo must never dispatch the example assignment", async () => {
  const prompts: string[] = [];
  const port: OrchestrationPort = {
    async promptAgent(_target, prompt) {
      prompts.push(prompt);
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle",
      };
    },
    async readAgent() {
      return prompts.length ? `› ${prompts[0]}` : "history";
    },
  };
  await assert.rejects(
    runTeamTask(
      {
        taskId: "echo",
        prompt: "Review",
        lead,
        workers: [workerA],
        timeoutMs: 40,
      },
      port,
      () => undefined,
    ),
  );
  assert.equal(prompts.length, 1, "must not dispatch example or synthesis");
});

test("ISSUE-014 old Worker report must not be completed", async () => {
  const prompts: Array<[string, string]> = [];
  const events: OrchestrationEvent[] = [];
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle",
      };
    },
    async readAgent(target) {
      if (target !== lead.pane_id) return "old commit and 13/13 tests";
      if (!prompts.length) return "history";
      const prompt = prompts
        .filter(([pane]) => pane === lead.pane_id)
        .at(-1)![1];
      const body =
        prompts.length === 1
          ? '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect"}]}'
          : "Partial report";
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)?.[0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)?.[0];
      return begin && end ? `${begin}\n${body}\n${end}` : body;
    },
  };
  const result = await runTeamTask(
    {
      taskId: "old-report",
      prompt: "Review",
      lead,
      workers: [workerA],
      timeoutMs: 80,
    },
    port,
    (event) => events.push(event),
  );
  assert.equal(result.reports[0].state, "failed");
  assert.equal(result.reports[0].report, "");
  assert.equal(result.state, "failed");
  assert.ok(!events.some((event) => event.type === "assignment_completed"));
});

test("ISSUE-014 waits for every Worker before starting synthesis", async () => {
  const prompts: Array<[string, string]> = [];
  const waits = new Map<string, number>();
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      const count = (waits.get(target) || 0) + 1;
      waits.set(target, count);
      if (target === lead.pane_id) return { ...lead, agent_status: "done" };
      const worker = target === workerA.pane_id ? workerA : workerB;
      return {
        ...worker,
        agent_status:
          count >= (target === workerA.pane_id ? 2 : 3) ? "done" : "idle",
      };
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (!prompt) return "old transcript with previous commit";
      if (target === lead.pane_id)
        return framed(
          prompt,
          prompt.includes("Synthesize the Worker reports")
            ? "Synthesis after both reports"
            : '{"assignments":[{"id":"a","workerPaneId":"w2:p6","instruction":"Inspect A"},{"id":"b","workerPaneId":"w2:p8","instruction":"Inspect B"}]}',
        );
      const done = waits.get(target)! >= (target === workerA.pane_id ? 2 : 3);
      return done
        ? framed(prompt, `${target} report for this task`)
        : "old transcript with previous commit";
    },
  };
  const result = await runTeamTask(
    {
      taskId: "wait-all",
      prompt: "Inspect",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 500,
    },
    port,
    () => undefined,
  );
  assert.equal(result.state, "completed");
  assert.equal(prompts.filter(([target]) => target === lead.pane_id).length, 2);
  assert.equal(
    prompts.filter(
      ([target, prompt]) =>
        target === lead.pane_id &&
        prompt.includes("Synthesize the Worker reports"),
    ).length,
    1,
  );
  assert.ok((waits.get(workerB.pane_id) || 0) >= 3);
});

test("ISSUE-014 recovers a prompt-stalled Worker without resending", async () => {
  const prompts: Array<[string, string]> = [];
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async promptAgentAndWait(target, prompt) {
      prompts.push([target, prompt]);
      if (target === workerA.pane_id) {
        const error = Object.assign(new Error("stalled"), {
          code: "agent_prompt_stalled",
        });
        throw error;
      }
      return { ...lead, agent_status: "done" };
    },
    async waitAgent(target) {
      if (target === workerA.pane_id)
        return { ...workerA, agent_status: "done" };
      throw new Error("must not wait after settled Lead prompt");
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      const leadPromptCount = prompts.filter(
        ([pane]) => pane === lead.pane_id,
      ).length;
      return framed(
        prompt,
        target === lead.pane_id && leadPromptCount === 1
          ? '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect"}]}'
          : target === workerA.pane_id
            ? "Worker report from the current assignment"
            : "Synthesis from the current task",
      );
    },
  };
  const result = await runTeamTask(
    {
      taskId: "atomic-wait",
      prompt: "Inspect",
      lead,
      workers: [workerA],
      timeoutMs: 20,
    },
    port,
    () => undefined,
  );
  assert.equal(result.state, "completed");
  assert.equal(
    result.reports[0].report,
    "Worker report from the current assignment",
  );
});

test("terminal repair preserves JSON escapes and existing whitespace", () => {
  const instruction = 'Read A  B\nthen "quoted" and C:\\temp';
  const json = JSON.stringify({
    assignments: [{ id: "inspect", workerPaneId: "w2:p6", instruction }],
  });
  assert.equal(
    parseAssignmentPlan(json, true).assignments[0].instruction,
    instruction,
  );
  const wrapped = json
    .replace("inspect", "in\r\n  spect")
    .replace("Read A", "Read \n  A");
  assert.throws(() => parseAssignmentPlan(wrapped), /JSON Assignment plan/);
  assert.equal(
    parseAssignmentPlan(wrapped, true).assignments[0].instruction,
    instruction,
  );
  const mixed =
    '{"assignments":[{"id":"in\n  spect","workerPaneId":"w2:p6","instruction":"Read"},{"id":"docs","workerPaneId":"w2:p8","instruction":"Review"}]}';
  assert.equal(parseAssignmentPlan(mixed, true).assignments.length, 2);
  assert.throws(
    () => parseAssignmentPlan('{"assignments":[', true),
    /JSON Assignment plan/,
  );
});

test("planning consumes the matching structured final rather than terminal JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-plan-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const session = "11111111-1111-1111-1111-111111111111";
    await mkdir(join(root, "sessions"));
    const path = join(root, "sessions", `rollout-${session}.jsonl`);
    await writeFile(path, "");
    const prompts: Array<[string, string]> = [];
    const instruction = 'Preserve  two spaces\nand "quotes"';
    const plan = JSON.stringify({
      assignments: [
        { id: "semantic", workerPaneId: workerA.pane_id, instruction },
      ],
    });
    const port: OrchestrationPort = {
      async promptAgent(target, prompt) {
        prompts.push([target, prompt]);
        if (prompts.length === 1) {
          const events = [
            { type: "task_started", turn_id: "current" },
            { type: "user_message", message: prompt },
            {
              type: "agent_message",
              phase: "commentary",
              message: "not a plan",
            },
            { type: "agent_message", phase: "final_answer", message: plan },
            { type: "task_complete", turn_id: "current" },
          ];
          await appendFile(
            path,
            events
              .map((payload) => JSON.stringify({ type: "event_msg", payload }))
              .join("\n") + "\n",
          );
        }
      },
      async waitAgent(target) {
        return {
          ...(target === lead.pane_id
            ? { ...lead, agent_session: { kind: "id", value: session } }
            : workerA),
          agent_status: "done",
        };
      },
      async readAgent(target) {
        return target === workerA.pane_id
          ? framed(latestPrompt(prompts, target), "Worker report with evidence")
          : framed(latestPrompt(prompts, target), "Integrated report");
      },
    };
    const result = await runTeamTask(
      {
        taskId: "structured",
        prompt: "Inspect",
        lead: { ...lead, agent_session: { kind: "id", value: session } },
        workers: [workerA],
      },
      port,
      () => undefined,
    );
    assert.equal(result.plan.assignments[0].instruction, instruction);
    assert.equal(prompts[1][0], workerA.pane_id);
    assert.equal(result.state, "completed");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapped Codex JSON from the reported failure dispatches both Workers", async () => {
  const prompts: Array<[string, string]> = [];
  const output = `• {"assignments":[{"id":"analyze-
  spec","workerPaneId":"w2:p6","instruction":"閱讀專案中的
  AGENTS.md、SPEC.md 與 CONTEXT.md，只回報發現。","dependsOn":[]},
  {"id":"analyze-
  implementation","workerPaneId":"w2:p8","instruction":"檢查
  repository 現有程式碼與測試，只回報發現。","dependsOn":[]}]}`;
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id
          ? lead
          : target === workerA.pane_id
            ? workerA
            : workerB),
        agent_status: "done",
      };
    },
    async readAgent(target) {
      if (!prompts.length) return "previous transcript";
      if (target !== lead.pane_id)
        return framed(
          latestPrompt(prompts, target),
          "Worker report with evidence",
        );
      return framed(
        latestPrompt(prompts, target),
        prompts.length === 1 ? output : "Integrated report",
      );
    },
  };
  const result = await runTeamTask(
    {
      taskId: "task-cd7ab775-9723-4840-9239-3a803076c52d",
      prompt: "討論1:1:N的實做有什麼問題",
      lead,
      workers: [workerA, workerB],
    },
    port,
    () => undefined,
  );
  assert.deepEqual(
    prompts
      .slice(1, 3)
      .map(([target]) => target)
      .sort(),
    [workerA.pane_id, workerB.pane_id].sort(),
  );
  assert.equal(result.plan.assignments[0].id, "analyze-spec");
  assert.equal(result.state, "completed");
});

test("Lead plan dispatches independent assignments and synthesizes one result", async () => {
  const prompts: Array<[string, string]> = [];
  const events: OrchestrationEvent[] = [];
  let leadReads = 0;
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      return target === lead.pane_id
        ? { ...lead, agent_status: "done" }
        : {
            ...(target === workerA.pane_id ? workerA : workerB),
            agent_status: "done",
          };
    },
    async readAgent(target) {
      if (target === lead.pane_id) {
        leadReads += 1;
        return framed(
          latestPrompt(prompts, target),
          leadReads <= 8
            ? '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect the bridge.","dependsOn":[]},{"id":"docs","workerPaneId":"w2:p8","instruction":"Review the docs.","dependsOn":[]}]}'
            : "Integrated result: both assignments passed.",
        );
      }
      return framed(
        latestPrompt(prompts, target),
        `${target} report: completed with evidence`,
      );
    },
  };

  const result = await runTeamTask(
    {
      taskId: "task-1",
      prompt: "Improve the bridge",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 1000,
    },
    port,
    (event) => events.push(event),
  );

  assert.equal(result.state, "completed");
  assert.equal(result.synthesis, "Integrated result: both assignments passed.");
  assert.equal(prompts.length, 4);
  assert.match(prompts[0][1], /Return ONLY JSON/);
  assert.deepEqual(
    prompts
      .slice(1, 3)
      .map(([target]) => target)
      .sort(),
    [workerA.pane_id, workerB.pane_id].sort(),
  );
  assert.match(prompts[3][1], /Assignment reports/);
  assert.ok(events.some((event) => event.type === "task_completed"));
});

test("invalid Lead plan fails before dispatching a non-Team Worker", async () => {
  const prompts: string[] = [];
  let reads = 0;
  const port: OrchestrationPort = {
    async promptAgent(_target, prompt) {
      prompts.push(prompt);
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "done",
      };
    },
    async readAgent() {
      reads += 1;
      if (reads === 1) return "old Lead transcript";
      return framed(
        prompts.at(-1) || "",
        '{"assignments":[{"id":"unsafe","workerPaneId":"w2:p99","instruction":"Write files."}]}',
      );
    },
  };

  await assert.rejects(
    runTeamTask(
      { taskId: "task-2", prompt: "Unsafe", lead, workers: [workerA] },
      port,
      () => undefined,
    ),
    /not in the Team roster/,
  );
  assert.equal(prompts.length, 1);
});

test("blocked Worker keeps the task blocked while Lead receives a partial synthesis", async () => {
  const prompts: string[] = [];
  const events: OrchestrationEvent[] = [];
  const port: OrchestrationPort = {
    async promptAgent(_target, prompt) {
      prompts.push(prompt);
    },
    async waitAgent(target) {
      return target === lead.pane_id
        ? { ...lead, agent_status: "done" }
        : { ...workerA, agent_status: "blocked" };
    },
    async readAgent(target) {
      if (target === lead.pane_id) {
        return prompts.length === 1
          ? framed(
              prompts.at(-1) || "",
              '{"assignments":[{"id":"needs-input","workerPaneId":"w2:p6","instruction":"Ask for the missing value."}]}',
            )
          : framed(
              prompts.at(-1) || "",
              "Partial synthesis: worker needs user input.",
            );
      }
      return framed(
        prompts.at(-1) || "",
        "Worker asks: which environment should be used?",
      );
    },
  };

  const result = await runTeamTask(
    { taskId: "task-blocked", prompt: "Investigate", lead, workers: [workerA] },
    port,
    (event) => events.push(event),
  );

  assert.equal(result.state, "blocked");
  assert.equal(result.reports[0].state, "blocked");
  assert.ok(events.some((event) => event.type === "task_blocked"));
});

test("planning parses the current Codex response instead of the transcript baseline", async () => {
  let planningPrompt = "";
  const port: OrchestrationPort = {
    async promptAgent(_target, prompt) {
      planningPrompt = prompt;
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "done",
      };
    },
    async readAgent() {
      if (!planningPrompt) return "previous Lead transcript";
      return framed(
        planningPrompt,
        !planningPrompt.includes("Synthesize the Worker reports")
          ? '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect the bridge."}]}'
          : "Synthesis is ready.",
      );
    },
  };

  const result = await runTeamTask(
    { taskId: "task-transcript", prompt: "Inspect", lead, workers: [workerA] },
    port,
    () => undefined,
  );

  assert.equal(result.plan.assignments[0].id, "inspect");
  assert.equal(result.state, "completed");
});

test("planning falls back when recent_unwrapped omits the current response", async () => {
  let planningPrompt = "";
  const port: OrchestrationPort = {
    async promptAgent(_target, prompt) {
      planningPrompt = prompt;
    },
    async waitAgent() {
      return { ...lead, agent_status: "done" };
    },
    async readAgent(_target, source) {
      if (source === "recent_unwrapped") return "old transcript only";
      if (source === "recent")
        return framed(
          planningPrompt,
          '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect the bridge."}]}',
        );
      return "";
    },
  };

  const result = await runTeamTask(
    {
      taskId: "task-source-fallback",
      prompt: "Inspect",
      lead,
      workers: [workerA],
    },
    port,
    () => undefined,
  );

  assert.equal(result.plan.assignments[0].id, "inspect");
});
