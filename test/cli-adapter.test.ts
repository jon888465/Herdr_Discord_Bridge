import test from "node:test";
import assert from "node:assert/strict";
import { latestAgentResponse } from "../src/cli-adapter.js";

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
