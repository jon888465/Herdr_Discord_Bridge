import test from "node:test";
import assert from "node:assert/strict";
import { assertCodingRoster } from "../src/coding-roster.js";

test("a coding task with no Worker is refused up front, naming the reason and the way out", () => {
  assert.throws(
    () => assertCodingRoster(true, 0),
    (error: Error) =>
      /--coding/.test(error.message) &&
      /Worker/.test(error.message) &&
      /不帶 --coding/.test(error.message),
  );
});

test("a coding task with at least one Worker or profile is allowed", () => {
  assert.doesNotThrow(() => assertCodingRoster(true, 1));
  assert.doesNotThrow(() => assertCodingRoster(true, 3));
});

test("a task that is not a coding task never needs a Worker", () => {
  assert.doesNotThrow(() => assertCodingRoster(false, 0));
});
