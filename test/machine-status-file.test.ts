import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  freshObservations,
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
      observedAt: now.getTime(),
      ssh: "SECRET-TOKEN-xyz",
      socket: "SECRET-TOKEN-xyz",
      hookSocket: "SECRET-TOKEN-xyz",
      cardReview: { root: "SECRET-TOKEN-xyz", kinds: ["agy"] },
      token: "SECRET-TOKEN-xyz",
    },
    { id: "down", reachable: false, observedAt: now.getTime() },
  ];
  const parsed = JSON.parse(serializeMachineStatus(entries, now));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.updatedAt, now.toISOString());
  for (const entry of parsed.machines)
    assert.deepEqual(Object.keys(entry), ["id", "status", "observedAt"]);
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
    [{ id: "r", reachable: true, observedAt: now.getTime() }],
    new Date(now.getTime() - 15001),
  ),
  future: serializeMachineStatus(
    [{ id: "r", reachable: true, observedAt: now.getTime() }],
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
        { id: 1, status: "connected", observedAt: now.toISOString() },
        { id: "bad", status: "other", observedAt: now.toISOString() },
        { id: "noTime", status: "connected" },
        { id: "badTime", status: "connected", observedAt: "invalid" },
        {
          id: "stale",
          status: "connected",
          observedAt: new Date(now.getTime() - 15001).toISOString(),
        },
        {
          id: "good",
          status: "connected",
          observedAt: now.toISOString(),
        },
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
      machineObservations: () => {
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

test("freshObservations drops never-observed and stale machines (F1)", () => {
  const nowMs = now.getTime();
  const max = MACHINE_STATUS_MAX_AGE_MS;
  const result = freshObservations(
    [
      { id: "fresh", reachable: true, observedAt: nowMs - 1000 },
      { id: "edge", reachable: false, observedAt: nowMs - max },
      { id: "stale", reachable: true, observedAt: nowMs - max - 1 },
      { id: "never", reachable: true },
      { id: "future", reachable: true, observedAt: nowMs + max + 1 },
    ],
    nowMs,
    max,
  );
  assert.deepEqual(result, [
    { id: "fresh", reachable: true, observedAt: nowMs - 1000 },
    { id: "edge", reachable: false, observedAt: nowMs - max },
  ]);
});

test("a status is accepted for at most 15s after its own observation, even while the writer keeps writing (F2)", (t) => {
  const file = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const observedAt = now.getTime();
  let current = new Date(observedAt + 10000);
  const stop = startMachineStatusWriter(
    {
      // t=0 觀測一次之後沒有新觀測。
      machineObservations: () => [
        { id: "remote", reachable: true, observedAt },
      ],
    },
    file,
    5000,
    () => current,
  );
  t.after(stop);
  // t=10 秒寫入：觀測還在 15 秒內，寫進檔案，updatedAt 是 t=10。
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.updatedAt, current.toISOString());
  assert.equal(
    written.machines[0].observedAt,
    new Date(observedAt).toISOString(),
  );
  // 之後 writer 停了（或一直寫不進去）。t=16 秒：檔案的 updatedAt 才 6 秒前，
  // 但這筆觀測已經 16 秒前，不能再接受。
  stop();
  assert.deepEqual(
    [...readMachineStatus(file, new Date(observedAt + 14000), 15000)],
    [["remote", "connected"]],
  );
  assert.deepEqual(
    [...readMachineStatus(file, new Date(observedAt + 16000), 15000)],
    [],
  );
});

test("writer does not keep a stale connected alive by rewriting the timestamp (F1)", (t) => {
  const file = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const observedAt = now.getTime();
  let current = now;
  const stop = startMachineStatusWriter(
    {
      // 觀測時間固定在 observedAt：之後沒有人再探測這台機器。
      machineObservations: () => [
        { id: "remote", reachable: true, observedAt },
      ],
    },
    file,
    5000,
    () => current,
  );
  t.after(stop);
  // 剛觀測完：寫入 connected，看板讀得到。
  assert.deepEqual(
    [...readMachineStatus(file, current, 15000)],
    [["remote", "connected"]],
  );
  // 超過 15 秒都沒有新觀測：每 5 秒的重寫不能再把它當成最新。
  current = new Date(observedAt + 20000);
  t.mock.timers.tick(5000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).machines, []);
  assert.deepEqual([...readMachineStatus(file, current, 15000)], []);
});

test("writer logs only a fixed message and survives write failures", (t) => {
  const file = fixture(t);
  fs.mkdirSync(file);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const messages: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  const stop = startMachineStatusWriter(
    { machineObservations: () => [] },
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

test("disconnected persists past observation TTL, but still requires a live writer", (t) => {
  const file = fixture(t);
  const entries = freshObservations(
    [
      {
        id: "remote",
        reachable: false,
        disconnected: true,
        observedAt: now.getTime() - 60000,
      },
    ],
    now.getTime(),
    MACHINE_STATUS_MAX_AGE_MS,
  );
  assert.equal(entries.length, 1);
  writeMachineStatus(file, entries, now);
  assert.equal(
    readMachineStatus(file, now, MACHINE_STATUS_MAX_AGE_MS).get("remote"),
    "disconnected",
  );
  assert.equal(
    readMachineStatus(
      file,
      new Date(now.getTime() + 16000),
      MACHINE_STATUS_MAX_AGE_MS,
    ).size,
    0,
  );
});
