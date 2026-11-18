import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CONTROL_FAILED,
  CONTROL_REJECTED,
  sendMachineControl,
  startMachineControlServer,
  type MachineControlHub,
} from "../src/machine-control-channel.js";

/** macOS 的 unix socket 路徑上限約 104 字元，所以用 /tmp 下的短目錄。 */
function setup() {
  const dir = fs.mkdtempSync("/tmp/mr-");
  return {
    socketPath: path.join(dir, "run", "mc.sock"),
    tokenFile: path.join(dir, "state", "token"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function hubWithCalls() {
  const calls: string[] = [];
  const hub: MachineControlHub = {
    connectMachine: (id) => {
      calls.push(`connect ${id}`);
      return { ok: true, status: "connected" };
    },
    disconnectMachine: (id) => {
      calls.push(`disconnect ${id}`);
      return { ok: true, status: "disconnected" };
    },
  };
  return { hub, calls };
}

test("restart：不需要 machineId、不碰 hub、不走 afterControl", async () => {
  const env = setup();
  const { hub, calls } = hubWithCalls();
  let after = 0;
  let restarts = 0;
  const stop = await startMachineControlServer(hub, {
    ...env,
    restart: () => {
      restarts++;
      return {
        ok: true,
        status: "connected",
        note: "重啟中",
        restarting: true,
      };
    },
    afterControl: async () => {
      after++;
      return "x";
    },
  });
  try {
    const result = await sendMachineControl(
      { action: "restart", machineId: "" },
      env,
    );
    assert.deepEqual(result, {
      ok: true,
      status: "connected",
      note: "重啟中",
      restarting: true,
    });
    assert.equal(restarts, 1);
    assert.equal(after, 0);
    assert.deepEqual(calls, []);
  } finally {
    stop();
    env.cleanup();
  }
});

test("沒給 restart 或 restart 丟例外，都只回操作失敗", async () => {
  for (const restart of [
    undefined,
    () => {
      throw new Error("boom");
    },
  ]) {
    const env = setup();
    const { hub } = hubWithCalls();
    const stop = await startMachineControlServer(hub, {
      ...env,
      ...(restart ? { restart } : {}),
    });
    try {
      assert.deepEqual(
        await sendMachineControl({ action: "restart", machineId: "" }, env),
        { ok: false, reason: CONTROL_FAILED },
      );
    } finally {
      stop();
      env.cleanup();
    }
  }
});

test("connect／disconnect 仍要 machineId", async () => {
  const env = setup();
  const { hub, calls } = hubWithCalls();
  const stop = await startMachineControlServer(hub, env);
  try {
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "" }, env),
      { ok: false, reason: CONTROL_REJECTED },
    );
    assert.deepEqual(calls, []);
  } finally {
    stop();
    env.cleanup();
  }
});
