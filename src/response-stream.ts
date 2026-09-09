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
