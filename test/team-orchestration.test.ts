import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../src/types.js";
import { HerdrError } from "../src/herdr.js";
import { roleEvent } from "../src/card-events.js";
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

test("Lead dynamically chooses follow-up work and only acquires selected profiles", async () => {
  const prompts: Array<[string, string]> = [];
  const acquired: string[] = [];
  let round = 0;
  const profile = {
    ...workerA,
    pane_id: "profile:helper",
    terminal_id: "profile:helper",
  };
  const unused = {
    ...workerB,
    pane_id: "profile:unused",
    terminal_id: "profile:unused",
  };
  const port: OrchestrationPort = {
    async promptAgent(target, text) {
      if (text.includes("Do not modify files while planning")) round++;
      prompts.push([target, text]);
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "done",
      };
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (!prompt) return "history";
      const body =
        target !== lead.pane_id
          ? `report for round ${round}`
          : prompt.includes("Do not modify files while planning")
            ? JSON.stringify({
                assignments:
                  round < 3
                    ? [
                        {
                          id: `step-${round}`,
                          workerPaneId: profile.pane_id,
                          instruction:
                            round === 1 ? "Inspect" : "Fix the finding",
                        },
                      ]
                    : [],
              })
            : "Verified final answer";
      return framed(prompt, body);
    },
  };
  const result = await runTeamTask(
    {
      taskId: "dynamic",
      prompt: "Fix and verify",
      lead,
      workers: [profile, unused],
      replan: true,
      timeoutMs: 500,
      acquireWorker: async (worker) => {
        acquired.push(worker.pane_id);
        return {
          agent: workerA,
          continuity: acquired.length === 1 ? "new-session" : "same-session",
        };
      },
    },
    port,
    () => {},
  );
  assert.equal(result.state, "completed");
  assert.deepEqual(acquired, ["profile:helper", "profile:helper"]);
  assert.equal(result.reports.length, 2);
  const followup = prompts.filter(
    ([target]) => target === workerA.pane_id,
  )[1][1];
  assert.match(followup, /same-session/);
  assert.match(followup, /report for round 1/);
  assert.match(followup, /Original task: Fix and verify/);
  assert.equal(result.synthesis, "Verified final answer");
});

test("Lead may perform a task directly with no Worker or pane creation", async () => {
  const prompts: Array<[string, string]> = [];
  const result = await runTeamTask(
    {
      taskId: "direct",
      prompt: "Explain",
      lead,
      workers: [],
      replan: true,
      timeoutMs: 500,
    },
    {
      async promptAgent(target, text) {
        prompts.push([target, text]);
      },
      async waitAgent() {
        return { ...lead, agent_status: "done" };
      },
      async readAgent() {
        const prompt = latestPrompt(prompts, lead.pane_id);
        return prompt
          ? framed(
              prompt,
              prompt.includes("Do not modify files while planning")
                ? '{"assignments":[]}'
                : "Direct answer",
            )
          : "history";
      },
    },
    () => {},
  );
  assert.equal(result.synthesis, "Direct answer");
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(([target]) => target === lead.pane_id));
});

function timeoutPort(
  slow: string[],
  waits: Array<[string, number | undefined]>,
): OrchestrationPort {
  const prompts: Array<[string, string]> = [];
  let leadPrompts = 0;
  return {
    async promptAgent(target, prompt) {
      if (target === lead.pane_id) leadPrompts += 1;
      prompts.push([target, prompt]);
    },
    async waitAgent(target, _until, timeoutMs) {
      waits.push([target, timeoutMs]);
      if (slow.includes(target))
        throw new Error(
          "herdr agent.prompt: timeout timed out waiting for agent status",
        );
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle",
      };
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (target === lead.pane_id && leadPrompts > 1)
        return framed(prompt, "summary");
      if (target === lead.pane_id)
        return framed(
          prompt,
          JSON.stringify({
            assignments: [
              { id: "impl", workerPaneId: workerA.pane_id, instruction: "do" },
              {
                id: "review",
                workerPaneId: workerB.pane_id,
                instruction: "check",
                dependsOn: ["impl"],
              },
            ],
          }),
        );
      return framed(prompt, "worker report");
    },
  };
}

test("ISSUE-124 Worker 回合逾時：失敗原因寫出逾時、assignment、等待時間與上限，連帶失敗註明來源", async () => {
  const events: OrchestrationEvent[] = [];
  const waits: Array<[string, number | undefined]> = [];
  const result = await runTeamTask(
    {
      taskId: "t124",
      prompt: "x",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 1500,
    },
    timeoutPort([workerA.pane_id], waits),
    (event) => events.push(event),
  );
  assert.ok(waits.length > 0);
  for (const [, limit] of waits) assert.ok(limit! >= 1 && limit! <= 1500);
  const impl = result.reports.find((r) => r.assignmentId === "impl")!;
  assert.equal(impl.state, "failed");
  assert.match(impl.blocker ?? "", /等待逾時/);
  assert.match(impl.blocker ?? "", /impl/);
  assert.match(impl.blocker ?? "", /上限 1\.5 秒/);
  assert.match(impl.blocker ?? "", /已等待/);
  assert.match(impl.blocker ?? "", /timed out waiting for agent status/);
  const dependent = result.reports.find((r) => r.assignmentId === "review")!;
  assert.match(dependent.blocker ?? "", /dependency impl did not complete/);
  assert.match(dependent.blocker ?? "", /impl 等待逾時/);
  assert.match(dependent.blocker ?? "", /worktree/);
  const failed = events.find((e) => e.type === "task_failed");
  assert.match(failed?.detail ?? "", /one or more Assignments failed/);
  assert.match(failed?.detail ?? "", /等待逾時/);
  // review F4：卡片的失敗原因只保留前 200 字元，逾時資訊必須排在通用說明與 gate 原因之前。
  const detail = failed?.detail ?? "";
  assert.ok(
    detail.indexOf("等待逾時") <
      detail.indexOf("one or more Assignments failed"),
    detail,
  );
  assert.ok(detail.indexOf("等待逾時") < 60, detail);
});

test("ISSUE-124 非逾時的 Worker 失敗訊息原樣不變", async () => {
  const events: OrchestrationEvent[] = [];
  const port = timeoutPort([], []);
  const original = port.waitAgent.bind(port);
  port.waitAgent = async (target, until, timeoutMs) => {
    if (target === workerA.pane_id)
      throw new Error("Agent identity changed while waiting for w2:p6");
    return original(target, until, timeoutMs);
  };
  const result = await runTeamTask(
    {
      taskId: "t124b",
      prompt: "x",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 1500,
    },
    port,
    (event) => events.push(event),
  );
  const impl = result.reports.find((r) => r.assignmentId === "impl")!;
  assert.equal(impl.blocker, "Agent identity changed while waiting for w2:p6");
  const dependent = result.reports.find((r) => r.assignmentId === "review")!;
  assert.equal(dependent.blocker, "dependency impl did not complete");
  const failed = events.find((e) => e.type === "task_failed");
  assert.ok(!/逾時/.test(failed?.detail ?? ""));
});

// F2：派工前取得 Worker 的 RPC 逾時不是回合逾時。
test("ISSUE-124 取得 Worker 時的 RPC 逾時不被當成 Worker 回合逾時", async () => {
  const events: OrchestrationEvent[] = [];
  const result = await runTeamTask(
    {
      taskId: "t124c",
      prompt: "x",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 1500,
      acquireWorker: async (worker) => {
        if (worker.pane_id === workerA.pane_id)
          throw new Error("herdr request agent.list timed out after 5000ms");
        return { agent: worker, continuity: "new-session" };
      },
    },
    timeoutPort([], []),
    (event) => events.push(event),
  );
  const impl = result.reports.find((r) => r.assignmentId === "impl")!;
  assert.equal(impl.state, "failed");
  assert.equal(impl.blocker, "herdr request agent.list timed out after 5000ms");
  assert.ok(!/等待逾時/.test(impl.blocker ?? ""));
  const dependent = result.reports.find((r) => r.assignmentId === "review")!;
  assert.equal(dependent.blocker, "dependency impl did not complete");
  const failed = events.find((e) => e.type === "task_failed");
  assert.ok(!/等待逾時|worktree/.test(failed?.detail ?? ""));
});

// F7：只有 runTeamTurn 自己的期限錯誤才算回合逾時，回合內的短 RPC 逾時不算。
test("ISSUE-124 只有真正的回合期限錯誤才被當成回合逾時，回合內的短 RPC 逾時不是", async () => {
  const cases: Array<[string, boolean]> = [
    ["herdr agent.prompt: timeout timed out waiting for agent status", true],
    ["herdr agent.wait: timeout timed out waiting for agent status", true],
    [
      "Timed out waiting for current response from w2:p6 (last state: working); no verified completion",
      true,
    ],
    // F9：bridge 端 request 逾時（`… timed out`）分不出回合等待或短 RPC，一律不算。
    ["herdr agent.prompt timed out", false],
    ["herdr agent.wait timed out", false],
    ["herdr agent.read timed out", false],
    ["herdr agent.list timed out", false],
    ["herdr request agent.list timed out after 5000ms", false],
    ["connection timeout while reading the pane", false],
  ];
  for (const [message, isDeadline] of cases) {
    const port = timeoutPort([], []);
    port.waitAgent = async (target, _until, _timeout) => {
      if (target === workerA.pane_id) throw new Error(message);
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle",
      };
    };
    const result = await runTeamTask(
      {
        taskId: "t124f7",
        prompt: "x",
        lead,
        workers: [workerA, workerB],
        timeoutMs: 1500,
      },
      port,
      () => {},
    );
    const impl = result.reports.find((r) => r.assignmentId === "impl")!;
    assert.equal(impl.state, "failed", message);
    if (isDeadline) {
      assert.match(impl.blocker ?? "", /等待逾時/, message);
      assert.match(impl.blocker ?? "", /上限 1\.5 秒/, message);
    } else {
      assert.equal(impl.blocker, message);
      const dependent = result.reports.find(
        (r) => r.assignmentId === "review",
      )!;
      assert.equal(dependent.blocker, "dependency impl did not complete");
    }
  }
  // 相容路徑：沒有 promptAgentAndWait（舊版 Herdr），送出 prompt 的 promptAgent RPC 逾時。
  const compat = timeoutPort([], []);
  assert.equal(compat.promptAgentAndWait, undefined);
  const sent = compat.promptAgent.bind(compat);
  compat.promptAgent = async (target, text) => {
    if (target === workerA.pane_id)
      throw new Error("herdr agent.prompt timed out");
    return sent(target, text);
  };
  const viaCompat = await runTeamTask(
    {
      taskId: "t124f9",
      prompt: "x",
      lead,
      workers: [workerA, workerB],
      timeoutMs: 1500,
    },
    compat,
    () => {},
  );
  const impl = viaCompat.reports.find((r) => r.assignmentId === "impl")!;
  assert.equal(impl.blocker, "herdr agent.prompt timed out");
});

// F6：Worker 已逾時、之後 Lead 彙整才失敗或受阻，原因仍要保留逾時摘要。
test("ISSUE-124 Worker 逾時後 Lead 彙整失敗或受阻，原因仍保留 Worker 逾時摘要", async () => {
  // 彙整丟出非逾時錯誤
  {
    const events: OrchestrationEvent[] = [];
    const port = timeoutPort([workerA.pane_id], []);
    const original = port.waitAgent.bind(port);
    let leadWaits = 0;
    port.waitAgent = async (target, until, timeoutMs) => {
      if (target === lead.pane_id && ++leadWaits >= 2)
        throw new Error("Lead synthesis exploded");
      return original(target, until, timeoutMs);
    };
    await assert.rejects(
      runTeamTask(
        {
          taskId: "t124f6a",
          prompt: "x",
          lead,
          workers: [workerA, workerB],
          timeoutMs: 1500,
        },
        port,
        (event) => events.push(event),
      ),
      /Lead synthesis exploded/,
    );
    const failed = events.find((e) => e.type === "task_failed");
    const detail = failed?.detail ?? "";
    assert.match(detail, /Lead synthesis exploded/);
    assert.match(detail, /Assignment impl 等待逾時/);
    assert.ok(detail.indexOf("等待逾時") < 60, detail);
  }
  // 彙整受阻（blocked）
  {
    const events: OrchestrationEvent[] = [];
    const port = timeoutPort([workerA.pane_id], []);
    // Lead 的第二個回合（彙整）在原子 prompt 就回報 blocked，這是 runTeamTurn 回傳 blocked 的路徑。
    let leadPrompts = 0;
    port.promptAgentAndWait = async (target, text) => {
      await port.promptAgent(target, text);
      if (target === lead.pane_id && ++leadPrompts >= 2)
        return { ...lead, agent_status: "blocked" };
      return undefined;
    };
    const result = await runTeamTask(
      {
        taskId: "t124f6b",
        prompt: "x",
        lead,
        workers: [workerA, workerB],
        timeoutMs: 1500,
      },
      port,
      (event) => events.push(event),
    );
    assert.equal(result.state, "blocked");
    const blocked = events.find((e) => e.type === "task_blocked");
    assert.match(blocked?.detail ?? "", /Assignment impl 等待逾時/);
  }
});

test("ISSUE-124 Lead 規劃回合逾時也明寫逾時", async () => {
  const events: OrchestrationEvent[] = [];
  await assert.rejects(
    runTeamTask(
      {
        taskId: "t124c",
        prompt: "x",
        lead,
        workers: [workerA],
        timeoutMs: 1500,
      },
      timeoutPort([lead.pane_id], []),
      (event) => events.push(event),
    ),
    /等待逾時/,
  );
  const failed = events.find((e) => e.type === "task_failed");
  assert.match(failed?.detail ?? "", /Lead planning 等待逾時/);
});

function atomicPort(
  waits: Array<[string, number]>,
  failOn?: (target: string, leadCalls: number) => boolean,
): OrchestrationPort {
  const prompts: Array<[string, string]> = [];
  let leadPrompts = 0;
  return {
    async promptAgent() {
      throw new Error("atomic prompt expected");
    },
    async promptAgentAndWait(target, prompt, timeoutMs) {
      if (target === lead.pane_id) leadPrompts += 1;
      prompts.push([target, prompt]);
      waits.push([target, timeoutMs]);
      if (failOn?.(target, leadPrompts))
        throw new Error(
          "herdr agent.prompt: timeout timed out waiting for agent status",
        );
      const agent = {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle" as const,
      };
      return target === workerB.pane_id
        ? { ...workerB, agent_status: "idle" as const }
        : agent;
    },
    async waitAgent(target) {
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "idle",
      };
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (target !== lead.pane_id) return framed(prompt, "worker report");
      return framed(
        prompt,
        leadPrompts > 1
          ? "summary"
          : JSON.stringify({
              assignments: [
                { id: "a", workerPaneId: workerA.pane_id, instruction: "do" },
                { id: "b", workerPaneId: workerB.pane_id, instruction: "do" },
              ],
            }),
      );
    },
  };
}

test("ISSUE-124 Lead 規劃、每個 Worker、Lead 彙整都以 timeoutMs 為等待上限", async () => {
  for (const timeoutMs of [1234, 777]) {
    const waits: Array<[string, number]> = [];
    const result = await runTeamTask(
      {
        taskId: `t124w${timeoutMs}`,
        prompt: "x",
        lead,
        workers: [workerA, workerB],
        timeoutMs,
      },
      atomicPort(waits),
      () => {},
    );
    assert.equal(result.state, "completed");
    assert.deepEqual(
      waits.map(([target]) => target).sort(),
      [lead.pane_id, lead.pane_id, workerA.pane_id, workerB.pane_id].sort(),
    );
    for (const [, limit] of waits) assert.equal(limit, timeoutMs);
  }
});

test("ISSUE-124 Lead 彙整回合逾時：失敗原因寫出 Lead synthesis 等待逾時與上限", async () => {
  const events: OrchestrationEvent[] = [];
  await assert.rejects(
    runTeamTask(
      {
        taskId: "t124s",
        prompt: "x",
        lead,
        workers: [workerA, workerB],
        timeoutMs: 1500,
      },
      atomicPort(
        [],
        (target, leadCalls) => target === lead.pane_id && leadCalls === 2,
      ),
      (event) => events.push(event),
    ),
    /Lead synthesis 等待逾時/,
  );
  const failed = events.find((e) => e.type === "task_failed");
  assert.match(
    failed?.detail ?? "",
    /Lead synthesis 等待逾時（已等待 .*，上限 1\.5 秒）/,
  );
});

test("Team roles use arbitrary Lead assignment ids and acquired Worker identity", async () => {
  const prompts: Array<[string, string]> = [];
  const roles: unknown[] = [];
  const acquired = {
    ...workerA,
    agent: "codex",
    model: "gpt-6.1-sol",
    machine: "remote-1",
    profileId: "helper",
    agent_session: { kind: "id", value: "PRIVATE" },
  };
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      return target === lead.pane_id ? lead : acquired;
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (!prompt) return "history";
      const body =
        target !== lead.pane_id
          ? "done"
          : prompts.filter(([pane]) => pane === lead.pane_id).length === 1
            ? JSON.stringify({
                assignments: [
                  {
                    id: "custom-check",
                    workerPaneId: workerA.pane_id,
                    instruction: "Check",
                  },
                ],
              })
            : "complete";
      return framed(prompt, body);
    },
  };
  const result = await runTeamTask(
    Object.assign(
      {
        taskId: "role-task",
        prompt: "work",
        lead,
        workers: [workerA],
        acquireWorker: async () => ({ agent: acquired, continuity: "unknown" }),
      },
      { onRoleAssigned: (role: unknown) => roles.push(role) },
    ),
    port,
    () => undefined,
  );
  assert.equal(result.state, "completed", JSON.stringify(result.reports));
  assert.deepEqual(roles, [
    { role: "lead", agent: "codex", machine: "local", taskId: "role-task" },
    {
      role: "custom-check",
      agent: "codex",
      machine: "remote-1",
      model: "gpt-6.1-sol",
      profileId: "helper",
      taskId: "role-task",
    },
  ]);
});

test("a Worker assignment named lead is recorded under a role that cannot collide with the Lead", async () => {
  const prompts: Array<[string, string]> = [];
  const roles: Array<{ role: string }> = [];
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async waitAgent(target) {
      return target === lead.pane_id ? lead : workerA;
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      if (!prompt) return "history";
      const body =
        target !== lead.pane_id
          ? "done"
          : prompts.filter(([pane]) => pane === lead.pane_id).length === 1
            ? JSON.stringify({
                assignments: [
                  {
                    id: "lead",
                    workerPaneId: workerA.pane_id,
                    instruction: "Check",
                  },
                ],
              })
            : "complete";
      return framed(prompt, body);
    },
  };
  const result = await runTeamTask(
    Object.assign(
      {
        taskId: "role-task",
        prompt: "work",
        lead,
        workers: [workerA],
        acquireWorker: async () => ({ agent: workerA, continuity: "unknown" }),
      },
      { onRoleAssigned: (role: { role: string }) => roles.push(role) },
    ),
    port,
    () => undefined,
  );
  assert.equal(result.state, "completed", JSON.stringify(result.reports));
  assert.equal(roles[0]!.role, "lead");
  assert.equal(roles[1]!.role, "assignment-lead");
  assert.notEqual(
    roleEvent(roles[0] as never, "2026-11-08T00:00:00Z").eventId,
    roleEvent(roles[1] as never, "2026-11-08T00:00:00Z").eventId,
  );
});

test("ISSUE-137 Lead and Worker first prompt readiness retries do not block the task", async () => {
  const prompts: Array<[string, string]> = [];
  const rejected = new Set<string>();
  const port: OrchestrationPort = {
    async promptAgent(target, prompt) {
      prompts.push([target, prompt]);
    },
    async promptAgentAndWait(target, prompt) {
      if (!rejected.has(target)) {
        rejected.add(target);
        throw new HerdrError(
          "agent.prompt",
          "agent_not_ready",
          "agent w5V:p1 is not an active named agent",
        );
      }
      prompts.push([target, prompt]);
      return {
        ...(target === lead.pane_id ? lead : workerA),
        agent_status: "done",
      };
    },
    async waitAgent(target) {
      return target === lead.pane_id ? lead : workerA;
    },
    async readAgent(target) {
      const prompt = latestPrompt(prompts, target);
      const planning =
        target === lead.pane_id &&
        prompts.filter(([pane]) => pane === target).length === 1;
      return framed(
        prompt,
        planning
          ? '{"assignments":[{"id":"inspect","workerPaneId":"w2:p6","instruction":"Inspect"}]}'
          : "completed report",
      );
    },
  };
  const result = await runTeamTask(
    {
      taskId: "prompt-retry",
      prompt: "Inspect",
      lead,
      workers: [workerA],
      timeoutMs: 3000,
    },
    port,
    () => undefined,
  );
  assert.equal(result.state, "completed");
  assert.equal(
    prompts.filter(([target]) => target === workerA.pane_id).length,
    1,
  );
  assert.equal(prompts.filter(([target]) => target === lead.pane_id).length, 2);
  assert.equal(rejected.size, 2);
});
