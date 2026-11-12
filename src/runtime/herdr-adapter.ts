import {
  runtimeStatus,
  type RuntimeTarget,
  type RuntimeWaitResult,
} from "./types.js";
import { HerdrClient } from "../herdr.js";
import type { AgentRecord, ReadSource } from "../types.js";
import { assertCapability } from "./errors.js";
import {
  HERDR_OPERATIONS,
  RuntimeCapability,
  type HerdrOperation,
  type RuntimeAdapter,
  type RuntimeRequestOptions,
} from "./types.js";

/** 接受 HerdrClient 或其 HerdrHub 子類，所有 wire／重試邏輯保留在原 client。 */
export class HerdrAdapter implements RuntimeAdapter {
  readonly kind = "herdr" as const;
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(
    Object.values(RuntimeCapability),
  );
  constructor(readonly client: HerdrClient = new HerdrClient()) {}
  health() {
    return this.client.ping();
  }
  private target(record: AgentRecord): RuntimeTarget {
    return {
      id: record.pane_id,
      runtime: "herdr",
      status: runtimeStatus(record.agent_status),
      cwd: record.foreground_cwd ?? record.cwd,
      title: record.title,
    };
  }
  async listTargets() {
    return (await this.client.listAgentsWithWorkspaceNames()).map((record) =>
      this.target(record),
    );
  }
  async getTarget(target: string) {
    const record = (await this.client.listAgentsWithWorkspaceNames()).find(
      (record) => record.pane_id === target || record.terminal_id === target,
    );
    return record ? this.target(record) : undefined;
  }
  async read(target: string, source?: ReadSource, lines?: number) {
    return {
      text: await this.client.readAgent(target, source, lines),
      complete: false,
      why: "legacy_completeness_unavailable",
    };
  }
  async prompt(target: string, text: string) {
    await this.client.promptAgent(target, text);
    return { status: runtimeStatus(undefined) };
  }
  async promptAndWait(target: string, text: string, timeoutMs: number) {
    const record = await this.client.promptAgentAndWait(
      target,
      text,
      timeoutMs,
    );
    return {
      status: runtimeStatus(record?.agent_status),
      wait: this.waitResult(target, record),
    };
  }
  async send(target: string, text: string, options?: RuntimeRequestOptions) {
    await this.client.sendAgent(target, text, options);
    return { status: runtimeStatus(undefined) };
  }
  async keys(target: string, keys: string[]) {
    await this.client.sendKeys(target, keys);
    return { status: runtimeStatus(undefined) };
  }
  private waitResult(
    target: string,
    record: AgentRecord | undefined,
  ): RuntimeWaitResult {
    const status = runtimeStatus(record?.agent_status);
    return {
      target,
      ended:
        record !== undefined && ["idle", "done", "blocked"].includes(status),
      reason: record ? "legacy_status" : "legacy_unknown",
      status,
    };
  }
  async wait(target: string, until?: string[], timeoutMs?: number) {
    return this.waitResult(
      target,
      await this.client.waitAgent(target, until, timeoutMs),
    );
  }
  herdrOperation<T = unknown>(
    operation: HerdrOperation,
    params?: Record<string, unknown>,
    options?: RuntimeRequestOptions,
  ): Promise<T> {
    assertCapability(this, HERDR_OPERATIONS[operation], operation);
    return this.client.request<T>(operation, params, options);
  }
}
