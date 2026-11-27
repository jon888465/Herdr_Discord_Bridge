// `node dist/src/hook-install-cli.js [--dry-run] [--local-only] [--config-dir DIR]`
// scripts/run.sh -r 會在 build 之後呼叫它（`--no-hooks` 可略過）。失敗只回報，結束碼一律 0（用法錯誤除外）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonComments } from "./config.js";
import { formatHookReports, installLocalHooks, installRemoteHooks, type HookReport } from "./hook-install.js";
import { validateMachines, type MachineConfig } from "./machines.js";

function usage(): never {
  console.error("Usage: hook-install-cli [--dry-run] [--local-only] [--config-dir DIR]");
  process.exit(2);
}

const args = process.argv.slice(2);
let dryRun = false;
let localOnly = false;
let configDir: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--local-only") localOnly = true;
  else if (arg === "--config-dir") configDir = args[(i += 1)] ?? usage();
  else usage();
}

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = os.homedir();

function findConfig(): string | undefined {
  const candidates = [
    configDir,
    process.env.HERDR_PLUGIN_CONFIG_DIR,
    path.join(home, ".config", "herdr", "plugins", "config", "herdr-discord-bridge"),
    path.join(home, ".config", "herdr-discord-bridge"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.map((dir) => path.join(dir, "config.json")).find((file) => fs.existsSync(file));
}

async function main(): Promise<void> {
  const reports: HookReport[] = installLocalHooks({ home, projectDir, dryRun });
  if (!localOnly) {
    const file = findConfig();
    if (!file) reports.push({ scope: "remote", agent: "-", outcome: "skipped", detail: "找不到 config.json，略過遠端 machine（可用 --config-dir 指定）" });
    else {
      let machines: MachineConfig[] = [];
      try {
        const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) as { machines?: unknown };
        machines = parsed.machines === undefined ? [] : validateMachines(parsed.machines);
      } catch (error) {
        reports.push({ scope: "remote", agent: "-", outcome: "error", detail: `讀 config.json 的 machines 失敗：${error instanceof Error ? error.message : String(error)}` });
      }
      for (const machine of machines) reports.push(...(await installRemoteHooks(machine, { projectDir, dryRun })));
    }
  }
  console.log(`${dryRun ? "（dry-run：以下是會做的事，沒有改任何檔案）\n" : ""}${formatHookReports(reports)}`);
  const attention = reports.filter((r) => r.outcome === "manual" || r.outcome === "error").length;
  if (attention) console.log(`\n有 ${attention} 項需要你處理（! 或 ✗）。`);
}

main().catch((error) => {
  console.error(`hook install failed: ${error instanceof Error ? error.message : String(error)}`);
});
