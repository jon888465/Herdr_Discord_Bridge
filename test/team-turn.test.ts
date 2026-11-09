import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../src/herdr.js";
import { runTeamTurn } from "../src/team-turn.js";
import type { OrchestrationPort } from "../src/team-orchestration.js";
import type { AgentRecord } from "../src/types.js";

const session = (value: string) => ({ kind: "id", value });

const base: AgentRecord = {
  pane_id: "w17:p1",
  terminal_id: "t-1",
  workspace_id: "w17",
  tab_id: "w17:t1",
  agent: "agy",
  agent_status: "idle",
};

/** 假的 Herdr：送出 prompt 後，輸出裡才有完整的 BEGIN／END 框。 */
function fakePort(waits: AgentRecord[]) {
  let prompt = "";
  const queue = [...waits];
  const port: OrchestrationPort = {
    promptAgent: async (_target, text) => {
      prompt = text;
    },
    waitAgent: async () => queue.shift() ?? waits.at(-1),
    readAgent: async () => {
      if (!prompt) return "";
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
      return `${begin}\n{"assignments": []}\n${end}`;
    },
  };
  return port;
}

const run = (
  agent: AgentRecord,
  waits: AgentRecord[],
  onBlocked?: (agent: AgentRecord) => void,
) =>
  runTeamTurn(agent, "plan", fakePort(waits), 2_000, 20, undefined, onBlocked);

test("an Agent that had no session when the turn was sent may register its first session during the turn", async () => {
  const result = await run(base, [{ ...base, agent_session: session("s1") }]);
  assert.equal(result.state, "done");
  assert.match(result.text, /assignments/);
});

test("an Agent that still has no session at the end of the turn is fine", async () => {
  const result = await run(base, [{ ...base }]);
  assert.equal(result.state, "done");
});

test("once a first session was seen, a different session later in the same turn is an identity change", async () => {
  let blocks = 0;
  await assert.rejects(
    run(
      base,
      [
        { ...base, agent_status: "blocked", agent_session: session("s1") },
        { ...base, agent_status: "idle", agent_session: session("s2") },
      ],
      () => {
        blocks += 1;
      },
    ),
    /Agent identity changed/,
  );
  assert.equal(blocks, 1);
});

test("a session that appears later in the turn and then disappears again is also an identity change", async () => {
  await assert.rejects(
    run(
      base,
      [
        { ...base, agent_status: "blocked", agent_session: session("s1") },
        { ...base, agent_status: "idle" },
      ],
      () => undefined,
    ),
    /Agent identity changed/,
  );
});

test("an Agent that already had a session must keep exactly that session", async () => {
  const known = { ...base, agent_session: session("s1") };
  const ok = await run(known, [{ ...known }]);
  assert.equal(ok.state, "done");
  for (const changed of [
    { ...known, agent_session: session("s2") },
    { ...known, agent_session: undefined },
  ])
    await assert.rejects(run(known, [changed]), /Agent identity changed/);
});

test("the pane, terminal, workspace and Agent kind must still match even when a first session appears", async () => {
  for (const changed of [
    { ...base, pane_id: "w17:p2" },
    { ...base, terminal_id: "t-2" },
    { ...base, workspace_id: "w18" },
    { ...base, agent: "claude" },
  ])
    await assert.rejects(
      run(base, [{ ...changed, agent_session: session("s1") }]),
      /Agent identity changed/,
      JSON.stringify(changed),
    );
});

/** ISSUE-086：畫面上的 JSON 被 pane 寬度硬換行切斷，hook 訊息則是完整的。 */
function wrappedPort(waits: AgentRecord[]) {
  let prompt = "";
  const port: OrchestrationPort = {
    promptAgent: async (_target, text) => {
      prompt = text;
    },
    waitAgent: async () => waits[0],
    readAgent: async () => {
      if (!prompt) return "";
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
      const frame = `${begin}\n{"assignments":[{"id":"a1","acces\ns":"write"}]}\n${end}`;
      return waits[0]?.agent === "claude"
        ? "⏺ " + frame.split("\n").join("\n  ")
        : frame;
    },
  };
  const markers = () => ({
    begin: prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0],
    end: prompt.match(/BRIDGE_END_[a-f0-9]+/)![0],
  });
  return { port, markers };
}

test("a hook final message is used instead of a screen frame that the pane width broke", async () => {
  const { port, markers } = wrappedPort([{ ...base }]);
  const result = await runTeamTurn(base, "plan", port, 2_000, 20, {
    taskId: "t",
    phase: "planning",
    hookFinal: () => {
      const { begin, end } = markers();
      return `${begin}\n{"assignments":[]}\n${end}`;
    },
  });
  assert.equal(result.state, "done");
  assert.equal(result.terminal, false);
  assert.equal(result.text, '{"assignments":[]}');
});

test("without a hook message the screen frame is still used after a short grace period", async () => {
  const { port } = wrappedPort([{ ...base }]);
  const result = await runTeamTurn(base, "plan", port, 5_000, 20, {
    taskId: "t",
    phase: "planning",
    hookFinal: () => undefined,
  });
  assert.equal(result.terminal, true);
  assert.match(result.text, /acces\ns/);
});

test("the hook lookup is bounded by the time the turn started", async () => {
  const { port } = wrappedPort([{ ...base }]);
  const before = Date.now();
  const seen: number[] = [];
  await runTeamTurn(base, "plan", port, 5_000, 20, {
    taskId: "t",
    phase: "planning",
    hookFinal: (_agent, since) => {
      seen.push(since);
      return undefined;
    },
  });
  assert.ok(seen.length > 0 && seen.every((s) => s >= before));
});

/**
 * ISSUE-089：codex 的回覆比 pane 可視高度長時，終端讀取只剩最後幾列、框遺失；
 * rollout 檔有完整的最終訊息，應優先採用，而且不受硬換行影響。
 */
test("a codex reply that scrolled out of the pane is read from its rollout file", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const codex: AgentRecord = { ...base, agent: "codex" };
  let prompt = "";
  const port: OrchestrationPort = {
    promptAgent: async (_target, text) => {
      prompt = text;
      const begin = text.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = text.match(/BRIDGE_END_[a-f0-9]+/)![0];
      const day = join(home, "sessions", "2026", "11", "05");
      mkdirSync(day, { recursive: true });
      const event = (payload: object) =>
        JSON.stringify({ type: "event_msg", payload });
      writeFileSync(
        join(
          day,
          "rollout-2026-11-05T10-00-00-01a1a9e0-0000-7000-8000-000000000001.jsonl",
        ),
        [
          event({ type: "task_started", turn_id: "t1" }),
          event({ type: "user_message", message: text }),
          event({
            type: "agent_message",
            phase: "final_answer",
            message: `${begin}\n${"line\n".repeat(40)}{"ok":true}\n${end}`,
          }),
          event({ type: "task_complete", turn_id: "t1" }),
        ].join("\n") + "\n",
      );
    },
    waitAgent: async () => ({ ...codex, agent_status: "done" }),
    // 終端畫面只剩輸入框：框已經捲出去，讀不到。
    readAgent: async () => (prompt ? "› Ask Codex to do anything" : ""),
  };
  try {
    const result = await runTeamTurn(codex, "plan", port, 5_000, 20, {
      taskId: "t",
      phase: "planning",
      observeSession: true,
    });
    assert.equal(result.state, "done");
    assert.equal(result.terminal, false);
    assert.match(result.text, /\{"ok":true\}$/);
    assert.equal(result.text.split("\n").length, 41);
    assert.equal(result.session?.value, "01a1a9e0-0000-7000-8000-000000000001");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ISSUE-107：agy 要處理完第一個 prompt 才被 Herdr 登記 session；coding 引擎需要回合內驗證過的 session。
const observing = {
  taskId: "t",
  phase: "assignment" as const,
  observeSession: true,
};
const runObserving = (agent: AgentRecord, waits: AgentRecord[]) =>
  runTeamTurn(agent, "work", fakePort(waits), 2_000, 20, observing);

test("a non-codex Agent's session first seen during the turn is returned when the caller asks to observe it", async () => {
  const result = await runObserving(base, [
    { ...base, agent_session: session("s1") },
  ]);
  assert.deepEqual(result.session, { kind: "id", value: "s1" });
});

test("a non-codex Agent that already had a session returns exactly that session", async () => {
  const known = { ...base, agent: "opencode", agent_session: session("s0") };
  const result = await runObserving(known, [{ ...known }]);
  assert.deepEqual(result.session, { kind: "id", value: "s0" });
});

test("no session is returned when none appeared, or when the caller did not ask", async () => {
  assert.equal((await runObserving(base, [{ ...base }])).session, undefined);
  const result = await runTeamTurn(
    base,
    "work",
    fakePort([{ ...base, agent_session: session("s1") }]),
    2_000,
    20,
    { taskId: "t", phase: "assignment" },
  );
  assert.equal(result.session, undefined);
});

test("a session that changed during the turn is never returned", async () => {
  await assert.rejects(
    runTeamTurn(
      base,
      "work",
      fakePort([
        { ...base, agent_status: "blocked", agent_session: session("s1") },
        { ...base, agent_session: session("s2") },
      ]),
      2_000,
      20,
      observing,
      () => {},
    ),
    /Agent identity changed/,
  );
});

test("codex never takes its session from Herdr's agent_session, only from its rollout", async () => {
  const codex = { ...base, agent: "codex" };
  const result = await runObserving(codex, [
    { ...codex, agent_session: session("hook-pane-session") },
  ]);
  assert.equal(result.session, undefined);
});

// ISSUE-134: card callers have hook context without a Team task id or phase.
test("card hook context preserves complete review JSON and omits missing debug fields", async () => {
  const { createTurnHookFinal } = await import("../src/turn-hook-final.js");
  const { HookEventStore } = await import("../src/hook-events.js");
  const agent = { ...base, agent: "claude" };
  const events = new HookEventStore();
  const full = JSON.stringify({
    verdict: "pass",
    summary: "complete review ".repeat(20),
    findings: [],
  });
  const wrapped = full.replace("complete review", "complete\nreview");
  let prompt = "";
  const port: OrchestrationPort = {
    promptAgent: async (_target, text) => {
      prompt = text;
      events.record({
        event: "Stop",
        sessionId: "review-session",
        paneId: agent.pane_id,
        message: frame(full),
      });
    },
    waitAgent: async () => agent,
    readAgent: async () =>
      prompt ? "⏺ " + frame(wrapped).split("\n").join("\n  ") : "",
  };
  function frame(body: string) {
    return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
  }
  const result = await runTeamTurn(agent, "review", port, 2000, 20, {
    hookFinal: createTurnHookFinal({ claude: "auto" }, events),
  });
  assert.equal(result.text, full);
  assert.notEqual(result.text, wrapped);
  assert.equal(result.terminal, false);
  const debug = prompt
    .split("\n")
    .find((line) => line.startsWith("Debug context:"))!;
  assert.doesNotMatch(debug, /undefined|taskId=|phase=/);
});

test("shared hook lookup falls back to screen for missing messages and never reads hooks in parser mode", async () => {
  const { createTurnHookFinal } = await import("../src/turn-hook-final.js");
  const agent = { ...base, agent: "claude" };
  for (const mode of ["auto", "parser"] as const) {
    let lookups = 0;
    const events = {
      stopSince: () => {
        lookups++;
        return undefined;
      },
      stopForPane: () => {
        lookups++;
        return undefined;
      },
    };
    const { port } = wrappedPort([agent]);
    const result = await runTeamTurn(agent, "review", port, 2000, 20, {
      hookFinal: createTurnHookFinal({ claude: mode }, events),
    });
    assert.equal(result.terminal, true);
    assert.match(result.text, /acces\ns/);
    assert.equal(lookups > 0, mode === "auto");
  }
});

test("Team engine and both card flows wire the shared hook lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /createTurnHookFinal\(config\.hookTransport, hookEvents\)/,
  );
  for (const name of ["fixCard:", "reviewPullRequest:"]) {
    const start = source.indexOf(name);
    assert.ok(start >= 0);
    const turn = source.slice(
      start,
      source.indexOf("return { state: turn.state", start),
    );
    assert.match(
      turn,
      /runTeamTurn\([\s\S]*runtime\.config\.outputLines,\s*\{\s*hookFinal: createTurnHookFinal\(\s*runtime\.config\.hookTransport,\s*hookEvents,/,
    );
  }
});

function retryClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

for (const atomic of [true, false]) {
  test(`ISSUE-137 retries rejected first prompt exactly until accepted (atomic=${atomic})`, async () => {
    const port = fakePort([base]);
    const send = port.promptAgent;
    let calls = 0,
      accepted = 0,
      dispatched = 0;
    const dispatch = async (target: string, text: string) => {
      if (++calls <= 3)
        throw new HerdrError(
          "agent.prompt",
          "agent_not_ready",
          "agent w5V:p1 is not an active named agent",
        );
      accepted++;
      await send(target, text);
      return base;
    };
    if (atomic) port.promptAgentAndWait = dispatch;
    else
      port.promptAgent = async (target, text) => {
        await dispatch(target, text);
      };
    const clock = retryClock();
    const result = await runTeamTurn(base, "plan", port, 5000, 20, {
      promptRetry: { clock },
      beforeDispatch: () => {
        dispatched++;
      },
    });
    assert.equal(result.state, "done");
    assert.equal(calls, 4);
    assert.equal(accepted, 1);
    assert.equal(dispatched, 1);
    assert.deepEqual(clock.sleeps, [500, 500, 500]);
  });
}

test("ISSUE-137 other errors propagate unchanged without retry", async () => {
  const port = fakePort([base]);
  const error = new HerdrError("agent.prompt", "agent_blocked", "blocked");
  let calls = 0;
  port.promptAgentAndWait = async () => {
    calls++;
    throw error;
  };
  await assert.rejects(
    runTeamTurn(base, "plan", port, 2000, 20),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});

for (const timeoutMs of [1200, 5000]) {
  test(`ISSUE-137 exhaustion is bounded by retry and turn budgets (${timeoutMs})`, async () => {
    const port = fakePort([base]);
    const clock = retryClock();
    let calls = 0;
    port.promptAgent = async () => {
      calls++;
      throw new HerdrError(
        "agent.prompt",
        "agent_not_ready",
        "agent w5V:p1 is not an active named agent",
      );
    };
    await assert.rejects(
      runTeamTurn(base, "plan", port, timeoutMs, 20, {
        promptRetry: { clock, timeoutMs: 1200 },
      }),
      /Waited 1\.2 seconds.*first prompt was not delivered:.*agent_not_ready.*active named agent/,
    );
    assert.equal(calls, 3);
    assert.equal(clock.now(), 1200);
  });
}

test("ISSUE-137 never dispatches when setup already used the turn budget", async () => {
  const clock = retryClock();
  const port = fakePort([base]);
  const read = port.readAgent;
  port.readAgent = async (...args) => {
    clock.now = () => 120;
    return read(...args);
  };
  let calls = 0;
  port.promptAgentAndWait = async () => {
    calls++;
    return base;
  };
  await assert.rejects(
    runTeamTurn(base, "plan", port, 100, 20, { promptRetry: { clock } }),
    /used up before the first prompt was dispatched; nothing was sent/,
  );
  assert.equal(calls, 0);
});

for (const outcome of ["ok", "undefined", "stalled"]) {
  test(`ISSUE-137 ${outcome} is never resent`, async () => {
    const port = fakePort([base]);
    const send = port.promptAgent;
    let calls = 0;
    port.promptAgentAndWait = async (target, text) => {
      calls++;
      await send(target, text);
      if (outcome === "stalled")
        throw new HerdrError("agent.prompt", "agent_prompt_stalled", "stalled");
      return outcome === "undefined" ? undefined : base;
    };
    assert.equal(
      (await runTeamTurn(base, "plan", port, 2000, 20)).state,
      "done",
    );
    assert.equal(calls, 1);
  });
}

test("ISSUE-137 abort during retry sleep prevents another dispatch", async () => {
  const port = fakePort([base]);
  const controller = new AbortController();
  let calls = 0;
  port.promptAgent = async () => {
    calls++;
    throw new HerdrError("agent.prompt", "agent_not_ready", "not ready");
  };
  const clock = {
    now: () => 0,
    sleep: async () => {
      controller.abort();
    },
  };
  await assert.rejects(
    runTeamTurn(base, "plan", port, 2000, 20, {
      signal: controller.signal,
      promptRetry: { clock },
    }),
    /abort/i,
  );
  assert.equal(calls, 1);
});

for (const atomicMs of [60, 90]) {
  test(`ISSUE-137 retry-deadline-1 shares the turn deadline after retry then stalled (${atomicMs} ms atomic wait)`, async () => {
    const clock = retryClock();
    let calls = 0,
      accepted = 0,
      dispatched = 0;
    const observationBudgets: number[] = [];
    const port: OrchestrationPort = {
      async promptAgent() {
        throw new Error("unexpected fallback");
      },
      async promptAgentAndWait(_target, _text, remaining) {
        calls++;
        if (calls === 1)
          throw new HerdrError(
            "agent.prompt",
            "agent_not_ready",
            "not registered",
          );
        accepted++;
        assert.equal(remaining, 90);
        await clock.sleep(atomicMs);
        throw new HerdrError("agent.prompt", "agent_prompt_stalled", "stalled");
      },
      async waitAgent(_target, _states, remaining) {
        assert.ok(remaining !== undefined);
        observationBudgets.push(remaining);
        await clock.sleep(remaining);
        return base;
      },
      async readAgent() {
        return "no current marker";
      },
    };
    await assert.rejects(
      runTeamTurn(base, "plan", port, 120, 20, {
        promptRetry: { clock, intervalMs: 30 },
        beforeDispatch: () => {
          dispatched++;
        },
      }),
      /Timed out waiting for current response/,
    );
    assert.equal(
      clock.now(),
      120,
      "observation must not create a new turn budget",
    );
    assert.deepEqual(observationBudgets, atomicMs === 60 ? [30] : []);
    assert.equal(calls, 2);
    assert.equal(accepted, 1);
    assert.equal(dispatched, 1);
  });
}
