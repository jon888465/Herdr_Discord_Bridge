import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrHub } from "./machines.js";

export const MACHINE_STATUS_WRITE_INTERVAL_MS = 5000;
export const MACHINE_STATUS_MAX_AGE_MS = 15000;
export type MachineStatus = "connected" | "unreachable";
type Entry = { id: string; reachable: boolean };

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
  hub: Pick<HerdrHub, "usageMachineStatus">,
  file: string,
  intervalMs: number,
  now = () => new Date(),
): () => void {
  const write = (): void => {
    try {
      writeMachineStatus(file, hub.usageMachineStatus(), now());
    } catch {
      console.error("Machine status write failed");
    }
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
