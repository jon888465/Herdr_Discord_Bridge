// 看板按 o 連線時，Herdr 要求重啟遠端 server 要先確認（ISSUE-177）：控制通道、看板按鍵與進度訊息。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeControlResult,
  parseControlRequest,
  sendMachineControl,
  startMachineControlServer,
  type MachineControlCommand,
  type MachineControlHub,
} from "../src/machine-control-channel.js";
import {
  machineControlKey,
  machineControlResult,
  remoteRestartMessage,
  REMOTE_RESTART_CONFIRM,
  REMOTE_RESTART_SHOW_MS,
} from "../src/card-board-machines.js";

const TOKEN = "t".repeat(64);
const line = (extra: object): string => JSON.stringify({ version: 1, token: TOKEN, action: "connect", machineId: "m1", ...extra });

test("parseControlRequest：restartRemote 只接受 connect 搭配布林值，其他一律拒絕", () => {
  assert.deepEqual(parseControlRequest(line({ restartRemote: true }), TOKEN), { action: "connect", machineId: "m1", restartRemote: true });
  assert.deepEqual(parseControlRequest(line({}), TOKEN), { action: "connect", machineId: "m1" });
  assert.deepEqual(parseControlRequest(line({ restartRemote: false }), TOKEN), { action: "connect", machineId: "m1" });
  assert.equal(parseControlRequest(line({ action: "disconnect", restartRemote: true }), TOKEN), undefined);
  assert.equal(parseControlRequest(line({ action: "restart", machineId: "", restartRemote: true }), TOKEN), undefined);
  assert.equal(parseControlRequest(line({ restartRemote: "yes" }), TOKEN), undefined);
  assert.equal(parseControlRequest(line({ restartRemote: 1 }), TOKEN), undefined);
});

test("normalizeControlResult：只保留結構化的 needsRemoteRestart:true", () => {
  const base = { ok: true, status: "connected" };
  assert.deepEqual(normalizeControlResult({ ...base, needsRemoteRestart: true }), { ok: true, status: "connected", needsRemoteRestart: true });
  assert.deepEqual(normalizeControlResult({ ...base, needsRemoteRestart: false }), { ok: true, status: "connected" });
  assert.deepEqual(normalizeControlResult({ ...base, needsRemoteRestart: "true" }), { ok: true, status: "connected" });
  // 失敗結果不帶這個欄位
  assert.deepEqual(normalizeControlResult({ ok: false, reason: "x", needsRemoteRestart: true }), { ok: false, reason: "x" });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mc-"));
  return { dir, socketPath: path.join(dir, "run", "mc.sock"), tokenFile: path.join(dir, "state", "token"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const hub: MachineControlHub = {
  connectMachine: () => ({ ok: true, status: "connected" }),
  disconnectMachine: () => ({ ok: true, status: "disconnected" }),
};

test("控制通道：afterControl 回結構化結果時，needsRemoteRestart 與說明一起回給看板；restartRemote 會傳到 afterControl", async () => {
  const env = setup();
  const seen: MachineControlCommand[] = [];
  const stop = await startMachineControlServer(hub, {
    ...env,
    afterControl: async (command) => {
      seen.push(command);
      return command.restartRemote ? { herdr: "已開始重啟" } : { herdr: "舊埠", needsRemoteRestart: true };
    },
  });
  try {
    assert.deepEqual(await sendMachineControl({ action: "connect", machineId: "m1" }, env), { ok: true, status: "connected", herdr: "舊埠", needsRemoteRestart: true });
    assert.deepEqual(await sendMachineControl({ action: "connect", machineId: "m1", restartRemote: true }, env), { ok: true, status: "connected", herdr: "已開始重啟" });
    assert.deepEqual(seen, [{ action: "connect", machineId: "m1" }, { action: "connect", machineId: "m1", restartRemote: true }]);
  } finally {
    stop();
    env.cleanup();
  }
});

test("控制通道：afterControl 回字串時行為與以前相同（只有 herdr 說明）", async () => {
  const env = setup();
  const stop = await startMachineControlServer(hub, { ...env, afterControl: async () => "Herdr 側邊欄已啟用" });
  try {
    assert.deepEqual(await sendMachineControl({ action: "connect", machineId: "m1" }, env), { ok: true, status: "connected", herdr: "Herdr 側邊欄已啟用" });
  } finally {
    stop();
    env.cleanup();
  }
});

const idle = { pending: false };

test("看板：結果帶 needsRemoteRestart 時要求確認，文字寫清楚會中斷什麼", () => {
  const out = machineControlResult("m1", { ok: true, status: "connected", needsRemoteRestart: true }, 0);
  assert.deepEqual(out.ui, { pending: false, remoteRestartFor: "m1" });
  assert.ok(out.message.includes(REMOTE_RESTART_CONFIRM));
  assert.match(REMOTE_RESTART_CONFIRM, /中斷/);
  assert.match(REMOTE_RESTART_CONFIRM, /bridge/);
  assert.match(REMOTE_RESTART_CONFIRM, /再按一次 o/);
  // 一般連線結果不要求確認
  assert.deepEqual(machineControlResult("m1", { ok: true, status: "connected" }, 0).ui, { pending: false });
});

test("看板：確認前的 o 不帶 restartRemote；確認後緊接著對同一台再按 o 才帶", () => {
  const first = machineControlKey(idle, "o", "machines", "m1");
  assert.deepEqual(first.outcome, { kind: "send", command: { action: "connect", machineId: "m1" }, message: "處理中…" });
  const awaiting = machineControlResult("m1", { ok: true, status: "connected", needsRemoteRestart: true }, 0).ui;
  const second = machineControlKey(awaiting, "o", "machines", "m1");
  assert.deepEqual(second.outcome, { kind: "send", command: { action: "connect", machineId: "m1", restartRemote: true }, message: "處理中…" });
});

test("看板：換一台、按別的鍵、或在 Card 檢視，都取消確認，不會重啟", () => {
  const awaiting = machineControlResult("m1", { ok: true, status: "connected", needsRemoteRestart: true }, 0).ui;
  const other = machineControlKey(awaiting, "o", "machines", "m2");
  assert.deepEqual((other.outcome as { command: MachineControlCommand }).command, { action: "connect", machineId: "m2" });
  const disconnect = machineControlKey(awaiting, "x", "machines", "m1");
  assert.deepEqual((disconnect.outcome as { command: MachineControlCommand }).command, { action: "disconnect", machineId: "m1" });
  const move = machineControlKey(awaiting, "j", "machines", "m1");
  assert.deepEqual(move.outcome, { kind: "pass" });
  assert.deepEqual(move.ui, { pending: false });
  assert.deepEqual(machineControlKey(awaiting, "o", "cards", "m1").outcome, { kind: "pass" });
  // 取消後再按 o 不會直接重啟
  const after = machineControlKey(move.ui, "o", "machines", "m1");
  assert.deepEqual((after.outcome as { command: MachineControlCommand }).command, { action: "connect", machineId: "m1" });
});

test("看板：等待回應期間不處理按鍵，不會因為連按 o 重複送出重啟", () => {
  assert.deepEqual(machineControlKey({ pending: true, remoteRestartFor: "m1" }, "o", "machines", "m1").outcome, { kind: "ignore" });
});

test("進度訊息：有變化才顯示一次；結束後超過期限不再顯示；沒有狀態不動", () => {
  const running = { machineId: "m1", state: "running", note: "重啟遠端 Herdr server 中，請稍候", updatedAt: 1000 };
  const first = remoteRestartMessage(running, 2000, "");
  assert.equal(first.message, "m1：重啟遠端 Herdr server 中，請稍候");
  assert.deepEqual(remoteRestartMessage(running, 3000, first.shown), { shown: first.shown });
  const done = { ...running, state: "done", note: "遠端 Herdr server 已重啟，側邊欄已更新", updatedAt: 5000 };
  assert.equal(remoteRestartMessage(done, 6000, first.shown).message, "m1：遠端 Herdr server 已重啟，側邊欄已更新");
  const old = remoteRestartMessage(done, 5000 + REMOTE_RESTART_SHOW_MS + 1, "");
  assert.equal(old.message, undefined);
  assert.deepEqual(remoteRestartMessage(undefined, 1, "abc"), { shown: "abc" });
});
