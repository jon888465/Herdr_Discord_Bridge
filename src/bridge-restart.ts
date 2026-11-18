import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDirectory } from "./config.js";
import type { MachineControlResult } from "./machines.js";

/**
 * 看板「重啟 bridge」的 bridge 端（ISSUE-169）：確認沒有進行中的 Discord 串流後，
 * 先回覆看板，再另開獨立的 `scripts/run.sh`（不重建，只重開 plugin pane）。
 * run.sh 會關掉目前這個 bridge pane，所以必須脫離這個程序（新 session、不繼承 stdio）才不會跟著被關掉。
 */
export const RESTART_DELAY_MS = 300;
export const RESTART_RETRY_MS = 60_000;
export const RESTART_BUSY = (count: number): string =>
  `有 ${count} 個進行中的 Discord 串流，暫不重啟`;
export const RESTART_IN_PROGRESS = "已在重啟中";
export const RESTART_NO_SCRIPT = "找不到 scripts/run.sh";
export const RESTART_STARTED = "bridge 重啟中，稍候重新連線";

export interface BridgeRestartDeps {
  /** 進行中的 Discord 串流數（active-streams）。 */
  activeStreams: () => number;
  /** 專案目錄（含 scripts/run.sh）。 */
  projectDir: string;
  /** 回覆送出之後才呼叫；測試注入。預設以脫離的子程序執行 run.sh。 */
  launch?: (script: string, projectDir: string) => void;
  schedule?: (run: () => void, delayMs: number) => void;
}

/** dist/src/*.js 往上兩層是專案目錄。 */
export function defaultProjectDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 預設啟動方式：新 session、stdio 導向 state 目錄的 restart.log，並禁止 run.sh 自己在背景開 Herdr 伺服器（ISSUE-168 的 -25308）。 */
export function launchRestartScript(script: string, projectDir: string): void {
  const out = fs.openSync(path.join(stateDirectory(), "restart.log"), "a", 0o600);
  try {
    const child = spawn("bash", [script], {
      cwd: projectDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, HERDR_BRIDGE_NO_SERVER_START: "1" },
    });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    fs.closeSync(out);
  }
}

let restarting = false;

export function requestBridgeRestart(deps: BridgeRestartDeps): MachineControlResult {
  if (restarting) return { ok: false, reason: RESTART_IN_PROGRESS };
  const active = deps.activeStreams();
  if (active > 0) return { ok: false, reason: RESTART_BUSY(active) };
  const script = path.join(deps.projectDir, "scripts", "run.sh");
  if (!fs.existsSync(script)) return { ok: false, reason: RESTART_NO_SCRIPT };
  restarting = true;
  // run.sh 失敗時 bridge 還活著：一段時間後允許再試。
  setTimeout(() => (restarting = false), RESTART_RETRY_MS).unref();
  const launch = deps.launch ?? launchRestartScript;
  const schedule = deps.schedule ?? ((run, ms) => void setTimeout(run, ms));
  schedule(() => {
    try {
      launch(script, deps.projectDir);
    } catch {
      restarting = false;
    }
  }, RESTART_DELAY_MS);
  return { ok: true, status: "connected", note: RESTART_STARTED, restarting: true };
}

/** 測試用：清掉「已在重啟中」。 */
export function resetBridgeRestartForTest(): void {
  restarting = false;
}
