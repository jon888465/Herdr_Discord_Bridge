// ISSUE-177 階段 2：背景重啟工作在重啟前偵測遠端 bridge，換埠成功後重開。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRemoteRestart, setRemoteRestartPending, startRemoteRestart } from "../src/machine-remote-restart.js";

const machine = { id: "devbox", ssh: "devbox", port: 50123, socket: "/s" };
const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "restart-bridge-")), "state.json");
const quiet = (): void => {};
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const okOutcome = { note: "Herdr 側邊欄已更新到埠 50123" };
const failOutcome = { note: "Herdr 側邊欄的埠沒有更新成功，保留原設定" };

type Deps = Parameters<typeof startRemoteRestart>[1];

async function runJob(deps: Partial<Deps> & { reconcile: Deps["reconcile"] }) {
  const file = tmp();
  setRemoteRestartPending(file, "devbox", true);
  assert.deepEqual(startRemoteRestart(machine, { file, log: quiet, ...deps }), { started: true });
  for (let i = 0; i < 8; i++) await tick();
  return loadRemoteRestart(file);
}

test("遠端有 bridge：重啟前偵測、換埠成功後重開，狀態 done，說明帶重開結果", async () => {
  const order: string[] = [];
  const state = await runJob({
    detectBridge: async () => (order.push("detect"), true),
    reconcile: async () => (order.push("reconcile"), okOutcome),
    reopenBridge: async () => (order.push("reopen"), { ok: true, note: "已重開遠端 bridge" }),
  });
  assert.deepEqual(order, ["detect", "reconcile", "reopen"]);
  assert.equal(state.status?.state, "done");
  assert.equal(state.status?.note, "遠端 Herdr server 已重啟，側邊欄已更新；已重開遠端 bridge");
  assert.deepEqual(state.pending, []);
});

test("重開失敗：埠已換成功所以清掉 pending，但狀態是 failed，說明請使用者自行重開", async () => {
  const state = await runJob({
    detectBridge: async () => true,
    reconcile: async () => okOutcome,
    reopenBridge: async () => ({ ok: false, note: "重開遠端 bridge 失敗，請自行重開" }),
  });
  assert.equal(state.status?.state, "failed");
  assert.match(state.status?.note ?? "", /側邊欄已更新；重開遠端 bridge 失敗，請自行重開/);
  assert.deepEqual(state.pending, []);
});

test("重開丟錯：同樣是 failed 並請使用者自行重開，不會讓工作卡住", async () => {
  const state = await runJob({
    detectBridge: async () => true,
    reconcile: async () => okOutcome,
    reopenBridge: async () => Promise.reject(new Error("boom")),
  });
  assert.equal(state.status?.state, "failed");
  assert.match(state.status?.note ?? "", /自行重開/);
});

test("遠端沒有 bridge：不重開，說明寫明沒有偵測到", async () => {
  let reopened = 0;
  const state = await runJob({
    detectBridge: async () => false,
    reconcile: async () => okOutcome,
    reopenBridge: async () => (reopened++, { ok: true, note: "x" }),
  });
  assert.equal(reopened, 0);
  assert.equal(state.status?.note, "遠端 Herdr server 已重啟，側邊欄已更新（沒有偵測到遠端 bridge）");
});

test("偵測丟錯：當成沒有 bridge，重啟照常進行", async () => {
  let reopened = 0;
  const state = await runJob({
    detectBridge: async () => Promise.reject(new Error("tunnel down")),
    reconcile: async () => okOutcome,
    reopenBridge: async () => (reopened++, { ok: true, note: "x" }),
  });
  assert.equal(reopened, 0);
  assert.equal(state.status?.state, "done");
});

test("換埠沒成功：不重開 bridge，保留 pending，說明提醒遠端 bridge 若停了要自行重開", async () => {
  let reopened = 0;
  const state = await runJob({
    detectBridge: async () => true,
    reconcile: async () => failOutcome,
    reopenBridge: async () => (reopened++, { ok: true, note: "x" }),
  });
  assert.equal(reopened, 0);
  assert.equal(state.status?.state, "failed");
  assert.match(state.status?.note ?? "", /若遠端 bridge 停了請自行重開/);
  assert.deepEqual(state.pending, ["devbox"]);
});

test("沒有提供偵測與重開（階段 1 的呼叫方式）：行為與以前完全相同", async () => {
  const state = await runJob({ reconcile: async () => okOutcome });
  assert.equal(state.status?.note, "遠端 Herdr server 已重啟，側邊欄已更新");
});
