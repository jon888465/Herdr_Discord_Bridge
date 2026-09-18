import net from "node:net";
import type { AgentProfile } from "./agent-pool.js";
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
  private workspaceNameCache = new Map<string, string | undefined>();
  private workspaceNameCacheAt = 0;
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

  async listAgentsWithWorkspaceNames(): Promise<AgentRecord[]> {
    const agents = await this.listAgents();
    const now = Date.now();
    if (now - this.workspaceNameCacheAt > 10000) {
      try {
        const workspaces = await this.listWorkspaces();
        this.workspaceNameCache = new Map(
          workspaces.map((workspace) => [
            workspace.workspace_id,
            workspace.label || workspace.name,
          ]),
        );
        this.workspaceNameCacheAt = now;
      } catch {
        return agents;
      }
    }
    return agents.map((agent) => ({
      ...agent,
      workspace_name:
        agent.workspace_name || this.workspaceNameCache.get(agent.workspace_id),
    }));
  }

  async startProfile(
    lead: AgentRecord,
    profile: AgentProfile,
    name: string,
    onPane: (paneId: string) => void,
    onStarting?: () => void,
  ): Promise<AgentRecord> {
    const liveLead = (await this.listAgents()).find(
      (a) =>
        a.pane_id === lead.pane_id &&
        a.terminal_id === lead.terminal_id &&
        a.workspace_id === lead.workspace_id,
    );
    if (!liveLead) throw new Error("Lead pane is stale; cannot create Worker");
    const cwd = liveLead.cwd || liveLead.foreground_cwd;
    if (!cwd)
      throw new Error(
        "Lead cwd unavailable; refusing to start Worker in an unrelated directory",
      );
    const layout = await this.request<{
      layout: {
        panes: Array<{
          pane_id: string;
          rect: { width: number; height: number };
        }>;
      };
    }>("pane.layout", { pane_id: liveLead.pane_id });
    const rect = layout.layout?.panes.find(
      (p) => p.pane_id === liveLead.pane_id,
    )?.rect;
    if (!rect) throw new Error("Lead pane geometry unavailable");
    const direction =
      rect.width >= 120 && rect.width >= rect.height * 2 ? "right" : "down";
    if (
      (direction === "right" && rect.width < 80) ||
      (direction === "down" && rect.height < 16)
    )
      throw new Error(
        "Lead pane is too small to split; arrange the workspace or bind an existing session",
      );
    onStarting?.();
    const result = await this.request<{
      pane: { pane_id: string; workspace_id: string };
    }>(
      "pane.split",
      {
        target_pane_id: liveLead.pane_id,
        workspace_id: liveLead.workspace_id,
        direction,
        cwd,
        focus: false,
      },
      { retries: 0 },
    );
    const pane = result.pane;
    if (!pane?.pane_id || pane.workspace_id !== lead.workspace_id)
      throw new Error("pane split returned unexpected workspace/identity");
    onPane(pane.pane_id);
    await this.request(
      "agent.start",
      {
        pane_id: pane.pane_id,
        name,
        kind: profile.kind,
        args: [
          ...(profile.args || []),
          ...(profile.model ? [profile.modelFlag!, profile.model] : []),
        ],
        timeout_ms: 30000,
      },
      { retries: 0, timeoutMs: 35000 },
    );
    const agent = (await this.listAgentsWithWorkspaceNames()).find(
      (a) => a.pane_id === pane.pane_id,
    );
    if (!agent)
      throw new Error(
        `started Agent not visible in ${pane.pane_id}; inspect before retrying`,
      );
    return agent;
  }

  async sendInput(target: string, text: string): Promise<void> {
    await this.request("pane.send_input", {
      pane_id: target,
      text,
      keys: ["enter"],
    });
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

  /** Atomically submit a normal prompt and wait for this prompt's first settled lifecycle. */
  async promptAgentAndWait(
    target: string,
    text: string,
    timeoutMs: number,
  ): Promise<AgentRecord | undefined> {
    try {
      const result = await this.request<{ agent?: AgentRecord }>(
        "agent.prompt",
        {
          target,
          text,
          // Herdr 在同一個 agent.prompt request 內等待本次 prompt 的 settled lifecycle。
          wait: {
            until: ["idle", "done", "blocked"],
            timeout_ms: timeoutMs,
          },
        },
        // Socket request 多保留 5 秒處理協定／傳輸開銷；不是 Agent 工作時間。
        { timeoutMs: timeoutMs + 5000, retries: 0 },
      );
      return result.agent;
    } catch (error) {
      if (!(error instanceof HerdrError) || !isMissingMethod(error.code))
        throw error;
      await this.promptAgent(target, text);
      // 舊版 Herdr 沒有 prompt(wait)，才拆成發送後再等待。
      return this.waitAgent(
        target,
        ["idle", "done", "blocked", "unknown"],
        timeoutMs,
      );
    }
  }

  /** Deliver an approval to older Herdr versions without bypassing Herdr's API. */
  async sendAgent(
    target: string,
    text: string,
    options: RequestOptions = {},
  ): Promise<void> {
    try {
      await this.request("agent.send", { target, text }, options);
    } catch (error) {
      if (!(error instanceof HerdrError) || !isMissingMethod(error.code))
        throw error;
      try {
        await this.request("agent.prompt", { target, text }, options);
      } catch (promptError) {
        // Herdr 0.8 removed the legacy agent.send method and deliberately
        // rejects agent.prompt while blocked. Its official raw pane API is
        // the portable compatibility path for a deliberate blocked reply.
        if (
          !(promptError instanceof HerdrError) ||
          promptError.code !== "agent_blocked"
        )
          throw promptError;
        await this.request(
          "pane.send_input",
          {
            pane_id: target,
            text,
            keys: ["enter"],
          },
          options,
        );
      }
    }
  }

  async waitAgent(
    target: string,
    until: string[] = ["idle", "done", "blocked"],
    timeoutMs = 120000,
  ): Promise<AgentRecord | undefined> {
    // 直接呼叫 agent.wait 時的 Herdr lifecycle timeout；orchestration 會傳入
    // approvalTimeoutMs，而非使用此處的 120 秒預設值。
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
