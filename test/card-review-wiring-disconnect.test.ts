import assert from "node:assert/strict";
import test from "node:test";
import { assertRemoteNotDisconnected } from "../src/card-review-wiring.js";
import { RemoteRoleWork, trackRemoteWork } from "../src/machine-busy.js";

// review F9：等 fetchMaterial 期間 machine 可能被手動斷線，啟動遠端操作前要用即時狀態重驗。
test("a machine disconnected after the context was built is refused, using the live answer", () => {
  let disconnected = false;
  const ctx = { isDisconnected: (id: string) => disconnected && id === "pod" };
  assert.doesNotThrow(() => assertRemoteNotDisconnected(ctx, "pod"));
  disconnected = true;
  assert.throws(() => assertRemoteNotDisconnected(ctx, "pod"), /已手動斷線/);
  assert.doesNotThrow(() => assertRemoteNotDisconnected(ctx, "other"));
  assert.doesNotThrow(() => assertRemoteNotDisconnected(undefined, "pod"));
});

test("the check runs after the work is registered, and a refusal releases it", async () => {
  const registry = new RemoteRoleWork();
  let busyDuringCheck = -1;
  await assert.rejects(
    trackRemoteWork(registry, "card-review:o/r#1", "pod", async () => {
      busyDuringCheck = registry.entries().size; // 此時並發的斷線會看到忙碌
      assertRemoteNotDisconnected({ isDisconnected: () => true }, "pod");
    }),
    /已手動斷線/,
  );
  assert.equal(busyDuringCheck, 1);
  assert.equal(registry.entries().size, 0, "拒絕後要釋放");
});
