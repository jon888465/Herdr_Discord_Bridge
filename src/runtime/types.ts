import type { ReadSource } from "../types.js";

export type RuntimeKind = "herdr" | "core";

export enum RuntimeCapability {
  Health = "health",
  Targets = "targets",
  Read = "read",
  Prompt = "prompt",
  Send = "send",
  Keys = "keys",
  Wait = "wait",
  Workspace = "workspace",
  Pane = "pane",
  Tab = "tab",
  Worktree = "worktree",
  AgentStart = "agent-start",
  RawInput = "raw-input",
  Snapshot = "snapshot",
}

/** 只容許 bridge 已使用的 Herdr 專屬操作；Core 不轉送這些名稱。 */
export const HERDR_OPERATIONS = {
  "workspace.list": RuntimeCapability.Workspace,
  "workspace.create": RuntimeCapability.Workspace,
  "workspace.close": RuntimeCapability.Workspace,
  "session.snapshot": RuntimeCapability.Snapshot,
  "pane.get": RuntimeCapability.Pane,
  "pane.layout": RuntimeCapability.Pane,
  "pane.split": RuntimeCapability.Pane,
  "pane.rename": RuntimeCapability.Pane,
  "pane.close": RuntimeCapability.Pane,
  "pane.send_input": RuntimeCapability.RawInput,
  "tab.create": RuntimeCapability.Tab,
  "tab.rename": RuntimeCapability.Tab,
  "worktree.list": RuntimeCapability.Worktree,
  "worktree.create": RuntimeCapability.Worktree,
  "worktree.remove": RuntimeCapability.Worktree,
  "agent.start": RuntimeCapability.AgentStart,
} as const;
export type HerdrOperation = keyof typeof HERDR_OPERATIONS;

export interface RuntimeRequestOptions {
  timeoutMs?: number;
  retries?: number;
}

export type RuntimeStatus =
  "idle" | "working" | "done" | "blocked" | "error" | "unknown";
export interface RuntimeTarget {
  id: string;
  runtime: RuntimeKind;
  status: RuntimeStatus;
  turn?: number;
  cwd?: string;
  title?: string;
  coreId?: string;
  name?: string;
  state?: string;
}
export interface RuntimeReadResult {
  text: string;
  complete: boolean;
  why?: string | null;
  how?: string;
}
export interface RuntimeSendResult {
  turn?: number;
  started?: boolean | null;
  status: RuntimeStatus;
  wait?: RuntimeWaitResult;
}
export interface RuntimeKeysResult {
  turn?: number;
  status: RuntimeStatus;
}
export interface RuntimeWaitResult {
  target: string;
  ended: boolean;
  reason: string;
  turn?: number;
  status: RuntimeStatus;
}
export function runtimeStatus(value: unknown): RuntimeStatus {
  return typeof value === "string" &&
    ["idle", "working", "done", "blocked", "error"].includes(value)
    ? (value as RuntimeStatus)
    : "unknown";
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  health(): Promise<boolean>;
  listTargets(): Promise<RuntimeTarget[]>;
  getTarget(target: string): Promise<RuntimeTarget | undefined>;
  read(
    target: string,
    source?: ReadSource,
    lines?: number,
  ): Promise<RuntimeReadResult>;
  prompt(target: string, text: string): Promise<RuntimeSendResult>;
  promptAndWait(
    target: string,
    text: string,
    timeoutMs: number,
  ): Promise<RuntimeSendResult>;
  send(
    target: string,
    text: string,
    options?: RuntimeRequestOptions,
  ): Promise<RuntimeSendResult>;
  keys(target: string, keys: string[]): Promise<RuntimeKeysResult>;
  wait(
    target: string,
    until?: string[],
    timeoutMs?: number,
  ): Promise<RuntimeWaitResult>;
  herdrOperation<T = unknown>(
    operation: HerdrOperation,
    params?: Record<string, unknown>,
    options?: RuntimeRequestOptions,
  ): Promise<T>;
}
