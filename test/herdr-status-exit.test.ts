import assert from "node:assert/strict";
import test from "node:test";
import { settleHerdrOutput } from "../src/herdr-machine-sync.js";

const exit = (code: number) =>
  Object.assign(new Error("Command failed"), { code });
const json = '[{"id":"a","label":"x","status":"error"}]';

test("machine status 非零 exit 但有 JSON：照常使用輸出", () => {
  assert.equal(
    settleHerdrOutput(["machine", "status", "--json"], exit(1), json),
    json,
  );
});

test("其他情況仍丟錯：無輸出、逾時被殺、非 status 指令、spawn 失敗", () => {
  assert.throws(() =>
    settleHerdrOutput(["machine", "status", "--json"], exit(1), "  "),
  );
  assert.throws(() =>
    settleHerdrOutput(
      ["machine", "status", "--json"],
      Object.assign(exit(1), { killed: true }),
      json,
    ),
  );
  assert.throws(() => settleHerdrOutput(["machine", "add", "x"], exit(1), json));
  assert.throws(() =>
    settleHerdrOutput(
      ["machine", "status", "--json"],
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      json,
    ),
  );
});

test("成功就原樣回傳", () => {
  assert.equal(
    settleHerdrOutput(["machine", "list", "--json"], null, json),
    json,
  );
});
