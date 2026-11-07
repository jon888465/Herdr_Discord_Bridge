import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, teamTaskTimeoutMs } from "../src/config.js";

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

test("ISSUE-124 數字字串沿用 positiveInt：接受並向下取整，與 approvalTimeoutMs 一致", () => {
  const config = withConfig(
    '{"teamTurnTimeoutMs": "2500.9", "approvalTimeoutMs": "3500.9"}',
  );
  assert.equal(config.teamTurnTimeoutMs, 2500);
  assert.equal(config.approvalTimeoutMs, 3500);
});
