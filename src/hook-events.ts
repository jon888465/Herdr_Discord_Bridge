import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI hook → bridge 事件（ISSUE-045）。目前只處理 Claude 的 `Stop`：回合結束與最終回覆。
 * 這是主要通道的「加速器」，不是唯一來源：事件沒到時 streamAgent 仍走畫面 parser。
 */
export interface HookEvent {
  event: "Stop";
  sessionId: string;
  paneId?: string;
  promptId?: string;
  message: string;
}

const MAX_EVENT_BYTES = 1024 * 1024;
const KEEP_EVENTS = 64;

export function hookSocketPath(): string {
  if (process.env.HERDR_DISCORD_HOOK_SOCKET)
    return process.env.HERDR_DISCORD_HOOK_SOCKET;
  return join(homedir(), ".config", "herdr-discord-bridge", "hooks.sock");
}

/** 最近的 Stop 事件，依 agent session id 查詢；僅記憶體，重啟後遺失（由 parser 備援）。 */
export class HookEventStore {
  private readonly stops = new Map<string, HookEvent & { at: number }>();

  record(event: HookEvent, at = Date.now()): void {
    this.stops.delete(event.sessionId);
    this.stops.set(event.sessionId, { ...event, at });
    while (this.stops.size > KEEP_EVENTS) {
      const oldest = this.stops.keys().next().value;
      if (oldest === undefined) break;
      this.stops.delete(oldest);
    }
  }

  /** 回傳 `since`（含）之後收到的該 session Stop 事件；否則 undefined。 */
  stopSince(
    sessionId: string | undefined,
    since: number,
  ): HookEvent | undefined {
    if (!sessionId) return undefined;
    const found = this.stops.get(sessionId);
    return found && found.at >= since ? found : undefined;
  }
}

export const hookEvents = new HookEventStore();

export function parseHookEvent(value: unknown): HookEvent | undefined {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null || v.event !== "Stop")
    return undefined;
  if (typeof v.sessionId !== "string" || !v.sessionId) return undefined;
  if (typeof v.message !== "string") return undefined;
  return {
    event: "Stop",
    sessionId: v.sessionId,
    paneId: typeof v.paneId === "string" ? v.paneId : undefined,
    promptId: typeof v.promptId === "string" ? v.promptId : undefined,
    message: v.message,
  };
}

/** 與 send socket 相同的保護：目錄 0700、socket 0600，只有同一個 OS 使用者能連。 */
export async function startHookServer(
  store: HookEventStore = hookEvents,
  path = hookSocketPath(),
): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await removeIfStale(path);
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_EVENT_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const event = parseHookEvent(JSON.parse(buffer.slice(0, end)));
        if (event) store.record(event);
      } catch {
        /* 無效事件直接忽略；parser 仍會完成回合 */
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  server.unref();
  return () => {
    server.close();
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

function removeIfStale(path: string): Promise<void> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve();
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
      resolve();
    });
  });
}

export function sendHookEvent(
  event: HookEvent,
  path = hookSocketPath(),
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.once("close", () => resolve(true));
    socket.on("connect", () => socket.end(JSON.stringify(event) + "\n"));
  });
}
