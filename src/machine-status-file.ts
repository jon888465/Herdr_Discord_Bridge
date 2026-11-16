import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrHub } from "./machines.js";

export const MACHINE_STATUS_WRITE_INTERVAL_MS = 5000;
export const MACHINE_STATUS_MAX_AGE_MS = 15000;
export type MachineStatus = "connected" | "unreachable";
type Entry = { id: string; reachable: boolean };
type Observation = Entry & { observedAt?: number };

/**
 * 只留下觀測夠新的機器。hub 的 `reachable` 只在請求遠端時更新，沒人探測時會一直停在舊值；
 * 如果照寫、再蓋上現在的時間，過期的 connected 就永遠不會過期（review 第 1 輪，F1）。
 * 從沒觀測過或太舊的機器不寫進檔案，看板就顯示「未知」。
 */
export function freshObservations(
  observations: Observation[],
  nowMs: number,
  maxAgeMs: number,
): Entry[] {
  return observations
    .filter(
      (o) =>
        o.observedAt !== undefined &&
        nowMs - o.observedAt >= -maxAgeMs &&
        nowMs - o.observedAt <= maxAgeMs,
    )
    .map(({ id, reachable }) => ({ id, reachable }));
}

export function serializeMachineStatus(entries: Entry[], now: Date): string {
  return JSON.stringify({
    version: 1,
    updatedAt: now.toISOString(),
    machines: entries.map(({ id, reachable }) => ({
      id,
      status: reachable ? "connected" : "unreachable",
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
        isObject(entry) &&
        typeof entry.id === "string" &&
        (entry.status === "connected" || entry.status === "unreachable")
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
