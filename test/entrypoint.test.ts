import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("npm start and packaged bin reach the compiled startup validation without network or credentials", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "entrypoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ discord: { enabled: false } }),
  );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(
    pkg.bin["herdr-discord-bridge"],
    lock.packages[""].bin["herdr-discord-bridge"],
  );
  assert.match(
    await readFile(path.join(root, pkg.bin["herdr-discord-bridge"]), "utf8"),
    /^#!\/usr\/bin\/env node/,
  );
  assert.equal(pkg.scripts["dry-run"], pkg.scripts.start + " --dry-run");
  for (const [command, args] of [
    ["npm", ["start"]],
    [process.execPath, [pkg.bin["herdr-discord-bridge"]]],
  ] as const) {
    await assert.rejects(
      promisify(execFile)(command, [...args], {
        cwd: root,
        timeout: 10000,
        env: {
          ...process.env,
          HERDR_PLUGIN_CONFIG_DIR: dir,
          HERDR_PLUGIN_STATE_DIR: dir,
          HERDR_DISCORD_BOT_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          HERDR_DISCORD_ENABLED: "false",
        },
      }),
      (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 1);
        assert.match(
          failure.stderr,
          /Discord is disabled or its bot token is missing/,
        );
        assert.doesNotMatch(failure.stderr, /MODULE_NOT_FOUND/);
        return true;
      },
    );
  }
});
