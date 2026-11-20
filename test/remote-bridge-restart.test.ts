// 遠端 bridge 的偵測與重開（ISSUE-177 階段 2）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_PANE_LABEL,
  detectRemoteBridge,
  hasBridgePane,
  reopenRemoteBridge,
} from "../src/remote-bridge-restart.js";

const machine = { id: "devbox", ssh: "devbox", port: 50123, socket: "/s" };
const profile = (id: string, target: string, label = "devbox") => ({ id, label, target, enabled: true });
const panesJson = (...labels: Array<string | undefined>): string =>
  JSON.stringify({ id: "cli:pane:list", result: { panes: labels.map((label, i) => ({ pane_id: `w1:p${i}`, ...(label ? { label } : {}) })) } });
const quiet = (): void => {};
const instant = async (): Promise<void> => {};

/** 假的 herdr：machine list／--machine <id> pane list／--machine <id> plugin pane open。 */
function fake(options: {
  profiles?: ReturnType<typeof profile>[];
  /** 第幾次 pane list 開始成功（1 起算）；Infinity＝一直失敗。 */
  readyFrom?: number;
  existingBridge?: boolean;
  openFails?: boolean;
  appearsAfterOpen?: boolean;
} = {}) {
  const calls: string[][] = [];
  let listCalls = 0;
  let opened = false;
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "machine" && args[1] === "list") return JSON.stringify(options.profiles ?? [profile("new1", "ssh://devbox:50123")]);
    if (args[0] === "--machine" && args[2] === "pane" && args[3] === "list") {
      listCalls++;
      if (listCalls < (options.readyFrom ?? 1)) throw new Error("connection refused");
      return panesJson(options.existingBridge || (opened && options.appearsAfterOpen !== false) ? BRIDGE_PANE_LABEL : "other");
    }
    if (args[0] === "--machine" && args[2] === "plugin" && args[3] === "pane" && args[4] === "open") {
      if (options.openFails) throw new Error("plugin not found");
      opened = true;
      return "{}";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { run, calls, listCalls: () => listCalls, opened: () => opened };
}

test("hasBridgePane 只認標題是 Discord bridge 的 pane，格式不對一律 false", () => {
  assert.equal(hasBridgePane({ panes: [{ label: "x" }, { label: BRIDGE_PANE_LABEL }] }), true);
  assert.equal(hasBridgePane({ panes: [{ label: "x" }, {}] }), false);
  assert.equal(hasBridgePane({ panes: [null, 5] }), false);
  assert.equal(hasBridgePane({ panes: "no" }), false);
  assert.equal(hasBridgePane(undefined), false);
  assert.equal(hasBridgePane({ panes: [{ label: "discord bridge" }] }), false);
});

test("detectRemoteBridge：偵測得到回 true；查詢失敗回 false，不丟錯", async () => {
  assert.equal(await detectRemoteBridge(async () => ({ panes: [{ label: BRIDGE_PANE_LABEL }] })), true);
  assert.equal(await detectRemoteBridge(async () => ({ panes: [{ label: "x" }] })), false);
  assert.equal(await detectRemoteBridge(async () => Promise.reject(new Error("tunnel down"))), false);
});

test("重開：遠端沒有 bridge 時，用新埠的 machine 開 plugin pane，確認 pane 出現", async () => {
  const herdr = fake();
  const result = await reopenRemoteBridge(machine, herdr.run, instant, quiet);
  assert.deepEqual(result, { ok: true, note: "已重開遠端 bridge" });
  assert.deepEqual(herdr.calls.find((call) => call[2] === "plugin"), ["--machine", "new1", "plugin", "pane", "open", "--plugin", "herdr-discord-bridge", "--entrypoint", "bridge"]);
});

test("重開：遠端已經有 bridge 就不再開（避免兩個）", async () => {
  const herdr = fake({ existingBridge: true });
  assert.deepEqual(await reopenRemoteBridge(machine, herdr.run, instant, quiet), { ok: true, note: "遠端 bridge 已在執行" });
  assert.equal(herdr.opened(), false);
});

test("重開：遠端 server 還沒回來會重試，回來後才開", async () => {
  const herdr = fake({ readyFrom: 4 });
  const result = await reopenRemoteBridge(machine, herdr.run, instant, quiet);
  assert.equal(result.ok, true);
  assert.equal(herdr.opened(), true);
  assert.ok(herdr.listCalls() >= 4);
});

test("重開：遠端 server 一直沒回來，不開，請使用者自行重開", async () => {
  const herdr = fake({ readyFrom: Number.POSITIVE_INFINITY });
  const result = await reopenRemoteBridge(machine, herdr.run, instant, quiet);
  assert.equal(result.ok, false);
  assert.match(result.note, /自行重開/);
  assert.equal(herdr.opened(), false);
});

test("重開：plugin pane open 失敗、或開了但 pane 沒出現，都回報失敗並請使用者確認", async () => {
  const failed = await reopenRemoteBridge(machine, fake({ openFails: true }).run, instant, quiet);
  assert.deepEqual(failed, { ok: false, note: "重開遠端 bridge 失敗，請自行重開" });
  const missing = await reopenRemoteBridge(machine, fake({ appearsAfterOpen: false }).run, instant, quiet);
  assert.equal(missing.ok, false);
  assert.match(missing.note, /沒有看到 pane/);
});

test("重開：找不到唯一對應的 Herdr machine（沒有或多個符合）就不開", async () => {
  for (const profiles of [[], [profile("a", "ssh://devbox:50123"), profile("b", "ssh://devbox:50123", "devbox-2")]]) {
    const herdr = fake({ profiles });
    const result = await reopenRemoteBridge(machine, herdr.run, instant, quiet);
    assert.equal(result.ok, false);
    assert.equal(herdr.opened(), false);
  }
});

test("重開：同別名有舊埠與新埠兩筆時，只選新埠那筆", async () => {
  const herdr = fake({ profiles: [profile("old", "ssh://devbox:40000"), profile("new1", "ssh://devbox:50123", "devbox-x")] });
  const result = await reopenRemoteBridge(machine, herdr.run, instant, quiet);
  assert.equal(result.ok, true);
  assert.equal(herdr.calls.find((call) => call[2] === "plugin")![1], "new1");
});
