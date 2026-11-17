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

// review 第 1 輪 F2：遠端角色不經 AgentPool，準備期間也還沒有 stream。
test("a remote role counts as busy from the moment it starts preparing, before a stream or lease exists", async () => {
  const registry = new RemoteRoleWork();
  let release!: (role: { cleanup(): Promise<string> }) => void;
  const starting = trackRemoteRole(
    registry,
    "task/w1",
    "pod",
    () =>
      new Promise<{ cleanup(): Promise<string> }>((resolve) => {
        release = resolve;
      }),
  );
  // 還在 SSH checkout／啟動 agent：沒有 stream、沒有租約，但普通斷線必須看得到。
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "1 個進行中的回合",
  );
  assert.equal(
    machineBusyReason("other", { ...idle, remoteRoles: registry }),
    undefined,
    "別台機器不受影響",
  );
  let cleanups = 0;
  release({
    cleanup: async () => {
      cleanups++;
      return "";
    },
  });
  const role = await starting;
  // 啟動完成不代表結束：角色還在跑，直到 cleanup。
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "1 個進行中的回合",
  );
  await role.cleanup();
  assert.equal(cleanups, 1);
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    undefined,
  );
  // cleanup 重複呼叫沒有副作用，也不會把別的工作一起釋放。
  const other = registry.begin("task/w2", "pod");
  await role.cleanup();
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "1 個進行中的回合",
  );
  other();
});

test("a remote role that fails to start is released immediately, and a failing cleanup still releases it", async () => {
  const registry = new RemoteRoleWork();
  await assert.rejects(
    trackRemoteRole(registry, "task/w1", "pod", async () => {
      throw new Error("checkout failed");
    }),
    /checkout failed/,
  );
  assert.equal(registry.entries().size, 0, "啟動失敗不能留下殘留的忙碌紀錄");
  const role = await trackRemoteRole(registry, "task/w2", "pod", async () => ({
    cleanup: async (): Promise<string> => {
      throw new Error("cleanup failed");
    },
  }));
  assert.equal(registry.entries().size, 1);
  await assert.rejects(role.cleanup(), /cleanup failed/);
  assert.equal(
    registry.entries().size,
    0,
    "cleanup 失敗也要釋放，不能永遠卡在忙碌",
  );
});

test("remote roles are deduplicated together with streams and leases by key, per machine", () => {
  const registry = new RemoteRoleWork();
  registry.begin("task/a", "pod");
  registry.begin("task/b", "pod");
  registry.begin("task/c", "other");
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod:t1"],
      pool: { leases: [], pending: [] },
      remoteRoles: registry,
    }),
    "3 個進行中的回合",
  );
});

// review 第 2 輪 F5：card review 的遠端 reviewer 整段都在一次 await 裡。
test("trackRemoteWork counts the whole awaited remote call as busy and releases it on success or failure", async () => {
  const registry = new RemoteRoleWork();
  let finish!: (value: string) => void;
  const running = trackRemoteWork(
    registry,
    "card-review:o/r#1",
    "pod",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "1 個進行中的回合",
    "checkout、啟動 reviewer、review 回合期間都算忙碌",
  );
  finish("done");
  assert.equal(await running, "done");
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    undefined,
  );
  await assert.rejects(
    trackRemoteWork(registry, "card-review:o/r#2", "pod", async () => {
      throw new Error("review failed");
    }),
    /review failed/,
  );
  assert.equal(registry.entries().size, 0, "失敗也要釋放");
});

test("registering the same key twice does not overwrite, and finishing one does not release the other", () => {
  const registry = new RemoteRoleWork();
  const endFirst = registry.begin("task/w1", "pod");
  const endSecond = registry.begin("task/w1", "pod");
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "2 個進行中的回合",
  );
  endFirst();
  endFirst();
  assert.equal(
    machineBusyReason("pod", { ...idle, remoteRoles: registry }),
    "1 個進行中的回合",
  );
  endSecond();
  assert.equal(registry.entries().size, 0);
});
