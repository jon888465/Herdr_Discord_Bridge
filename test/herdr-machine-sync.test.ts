import assert from "node:assert/strict";
import test from "node:test";
import {
  matchHerdrProfiles,
  parseHerdrProfiles,
  syncHerdrMachine,
} from "../src/herdr-machine-sync.js";

const profile = (id: string, label: string, target: string, enabled = true) => ({ id, label, target, enabled });
const listing = (...items: unknown[]) => JSON.stringify(items);
const machine = { id: "pod", ssh: "pod-alias", socket: "/s" };

/** 記錄每次呼叫的 herdr 參數；list 回傳給定的輸出。 */
function fakeRunner(output: string | Error) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "list") {
      if (output instanceof Error) throw output;
      return output;
    }
    return "";
  };
  return { calls, run };
}

test("parseHerdrProfiles 只收欄位齊全的項目，非陣列丟錯", () => {
  assert.deepEqual(
    parseHerdrProfiles(listing(profile("1", "a", "t"), { id: "2" }, null)),
    [profile("1", "a", "t")],
  );
  assert.throws(() => parseHerdrProfiles("{}"));
});

test("matchHerdrProfiles：有 ssh 比 target，沒有 ssh 比 label", () => {
  const profiles = [profile("1", "pod", "other"), profile("2", "x", "pod-alias")];
  assert.deepEqual(matchHerdrProfiles(machine, profiles).map((p) => p.id), ["2"]);
  assert.deepEqual(
    matchHerdrProfiles({ id: "pod", socket: "/s" }, profiles).map((p) => p.id),
    ["1"],
  );
});

test("斷線停用、連線啟用；狀態已一致不再呼叫", async () => {
  const off = fakeRunner(listing(profile("p1", "pod", "pod-alias", true)));
  assert.equal(await syncHerdrMachine(machine, false, off.run), "Herdr 側邊欄已停用");
  assert.deepEqual(off.calls, [["machine", "list", "--json"], ["machine", "disable", "p1"]]);

  const on = fakeRunner(listing(profile("p1", "pod", "pod-alias", false)));
  assert.equal(await syncHerdrMachine(machine, true, on.run), "Herdr 側邊欄已啟用");
  assert.deepEqual(on.calls[1], ["machine", "enable", "p1"]);

  const same = fakeRunner(listing(profile("p1", "pod", "pod-alias", true)));
  assert.equal(await syncHerdrMachine(machine, true, same.run), undefined);
  assert.equal(same.calls.length, 1);
});

test("沒有對應的 profile 不動作也不報錯；多筆符合不猜", async () => {
  const none = fakeRunner(listing(profile("p1", "elsewhere", "elsewhere")));
  assert.equal(await syncHerdrMachine(machine, false, none.run), undefined);
  assert.equal(none.calls.length, 1);

  const many = fakeRunner(listing(profile("p1", "a", "pod-alias"), profile("p2", "b", "pod-alias")));
  assert.equal(await syncHerdrMachine(machine, false, many.run), "Herdr 有多個符合的 machine，沒有同步");
  assert.equal(many.calls.length, 1);

  assert.equal(await syncHerdrMachine(undefined, false, none.run), undefined);
});

test("herdr 指令失敗或輸出不合法只回說明，不丟錯", async () => {
  assert.equal(
    await syncHerdrMachine(machine, false, fakeRunner(new Error("boom")).run),
    "Herdr 側邊欄沒有同步成功",
  );
  assert.equal(
    await syncHerdrMachine(machine, false, fakeRunner("not json").run),
    "Herdr 側邊欄沒有同步成功",
  );
  const failing = async (args: string[]) => {
    if (args[1] === "list") return listing(profile("p1", "pod", "pod-alias", true));
    throw new Error("disable failed");
  };
  assert.equal(await syncHerdrMachine(machine, false, failing), "Herdr 側邊欄沒有同步成功");
});
