// 遠端 server 重啟的狀態檔與背景工作（ISSUE-177）。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRemoteRestart,
  portReconcileSucceeded,
  saveRemoteRestart,
  setRemoteRestartPending,
  setRemoteRestartStatus,
  startRemoteRestart,
} from "../src/machine-remote-restart.js";

const machine = { id: "devbox", ssh: "devbox", port: 50123, socket: "/s" };
const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "restart-state-")), "state.json");
const quiet = (): void => {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** 背景工作現在先 await 偵測才呼叫 reconcile（階段 2），所以要多等幾輪才看得到結果。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await tick();
};

test("狀態檔往返、權限 0600；壞掉或版本不認得都當成沒有", () => {
  const file = tmp();
  assert.deepEqual(loadRemoteRestart(file), { pending: [] });
  assert.equal(saveRemoteRestart(file, { pending: ["b", "a", "a"], status: { machineId: "a", state: "running", note: "x", updatedAt: 1 } }), true);
  assert.deepEqual(loadRemoteRestart(file), { pending: ["a", "b"], status: { machineId: "a", state: "running", note: "x", updatedAt: 1 } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadRemoteRestart(file), { pending: [] });
  fs.writeFileSync(file, JSON.stringify({ version: 2, pending: ["a"] }));
  assert.deepEqual(loadRemoteRestart(file), { pending: [] });
  fs.writeFileSync(file, JSON.stringify({ version: 1, pending: ["a", 5, "gone"], status: { machineId: "a", state: "bogus", note: "x", updatedAt: 1 } }));
  assert.deepEqual(loadRemoteRestart(file, ["a"]), { pending: ["a"] });
});

test("setRemoteRestartPending 加入與移除，不動 status；重複設定不重寫", () => {
  const file = tmp();
  setRemoteRestartStatus(file, { machineId: "devbox", state: "done", note: "ok", updatedAt: 5 });
  setRemoteRestartPending(file, "devbox", true);
  setRemoteRestartPending(file, "devbox", true);
  assert.deepEqual(loadRemoteRestart(file).pending, ["devbox"]);
  assert.equal(loadRemoteRestart(file).status?.state, "done");
  setRemoteRestartPending(file, "devbox", false);
  assert.deepEqual(loadRemoteRestart(file).pending, []);
  assert.equal(loadRemoteRestart(file).status?.note, "ok");
});

test("portReconcileSucceeded 只認側邊欄真的換到新埠", () => {
  assert.equal(portReconcileSucceeded({ note: "Herdr 側邊欄已更新到埠 1" }), true);
  assert.equal(portReconcileSucceeded({ note: "Herdr 側邊欄已換到新埠，但改名或停用沒成功（目前標籤 x）" }), true);
  assert.equal(portReconcileSucceeded({ note: "Herdr 側邊欄的埠沒有更新成功，保留原設定", needsRemoteRestart: true }), false);
  assert.equal(portReconcileSucceeded({}), false);
});

test("沒有被標成需要重啟的 machine，確認也不會重啟（不能用來重啟任意遠端）", () => {
  const file = tmp();
  let called = 0;
  const result = startRemoteRestart(machine, { file, reconcile: async () => (called++, {}), log: quiet });
  assert.deepEqual(result, { started: false, reason: "這台目前沒有需要重啟遠端 server" });
  assert.equal(called, 0);
  assert.equal(loadRemoteRestart(file).status, undefined);
  assert.deepEqual(startRemoteRestart(undefined, { file, reconcile: async () => ({}), log: quiet }), { started: false, reason: "沒有這台 machine" });
});

test("確認後立刻回傳 started，狀態是 running；成功後清掉 pending、狀態變 done", async () => {
  const file = tmp();
  setRemoteRestartPending(file, "devbox", true);
  const gate = deferred<{ note: string }>();
  const seen: unknown[] = [];
  const result = startRemoteRestart(machine, { file, reconcile: (m) => (seen.push(m), gate.promise), now: () => 42, log: quiet });
  assert.deepEqual(result, { started: true });
  assert.deepEqual(loadRemoteRestart(file).status, { machineId: "devbox", state: "running", note: "重啟遠端 Herdr server 中，請稍候", updatedAt: 42 });
  assert.deepEqual(loadRemoteRestart(file).pending, ["devbox"]);
  await settle();
  gate.resolve({ note: "Herdr 側邊欄已更新到埠 50123" });
  await settle();
  assert.equal(loadRemoteRestart(file).status?.state, "done");
  assert.deepEqual(loadRemoteRestart(file).pending, []);
  assert.deepEqual(seen, [machine]);
});

test("同一台重啟進行中，再確認一次會被拒絕，不會跑第二個", async () => {
  const file = tmp();
  setRemoteRestartPending(file, "devbox", true);
  const gate = deferred<{ note: string }>();
  let calls = 0;
  const deps = { file, reconcile: () => (calls++, gate.promise), log: quiet };
  assert.deepEqual(startRemoteRestart(machine, deps), { started: true });
  assert.deepEqual(startRemoteRestart(machine, deps), { started: false, reason: "已在重啟中" });
  await settle();
  assert.equal(calls, 1);
  gate.resolve({ note: "Herdr 側邊欄已更新到埠 1" });
  await settle();
});

test("失敗（沒換到、或丟錯）：狀態 failed，pending 保留，之後可以再確認", async () => {
  for (const reconcile of [async () => ({ note: "Herdr 側邊欄的埠沒有更新成功，保留原設定" }), async () => Promise.reject(new Error("boom"))]) {
    const file = tmp();
    setRemoteRestartPending(file, "devbox", true);
    assert.deepEqual(startRemoteRestart(machine, { file, reconcile, log: quiet }), { started: true });
    await settle();
    assert.equal(loadRemoteRestart(file).status?.state, "failed");
    assert.deepEqual(loadRemoteRestart(file).pending, ["devbox"]);
    assert.deepEqual(startRemoteRestart(machine, { file, reconcile: async () => ({ note: "Herdr 側邊欄已更新到埠 1" }), log: quiet }), { started: true });
    await settle();
  }
});
