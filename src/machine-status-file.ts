import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrHub } from "./machines.js";

export const MACHINE_STATUS_WRITE_INTERVAL_MS = 5000;
export const MACHINE_STATUS_MAX_AGE_MS = 15000;
export type MachineStatus = "connected" | "unreachable";
/** `observedAt` 是 hub 最後一次實際請求這台機器的時間（毫秒）。 */
type Entry = { id: string; reachable: boolean; observedAt: number };
type Observation = Omit<Entry, "observedAt"> & { observedAt?: number };

/**
 * 只留下觀測夠新的機器。hub 的 `reachable` 只在請求遠端時更新，沒人探測時會一直停在舊值；
 * 如果照寫、再蓋上現在的時間，過期的 connected 就永遠不會過期（review 第 1 輪，F1）。
 * 從沒觀測過或太舊的機器不寫進檔案，看板就顯示「未知」。每筆保留自己的觀測時間，
 * 讀取端才能逐筆判斷，不會因為整份檔案的 `updatedAt` 較新就多接受 15 秒（review 第 2 輪，F2）。
 */
export function freshObservations(
  observations: Observation[],
  nowMs: number,
  maxAgeMs: number,
): Entry[] {
  const fresh: Entry[] = [];
  for (const { id, reachable, observedAt } of observations) {
    if (observedAt === undefined) continue;
    const age = nowMs - observedAt;
    if (age < -maxAgeMs || age > maxAgeMs) continue;
    fresh.push({ id, reachable, observedAt });
  }
  return fresh;
}

export function serializeMachineStatus(entries: Entry[], now: Date): string {
  return JSON.stringify({
    version: 1,
    updatedAt: now.toISOString(),
    machines: entries.map(({ id, reachable, observedAt }) => ({
      id,
      status: reachable ? "connected" : "unreachable",
      observedAt: new Date(observedAt).toISOString(),
    })),
  });
}

export function writeMachineStatus(
  file: string,
  entries: Entry[],
  now: Date,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, serializeMachineStatus(entries, now), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readMachineStatus(
  file: string,
  now: Date,
  maxAgeMs: number,
): Map<string, MachineStatus> {
  const statuses = new Map<string, MachineStatus>();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "string"
    )
      return statuses;
    const updatedAt = Date.parse(parsed.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      Math.abs(now.getTime() - updatedAt) > maxAgeMs ||
      !Array.isArray(parsed.machines)
    )
      return statuses;
    for (const entry of parsed.machines) {
      if (
        !isObject(entry) ||
        typeof entry.id !== "string" ||
        (entry.status !== "connected" && entry.status !== "unreachable") ||
        typeof entry.observedAt !== "string"
      )
        continue;
      // 逐筆檢查觀測時間：整份檔案的 updatedAt 只代表 writer 還活著，不代表這筆觀測有多新。
      const observedAt = Date.parse(entry.observedAt);
      if (
        Number.isFinite(observedAt) &&
        Math.abs(now.getTime() - observedAt) <= maxAgeMs
      )
        statuses.set(entry.id, entry.status);
    }
  } catch {
    // Missing, unreadable or invalid sources are unknown, never connected.
  }
  return statuses;
}

export function startMachineStatusWriter(
  hub: Pick<HerdrHub, "machineObservations">,
  file: string,
  intervalMs: number,
  now = () => new Date(),
): () => void {
  const write = (): void => {
    try {
      const at = now();
      writeMachineStatus(
        file,
        freshObservations(
          hub.machineObservations(),
          at.getTime(),
          MACHINE_STATUS_MAX_AGE_MS,
        ),
        at,
      );
    } catch {
      console.error("Machine status write failed");
    }
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
