import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI hook → bridge 事件（ISSUE-045）。目前只處理 Claude 的 `Stop`：回合結束與最終回覆。
 * 這是主要通道的「加速器」，不是唯一來源：事件沒到時 streamAgent 仍走畫面 parser。
 */
export interface HookEvent {
  event: "Stop" | "PermissionRequest";
  sessionId: string;
  paneId?: string;
  promptId?: string;
  message: string;
  /** PermissionRequest 專用：工具名稱與（截短的）輸入摘要。 */
  toolName?: string;
  toolInput?: string;
}

export type PermissionDecision = "allow" | "deny";

const MAX_EVENT_BYTES = 1024 * 1024;
const KEEP_EVENTS = 64;
/** 權限請求最長等待；hook 本身的 timeout 通常更短，到時連線關閉即回到 TUI 原流程。 */
export const PERMISSION_HOLD_MS = 10 * 60 * 1000;

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

interface PendingPermission {
  event: HookEvent;
  respond: (decision: PermissionDecision | undefined) => void;
}

/**
 * 等待中的 PermissionRequest hook（ISSUE-045）。每個 pane 同時最多一筆；hook 連線保持開啟直到
 * Discord 給出決定、TUI 先決定（cancel）、逾時或連線中斷。沒有決定時 hook 不輸出任何東西，
 * Claude 回到 TUI 原本的提示流程，因此永遠不會預設 allow。
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();

  register(event: HookEvent, respond: PendingPermission["respond"]): void {
    if (!event.paneId) {
      respond(undefined);
      return;
    }
    this.pending.get(event.paneId)?.respond(undefined);
    this.pending.set(event.paneId, { event, respond });
  }

  has(paneId: string): boolean {
    return this.pending.has(paneId);
  }

  peek(paneId: string): HookEvent | undefined {
    return this.pending.get(paneId)?.event;
  }

  /** 以 Discord 的決定回應 hook；沒有等待中的請求回傳 false。 */
  decide(paneId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(paneId);
    if (!entry) return false;
    this.pending.delete(paneId);
    entry.respond(decision);
    return true;
  }

  /** TUI 先決定、agent 離開 blocked 或連線結束：放棄等待，不輸出決定。 */
  cancel(paneId: string): void {
    const entry = this.pending.get(paneId);
    if (!entry) return;
    this.pending.delete(paneId);
    entry.respond(undefined);
  }

  /** 只在該 respond 仍是目前這筆時移除（連線關閉用）。 */
  drop(paneId: string, respond: PendingPermission["respond"]): void {
    if (this.pending.get(paneId)?.respond === respond)
      this.pending.delete(paneId);
  }
}

export const permissionBroker = new PermissionBroker();

/** Discord 文字／按鈕 → 決定；其他文字（含數字選項）原樣打進 TUI。 */
export function permissionDecisionFromText(
  text: string,
): PermissionDecision | undefined {
  const t = text.trim().toLowerCase();
  if (/^(allow|approve|yes|y|ok|continue)$/.test(t)) return "allow";
  if (/^(deny|reject|no|n|cancel)$/.test(t)) return "deny";
  return undefined;
}

export function parseHookEvent(value: unknown): HookEvent | undefined {
  const v = value as Record<string, unknown> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    (v.event !== "Stop" && v.event !== "PermissionRequest")
  )
    return undefined;
  if (typeof v.sessionId !== "string" || !v.sessionId) return undefined;
  if (typeof v.message !== "string") return undefined;
  return {
    event: v.event,
    sessionId: v.sessionId,
    paneId: typeof v.paneId === "string" ? v.paneId : undefined,
    promptId: typeof v.promptId === "string" ? v.promptId : undefined,
    message: v.message,
    toolName: typeof v.toolName === "string" ? v.toolName : undefined,
    toolInput: typeof v.toolInput === "string" ? v.toolInput : undefined,
  };
}

/** 與 send socket 相同的保護：目錄 0700、socket 0600，只有同一個 OS 使用者能連。 */
export async function startHookServer(
  store: HookEventStore = hookEvents,
  path = hookSocketPath(),
  broker: PermissionBroker = permissionBroker,
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
      let event: HookEvent | undefined;
      try {
        event = parseHookEvent(JSON.parse(buffer.slice(0, end)));
      } catch {
        /* 無效事件直接忽略；parser 仍會完成回合 */
      }
      if (event?.event === "PermissionRequest") {
        // 連線保持開啟等待決定；逾時、中斷或 cancel 都不輸出決定。
        socket.setTimeout(PERMISSION_HOLD_MS, () => socket.destroy());
        const respond = (decision: PermissionDecision | undefined): void => {
          if (socket.destroyed) return;
          socket.end(
            decision ? JSON.stringify({ behavior: decision }) + "\n" : "",
          );
        };
        socket.once("close", () => {
          if (event?.paneId) broker.drop(event.paneId, respond);
        });
        broker.register(event, respond);
        return;
      }
      if (event) store.record(event);
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

/**
 * 送出 PermissionRequest 並等待 bridge 的決定。bridge 不在、逾時或被取消時回傳 undefined
 * （hook 不輸出決定，Claude 走 TUI 原流程）。
 */
export function requestPermission(
  event: HookEvent,
  path = hookSocketPath(),
  timeoutMs = PERMISSION_HOLD_MS,
): Promise<PermissionDecision | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let data = "";
    const done = (value: PermissionDecision | undefined): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => done(undefined));
    socket.once("error", () => done(undefined));
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(data.trim()) as { behavior?: unknown };
        done(
          parsed.behavior === "allow" || parsed.behavior === "deny"
            ? parsed.behavior
            : undefined,
        );
      } catch {
        done(undefined);
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify(event) + "\n"));
  });
}
