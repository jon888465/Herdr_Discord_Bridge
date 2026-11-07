import test from "node:test";
import assert from "node:assert/strict";
import { updateSkipEventId } from "../src/card-command.js";

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

test("update-skip event id is valid and differs per pane or time in the same round", () => {
  const time = "2026-11-07T04:10:00.123Z";
  const first = updateSkipEventId("fix", 2, "w5:p9", time);
  const otherPane = updateSkipEventId("fix", 2, "w5:p4W", time);
  const later = updateSkipEventId(
    "fix",
    2,
    "w5:p9",
    "2026-11-07T04:12:30.456Z",
  );
  for (const id of [first, otherPane, later]) assert.match(id, EVENT_ID);
  assert.equal(new Set([first, otherPane, later]).size, 3);
});

test("update-skip event id stays within the length limit", () => {
  const id = updateSkipEventId(
    "review",
    12,
    "w".repeat(80),
    "2026-11-07T04:10:00.123Z",
  );
  assert.match(id, EVENT_ID);
});
