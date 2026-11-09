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
  /**
   * 原回合的 agent session（`kind:value`）；回合開始時沒有 session 記成空字串，欄位不存在表示舊版紀錄。
   * 回合中 session 合法轉移（首次登記、同回合新建）時由 `updateSession` 同步，補送時才比對得過。
   */
  sessionKey?: string;
  recovery?: "pending" | "claimed";
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

  owns(record: ActiveStreamRecord): boolean {
    return this.records.get(record.terminalId) === record;
  }

  remove(terminalId: string): void {
    if (this.records.delete(terminalId)) this.save();
  }

  /** Records still within the 24h stream lifetime; older ones are dropped. */
  list(now = Date.now()): ActiveStreamRecord[] {
    let dropped = false;
    for (const [key, r] of this.records)
      if (now - r.startedAt >= MAX_AGE_MS) {
        console.warn(
          `Stream not resumed terminal=${r.terminalId} pane=${r.paneId}: 紀錄逾期 (24h)`,
        );
        this.records.delete(key);
        dropped = true;
      }
    if (dropped) this.save();
    return [...this.records.values()];
  }

  /** 同回合合法換 session 時同步紀錄，讓重啟後的補送仍認得這個回合。 */
  updateSession(terminalId: string, sessionKey: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.sessionKey === sessionKey) return;
    record.sessionKey = sessionKey;
    this.save();
  }

  /** Claim before sending: uncertain delivery must never be repeated after restart. */
  claim(record: ActiveStreamRecord): boolean {
    if (
      this.records.get(record.terminalId) !== record ||
      record.recovery !== "pending"
    )
      return false;
    const previous = record.recovery;
    record.recovery = "claimed";
    if (this.save()) return true;
    record.recovery = previous;
    return false;
  }

  private save(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.records.values()]), "utf8");
      renameSync(tmp, this.path);
      return true;
    } catch (error) {
      console.error(`Stream resume state write failed: ${String(error)}`);
      return false;
    }
  }
}
