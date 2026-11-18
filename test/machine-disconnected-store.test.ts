import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDisconnectedMachines, saveDisconnectedMachines } from "../src/machine-disconnected-store.js";
import { HerdrHub } from "../src/machines.js";

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state", "machine-disconnected.json");
}

test("存檔再讀回：去重排序、只留 config 還有的 id、權限 0600", (t) => {
  const file = tempFile(t);
  assert.equal(saveDisconnectedMachines(file, ["b", "a", "a", "gone"]), true);
  assert.deepEqual(loadDisconnectedMachines(file, ["a", "b", "c"]), ["a", "b"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["machine-disconnected.json"], "沒有留下暫存檔");
});

test("檔案不存在、壞掉、版本或欄位不對都當成沒有，不丟錯", (t) => {
  const file = tempFile(t);
  assert.deepEqual(loadDisconnectedMachines(file, ["a"]), []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cases: Array<[string, string[]]> = [
    ["not json", []],
    ["null", []],
    ["[]", []],
    ['{"version":2,"disconnected":["a"]}', []],
    ['{"version":1}', []],
    ['{"version":1,"disconnected":"a"}', []],
    ['{"version":1,"disconnected":[1,null,"a"]}', ["a"]],
  ];
  for (const [text, expected] of cases) {
    fs.writeFileSync(file, text);
    assert.deepEqual(loadDisconnectedMachines(file, ["a"]), expected, text);
  }
});

test("寫不進去回傳 false，不丟錯", (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(file); // 目標是目錄，rename 會失敗
  assert.equal(saveDisconnectedMachines(file, ["a"]), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["machine-disconnected.json"], "失敗後也清掉暫存檔");
});

const machines = [
  { id: "m1", ssh: "herdr-test-unconfigured", socket: "/s1" },
  { id: "m2", ssh: "herdr-test-unconfigured", socket: "/s2" },
];
function hub(started: string[]) {
  const h = new HerdrHub(machines, undefined, 100, 100, () => {}, (id) => `/tmp/none-${id}.sock`, undefined, () => {});
  for (const id of ["m1", "m2"]) {
    const remote = (h as unknown as { remotes: Map<string, { tunnel: { start(): void; stop(): void }; hookTunnel?: unknown }> }).remotes.get(id)!;
    remote.tunnel.start = () => void started.push(id);
    remote.tunnel.stop = () => {};
  }
  return h;
}

test("restoreDisconnected：重啟後不啟動該 machine 的 tunnel，標為已斷線，按連線才啟動", () => {
  const started: string[] = [];
  const h = hub(started);
  h.restoreDisconnected(["m2", "unknown"]);
  h.startTunnels();
  assert.deepEqual(started, ["m1"]);
  assert.equal(h.isDisconnected("m2"), true);
  assert.equal(h.isDisconnected("m1"), false);
  assert.deepEqual(h.machineObservations().find((m) => m.id === "m2")?.disconnected, true);
  assert.deepEqual(h.connectMachine("m2"), { ok: true, status: "connected" });
  assert.deepEqual(started, ["m1", "m2"]);
  assert.equal(h.isDisconnected("m2"), false);
});

test("連線／斷線時把目前的手動斷線清單交給 persist（含強制斷線與已是斷線）", () => {
  const h = hub([]);
  const saved: string[][] = [];
  h.setDisconnectedPersistence((ids) => void saved.push(ids));
  assert.equal(h.disconnectMachine("m1").ok, true);
  assert.equal(h.disconnectMachine("m2").ok, true);
  assert.equal(h.connectMachine("m1").ok, true);
  assert.deepEqual(saved, [["m1"], ["m1", "m2"], ["m2"]]);
  // 未知 machine 與失敗的操作不動檔案
  h.disconnectMachine("nope");
  assert.equal(saved.length, 3);
});

test("persist 丟錯不影響連線／斷線的結果", () => {
  const h = hub([]);
  h.setDisconnectedPersistence(() => {
    throw new Error("disk full");
  });
  assert.deepEqual(h.disconnectMachine("m1"), { ok: true, status: "disconnected" });
  assert.equal(h.isDisconnected("m1"), true);
});
