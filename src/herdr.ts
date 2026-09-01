import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  AgentRecord,
  HerdrErrorShape,
  HerdrResponse,
  HerdrSnapshot,
  ReadSource,
  WorkspaceRecord,
} from "./types.js";

export class HerdrError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
    message: string,
  ) {
    super(`herdr ${method}: ${code} ${message}`);
    this.name = "HerdrError";
  }
}

export function resolveSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_SESSION) {
    return path.join(
      os.homedir(),
      ".config",
      "herdr",
      "sessions",
      process.env.HERDR_SESSION,
      "herdr.sock",
    );
  }
  return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
}

/** Newline-delimited JSON client. Each request gets a bounded fresh connection. */
export class HerdrClient {
  constructor(
    private readonly socketPath = resolveSocketPath(),
    private readonly defaultTimeoutMs = 5000,
    private readonly reconnectBaseMs = 250,
  ) {}

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return this.requestWithRetry<T>(method, params, timeoutMs, retries);
  }

  private async requestWithRetry<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    retries: number,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestOnce<T>(method, params, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isTransientSocketError(error) || attempt >= retries) throw error;
        await delay(this.reconnectBaseMs * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("herdr request failed");
  }

  private requestOnce<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr ${method} timed out`))),
        timeoutMs,
      );
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({ id: `herdr-discord-${Date.now()}`, method, params })}\n`,
        );
      });
      socket.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        let response: HerdrResponse<T>;
        try {
          response = JSON.parse(line) as HerdrResponse<T>;
        } catch {
          finish(() =>
            reject(new Error(`herdr ${method} returned invalid JSON`)),
          );
          return;
        }
        if (response.error) {
          const error = response.error as HerdrErrorShape;
          finish(() =>
            reject(
              new HerdrError(
                method,
                error.code || "unknown_error",
                error.message || "request failed",
              ),
            ),
          );
          return;
        }
        finish(() => resolve(response.result as T));
      });
      socket.once("error", (error) => finish(() => reject(error)));
      socket.once("close", () => {
        if (!settled)
          finish(() =>
            reject(new Error(`herdr ${method} socket closed before response`)),
          );
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("ping", {}, { timeoutMs: 1500, retries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return this.request<HerdrSnapshot>("session.snapshot");
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    try {
      const result = await this.request<{ workspaces?: WorkspaceRecord[] }>(
        "workspace.list",
      );
      return normalizeArray<WorkspaceRecord>(result, "workspaces");
    } catch (error) {
      if (!(error instanceof HerdrError) || !isMissingMethod(error.code))
        throw error;
      const result = await this.snapshot();
      return result.workspaces ?? [];
    }
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.request<{ agents?: AgentRecord[] }>("agent.list");
    return normalizeArray<AgentRecord>(result, "agents");
  }

  async readAgent(
    target: string,
    source: ReadSource = "recent_unwrapped",
    lines = 80,
  ): Promise<string> {
    const result = await this.request<Record<string, unknown>>("agent.read", {
      target,
      source,
      lines,
    });
    const read = result.read as { text?: string } | undefined;
    return read?.text ?? (typeof result.text === "string" ? result.text : "");
  }

  /** Use the documented prompt method, with compatibility for herdr-hail's agent.send. */
  async promptAgent(target: string, text: string): Promise<void> {
    try {
      await this.request("agent.prompt", { target, text });
    } catch (error) {
      if (!(error instanceof HerdrError) || !isMissingMethod(error.code))
        throw error;
      await this.request("agent.send", { target, text });
    }
  }

  /** Deliver an approval to older Herdr versions without bypassing Herdr's API. */
  async sendAgent(target: string, text: string): Promise<void> {
    try {
      await this.request("agent.send", { target, text });
    } catch (error) {
      if (!(error instanceof HerdrError) || !isMissingMethod(error.code))
        throw error;
      try {
        await this.request("agent.prompt", { target, text });
      } catch (promptError) {
        // Herdr 0.8 removed the legacy agent.send method and deliberately
        // rejects agent.prompt while blocked. Its official raw pane API is
        // the portable compatibility path for a deliberate blocked reply.
        if (
          !(promptError instanceof HerdrError) ||
          promptError.code !== "agent_blocked"
        )
          throw promptError;
        await this.request("pane.send_input", {
          pane_id: target,
          text,
          keys: ["enter"],
        });
      }
    }
  }

  async waitAgent(
    target: string,
    until: string[] = ["idle", "done", "blocked"],
    timeoutMs = 120000,
  ): Promise<AgentRecord | undefined> {
    const result = await this.request<{ agent?: AgentRecord }>(
      "agent.wait",
      {
        target,
        until,
        timeout_ms: timeoutMs,
      },
      { timeoutMs: timeoutMs + 5000, retries: 0 },
    );
    return result.agent;
  }

  async cancelAgent(target: string): Promise<void> {
    await this.request("agent.send_keys", { target, keys: ["ctrl+c"] });
  }
}

function normalizeArray<T>(result: Record<string, unknown>, key: string): T[] {
  const value = result[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function isMissingMethod(code: string): boolean {
  return ["method_not_found", "unknown_method", "unsupported_method"].includes(
    code,
  );
}

function isTransientSocketError(error: unknown): boolean {
  if (error instanceof HerdrError) return false;
  if (!(error instanceof Error)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    !code ||
    [
      "ECONNREFUSED",
      "ENOENT",
      "EPIPE",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENOTFOUND",
    ].includes(code)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
