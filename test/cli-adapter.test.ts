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
