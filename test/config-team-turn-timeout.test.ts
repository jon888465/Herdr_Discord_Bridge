import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, teamTaskTimeoutMs } from "../src/config.js";
import { RoutingStore } from "../src/routing.js";

function withConfig(json: string): ReturnType<typeof loadConfig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-turn-"));
  const previous = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    fs.writeFileSync(path.join(dir, "config.json"), json);
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    return loadConfig();
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ISSUE-124 teamTurnTimeoutMs 預設 30 分鐘，approvalTimeoutMs 維持 15 分鐘", () => {
  const config = withConfig("{}");
  assert.equal(config.teamTurnTimeoutMs, 1800000);
  assert.equal(config.approvalTimeoutMs, 900000);
});

test("ISSUE-124 teamTurnTimeoutMs 有效覆寫不影響 approvalTimeoutMs", () => {
  const config = withConfig('{"teamTurnTimeoutMs": 2400000}');
  assert.equal(config.teamTurnTimeoutMs, 2400000);
  assert.equal(config.approvalTimeoutMs, 900000);
  const other = withConfig('{"approvalTimeoutMs": 1000}');
  assert.equal(other.approvalTimeoutMs, 1000);
  assert.equal(other.teamTurnTimeoutMs, 1800000);
});

test("ISSUE-124 teamTurnTimeoutMs 無效值回到預設且不拋出", () => {
  for (const value of ["-5", "0", '"abc"', "null", '"-1"', "{}"]) {
    const config = withConfig(`{"teamTurnTimeoutMs": ${value}}`);
    assert.equal(config.teamTurnTimeoutMs, 1800000, value);
  }
});

// review F1：JSON 物件的 toString 不是函式時，Number() 會拋 TypeError；設定值不可讓 bridge 無法啟動。
// positiveInt 是所有數值設定共用的，approvalTimeoutMs 也要一樣安全。
test("ISSUE-124 物件值（toString 不是函式）回到預設，不會讓 loadConfig 拋出", () => {
  for (const value of ['{"toString": null}', '{"valueOf": 1, "toString": 2}']) {
    const config = withConfig(
      `{"teamTurnTimeoutMs": ${value}, "approvalTimeoutMs": ${value}}`,
    );
    assert.equal(config.teamTurnTimeoutMs, 1800000, value);
    assert.equal(config.approvalTimeoutMs, 900000, value);
  }
});

test("ISSUE-124 Team 回合上限取自 teamTurnTimeoutMs，與 approvalTimeoutMs 互不影響", () => {
  const a = withConfig(
    '{"teamTurnTimeoutMs": 4000, "approvalTimeoutMs": 9000}',
  );
  assert.equal(teamTaskTimeoutMs(a), 4000);
  assert.equal(a.approvalTimeoutMs, 9000);
  const b = withConfig('{"approvalTimeoutMs": 5000}');
  assert.equal(teamTaskTimeoutMs(b), 1800000);
  assert.equal(b.approvalTimeoutMs, 5000);
  const c = withConfig('{"teamTurnTimeoutMs": 6000}');
  assert.equal(teamTaskTimeoutMs(c), 6000);
  assert.equal(c.approvalTimeoutMs, 900000);
});

// review F5：用兩個「不同」的設定值驗證批准提示的實際有效期。
// DiscordAdapter 建立批准提示時把 approvalTimeoutMs 交給 RoutingStore.createApproval，有效期由它計算。
test("ISSUE-124 批准提示的有效期是 approvalTimeoutMs，不受 teamTurnTimeoutMs 影響", () => {
  const config = withConfig(
    '{"teamTurnTimeoutMs": 4000, "approvalTimeoutMs": 9000}',
  );
  assert.notEqual(config.teamTurnTimeoutMs, config.approvalTimeoutMs);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "approval-expiry-"));
  try {
    const store = new RoutingStore(path.join(directory, "state.json"));
    const approval = store.createApproval({
      discordGuildId: "g",
      discordChannelId: "c",
      discordThreadId: "t",
      discordMessageId: "m",
      terminalId: "term-1",
      workspaceId: "w1",
      paneId: "w1:p1",
      agentName: "builder",
      timeoutMs: config.approvalTimeoutMs,
    });
    const lifetime =
      Date.parse(approval.expiresAt) - Date.parse(approval.createdAt);
    assert.equal(lifetime, 9000);
    assert.notEqual(lifetime, config.teamTurnTimeoutMs);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// 接線守門（讀原始碼，不是端到端）：批准提示相關的程式仍只接 approvalTimeoutMs，
// teamTurnTimeoutMs 只透過 teamTaskTimeoutMs() 進入 Team 任務。日後有人誤把批准提示接到新設定，這個測試會失敗。
test("ISSUE-124 接線守門：批准提示仍接 approvalTimeoutMs，teamTurnTimeoutMs 只用於 Team 任務", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  assert.match(
    main,
    /new DiscordAdapter\(\s*config\.discord,\s*routing,\s*config\.approvalTimeoutMs,?\s*\)/,
  );
  assert.match(main, /timeoutMs:\s*teamTaskTimeoutMs\(runtime\.config\)/);
  const code = main
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(/\bteamTurnTimeoutMs\b/.test(code), false);
  for (const file of ["src/discord.ts", "src/routing.ts"])
    assert.equal(
      /teamTurnTimeoutMs/.test(fs.readFileSync(file, "utf8")),
      false,
      file,
    );
});

test("ISSUE-124 數字字串沿用 positiveInt：接受並向下取整，與 approvalTimeoutMs 一致", () => {
  const config = withConfig(
    '{"teamTurnTimeoutMs": "2500.9", "approvalTimeoutMs": "3500.9"}',
  );
  assert.equal(config.teamTurnTimeoutMs, 2500);
  assert.equal(config.approvalTimeoutMs, 3500);
});
