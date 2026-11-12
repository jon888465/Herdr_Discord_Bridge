import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeCoreServer } from "./helpers/fake-core-server.js";

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

test("Core 入口 health 後仍在 Discord routing 前停止且不碰 Herdr", async () => {
  const fake = await fakeCoreServer();
  const directory = path.dirname(fake.socketPath);
  fs.writeFileSync(path.join(directory, "config.json"), "{}");
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["dist/src/index.js", "--dry-run"],
      {
        env: {
          ...process.env,
          HERDR_BRIDGE_RUNTIME: "core",
          HC_SOCKET: fake.socketPath,
          HERDR_SOCKET_PATH: path.join(directory, "legacy.sock"),
          HERDR_PLUGIN_CONFIG_DIR: directory,
          HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
        },
      },
    );
    assert.match(result.stdout, /generation=1 terminals=0 allowed=0/);
    assert.doesNotMatch(result.stderr, /legacy.sock/);
    assert.equal(fs.existsSync(path.join(directory, "state")), false);
    assert.deepEqual(
      fake.calls.map((call) => call.method),
      ["hello", "server.status", "terminal.list"],
    );
  } finally {
    await fake.close();
  }
});
