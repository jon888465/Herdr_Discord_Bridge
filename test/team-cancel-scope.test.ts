import test from "node:test";
import assert from "node:assert/strict";
import { mayCancelFromWorkspace } from "../src/team-cancel-scope.js";

test("同一個 workspace 一律允許，不查 workspace 列表", async () => {
  let listed = 0;
  assert.equal(
    await mayCancelFromWorkspace("w1", "w1", async () => {
      listed++;
      return [];
    }),
    true,
  );
  assert.equal(listed, 0);
});

test("task 的 workspace 還存在時，從別的 workspace 取消仍被拒絕", async () => {
  assert.equal(
    await mayCancelFromWorkspace("w6W", "w5D", async () => ["w5D", "w6W"]),
    false,
  );
});

test("task 的 workspace 已關閉時，允許從別的 workspace 取消（ISSUE-157）", async () => {
  assert.equal(
    await mayCancelFromWorkspace("w6W", "w5D", async () => ["w5D", "w2"]),
    true,
  );
});

test("列不出 workspace 時維持拒絕", async () => {
  assert.equal(
    await mayCancelFromWorkspace("w6W", "w5D", async () => {
      throw new Error("herdr unavailable");
    }),
    false,
  );
});
