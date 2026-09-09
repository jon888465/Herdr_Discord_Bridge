import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexTurn,
  Settlement,
  rollingPreview,
} from "../src/response-stream.js";

const event = (payload: object) =>
  JSON.stringify({ type: "event_msg", payload });
test("Codex final uses the matching turn, excluding commentary and reasoning", () => {
  const turn = new CodexTurn("question\nsecond line");
  turn.accept(event({ type: "task_started", turn_id: "one" }));
  turn.accept(
    event({ type: "user_message", message: "question\nsecond line" }),
  );
  turn.accept(event({ type: "agent_reasoning", text: "private" }));
  turn.accept(
    event({ type: "agent_message", phase: "commentary", message: "working" }),
  );
  assert.equal(turn.final, "");
  const answer = "完整回答\n".repeat(3000);
  turn.accept(
    event({ type: "agent_message", phase: "final_answer", message: answer }),
  );
  turn.accept(event({ type: "task_complete", turn_id: "other" }));
  assert.equal(turn.completed, false);
  turn.accept(event({ type: "task_complete", turn_id: "one" }));
  assert.equal(turn.completed, true);
  turn.accept(
    event({
      type: "agent_message",
      phase: "final_answer",
      message: "next turn",
    }),
  );
  assert.equal(turn.final, answer);
});
test("unmatched prompts cannot publish another answer", () => {
  const turn = new CodexTurn("expected");
  turn.accept("invalid json");
  turn.accept(event({ type: "task_started", turn_id: "one" }));
  turn.accept(event({ type: "user_message", message: "different" }));
  turn.accept(
    event({ type: "agent_message", phase: "final_answer", message: "wrong" }),
  );
  turn.accept(event({ type: "task_complete", turn_id: "one" }));
  assert.equal(turn.final, "");
  assert.equal(turn.completed, false);
});
test("blocked, unknown, failed reads and new output reset settlement", () => {
  const state = new Settlement();
  for (const status of ["blocked", "unknown", "working"]) {
    for (let i = 0; i < 10; i++)
      assert.equal(state.observe(status, true, false), false);
  }
  for (let i = 0; i < 3; i++)
    assert.equal(state.observe("idle", true, false), false);
  assert.equal(state.observe("idle", false, false), false);
  assert.equal(state.observe("idle", true, true), false);
  for (let i = 0; i < 3; i++)
    assert.equal(state.observe("done", true, false), false);
  assert.equal(state.observe("done", true, false), true);
});
test("preview shows the latest tail instead of the first chunk", () => {
  const text = "old".repeat(1000) + "latest CLI response";
  assert.ok(rollingPreview(text).endsWith("latest CLI response"));
  assert.ok(rollingPreview(text).length <= 1502);
});
