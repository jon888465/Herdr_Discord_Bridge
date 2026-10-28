import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** In-flight Discord-driven turn, persisted so a restarted bridge can resume it (ISSUE-042). */
export interface ActiveStreamRecord {
  terminalId: string;
  paneId: string;
  channelId: string;
  progressMessageId: string;
  prompt: string;
  baselineOutput: string;
  startedAt: number;
}

const MAX_AGE_MS = 86400000;

export class StreamResumeStore {
  private records = new Map<string, ActiveStreamRecord>();

  constructor(private readonly path: string) {
    try {
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        const r = item as Partial<ActiveStreamRecord>;
        if (
          typeof r.terminalId === "string" &&
          typeof r.paneId === "string" &&
          typeof r.channelId === "string" &&
          typeof r.progressMessageId === "string" &&
          typeof r.prompt === "string" &&
          typeof r.baselineOutput === "string" &&
          typeof r.startedAt === "number"
        )
          this.records.set(r.terminalId, r as ActiveStreamRecord);
      }
    } catch {
      this.records.clear();
    }
  }

  add(record: ActiveStreamRecord): void {
    this.records.set(record.terminalId, record);
    this.save();
  }

  remove(terminalId: string): void {
    if (this.records.delete(terminalId)) this.save();
  }

  /** Records still within the 24h stream lifetime; older ones are dropped. */
  list(now = Date.now()): ActiveStreamRecord[] {
    let dropped = false;
    for (const [key, r] of this.records)
      if (now - r.startedAt >= MAX_AGE_MS) {
        this.records.delete(key);
        dropped = true;
      }
    if (dropped) this.save();
    return [...this.records.values()];
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.records.values()]), "utf8");
      renameSync(tmp, this.path);
    } catch (error) {
      console.error(`Stream resume state write failed: ${String(error)}`);
    }
  }
}
