import test from "node:test";
import assert from "node:assert/strict";
import {
  latestAgentResponse,
  modelCommandFor,
  modelOptionsFor,
  normalizeTerminalResponse,
} from "../src/cli-adapter.js";

test("latestAgentResponse keeps a long Codex response intact", () => {
  const prompt = "please inspect the bridge";
  const response = "answer line\n".repeat(600);
  const output = `before\n› ${prompt}\n${response}`;

  assert.equal(
    latestAgentResponse("codex", prompt, output, "before"),
    response.trim(),
  );
});

test("latestAgentResponse uses the OpenCode prompt boundary", () => {
  const prompt = "inspect the bridge";
  const output = `before\n> ${prompt}\nOpenCode response\n`;

  assert.equal(
    latestAgentResponse("opencode", prompt, output, "before"),
    "OpenCode response",
  );
});

const grokBox = (body: string) => ` ┌                         ┐
${body
  .split("\n")
  .map((line, i) => ` │   ${line}${i === 0 ? "   2:13 PM" : ""}  │`)
  .join("\n")}
 └                         ┘
 Worked for 9.6s
 ╭──────────╮
 │ ❯        │
 ╰──────────╯`;

test("Grok extracts a changed answer box despite truncated prompt echo", () => {
  assert.equal(
    latestAgentResponse(
      "grok",
      "long prompt",
      grokBox("new answer"),
      grokBox("old answer"),
    ),
    "new answer",
  );
  assert.equal(
    latestAgentResponse(
      "grok",
      "long prompt",
      grokBox("old answer"),
      grokBox("old answer"),
    ),
    "",
  );
});

const grokPlain = (body: string) =>
  `     ❯ truncated probe…   2:18 PM\n\n${body
    .split("\n")
    .map((line, i) => `     ${line}${i === 0 ? "   2:18 PM" : ""}     █`)
    .join("\n")}\n\n     Worked for 6.2s     █`;

for (const [name, render] of [
  ["boxed", grokBox],
  ["unboxed", grokPlain],
] as const) {
  test(`Grok ${name} turn survives timestamps and wrapped markers`, async () => {
    const { runTeamTurn } = await import("../src/team-turn.js");
    const agent = {
      pane_id: "p",
      tab_id: "tab",
      terminal_id: "t",
      workspace_id: "w",
      agent: "grok",
      agent_status: "idle" as const,
    };
    let output = grokBox("old answer");
    const port = {
      readAgent: async () => output,
      promptAgent: async (_target: string, prompt: string) => {
        const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
        const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
        output = render(
          `${begin.slice(0, 35)}\n${begin.slice(35)} GROK_ADAPTER_OK\n${end.slice(0, 35)}\n${end.slice(35)}`,
        );
      },
      waitAgent: async () => agent,
      listAgentsWithWorkspaceNames: async () => [agent],
    };
    assert.equal(
      (await runTeamTurn(agent, "probe", port, 10, 200)).text,
      "GROK_ADAPTER_OK",
    );
  });
}

test("Grok preserves code indentation and ignores input, chrome and incomplete boxes", () => {
  const answer = "```ts\n  const n = 1;\n```\n│ quoted border";
  assert.equal(
    latestAgentResponse(
      "grok",
      "probe",
      `\x1b[32m${grokBox(answer)}\x1b[0m`,
      "",
    ),
    answer,
  );
  assert.equal(
    latestAgentResponse("grok", "probe", "│ ❯ probe │\nWorked for 1s", ""),
    "",
  );
  assert.equal(
    latestAgentResponse("grok", "probe", "┌    ┐\n │   partial │", ""),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "grok",
      "probe",
      grokBox("old").replace("2:13 PM", "2:14 PM"),
      grokBox("old"),
    ),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "grok",
      "probe",
      grokBox("old"),
      grokBox("old") + "\n" + grokBox("new"),
    ),
    "",
  );
});

test("Grok unboxed completed response excludes prompt, clock and scrollbar", () => {
  const output =
    "     ❯ probe     2:18 PM\n       wrapped prompt…\n\n     ◆ Thought for 1.2s\n\n     answer     2:18 PM\n       indented code      █\n\n     Worked for 6.2s    █\n │ ❯ │";
  assert.equal(
    latestAgentResponse("grok", "probe", output, ""),
    "answer\n  indented code",
  );
  assert.equal(latestAgentResponse("grok", "probe", output, output), "");
  assert.equal(
    latestAgentResponse(
      "grok",
      "probe",
      output.replace("Worked for", "Working for"),
      "",
    ),
    "",
  );
});

// Synthetic Claude terminal fixtures, not a captured live answer.
const claudeScreen = (prompt: string, body: string) =>
  `Claude Code v2.1.289\n❯ ${prompt}\n\n⏺ ${body.split("\n").join("\n  ")}\n\n✻ Worked for 2s\n────────────────────\n❯\n────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

test("Claude model picker uses Claude aliases and keeps explicit model names", () => {
  for (const kind of ["claude", "Claude", "claude-code"]) {
    assert.deepEqual(modelOptionsFor(kind), ["sonnet", "opus", "haiku"]);
    assert.equal(modelCommandFor(kind, "sonnet"), "/model sonnet");
    assert.equal(
      modelCommandFor(kind, "claude-sonnet-5-5"),
      "/model claude-sonnet-5-5",
    );
  }
});

test("Claude extracts multiline prompt replies and preserves code indentation", () => {
  const prompt = "inspect the bridge\n\nand report";
  const answer = "Result\n```ts\n  const n = 1;\n```\n> quoted text";
  assert.equal(
    latestAgentResponse(
      "claude",
      prompt,
      claudeScreen("inspect the bridge\n  \n  and report", answer),
      "",
    ),
    answer,
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "inspect the bridge and report",
      claudeScreen("inspect the bridge\n  \n  and report", answer),
      "",
    ),
    answer,
  );
});

test("Claude rejects prompt-only output, unrelated turns and redraws of old answers", () => {
  const old = claudeScreen("probe", "old answer");
  assert.equal(latestAgentResponse("claude", "probe", old, old), "");
  assert.equal(
    latestAgentResponse("claude", "probe", old.replace("2s", "3s"), old),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      claudeScreen("another prompt", "other answer"),
      "",
    ),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      "❯ probe\n────────────────────\n❯\n  ? for shortcuts",
      "",
    ),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      "Claude Code\n⏺ historical answer",
      "",
    ),
    "",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      old + "\n❯ another prompt\n\n⏺ other answer",
      old,
    ),
    "",
  );
});

test("Claude baseline overlap extracts new blocks but never guesses after history loss", () => {
  const baseline = "❯ probe\n\n⏺ First step";
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      baseline + "\n\n⏺ New answer",
      baseline,
    ),
    "First step\n\nNew answer",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "probe",
      "⏺ First step\n\n⏺ New answer",
      baseline,
    ),
    "New answer",
  );
  assert.equal(
    latestAgentResponse("claude", "probe", "⏺ unrelated answer", baseline),
    "",
  );
});

test("Claude shared turn normalization excludes prompt, tool results and input chrome", () => {
  assert.equal(
    normalizeTerminalResponse(
      "claude",
      "❯ probe\n\n⏺ Bash(BRIDGE_BEGIN_fake BRIDGE_END_fake)\n  ⎿  tool result\n     BRIDGE_BEGIN_fake\n     BRIDGE_END_fake\n\n⏺ Public answer\n  next line\n────────────────────\n❯ draft\n  input continuation",
    ),
    "Public answer\nnext line",
  );
});

test("Claude terminal answers reach the shared Team turn receiver", async () => {
  const { runTeamTurn } = await import("../src/team-turn.js");
  const agent = {
    pane_id: "p",
    tab_id: "tab",
    terminal_id: "t",
    workspace_id: "w",
    agent: "claude",
    agent_status: "idle" as const,
  };
  let output = claudeScreen("old", "old answer");
  const port = {
    readAgent: async () => output,
    promptAgent: async (_target: string, prompt: string) => {
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
      output = claudeScreen(
        prompt.replace(/\n/g, "\n  "),
        `${begin.slice(0, 30)}\n${begin.slice(30)}\nCLAUDE_ADAPTER_OK\n${end.slice(0, 30)}\n${end.slice(30)}`,
      );
    },
    waitAgent: async () => agent,
    listAgentsWithWorkspaceNames: async () => [agent],
  };
  assert.equal(
    (await runTeamTurn(agent, "probe", port, 50, 200)).text,
    "CLAUDE_ADAPTER_OK",
  );
});

test("Claude tools cannot complete a Team turn by echoing its markers", async () => {
  const { runTeamTurn } = await import("../src/team-turn.js");
  const agent = {
    pane_id: "p",
    tab_id: "tab",
    terminal_id: "t",
    workspace_id: "w",
    agent: "claude",
    agent_status: "idle" as const,
  };
  let output = "";
  const port = {
    readAgent: async () => output,
    promptAgent: async (_target: string, prompt: string) => {
      const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0];
      const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)![0];
      output = `❯ ${prompt.replace(/\n/g, "\n  ")}\n\n⏺ Bash(echo ${begin} TOOL_ONLY ${end})\n  ⎿  ${begin}\n     TOOL_ONLY\n     ${end}`;
    },
    waitAgent: async () => agent,
    listAgentsWithWorkspaceNames: async () => [agent],
  };
  await assert.rejects(
    runTeamTurn(agent, "probe", port, 20, 200),
    /no verified completion/,
  );
});

// Reproduces the observed 2026-10-05 narrow Claude 2.1.289 viewport.
test("Claude correlates Chinese and word-internal soft wraps without inventing spaces", () => {
  const prompt =
    "這是一般回覆相容性測試，請不要讀寫檔案或使用工具，也不要呼叫其他Agent，僅回答CLAUDE_SINGLE_OK。";
  const output =
    "❯ 這是一般回覆相容性測試，請不要讀寫檔案或使用工具\n  ，也不要呼叫其他Agent，僅回答CLAUDE_SINGLE_OK。\n\n● CLAUDE_SINGLE_OK\n\n✻ Worked for 4s · done 上午11:10\n────────────────────\n❯\n────────────────────\n  ⏵⏵ auto mode on";
  assert.equal(
    latestAgentResponse("claude", prompt, output, ""),
    "CLAUDE_SINGLE_OK",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      "inspect the implementation",
      claudeScreen("inspect the implemen\n  tation", "okay"),
      "",
    ),
    "okay",
  );
  assert.equal(
    latestAgentResponse(
      "claude",
      prompt.replace("不要讀寫", "請讀寫"),
      output,
      "",
    ),
    "",
  );
});
