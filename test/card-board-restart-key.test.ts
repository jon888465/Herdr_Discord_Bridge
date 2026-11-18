import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_RESTART_CONFIRM,
  MACHINE_CONTROL_PENDING,
  bridgeRestartResult,
  machineControlKey,
  type MachineControlUi,
} from "../src/card-board-machines.js";

const idle: MachineControlUi = { pending: false };

test("R 要按兩次：第一次只提示，第二次才送出重啟", () => {
  const first = machineControlKey(idle, "R", "machines", "m1");
  assert.deepEqual(first, {
    ui: { pending: false, restartConfirm: true },
    outcome: { kind: "message", message: BRIDGE_RESTART_CONFIRM },
  });
  const second = machineControlKey(first.ui, "R", "machines", "m1");
  assert.deepEqual(second, {
    ui: { pending: true },
    outcome: {
      kind: "send",
      command: { action: "restart", machineId: "" },
      message: MACHINE_CONTROL_PENDING,
    },
  });
});

test("確認狀態下按其他鍵會取消，要重新按兩次", () => {
  const armed = machineControlKey(idle, "R", "machines", "m1").ui;
  for (const key of ["j", "o", "x", "r", "e"]) {
    const cancelled = machineControlKey(armed, key, "machines", "m1");
    assert.equal(cancelled.ui.restartConfirm, undefined, key);
  }
  const afterMove = machineControlKey(armed, "j", "machines", "m1").ui;
  assert.equal(
    machineControlKey(afterMove, "R", "machines", "m1").outcome.kind,
    "message",
  );
});

test("R 只在 Machine 檢視有作用；沒有選取 machine 也能重啟 bridge", () => {
  assert.equal(
    machineControlKey(idle, "R", "cards", "m1").outcome.kind,
    "pass",
  );
  assert.equal(
    machineControlKey(
      { pending: false, restartConfirm: true },
      "R",
      "machines",
      undefined,
    ).outcome.kind,
    "send",
  );
});

test("處理中按 R 被擋下", () => {
  assert.deepEqual(
    machineControlKey({ pending: true }, "R", "machines", "m1").outcome,
    { kind: "ignore" },
  );
});

test("重啟回應：成功提示重啟中，失敗顯示固定短句並清掉等待", () => {
  assert.deepEqual(
    bridgeRestartResult({
      ok: true,
      status: "connected",
      note: "bridge 重啟中，稍候重新連線",
      restarting: true,
    }),
    { ui: { pending: false }, message: "bridge：bridge 重啟中，稍候重新連線" },
  );
  assert.deepEqual(
    bridgeRestartResult({
      ok: false,
      reason: "有 2 個進行中的 Discord 串流，暫不重啟",
    }),
    {
      ui: { pending: false },
      message: "bridge：有 2 個進行中的 Discord 串流，暫不重啟",
    },
  );
});
