import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readMachineStatus,
  serializeMachineStatus,
  startMachineStatusWriter,
  writeMachineStatus,
  MACHINE_STATUS_MAX_AGE_MS,
} from "../src/machine-status-file.js";

const now = new Date("2026-11-16T00:00:00.000Z");
function fixture(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "machine-status.json");
}

test("serialize and write project only id/status without config secrets", (t) => {
  const file = fixture(t);
  const entries = [
    {
      id: "remote",
      reachable: true,
      ssh: "SECRET-TOKEN-xyz",
      socket: "SECRET-TOKEN-xyz",
      hookSocket: "SECRET-TOKEN-xyz",
      cardReview: { root: "SECRET-TOKEN-xyz", kinds: ["agy"] },
      token: "SECRET-TOKEN-xyz",
    },
    { id: "down", reachable: false },
  ];
  const parsed = JSON.parse(serializeMachineStatus(entries, now));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.updatedAt, now.toISOString());
  for (const entry of parsed.machines)
    assert.deepEqual(Object.keys(entry), ["id", "status"]);
  writeMachineStatus(file, entries, now);
  const text = fs.readFileSync(file, "utf8");
  for (const secret of [
    "ssh",
    "socket",
    "hookSocket",
    "cardReview",
    "SECRET-TOKEN",
    "token",
  ])
    assert.ok(!text.includes(secret));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["machine-status.json"]);
  assert.deepEqual(
    [...readMachineStatus(file, now, 15000)],
    [
      ["remote", "connected"],
      ["down", "unreachable"],
    ],
  );
});

for (const [label, content] of Object.entries({
  badJson: "{",
  null: "null",
  array: "[]",
  scalar: "42",
  version: JSON.stringify({
    version: 2,
    updatedAt: now.toISOString(),
    machines: [],
  }),
  invalidTime: JSON.stringify({
    version: 1,
    updatedAt: "invalid",
    machines: [],
  }),
  old: serializeMachineStatus(
    [{ id: "r", reachable: true }],
    new Date(now.getTime() - 15001),
  ),
  future: serializeMachineStatus(
    [{ id: "r", reachable: true }],
    new Date(now.getTime() + 15001),
  ),
})) {
  test(`readMachineStatus rejects ${label}`, (t) => {
    const file = fixture(t);
    fs.writeFileSync(file, content);
    assert.equal(
      readMachineStatus(file, now, MACHINE_STATUS_MAX_AGE_MS).size,
      0,
    );
  });
}

test("readMachineStatus missing/unreadable files and invalid entries", (t) => {
  const file = fixture(t);
  assert.equal(readMachineStatus(file, now, 15000).size, 0);
  assert.equal(readMachineStatus(path.dirname(file), now, 15000).size, 0);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: now.toISOString(),
      machines: [
        null,
        { id: 1, status: "connected" },
        { id: "bad", status: "other" },
        { id: "good", status: "connected" },
      ],
    }),
  );
  assert.deepEqual(
    [...readMachineStatus(file, now, 15000)],
    [["good", "connected"]],
  );
});

test("writer periodically snapshots fake hub and stops", (t) => {
  const file = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const stop = startMachineStatusWriter(
    {
      usageMachineStatus: () => {
        calls++;
        return [];
      },
    },
    file,
    5000,
    () => now,
  );
  t.after(stop);
  assert.equal(calls, 1);
  t.mock.timers.tick(5000);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    updatedAt: now.toISOString(),
    machines: [],
  });
  stop();
  fs.unlinkSync(file);
  t.mock.timers.tick(15000);
  assert.equal(calls, 2);
  assert.ok(!fs.existsSync(file));
});

test("writer logs only a fixed message and survives write failures", (t) => {
  const file = fixture(t);
  fs.mkdirSync(file);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const messages: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  const stop = startMachineStatusWriter(
    { usageMachineStatus: () => [] },
    file,
    5000,
    () => now,
  );
  t.after(stop);
  t.mock.timers.tick(5000);
  assert.deepEqual(messages, [
    ["Machine status write failed"],
    ["Machine status write failed"],
  ]);
});
