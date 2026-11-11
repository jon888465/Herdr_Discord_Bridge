import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HerdrClient } from "../src/herdr.js";
import { HerdrAdapter } from "../src/runtime/herdr-adapter.js";
import { CoreAdapter } from "../src/runtime/core-adapter.js";
import { RuntimeError, assertCapability } from "../src/runtime/errors.js";
import {
  HERDR_OPERATIONS,
  RuntimeCapability,
  type HerdrOperation,
} from "../src/runtime/types.js";

test("Herdr adapter 宣告全部能力且不改 wire method 或重試參數", async () => {
  const calls: unknown[] = [];
  class FakeClient extends HerdrClient {
    override async request<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: { retries?: number; timeoutMs?: number },
    ): Promise<T> {
      calls.push({ method, params, options });
      return {} as T;
    }
  }
  const adapter = new HerdrAdapter(new FakeClient());
  for (const capability of Object.values(RuntimeCapability))
    assert.doesNotThrow(() => assertCapability(adapter, capability, "test"));
  const params = { pane_id: "w1:p1" };
  const options = { retries: 0, timeoutMs: 1234 };
  await adapter.herdrOperation("pane.get", params, options);
  assert.deepEqual(calls, [{ method: "pane.get", params, options }]);
});

test("Core 逐項拒絕所有 Herdr 專屬操作並包含操作名", async () => {
  const adapter = new CoreAdapter("/tmp/not-connected.sock");
  assert.equal(adapter.capabilities.has(RuntimeCapability.Workspace), false);
  for (const operation of Object.keys(HERDR_OPERATIONS) as HerdrOperation[]) {
    await assert.rejects(
      adapter.herdrOperation(operation),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "RUNTIME_UNSUPPORTED_OPERATION" &&
        error.message.includes(operation),
    );
  }
});

test("Core 入口在舊 Herdr 連線與狀態寫入前明確失敗", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-entry-"));
  try {
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({ runtime: "core" }),
    );
    const result = spawnSync(
      process.execPath,
      ["dist/src/index.js", "--dry-run"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HERDR_BRIDGE_RUNTIME: "core",
          HC_SOCKET: path.join(directory, "core.sock"),
          HERDR_SOCKET_PATH: path.join(directory, "legacy.sock"),
          HERDR_PLUGIN_CONFIG_DIR: directory,
          HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /bridge runtime=core socket=/);
    assert.match(result.stderr, /無法連線所選 Core runtime/);
    assert.equal(fs.existsSync(path.join(directory, "state")), false);
    assert.doesNotMatch(result.stderr, /legacy.sock|ECONNREFUSED|ENOENT/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
