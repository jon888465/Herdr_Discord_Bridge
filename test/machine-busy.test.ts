import test from "node:test";
import assert from "node:assert/strict";
import {
  machineBusyReason,
  RemoteRoleWork,
  trackRemoteRole,
  trackRemoteWork,
} from "../src/machine-busy.js";

const idle = { activeTerminals: [], pool: { leases: [], pending: [] } };

test("busy reason covers active prefix, pane prefix, machine field, pending and terminal dedup", () => {
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod:t1", "pod2:t2", "local"],
      pool: {
        leases: [
          { key: "a", paneId: "pod:p1", terminalId: "pod:t1" },
          { key: "b", paneId: "pod:p2", terminalId: "t2" },
          { key: "c", machine: "pod", terminalId: "t3" },
        ],
        pending: [
          { key: "d", workspace: "pod:w1" },
          { key: "b", paneId: "pod:p2", terminalId: "t2" },
        ],
      },
    }),
    "4 個進行中的回合",
  );
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod2:t"],
      pool: { leases: [], pending: [{ key: "local/a", workspace: "local" }] },
    }),
    undefined,
  );
});

const busy = (registry: RemoteRoleWork, machine = "pod") =>
  machineBusyReason(machine, { ...idle, remoteRoles: registry });

test("a remote role is busy from the start of preparing until cleanup, and only for its own machine (review F2)", async () => {
  const registry = new RemoteRoleWork();
  let release!: (role: { cleanup(): Promise<string> }) => void;
  const starting = trackRemoteRole(
    registry,
    "task/w1",
    "pod",
    () =>
      new Promise<{ cleanup(): Promise<string> }>(
        (resolve) => (release = resolve),
      ),
  );
  assert.equal(
    busy(registry),
    "1 個進行中的回合",
    "準備中：沒有 stream、沒有租約",
  );
  assert.equal(busy(registry, "other"), undefined);
  release({ cleanup: async () => "" });
  const role = await starting;
  assert.equal(busy(registry), "1 個進行中的回合", "啟動完成不代表結束");
  await role.cleanup();
  assert.equal(busy(registry), undefined);
  await role.cleanup(); // 重複 cleanup 沒有副作用
});

test("failures release the work: failed start, failing cleanup and failing awaited call (review F2, F5)", async () => {
  const registry = new RemoteRoleWork();
  await assert.rejects(
    trackRemoteRole(registry, "a", "pod", async () => {
      throw new Error("checkout failed");
    }),
    /checkout failed/,
  );
  const role = await trackRemoteRole(registry, "b", "pod", async () => ({
    cleanup: async (): Promise<string> => {
      throw new Error("cleanup failed");
    },
  }));
  assert.equal(registry.entries().size, 1);
  await assert.rejects(role.cleanup(), /cleanup failed/);
  await assert.rejects(
    trackRemoteWork(registry, "c", "pod", async () => {
      throw new Error("review failed");
    }),
    /review failed/,
  );
  assert.equal(registry.entries().size, 0);
});

test("trackRemoteWork counts the awaited call, the same key twice does not overwrite, and roles dedupe with streams (review F5)", async () => {
  const registry = new RemoteRoleWork();
  let finish!: (value: string) => void;
  const running = trackRemoteWork(
    registry,
    "card-review:o/r#1",
    "pod",
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  const endSecond = registry.begin("card-review:o/r#1", "pod"); // 同 key 重複登記
  assert.equal(busy(registry), "2 個進行中的回合");
  finish("done");
  assert.equal(await running, "done");
  assert.equal(busy(registry), "1 個進行中的回合", "先結束的不會釋放另一份");
  registry.begin("task/other", "other");
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod:t1"],
      pool: idle.pool,
      remoteRoles: registry,
    }),
    "2 個進行中的回合",
    "一個 stream 加一份遠端工作",
  );
  endSecond();
  assert.equal(busy(registry), undefined);
});
