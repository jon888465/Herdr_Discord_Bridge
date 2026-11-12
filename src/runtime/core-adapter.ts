import { CoreTransport } from "./core-transport.js";
import {
  runtimeStatus,
  type RuntimeTarget,
  type RuntimeReadResult,
  type RuntimeSendResult,
  type RuntimeKeysResult,
  type RuntimeWaitResult,
} from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReadSource } from "../types.js";
import { assertCapability, RuntimeError } from "./errors.js";
import {
  HERDR_OPERATIONS,
  RuntimeCapability,
  type HerdrOperation,
  type RuntimeAdapter,
  type RuntimeRequestOptions,
} from "./types.js";

function absoluteEnvPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || !path.isAbsolute(value) || value.includes("\0"))
    throw new RuntimeError("RUNTIME_INCOMPATIBLE");
  return value;
}

/**
 * Core socket 選擇（ISSUE-151，2026-11-12 Linux 實機修正）：
 * 1. HC_SOCKET（明確指定，必須是絕對路徑）。
 * 2. 未設 HC_SESSION 且程序在 Core terminal 內時，Core 注入的 HC_TERMINAL_SOCKET
 *    （就是啟動這個 terminal 的 Core）。
 * 3. 依 session（HC_SESSION，預設 default）：Linux 的 Core 把 socket 放在
 *    `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`；macOS／未設 XDG_RUNTIME_DIR 時在
 *    `$XDG_STATE_HOME|~/.local/state/herdr-core/<session>/<session>.sock`。
 *    兩個候選都定義時取實際存在者；都不存在則取 XDG_RUNTIME_DIR 候選。
 * 不讀舊 Herdr 的 HERDR_SOCKET_PATH。
 */
export function resolveCoreSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): string {
  const explicit = absoluteEnvPath(env.HC_SOCKET);
  if (explicit !== undefined) return explicit;
  if (env.HC_SESSION === undefined) {
    const terminalSocket = absoluteEnvPath(env.HC_TERMINAL_SOCKET);
    if (terminalSocket !== undefined) return terminalSocket;
  }
  const session = env.HC_SESSION ?? "default";
  if (!/^[A-Za-z0-9_.-]+$/.test(session) || session === "." || session === "..")
    throw new RuntimeError("RUNTIME_INCOMPATIBLE");
  const runtimeDir = absoluteEnvPath(env.XDG_RUNTIME_DIR || undefined);
  const stateHome =
    absoluteEnvPath(env.XDG_STATE_HOME || undefined) ??
    path.join(home, ".local", "state");
  const candidates = [
    ...(runtimeDir === undefined
      ? []
      : [path.join(runtimeDir, "herdr-core", `${session}.sock`)]),
    path.join(stateHome, "herdr-core", session, `${session}.sock`),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

export const CORE_REQUIRED_METHODS = [
  "server.status",
  "terminal.list",
  "terminal.get",
  "terminal.read",
  "terminal.send",
  "terminal.keys",
  "terminal.wait",
];

export class CoreAdapter implements RuntimeAdapter {
  readonly kind = "core" as const;
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    RuntimeCapability.Health,
    RuntimeCapability.Targets,
    RuntimeCapability.Read,
    RuntimeCapability.Prompt,
    RuntimeCapability.Send,
    RuntimeCapability.Keys,
    RuntimeCapability.Wait,
  ]);
  readonly transport: CoreTransport;
  generation?: number;
  version?: string;
  coreId?: string;
  constructor(
    readonly socketPath: string,
    timeoutMs = 5000,
  ) {
    this.transport = new CoreTransport(socketPath, timeoutMs);
  }
  async health(): Promise<boolean> {
    const hello = await this.transport.request<Record<string, unknown>>(
      "hello",
      { generation: 1 },
    );
    if (!hello || typeof hello !== "object")
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    const missing = CORE_REQUIRED_METHODS.filter(
      (method) =>
        !Array.isArray(hello.methods) || !hello.methods.includes(method),
    );
    if (
      hello.generation !== 1 ||
      missing.length ||
      typeof hello.version !== "string" ||
      !hello.core ||
      typeof (hello.core as { id?: unknown }).id !== "string"
    )
      throw new RuntimeError("RUNTIME_INCOMPATIBLE", {
        missingMethods: missing,
      });
    const status =
      await this.transport.request<Record<string, unknown>>("server.status");
    if (
      !status ||
      status.version !== hello.version ||
      (status.core as { id?: unknown })?.id !==
        (hello.core as { id: string }).id
    )
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    this.generation = 1;
    this.version = hello.version;
    this.coreId = (hello.core as { id: string }).id;
    return true;
  }
  private target(value: CoreTerminal): RuntimeTarget {
    if (!value || typeof value.address !== "string")
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    return {
      id: value.address,
      runtime: "core",
      coreId: this.coreId,
      status:
        value.reported === true
          ? runtimeStatus(value.status?.state)
          : "unknown",
      turn: value.turn,
      cwd: value.cwd,
      title: value.title,
      name: value.name ?? undefined,
      state: value.state,
    };
  }
  async listTargets(): Promise<RuntimeTarget[]> {
    const result = await this.transport.request<{ terminals: CoreTerminal[] }>(
      "terminal.list",
    );
    if (!result || !Array.isArray(result.terminals))
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    return result.terminals.map((value) => this.target(value));
  }
  async getTarget(target: string): Promise<RuntimeTarget> {
    return this.target(
      await this.transport.request<CoreTerminal>("terminal.get", {
        terminal: target,
      }),
    );
  }
  async read(
    target: string,
    source: ReadSource = "visible",
    lines = 0,
  ): Promise<RuntimeReadResult> {
    if (source !== "visible" || lines !== 0)
      throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
        operation: `read.${source}`,
        capability: RuntimeCapability.Read,
      });
    const result = await this.transport.request<RuntimeReadResult>(
      "terminal.read",
      { terminal: target, lines: 0 },
    );
    if (
      !result ||
      typeof result.text !== "string" ||
      typeof result.complete !== "boolean"
    )
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    return result;
  }
  private async input<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    try {
      return await this.transport.request<T>(method, params, timeoutMs);
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.details.deliveryAttempted &&
        error.details.reason !== "rpc_error"
      )
        throw new RuntimeError("RUNTIME_DELIVERY_UNKNOWN", error.details);
      throw error;
    }
  }
  prompt(target: string, text: string): Promise<RuntimeSendResult> {
    return this.send(target, text);
  }
  async send(
    target: string,
    text: string,
    options: RuntimeRequestOptions = {},
  ): Promise<RuntimeSendResult> {
    const result = await this.input<{
      turn: number;
      started?: boolean | null;
      status?: string;
    }>("terminal.send", { terminal: target, text }, options.timeoutMs ?? 70000);
    if (!result || !Number.isSafeInteger(result.turn))
      throw new RuntimeError("RUNTIME_DELIVERY_UNKNOWN");
    return { ...result, status: runtimeStatus(result.status) };
  }
  async promptAndWait(
    target: string,
    text: string,
    timeoutMs: number,
  ): Promise<RuntimeSendResult> {
    const result = await this.input<{
      turn: number;
      started?: boolean | null;
      status?: string;
      wait?: CoreWait;
    }>(
      "terminal.send",
      { terminal: target, text, wait: true, timeout: timeoutMs / 1000 },
      timeoutMs + 70000,
    );
    if (!result || !Number.isSafeInteger(result.turn))
      throw new RuntimeError("RUNTIME_DELIVERY_UNKNOWN");
    return {
      ...result,
      status: runtimeStatus(result.status),
      wait: result.wait ? this.waitResult(result.wait) : undefined,
    };
  }
  async keys(target: string, keys: string[]): Promise<RuntimeKeysResult> {
    const result = await this.input<{ turn: number; status?: string }>(
      "terminal.keys",
      { terminal: target, keys },
      10000,
    );
    if (!result || !Number.isSafeInteger(result.turn))
      throw new RuntimeError("RUNTIME_DELIVERY_UNKNOWN");
    return { ...result, status: runtimeStatus(result.status) };
  }
  private waitResult(result: CoreWait): RuntimeWaitResult {
    if (
      !result ||
      typeof result.terminal !== "string" ||
      typeof result.ended !== "boolean" ||
      typeof result.reason !== "string" ||
      !Number.isSafeInteger(result.turn)
    )
      throw new RuntimeError("RUNTIME_INCOMPATIBLE");
    return {
      target: result.terminal,
      ended: result.ended,
      reason: result.reason,
      turn: result.turn,
      status: runtimeStatus(result.status),
    };
  }
  async wait(
    target: string,
    until?: string[],
    timeoutMs = 120000,
  ): Promise<RuntimeWaitResult> {
    if (until !== undefined)
      throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
        operation: "wait.until",
        capability: RuntimeCapability.Wait,
      });
    return this.waitResult(
      await this.transport.request<CoreWait>(
        "terminal.wait",
        { terminal: target, timeout: timeoutMs / 1000 },
        timeoutMs + 5000,
      ),
    );
  }
  async herdrOperation<T = unknown>(
    operation: HerdrOperation,
    _params?: Record<string, unknown>,
    _options?: RuntimeRequestOptions,
  ): Promise<T> {
    assertCapability(this, HERDR_OPERATIONS[operation], operation);
    throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
      operation,
      capability: HERDR_OPERATIONS[operation],
    });
  }
}
interface CoreTerminal {
  name?: string | null;
  state?: string;
  address: string;
  reported?: boolean;
  status?: { state?: string } | null;
  turn?: number;
  cwd?: string;
  title?: string;
}
interface CoreWait {
  terminal: string;
  ended: boolean;
  reason: string;
  turn: number;
  status?: string | null;
}
