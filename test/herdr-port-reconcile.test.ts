import assert from "node:assert/strict";
import test from "node:test";
import { reconcileHerdrPort } from "../src/herdr-machine-sync.js";

interface FakeProfile {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
}

const machine = { id: "devbox", ssh: "devbox", port: 50123, socket: "/s" };

/** 模擬 herdr machine：list／status／add／remove／rename／disable，可指定哪個指令失敗、新的是否 reachable。 */
function fakeHerdr(
  initial: FakeProfile[],
  options: { failOn?: string; reachable?: boolean } = {},
) {
  const profiles = initial.map((p) => ({ ...p }));
  const calls: string[] = [];
  let next = 1;
  /** 實機量到：`status` 約 4.4 秒、`add` 約 4.5 秒；預設逾時 2 秒，給的逾時不夠就像 execFile 一樣失敗。 */
  const run = async (args: string[], timeoutMs = 2000): Promise<string> => {
    const [, verb] = args;
    calls.push(args.slice(1).join(" "));
    if ((verb === "status" && timeoutMs < 4500) || (verb === "add" && timeoutMs < 5000))
      throw new Error("timed out");
    if (options.failOn === verb) throw new Error("boom");
    if (verb === "list") return JSON.stringify(profiles);
    if (verb === "status")
      return JSON.stringify(
        profiles.map((p) => ({
          id: p.id,
          label: p.label,
          status: p.id.startsWith("new") && options.reachable === false ? "error" : "reachable",
        })),
      );
    if (verb === "add") {
      profiles.push({
        id: `new${next++}`,
        label: args[args.indexOf("--label") + 1]!,
        target: args[2]!,
        enabled: true,
      });
      return "Saved";
    }
    if (verb === "remove") {
      profiles.splice(profiles.findIndex((p) => p.id === args[2]), 1);
      return "Removed";
    }
    if (verb === "rename") {
      profiles.find((p) => p.id === args[2])!.label = args[4]!;
      return "Renamed";
    }
    if (verb === "disable") {
      profiles.find((p) => p.id === args[2])!.enabled = false;
      return "ok";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { run, calls, profiles };
}

const noWait = async (): Promise<void> => undefined;
const old = (target: string, enabled = true): FakeProfile => ({
  id: "old1",
  label: "devbox",
  target,
  enabled,
});

test("舊埠的 profile 換成新埠：新增→確認 reachable→移除舊的→改回原 label", async () => {
  const h = fakeHerdr([old("ssh://devbox:49233")]);
  assert.equal(
    await reconcileHerdrPort(machine, h.run, noWait),
    "Herdr 側邊欄已更新到埠 50123",
  );
  assert.deepEqual(h.profiles, [
    { id: "new1", label: "devbox", target: "ssh://devbox:50123", enabled: true },
  ]);
  const verbs = h.calls.map((c) => c.split(" ")[0]);
  assert.ok(verbs.indexOf("add") < verbs.indexOf("remove"), "先新增再移除");
  assert.ok(verbs.indexOf("status") < verbs.indexOf("remove"), "確認 reachable 才移除");
});

test("原本停用的維持停用", async () => {
  const h = fakeHerdr([old("ssh://devbox:49233", false)]);
  await reconcileHerdrPort(machine, h.run, noWait);
  assert.equal(h.profiles[0]!.enabled, false);
  assert.equal(h.profiles[0]!.target, "ssh://devbox:50123");
});

test("已有 target 完全相同、沒有舊 profile、或不是別名加埠的設定：什麼都不做", async () => {
  for (const [config, profiles] of [
    [machine, [old("ssh://devbox:50123")]],
    [machine, [old("ssh://other:49233")]],
    [machine, []],
    [{ ...machine, host: "1.2.3.4" }, [old("ssh://devbox:49233")]],
    [{ id: "devbox", ssh: "devbox", socket: "/s" }, [old("ssh://devbox:49233")]],
    [undefined, [old("ssh://devbox:49233")]],
  ] as const) {
    const h = fakeHerdr([...profiles]);
    assert.equal(await reconcileHerdrPort(config, h.run, noWait), undefined);
    assert.ok(h.calls.every((c) => c.startsWith("list")), "只讀取");
  }
});

test("同別名不同埠有多筆：不猜、不改", async () => {
  const h = fakeHerdr([
    old("ssh://devbox:49233"),
    { id: "old2", label: "devbox2", target: "ssh://devbox:40000", enabled: true },
  ]);
  assert.equal(
    await reconcileHerdrPort(machine, h.run, noWait),
    "Herdr 有多個同別名不同埠的 machine，沒有更新埠",
  );
  assert.equal(h.profiles.length, 2);
  assert.ok(h.calls.every((c) => c.startsWith("list")));
});

test("新的連不上：移除剛新增的，舊的原封不動", async () => {
  const h = fakeHerdr([old("ssh://devbox:49233")], { reachable: false });
  assert.equal(
    await reconcileHerdrPort(machine, h.run, noWait),
    "Herdr 側邊欄的埠沒有更新成功，保留原設定",
  );
  assert.deepEqual(h.profiles, [old("ssh://devbox:49233")]);
});

test("新增失敗：沒有動任何 profile；移除舊的失敗：復原剛新增的", async () => {
  const addFail = fakeHerdr([old("ssh://devbox:49233")], { failOn: "add" });
  assert.match((await reconcileHerdrPort(machine, addFail.run, noWait))!, /沒有更新成功/);
  assert.deepEqual(addFail.profiles, [old("ssh://devbox:49233")]);

  const removeFail = fakeHerdr([old("ssh://devbox:49233")], { failOn: "remove" });
  assert.match((await reconcileHerdrPort(machine, removeFail.run, noWait))!, /沒有更新成功/);
  assert.deepEqual(removeFail.profiles.map((p) => p.id).sort(), ["new1", "old1"].sort(), "復原的移除也失敗，只留下多的一筆");
});

test("改名失敗：不再移除新的，說明目前標籤", async () => {
  const h = fakeHerdr([old("ssh://devbox:49233")], { failOn: "rename" });
  assert.match((await reconcileHerdrPort(machine, h.run, noWait))!, /目前標籤 devbox-new/);
  assert.deepEqual(h.profiles.map((p) => p.target), ["ssh://devbox:50123"]);
});

test("list 失敗：回固定說明，不丟錯", async () => {
  const h = fakeHerdr([], { failOn: "list" });
  assert.equal(
    await reconcileHerdrPort(machine, h.run, noWait),
    "Herdr 側邊欄的埠沒有更新成功，保留原設定",
  );
});
