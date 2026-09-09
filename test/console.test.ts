import test from "node:test";
import assert from "node:assert/strict";
import { parseConsoleCommand } from "../src/console.js";

test("pane console accepts plain and prefixed bridge commands", () => {
  assert.deepEqual(parseConsoleCommand("agents", "/herdr"), {
    command: "agents",
    args: [],
  });
  assert.deepEqual(parseConsoleCommand("/herdr team list", "/herdr"), {
    command: "team",
    args: ["list"],
  });
  assert.deepEqual(
    parseConsoleCommand("ask w2:p1 inspect the current task", "/herdr"),
    {
      command: "ask",
      args: ["w2:p1", "inspect", "the", "current", "task"],
    },
  );
  assert.equal(parseConsoleCommand("   ", "/herdr"), null);
});
