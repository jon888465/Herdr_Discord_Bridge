import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "node:net";
import {
  machineControlRequest,
  startMachineControlServer,
} from "../src/machine-control-ipc.js";

function raw(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("connect", () => socket.write(line + "\n"));
  });
}

test("machine control authenticates and validates before calling hub; files are private", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mi-"));
  const socketPath = path.join(dir, "m.sock"),
    tokenFile = path.join(dir, "token");
  const calls: unknown[] = [];
  const stop = await startMachineControlServer(
    {
      connectMachine: (id) => {
        calls.push(["connect", id]);
        return { ok: true, status: "connected" };
      },
      disconnectMachine: (id, options) => {
        calls.push(["disconnect", id, options]);
        return { ok: true, status: "disconnected" };
      },
    },
    socketPath,
    tokenFile,
  );
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    const token = fs.readFileSync(tokenFile, "utf8");
    assert.match(token, /^[a-f0-9]{64}$/);
    const good = { version: 1, token, action: "connect", machineId: "agy" };
    for (const request of [
      "{",
      JSON.stringify({ ...good, token: "x".repeat(64) }),
      JSON.stringify({ ...good, token: undefined }),
      JSON.stringify({ ...good, action: "delete" }),
      JSON.stringify({ ...good, machineId: 42 }),
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, force: "true" }),
    ]) {
      assert.deepEqual(await raw(socketPath, request), {
        ok: false,
        reason: "request rejected",
      });
      assert.equal(calls.length, 0);
    }
    assert.deepEqual(
      await machineControlRequest(
        { action: "connect", machineId: "agy", token },
        socketPath,
      ),
      { ok: true, status: "connected" },
    );
    assert.deepEqual(
      await machineControlRequest(
        { action: "disconnect", machineId: "agy", token, force: true },
        socketPath,
      ),
      { ok: true, status: "disconnected" },
    );
    assert.deepEqual(calls, [
      ["connect", "agy"],
      ["disconnect", "agy", { force: true }],
    ]);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(socketPath), false);
  assert.deepEqual(
    await machineControlRequest(
      { action: "connect", machineId: "agy", token: "unused" },
      socketPath,
    ),
    { ok: false, reason: "bridge 未連線" },
  );
});

test("board reports bridge unavailable when token cannot be read", async () => {
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    assert.deepEqual(
      await machineControlRequest(
        { action: "connect", machineId: "agy" },
        path.join(dir, "m.sock"),
      ),
      { ok: false, reason: "bridge 未連線" },
    );
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("occupied socket degrades safely without replacing the live token; short config path", async () => {
  const { startMachineControlServerSafely, machineControlSocketPath } =
    await import("../src/machine-control-ipc.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-safe-"));
  const socketPath = path.join(dir, "m.sock"),
    tokenFile = path.join(dir, "token");
  fs.chmodSync(dir, 0o755);
  const hub = {
    connectMachine: () => ({ ok: true as const, status: "connected" as const }),
    disconnectMachine: () => ({
      ok: true as const,
      status: "disconnected" as const,
    }),
  };
  const before = process.umask();
  const stop = await startMachineControlServer(hub, socketPath, tokenFile);
  try {
    assert.equal(process.umask(), before);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const token = fs.readFileSync(tokenFile, "utf8");
    const logs: string[] = [];
    const noop = await startMachineControlServerSafely(
      hub,
      socketPath,
      tokenFile,
      (line) => logs.push(line),
    );
    noop();
    assert.deepEqual(logs, ["Machine control channel unavailable"]);
    assert.equal(fs.readFileSync(tokenFile, "utf8"), token);
    assert.equal(fs.existsSync(socketPath), true);
    const oldConfig = process.env.HERDR_PLUGIN_CONFIG_DIR,
      oldState = process.env.HERDR_PLUGIN_STATE_DIR,
      oldSocket = process.env.HERDR_DISCORD_MACHINE_CONTROL_SOCKET;
    try {
      process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
      process.env.HERDR_PLUGIN_STATE_DIR = path.join(
        dir,
        "very-long-state".repeat(20),
      );
      delete process.env.HERDR_DISCORD_MACHINE_CONTROL_SOCKET;
      assert.equal(
        machineControlSocketPath(),
        path.join(dir, "machine-control.sock"),
      );
      process.env.HERDR_DISCORD_MACHINE_CONTROL_SOCKET = socketPath;
      assert.equal(machineControlSocketPath(), socketPath);
    } finally {
      for (const [key, value] of [
        ["HERDR_PLUGIN_CONFIG_DIR", oldConfig],
        ["HERDR_PLUGIN_STATE_DIR", oldState],
        ["HERDR_DISCORD_MACHINE_CONTROL_SOCKET", oldSocket],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
    }
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listen failure cleans its token, preserves existing path and restores umask", async () => {
  const { startMachineControlServerSafely } =
    await import("../src/machine-control-ipc.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-fail-"));
  const socketPath = path.join(dir, "occupied"),
    tokenFile = path.join(dir, "token");
  fs.mkdirSync(socketPath);
  const before = process.umask();
  const logs: string[] = [];
  try {
    const stop = await startMachineControlServerSafely(
      {
        connectMachine: () => {
          throw new Error("unused");
        },
        disconnectMachine: () => {
          throw new Error("unused");
        },
      },
      socketPath,
      tokenFile,
      (line) => logs.push(line),
    );
    stop();
    assert.deepEqual(logs, ["Machine control channel unavailable"]);
    assert.equal(process.umask(), before);
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal(fs.statSync(socketPath).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(dir), ["occupied"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
