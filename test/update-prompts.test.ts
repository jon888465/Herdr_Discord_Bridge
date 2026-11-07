import test from "node:test";
import assert from "node:assert/strict";
import { UPDATE_PROMPTS } from "../src/update-prompts.js";

test("observed update list contains only the confirmed codex menu and no sensitive wording", () => {
  assert.deepEqual(UPDATE_PROMPTS, [
    {
      kind: "codex",
      match: ["Update available", "Skip until next version"],
      skipKey: "3",
    },
  ]);
  for (const entry of UPDATE_PROMPTS) {
    assert.doesNotMatch(
      JSON.stringify(entry),
      /trust|permission|approv|allow|login|log\s*in|sign\s*in/i,
    );
  }
});
