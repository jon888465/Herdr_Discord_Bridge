import test from "node:test";
import assert from "node:assert/strict";

test("acceptance: intentionally red", () => {
  assert.fail("acceptance: intentionally red");
});
