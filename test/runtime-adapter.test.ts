import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient } from "../src/herdr.js";
import { HerdrAdapter } from "../src/runtime/herdr-adapter.js";
import { CoreAdapter } from "../src/runtime/core-adapter.js";
import { RuntimeError, assertCapability } from "../src/runtime/errors.js";
import {
  HERDR_OPERATIONS,
  RuntimeCapability,
  type HerdrOperation,
} from "../src/runtime/types.js";

test("Herdr adapter 宣告全部能力且不改 wire method 或重試參數", async () => {
  const calls: unknown[] = [];
  class FakeClient extends HerdrClient {
    override async request<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: { retries?: number; timeoutMs?: number },
    ): Promise<T> {
      calls.push({ method, params, options });
      return {} as T;
    }
  }
  const adapter = new HerdrAdapter(new FakeClient());
  for (const capability of Object.values(RuntimeCapability))
    assert.doesNotThrow(() => assertCapability(adapter, capability, "test"));
  const params = { pane_id: "w1:p1" };
  const options = { retries: 0, timeoutMs: 1234 };
  await adapter.herdrOperation("pane.get", params, options);
  assert.deepEqual(calls, [{ method: "pane.get", params, options }]);
});

test("Core 逐項拒絕所有 Herdr 專屬操作並包含操作名", async () => {
  const adapter = new CoreAdapter("/tmp/not-connected.sock");
  assert.equal(adapter.capabilities.has(RuntimeCapability.Workspace), false);
  for (const operation of Object.keys(HERDR_OPERATIONS) as HerdrOperation[]) {
    await assert.rejects(
      adapter.herdrOperation(operation),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "RUNTIME_UNSUPPORTED_OPERATION" &&
        error.message.includes(operation),
    );
  }
});
