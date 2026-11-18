import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  RESTART_BUSY,
  RESTART_IN_PROGRESS,
  RESTART_NO_SCRIPT,
  RESTART_STARTED,
  requestBridgeRestart,
  resetBridgeRestartForTest,
} from "../src/bridge-restart.js";

afterEach(() => resetBridgeRestartForTest());

function projectWithScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/bash\n");
  return dir;
}

function harness(active: number, projectDir: string) {
  const launched: string[] = [];
  const scheduled: Array<() => void> = [];
  return {
    launched,
    scheduled,
    deps: {
      activeStreams: () => active,
      projectDir,
      launch: (script: string) => void launched.push(script),
      schedule: (run: () => void) => void scheduled.push(run),
    },
  };
}

test("有進行中的串流就拒絕，不排程也不啟動", () => {
  const dir = projectWithScript();
  const h = harness(2, dir);
  assert.deepEqual(requestBridgeRestart(h.deps), {
    ok: false,
    reason: RESTART_BUSY(2),
  });
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.launched.length, 0);
});

test("沒有串流：先回覆成功，run.sh 在排程之後才啟動", () => {
  const dir = projectWithScript();
  const h = harness(0, dir);
  assert.deepEqual(requestBridgeRestart(h.deps), {
    ok: true,
    status: "connected",
    note: RESTART_STARTED,
    restarting: true,
  });
  assert.equal(h.launched.length, 0, "回覆前不啟動");
  h.scheduled[0]!();
  assert.deepEqual(h.launched, [path.join(dir, "scripts", "run.sh")]);
});

test("找不到 run.sh 就拒絕", () => {
  const h = harness(0, fs.mkdtempSync(path.join(os.tmpdir(), "restart-")));
  assert.deepEqual(requestBridgeRestart(h.deps), {
    ok: false,
    reason: RESTART_NO_SCRIPT,
  });
  assert.equal(h.scheduled.length, 0);
});

test("重啟中再要求一次被擋下，只排程一次", () => {
  const dir = projectWithScript();
  const h = harness(0, dir);
  assert.equal(requestBridgeRestart(h.deps).ok, true);
  assert.deepEqual(requestBridgeRestart(h.deps), {
    ok: false,
    reason: RESTART_IN_PROGRESS,
  });
  assert.equal(h.scheduled.length, 1);
});

test("啟動丟錯不影響進程，並允許再試", () => {
  const dir = projectWithScript();
  const h = harness(0, dir);
  h.deps.launch = () => {
    throw new Error("spawn failed");
  };
  assert.equal(requestBridgeRestart(h.deps).ok, true);
  assert.doesNotThrow(() => h.scheduled[0]!());
  assert.equal(requestBridgeRestart(h.deps).ok, true);
});
