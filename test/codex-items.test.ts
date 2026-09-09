import test from "node:test";
import assert from "node:assert/strict";
import { CodexTurn } from "../src/response-stream.js";

test("live Codex item_completed events produce progress and final", () => {
  const turn = new CodexTurn("question");
  const emit = (payload: object) =>
    turn.accept(JSON.stringify({ type: "event_msg", payload }));
  emit({ type: "task_started", turn_id: "t" });
  emit({
    type: "item_completed",
    turn_id: "t",
    item: {
      type: "UserMessage",
      content: [{ type: "text", text: "question" }],
    },
  });
  emit({
    type: "item_completed",
    turn_id: "t",
    item: {
      type: "AgentMessage",
      phase: "commentary",
      content: [{ type: "Text", text: "checking files" }],
    },
  });
  // Public progress must be available even when the terminal prompt is offscreen.
  assert.equal(
    (turn as unknown as { preview: string }).preview,
    "checking files",
  );
  emit({
    type: "item_completed",
    turn_id: "other",
    item: {
      type: "AgentMessage",
      phase: "final_answer",
      content: [{ type: "Text", text: "wrong" }],
    },
  });
  assert.equal(turn.final, "");
  emit({
    type: "item_completed",
    turn_id: "t",
    item: {
      type: "AgentMessage",
      phase: "final_answer",
      content: [{ type: "Text", text: "complete answer" }],
    },
  });
  emit({ type: "task_complete", turn_id: "t" });
  assert.equal(turn.final, "complete answer");
  assert.equal(turn.completed, true);
});
