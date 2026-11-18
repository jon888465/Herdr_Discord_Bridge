import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearStaleSocket,
  CONTROL_BAD_RESPONSE,
  CONTROL_FAILED,
  CONTROL_NO_RESPONSE,
  CONTROL_REJECTED,
  CONTROL_START_FAILED_LOG,
  CONTROL_TIMEOUT,
  CONTROL_TOO_LARGE,
  CONTROL_UNAVAILABLE,
  sendMachineControl,
  startMachineControlServer,
  startMachineControlServerSafely,
  tokenMatches,
  type MachineControlHub,
} from "../src/machine-control-channel.js";
import type { MachineControlResult } from "../src/machines.js";

/** macOS 的 unix socket 路徑上限約 104 字元，os.tmpdir() 太長，所以用 /tmp 下的短目錄。 */
function shortDir(): string {
  return fs.mkdtempSync(
    path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mc-"),
  );
}

function setup() {
  const dir = shortDir();
  return {
    dir,
    socketPath: path.join(dir, "run", "mc.sock"),
    tokenFile: path.join(dir, "state", "token"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function recordingHub(
  respond: (call: unknown[]) => MachineControlResult = () => ({
    ok: true,
    status: "connected",
  }),
) {
  const calls: unknown[][] = [];
  const hub: MachineControlHub = {
    connectMachine: (id) => {
      calls.push(["connect", id]);
      return respond(calls.at(-1)!);
    },
    disconnectMachine: (id, options) => {
      calls.push(["disconnect", id, options]);
      return respond(calls.at(-1)!);
    },
  };
  return { hub, calls };
}

/** 直接寫 bytes 到 socket，收集整段回應。 */
function raw(
  socketPath: string,
  payload: string | Buffer,
  { endAfterWrite = false } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("close", () => resolve(data));
    socket.on("connect", () => {
      if (payload.length) socket.write(payload);
      if (endAfterWrite) socket.end();
    });
  });
}

test("socket、token 與目錄權限，umask 還原", async () => {
  const env = setup();
  fs.mkdirSync(path.dirname(env.socketPath), { mode: 0o755 });
  fs.chmodSync(path.dirname(env.socketPath), 0o755);
  const before = process.umask(0o022);
  try {
    const { hub } = recordingHub();
    const stop = await startMachineControlServer(hub, env);
    assert.equal(process.umask(0o022), 0o022, "listen 後 umask 還原");
    try {
      assert.ok(fs.lstatSync(env.socketPath).isSocket());
      assert.equal(fs.statSync(env.socketPath).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.dirname(env.socketPath)).mode & 0o777,
        0o700,
      );
      assert.equal(fs.statSync(env.tokenFile).mode & 0o777, 0o600);
      assert.match(fs.readFileSync(env.tokenFile, "utf8"), /^[0-9a-f]{64}$/);
      // 原子寫入不留暫存檔。
      assert.deepEqual(fs.readdirSync(path.dirname(env.tokenFile)), ["token"]);
    } finally {
      stop();
    }
    // shutdown 關閉並刪除 socket（token 也一併移除）。
    assert.equal(fs.existsSync(env.socketPath), false);
    assert.equal(fs.existsSync(env.tokenFile), false);
  } finally {
    process.umask(before);
    env.cleanup();
  }
});

test("每次啟動產生新 token", async () => {
  const env = setup();
  try {
    const { hub } = recordingHub();
    const stop1 = await startMachineControlServer(hub, env);
    const first = fs.readFileSync(env.tokenFile, "utf8");
    stop1();
    const stop2 = await startMachineControlServer(hub, env);
    const second = fs.readFileSync(env.tokenFile, "utf8");
    stop2();
    assert.notEqual(first, second);
  } finally {
    env.cleanup();
  }
});

test("合法請求呼叫 hub；needsForce:true 與 force 原樣保留", async () => {
  const env = setup();
  const { hub, calls } = recordingHub((call) =>
    call[0] === "connect"
      ? { ok: true, status: "connected" }
      : (call[2] as { force?: boolean }).force
        ? { ok: true, status: "disconnected" }
        : { ok: false, reason: "有進行中的工作", needsForce: true },
  );
  const stop = await startMachineControlServer(hub, env);
  try {
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m1" }, env),
      { ok: true, status: "connected" },
    );
    assert.deepEqual(
      await sendMachineControl({ action: "disconnect", machineId: "m1" }, env),
      { ok: false, reason: "有進行中的工作", needsForce: true },
    );
    assert.deepEqual(
      await sendMachineControl(
        { action: "disconnect", machineId: "m1", force: true },
        env,
      ),
      { ok: true, status: "disconnected" },
    );
    assert.deepEqual(calls, [
      ["connect", "m1"],
      ["disconnect", "m1", {}],
      ["disconnect", "m1", { force: true }],
    ]);
  } finally {
    stop();
    env.cleanup();
  }
});

test("格式、版本、token、action、machineId、force 錯誤都被拒絕且不呼叫 hub", async () => {
  const env = setup();
  const { hub, calls } = recordingHub();
  const stop = await startMachineControlServer(hub, env);
  try {
    const token = fs.readFileSync(env.tokenFile, "utf8");
    const good = { version: 1, token, action: "connect", machineId: "m1" };
    const sameLengthWrong = token.replace(/^./, token[0] === "a" ? "b" : "a");
    for (const line of [
      "{",
      "null",
      "[]",
      JSON.stringify({ ...good, token: sameLengthWrong }),
      JSON.stringify({ ...good, token: "short" }),
      JSON.stringify({ ...good, token: token + "0" }),
      JSON.stringify({ ...good, token: undefined }),
      JSON.stringify({ ...good, token: 1 }),
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, version: "1" }),
      JSON.stringify({ ...good, version: undefined }),
      JSON.stringify({ ...good, action: "delete" }),
      JSON.stringify({ ...good, machineId: 42 }),
      JSON.stringify({ ...good, machineId: "" }),
      JSON.stringify({ ...good, force: "true" }),
    ]) {
      const reply = await raw(env.socketPath, line + "\n");
      assert.deepEqual(
        JSON.parse(reply),
        { ok: false, reason: CONTROL_REJECTED },
        line,
      );
      assert.ok(!reply.includes(token) && !reply.includes(env.dir), line);
    }
    assert.equal(calls.length, 0);
  } finally {
    stop();
    env.cleanup();
  }
});

test("tokenMatches：長度不同直接拒絕，相同才比內容", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abd", "abc"), false);
  assert.equal(tokenMatches("ab", "abc"), false);
  assert.equal(tokenMatches("", "abc"), false);
});

test("超大與逾時的請求被拒絕且不呼叫 hub", async () => {
  const env = setup();
  const { hub, calls } = recordingHub();
  const stop = await startMachineControlServer(hub, {
    ...env,
    maxRequestBytes: 128,
    timeoutMs: 150,
  });
  try {
    const big = await raw(env.socketPath, "x".repeat(4096));
    assert.deepEqual(JSON.parse(big), { ok: false, reason: CONTROL_TOO_LARGE });
    const token = fs.readFileSync(env.tokenFile, "utf8");
    // 合法 JSON 但超過大小上限仍拒絕。
    const padded = JSON.stringify({
      version: 1,
      token,
      action: "connect",
      machineId: "m".repeat(200),
    });
    assert.deepEqual(JSON.parse(await raw(env.socketPath, padded + "\n")), {
      ok: false,
      reason: CONTROL_TOO_LARGE,
    });
    const slow = await raw(env.socketPath, '{"version":1');
    assert.deepEqual(JSON.parse(slow), { ok: false, reason: CONTROL_TIMEOUT });
    assert.equal(calls.length, 0);
  } finally {
    stop();
    env.cleanup();
  }
});

test("回覆後對方持續寫入也會在期限內被切斷（review f1）", async () => {
  const env = setup();
  const { hub } = recordingHub();
  const stop = await startMachineControlServer(hub, { ...env, timeoutMs: 120 });
  try {
    const closedAfter = await new Promise<number>((resolve) => {
      const started = Date.now();
      const client = connect(env.socketPath);
      client.on("error", () => {});
      client.on("connect", () => client.write('{"version":1'));
      // 每 30ms 寫一次，讓閒置逾時永遠不會觸發；只有不可重設的銷毀期限能切斷。
      const keep = setInterval(() => client.write("x"), 30);
      client.on("close", () => {
        clearInterval(keep);
        resolve(Date.now() - started);
      });
      setTimeout(() => {
        clearInterval(keep);
        client.destroy();
        resolve(Number.POSITIVE_INFINITY);
      }, 2000);
    });
    assert.ok(closedAfter < 1000, `被切斷花了 ${closedAfter}ms`);
  } finally {
    stop();
    env.cleanup();
  }
});

test("runWithCleanupOnFailure：失敗才清理並保留原例外，成功不清理（review F2）", async () => {
  const { runWithCleanupOnFailure } = await import("../src/machine-control-channel.js");
  let cleaned = 0;
  assert.equal(await runWithCleanupOnFailure(async () => 7, () => cleaned++), 7);
  assert.equal(cleaned, 0);
  await assert.rejects(
    runWithCleanupOnFailure(async () => { throw new Error("boom"); }, () => cleaned++),
    /boom/,
  );
  assert.equal(cleaned, 1);
});

test("hub 丟例外只回固定短句", async () => {
  const env = setup();
  const hub: MachineControlHub = {
    connectMachine: () => {
      throw new Error(`ssh user@secret-host failed at ${env.socketPath}`);
    },
    disconnectMachine: () => ({ ok: true, status: "disconnected" }),
  };
  const stop = await startMachineControlServer(hub, env);
  try {
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m1" }, env),
      { ok: false, reason: CONTROL_FAILED },
    );
  } finally {
    stop();
    env.cleanup();
  }
});

test("既有目錄與普通檔案路徑被保留，listen 失敗", async () => {
  for (const kind of ["directory", "file"] as const) {
    const env = setup();
    fs.mkdirSync(path.dirname(env.socketPath), { recursive: true });
    if (kind === "directory") {
      fs.mkdirSync(env.socketPath);
      fs.writeFileSync(path.join(env.socketPath, "keep"), "keep");
    } else fs.writeFileSync(env.socketPath, "keep");
    const before = process.umask();
    try {
      const { hub, calls } = recordingHub();
      await assert.rejects(startMachineControlServer(hub, env));
      assert.equal(process.umask(), before, `${kind}：失敗後 umask 還原`);
      if (kind === "directory") {
        assert.ok(fs.lstatSync(env.socketPath).isDirectory());
        assert.equal(
          fs.readFileSync(path.join(env.socketPath, "keep"), "utf8"),
          "keep",
        );
      } else
        assert.equal(fs.readFileSync(env.socketPath, "utf8"), "keep", kind);
      assert.equal(fs.existsSync(env.tokenFile), false);
      assert.equal(calls.length, 0);
    } finally {
      env.cleanup();
    }
  }
});

test("舊 socket（沒有程序在聽）被清除後可 listen", async () => {
  const env = setup();
  fs.mkdirSync(path.dirname(env.socketPath), { recursive: true });
  // 子程序 listen 後直接 exit，不會 unlink，留下過期的 socket 檔。
  const run = spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(env.socketPath)}, () => process.exit(0))`,
  ]);
  assert.equal(run.status, 0);
  assert.ok(fs.lstatSync(env.socketPath).isSocket());
  try {
    const { hub } = recordingHub();
    const stop = await startMachineControlServer(hub, env);
    try {
      assert.deepEqual(
        await sendMachineControl({ action: "connect", machineId: "m" }, env),
        { ok: true, status: "connected" },
      );
    } finally {
      stop();
    }
  } finally {
    env.cleanup();
  }
});

test("已有程序在聽時不搶走 socket", async () => {
  const env = setup();
  const { hub } = recordingHub();
  const stop = await startMachineControlServer(hub, env);
  try {
    await assert.rejects(startMachineControlServer(hub, env));
    assert.ok(fs.lstatSync(env.socketPath).isSocket());
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m" }, env),
      { ok: true, status: "connected" },
    );
  } finally {
    stop();
    env.cleanup();
  }
});

test("啟動失敗只記一行固定訊息，回傳可呼叫的停止函式", async () => {
  const env = setup();
  fs.mkdirSync(env.socketPath, { recursive: true });
  try {
    const logs: string[] = [];
    const { hub, calls } = recordingHub();
    const stop = await startMachineControlServerSafely(hub, env, (m) =>
      logs.push(m),
    );
    assert.deepEqual(logs, [CONTROL_START_FAILED_LOG]);
    assert.doesNotThrow(stop);
    assert.equal(calls.length, 0);
    assert.ok(fs.lstatSync(env.socketPath).isDirectory());
  } finally {
    env.cleanup();
  }
});

test("看板端：沒有 token、沒有 bridge、回應格式錯誤都轉成固定短句", async () => {
  const env = setup();
  try {
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m" }, env),
      { ok: false, reason: CONTROL_UNAVAILABLE },
    );
    fs.mkdirSync(path.dirname(env.tokenFile), { recursive: true });
    fs.writeFileSync(env.tokenFile, "t".repeat(64));
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m" }, env),
      { ok: false, reason: CONTROL_UNAVAILABLE },
    );
    fs.mkdirSync(path.dirname(env.socketPath), { recursive: true });
    for (const body of ['{"ok":"yes"}\n', "not json\n", "", '{"ok":true}\n']) {
      // resume：不讀取的話對方關閉後 socket 不會結束，server.close 會一直等。
      const server = createServer((socket) => socket.resume().end(body));
      await new Promise<void>((resolve) =>
        server.listen(env.socketPath, resolve),
      );
      try {
        assert.deepEqual(
          await sendMachineControl({ action: "connect", machineId: "m" }, env),
          { ok: false, reason: CONTROL_BAD_RESPONSE },
          JSON.stringify(body),
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    env.cleanup();
  }
});

test("probe 回 ECONNREFUSED 時，目錄與普通檔案仍保留，只有 socket 被清除", async () => {
  // Linux 對目錄／普通檔案的探測就是 ECONNREFUSED；注入 probe 讓 macOS 也走到同一條路。
  const refused = async () => "refused" as const;
  const env = setup();
  try {
    const dir = path.join(env.dir, "d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep"), "keep");
    await clearStaleSocket(dir, refused);
    assert.equal(fs.readFileSync(path.join(dir, "keep"), "utf8"), "keep");
    const file = path.join(env.dir, "f");
    fs.writeFileSync(file, "keep");
    await clearStaleSocket(file, refused);
    assert.equal(fs.readFileSync(file, "utf8"), "keep");
    await clearStaleSocket(path.join(env.dir, "missing"), refused);
    const sock = path.join(env.dir, "s");
    const run = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`,
    ]);
    assert.equal(run.status, 0);
    await clearStaleSocket(sock, async () => "other");
    assert.ok(fs.lstatSync(sock).isSocket(), "其他錯誤不刪");
    await assert.rejects(clearStaleSocket(sock, async () => "live"));
    assert.ok(fs.lstatSync(sock).isSocket(), "有程序在聽不刪");
    await clearStaleSocket(sock, refused);
    assert.equal(fs.existsSync(sock), false);
  } finally {
    env.cleanup();
  }
});

test("總期限不因收到資料重設：持續慢速送資料到期後仍回逾時且不呼叫 hub", async () => {
  const env = setup();
  const { hub, calls } = recordingHub();
  const stop = await startMachineControlServer(hub, { ...env, timeoutMs: 120 });
  try {
    const token = fs.readFileSync(env.tokenFile, "utf8");
    const line =
      JSON.stringify({ version: 1, token, action: "connect", machineId: "m" }) +
      "\n";
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(env.socketPath);
      let data = "";
      let ticks = 0;
      let timer: NodeJS.Timeout | undefined;
      socket.on("error", reject);
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => {
        clearInterval(timer);
        resolve(data);
      });
      socket.on("connect", () => {
        // 每 40ms 送一個空白（閒置逾時 120ms 永遠不會觸發），約 400ms 後才送完整合法 JSON。
        timer = setInterval(() => {
          if (socket.destroyed || !socket.writable) return clearInterval(timer);
          if (++ticks < 10) socket.write(" ");
          else {
            clearInterval(timer);
            socket.write(line);
          }
        }, 40);
      });
    });
    assert.deepEqual(JSON.parse(reply), { ok: false, reason: CONTROL_TIMEOUT });
    // 再等一段時間，確認之後送到的合法請求也沒有被解析。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(calls.length, 0);
  } finally {
    stop();
    env.cleanup();
  }
});

test("看板端：server 慢速送資料或不回應時，在總期限內以固定短句結束", async () => {
  const env = setup();
  fs.mkdirSync(path.dirname(env.tokenFile), { recursive: true });
  fs.writeFileSync(env.tokenFile, "t".repeat(64));
  fs.mkdirSync(path.dirname(env.socketPath), { recursive: true });
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((socket) => {
    socket.resume();
    socket.on("error", () => undefined);
    // 每 40ms 送一個空白但永遠不送換行。
    const timer = setInterval(() => {
      if (!socket.destroyed) socket.write(" ");
    }, 40);
    timers.add(timer);
    socket.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(env.socketPath, resolve));
  try {
    const started = Date.now();
    const result = await sendMachineControl(
      { action: "connect", machineId: "m" },
      { ...env, timeoutMs: 120 },
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { ok: false, reason: CONTROL_NO_RESPONSE });
    assert.ok(elapsed < 2000, `${elapsed}ms`);
  } finally {
    for (const timer of timers) clearInterval(timer);
    server.close();
    env.cleanup();
  }
});

test("afterControl 的說明放進結果的 herdr；失敗的結果不呼叫，它丟錯就回原結果", async () => {
  const env = setup();
  const seen: string[] = [];
  const hub: MachineControlHub = {
    connectMachine: () => ({ ok: true, status: "connected" }),
    disconnectMachine: () => ({ ok: false, reason: "有進行中的工作", needsForce: true }),
  };
  const stop = await startMachineControlServer(hub, {
    ...env,
    afterControl: async (command) => {
      seen.push(command.action);
      if (command.machineId === "boom") throw new Error("x");
      return "已同步";
    },
  });
  try {
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "m1" }, env),
      { ok: true, status: "connected", herdr: "已同步" },
    );
    assert.deepEqual(
      await sendMachineControl({ action: "connect", machineId: "boom" }, env),
      { ok: true, status: "connected" },
    );
    assert.equal((await sendMachineControl({ action: "disconnect", machineId: "m1" }, env)).ok, false);
    assert.deepEqual(seen, ["connect", "connect"]);
  } finally {
    stop();
    env.cleanup();
  }
});
