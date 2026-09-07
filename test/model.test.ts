import test from "node:test";
import assert from "node:assert/strict";
import { parseModelRequest } from "../src/main.js";
import type { AgentRecord } from "../src/types.js";

const agy: AgentRecord = {
  terminal_id: "term-agy",
  agent: "agy",
  agent_status: "idle",
  workspace_id: "w2",
  tab_id: "w2:t1",
  pane_id: "w2:p3",
};

test("model target alone opens the picker for a matching pane", () => {
  assert.deepEqual(parseModelRequest(["w2:p3"], [agy]), {
    query: "w2:p3",
    model: "",
  });
});

test("one unknown model argument remains a direct model request", () => {
  assert.deepEqual(parseModelRequest(["gemini-3.7-flash"], [agy]), {
    query: "",
    model: "gemini-3.7-flash",
  });
});

test("target and model arguments remain supported", () => {
  assert.deepEqual(parseModelRequest(["w2:p3", "gemini-3.7-flash"], [agy]), {
    query: "w2:p3",
    model: "gemini-3.7-flash",
  });
});
