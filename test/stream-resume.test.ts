import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamResumeStore } from "../src/stream-resume.js";

const record = (terminalId: string, startedAt: number) => ({
  terminalId,
  paneId: "w1:p1",
  channelId: "c1",
  progressMessageId: "m1",
  prompt: "hi",
  baselineOutput: "base",
  startedAt,
});

test("StreamResumeStore persists records across instances and removes them (ISSUE-042)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sr-")), "active.json");
  const a = new StreamResumeStore(file);
  a.add(record("t1", Date.now()));
  a.add(record("t2", Date.now()));
  a.remove("t1");
  const b = new StreamResumeStore(file);
  assert.deepEqual(
    b.list().map((r) => r.terminalId),
    ["t2"],
  );
});

test("StreamResumeStore drops records older than 24h and ignores corrupt files", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sr-")), "active.json");
  const store = new StreamResumeStore(file);
  store.add(record("old", Date.now() - 90000000));
  store.add(record("new", Date.now()));
  assert.deepEqual(
    store.list().map((r) => r.terminalId),
    ["new"],
  );
  writeFileSync(file, "{not json");
  assert.deepEqual(new StreamResumeStore(file).list(), []);
});
