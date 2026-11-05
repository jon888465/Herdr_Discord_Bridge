import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "./types.js";

/** Parse only public message events in the first matching new turn. */
export class CodexTurn {
  private turnId = "";
  private matched = false;
  private closed = false;
  preview = "";
  final = "";
  completed = false;
  constructor(private readonly prompt: string) {}
  accept(line: string): void {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (row.type !== "event_msg" || this.closed) return;
    const p = row.payload;
    if (!p || typeof p !== "object") return;
    if (p.type === "task_started") {
      if (this.matched) {
        this.closed = true;
        return;
      }
      this.turnId = p.turn_id;
    }
    // Newer Codex releases wrap public messages inside item_completed.
    if (p.type === "item_completed" && p.turn_id === this.turnId && p.item) {
      const item = p.item;
      const text = Array.isArray(item.content)
        ? item.content
            .filter(
              (part: { type?: string; text?: unknown }) =>
                ["Text", "text"].includes(part.type || "") &&
                typeof part.text === "string",
            )
            .map((part: { text: string }) => part.text)
            .join("")
        : "";
      if (item.type === "UserMessage" && text === this.prompt)
        this.matched = true;
      if (!this.matched) return;
      if (
        item.type === "AgentMessage" &&
        ["commentary", "final_answer"].includes(item.phase)
      ) {
        this.preview = text;
        if (item.phase === "final_answer") this.final = text;
      }
      if (item.type === "CommandExecution")
        this.preview =
          "Tool: command execution — " + String(item.status || "working");
      return;
    }
    if (p.type === "user_message" && this.turnId) {
      if (p.message === this.prompt) this.matched = true;
    }
    if (!this.matched) return;
    if (
      p.type === "agent_message" &&
      ["commentary", "final_answer"].includes(p.phase) &&
      typeof p.message === "string"
    )
      this.preview = p.message;
    if (
      p.type === "agent_message" &&
      p.phase === "final_answer" &&
      typeof p.message === "string"
    )
      this.final = p.message;
    if (p.type === "task_complete" && p.turn_id === this.turnId) {
      this.completed = true;
      this.closed = true;
    }
  }
}

export class CodexTranscript {
  readonly turn: CodexTurn;
  private pending = "";
  private constructor(
    private path: string,
    private offset: number,
    prompt: string,
  ) {
    this.turn = new CodexTurn(prompt);
  }
  static async connect(
    agent: AgentRecord,
    prompt: string,
  ): Promise<CodexTranscript | undefined> {
    if (!agent.agent?.toLowerCase().includes("codex")) return;
    const session = agent.agent_session as
      { kind?: string; value?: string } | undefined;
    if (
      session?.kind !== "id" ||
      !session.value ||
      !/^[a-f0-9-]{36}$/i.test(session.value)
    )
      return;
    const root = join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "sessions",
    );
    const paths: string[] = [];
    async function scan(dir: string, depth: number): Promise<void> {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isDirectory() && depth < 3)
          await scan(join(dir, item.name), depth + 1);
        else if (
          item.isFile() &&
          item.name.endsWith(`-${session!.value}.jsonl`)
        )
          paths.push(join(dir, item.name));
      }
    }
    try {
      await scan(root, 0);
      if (paths.length !== 1) return;
      return new CodexTranscript(paths[0], (await stat(paths[0])).size, prompt);
    } catch {
      return;
    }
  }
  async poll(): Promise<void> {
    const file = await open(this.path, "r");
    try {
      if ((await file.stat()).size < this.offset)
        throw new Error("Transcript truncated");
      // Bounded reads; carry incomplete UTF-8 bytes by advancing only through newlines.
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        this.offset,
      );
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end < 0) {
        if (bytesRead === buffer.length)
          throw new Error("Transcript record exceeds read limit");
        return;
      }
      this.offset += end + 1;
      this.pending = buffer.subarray(0, end).toString("utf8");
      for (const line of this.pending.split("\n")) this.turn.accept(line);
      this.pending = "";
    } finally {
      await file.close();
    }
  }
}

/** Completion requires successful, unchanged reads while idle/done. */
export class Settlement {
  private count = 0;
  observe(status: string, readOk: boolean, changed: boolean): boolean {
    if (!readOk || changed || !["idle", "done"].includes(status))
      this.count = 0;
    else this.count++;
    return this.count >= 4;
  }
}

export function rollingPreview(text: string): string {
  const tail = text.slice(-1500);
  return text.length > tail.length ? `…\n${tail}` : tail;
}

/** Agent 已經登記了可辨識的 session（kind 為 id／path 且有值）。剛啟動的 Agent 在第一個 prompt 之前還沒有。 */
export function hasAgentSession(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const session = value as { kind?: unknown; value?: unknown };
  return (
    (session.kind === "id" || session.kind === "path") &&
    typeof session.value === "string" &&
    session.value.length > 0
  );
}

// Provider/source metadata can change without replacing the underlying session.
export function sameAgentSession(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (typeof left !== "object" || typeof right !== "object") return false;
  const a = left as { kind?: unknown; value?: unknown };
  const b = right as { kind?: unknown; value?: unknown };
  return (
    (a.kind === "id" || a.kind === "path") &&
    typeof a.value === "string" &&
    a.value.length > 0 &&
    a.kind === b.kind &&
    a.value === b.value
  );
}

/**
 * Codex materializes a new session at the first prompt of a fresh thread, so
 * Herdr's `agent_session` can switch id mid-turn (ISSUE-047). A UUIDv7 id
 * embeds its creation time; a session created at or after the prompt was sent
 * (small clock tolerance) is the same turn's session, not another conversation.
 */
export function sessionCreatedSince(
  session: unknown,
  since: number,
  /** 非 UUIDv7 的 id（如 agy 的 UUIDv4）改由呼叫端提供建立時間（毫秒）。 */
  createdAt?: (id: string) => number | undefined,
): boolean {
  const s = session as { kind?: unknown; value?: unknown } | null;
  if (!s || typeof s.value !== "string") return false;
  if (s.kind === "path") {
    // pi 的 session 檔名帶建立時間：<ISO 時間（: 與 . 換成 -）>_<uuid>.jsonl
    const t =
      /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[^/]*$/.exec(
        s.value,
      );
    if (!t) return false;
    const ms = Date.parse(`${t[1]}T${t[2]}:${t[3]}:${t[4]}.${t[5]}Z`);
    return Number.isFinite(ms) && ms >= since - 5000;
  }
  if (s.kind !== "id") return false;
  const m = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.exec(s.value);
  const ms = m
    ? Number.parseInt(s.value.replace(/-/g, "").slice(0, 12), 16)
    : createdAt?.(s.value);
  return typeof ms === "number" && Number.isFinite(ms) && ms >= since - 5000;
}

/**
 * ISSUE-088：codex 的 hook 由長駐 app-server daemon 執行，`HERDR_PANE_ID` 是 daemon 啟動時
 * 的值，所以 Herdr 的 `agent_session` 對 codex 不可信。本回合 prompt 帶有唯一 nonce，
 * 含該 nonce 的 rollout 檔就是這個 pane 此刻使用的 session。恰好一個檔案符合才回傳，
 * 零個或多個都視為不明（呼叫端必須 fail closed）。
 */
const ROLLOUT_NAME =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;

export async function findCodexSessionByNonce(
  nonce: string,
  sinceMs: number,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<{ kind: "id"; value: string } | undefined> {
  if (!/^[a-f0-9]{16,}$/i.test(nonce)) return undefined;
  const root = join(codexHome, "sessions");
  const found = new Set<string>();
  async function scan(dir: string, depth: number): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isDirectory() && depth < 3) {
        await scan(path, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      const name = ROLLOUT_NAME.exec(item.name);
      if (!name) continue;
      try {
        const info = await stat(path);
        // 本回合開始之後有寫入、大小在上限內的檔案才可能含 nonce。
        if (info.mtimeMs < sinceMs - 5000 || info.size > MAX_ROLLOUT_BYTES)
          continue;
        const file = await open(path, "r");
        try {
          const buffer = Buffer.alloc(info.size);
          await file.read(buffer, 0, info.size, 0);
          if (buffer.includes(nonce)) found.add(name[1]!.toLowerCase());
        } finally {
          await file.close();
        }
      } catch {
        /* 讀不到就當作不符合 */
      }
    }
  }
  await scan(root, 0);
  return found.size === 1 ? { kind: "id", value: [...found][0]! } : undefined;
}
