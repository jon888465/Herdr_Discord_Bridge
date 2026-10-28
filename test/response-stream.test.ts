import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexTurn,
  Settlement,
  rollingPreview,
  sessionCreatedSince,
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

test("sessionCreatedSince accepts a UUIDv7 session created at or after the prompt (ISSUE-047)", () => {
  const id = "01a180fe-d4a8-7bd1-9701-2155cdc999e6"; // 2026-10-28T05:32:26.664Z
  const at = Date.parse("2026-10-28T05:32:26.664Z");
  assert.equal(sessionCreatedSince({ kind: "id", value: id }, at), true);
  assert.equal(sessionCreatedSince({ kind: "id", value: id }, at - 1000), true);
  assert.equal(
    sessionCreatedSince({ kind: "id", value: id }, at + 60000),
    false,
  );
  assert.equal(sessionCreatedSince({ kind: "path", value: id }, at), false);
  assert.equal(
    sessionCreatedSince(
      { kind: "id", value: "43629c7e-0750-42da-bef9-53223d69b93f" },
      0,
    ),
    false,
  );
  assert.equal(sessionCreatedSince(null, 0), false);
});

test("sessionCreatedSince uses a creation-time lookup for non-UUIDv7 ids (agy, ISSUE-047)", () => {
  const id = "db1c4b58-690b-4f4a-93e7-fcc260852613";
  const at = 1_000_000;
  assert.equal(sessionCreatedSince({ kind: "id", value: id }, at), false);
  assert.equal(
    sessionCreatedSince({ kind: "id", value: id }, at, () => at + 1000),
    true,
  );
  assert.equal(
    sessionCreatedSince({ kind: "id", value: id }, at, () => at - 60000),
    false,
  );
});
