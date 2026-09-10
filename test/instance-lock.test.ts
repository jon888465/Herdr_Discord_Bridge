import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireInstanceLock } from "../src/instance-lock.js";

test("concurrent starts allow only one owner and release allows restart", async () => {
  const key = randomUUID();
  const attempts = await Promise.allSettled([
    acquireInstanceLock(key),
    acquireInstanceLock(key),
  ]);
  const winner = attempts.find((result) => result.status === "fulfilled");
  assert.ok(winner && winner.status === "fulfilled");
  try {
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const loser = attempts.find((result) => result.status === "rejected");
    assert.ok(loser && loser.status === "rejected");
    assert.match(String(loser.reason), /already running/);
    assert.ok(!String(loser.reason).includes(key));
  } finally {
    await winner.value();
  }
  const release = await acquireInstanceLock(key);
  await release();
  await release();
});

test("rotated tokens for the same bot share the lock", async () => {
  const botId = String(
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 15)) +
      1000000000000000000n,
  );
  const prefix = Buffer.from(botId).toString("base64url");
  const release = await acquireInstanceLock(`${prefix}.first.signature`);
  try {
    await assert.rejects(
      acquireInstanceLock(`${prefix}.rotated.signature`),
      /already running/,
    );
  } finally {
    await release();
  }
});

test(
  "Linux releases the lock after an owner process is killed",
  { skip: process.platform !== "linux" },
  async () => {
    const key = randomUUID();
    const moduleUrl = new URL("../src/instance-lock.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    await acquireInstanceLock(${JSON.stringify(key)});
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const ready = await once(child.stdout!, "data");
      assert.match(String(ready[0]), /ready/);
      await assert.rejects(acquireInstanceLock(key), /already running/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const release = await acquireInstanceLock(key);
      await release();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  },
);

test("the real entrypoint rejects a duplicate before contacting Herdr or Discord", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const key = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "bridge-duplicate-start-"));
  const release = await acquireInstanceLock(key);
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../src/index.js", import.meta.url))],
        {
          env: {
            ...process.env,
            HERDR_DISCORD_BOT_TOKEN: key,
            DISCORD_BOT_TOKEN: key,
            HERDR_PLUGIN_CONFIG_DIR: dir,
            HERDR_PLUGIN_STATE_DIR: dir,
            HERDR_SOCKET_PATH: join(dir, "missing.sock"),
          },
          timeout: 10000,
        },
      ),
      (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr, /already running/);
        assert.ok(!failure.stderr.includes(key));
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await release();
    await rm(dir, { recursive: true, force: true });
  }
});
