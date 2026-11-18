import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDirectory } from "./config.js";

/** 看板 `x` 手動斷線的 machine；bridge 重啟後不自動重連，要在看板按 `o`（ISSUE-166）。 */
export function machineDisconnectedFile(): string {
  return path.join(stateDirectory(), "machine-disconnected.json");
}

/**
 * 讀回手動斷線的 machine id。檔案不存在、格式不對、版本不認得都當成沒有（照 config 連線，是 bridge 原本的預設行為）；
 * 只留下現在 config 還有的 id，已移除的 machine 不會留下殘影。
 */
export function loadDisconnectedMachines(file: string, knownIds: string[]): string[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) return [];
    const ids = (value as { disconnected?: unknown }).disconnected;
    if (!Array.isArray(ids)) return [];
    const known = new Set(knownIds);
    return [...new Set(ids.filter((id): id is string => typeof id === "string" && known.has(id)))];
  } catch {
    return [];
  }
}

/** 原子寫入（暫存檔加 rename），權限 0600；失敗回傳 false，不丟錯，連線操作本身不受影響。 */
export function saveDisconnectedMachines(file: string, ids: string[]): boolean {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, disconnected: [...new Set(ids)].sort() }) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 暫存檔清不掉就留著，不影響結果 */
    }
    return false;
  }
}
