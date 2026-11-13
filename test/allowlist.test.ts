import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyDiscordAllowlists,
  inAllowlist,
  nonStringAllowlistKeys,
} from "../src/allowlist.js";

test("白名單留空一律拒絕，非空只放行列出的 ID", () => {
  assert.equal(inAllowlist([], "u"), false);
  assert.equal(inAllowlist(["u"], "u"), true);
  assert.equal(inAllowlist(["u"], "x"), false);
});

test("emptyDiscordAllowlists 列出空的欄位", () => {
  assert.deepEqual(
    emptyDiscordAllowlists({
      allowedGuildIds: ["g"],
      allowedChannelIds: [],
      allowedUserIds: [],
    }),
    ["allowedChannelIds", "allowedUserIds"],
  );
  assert.deepEqual(
    emptyDiscordAllowlists({
      allowedGuildIds: ["g"],
      allowedChannelIds: ["c"],
      allowedUserIds: ["u"],
    }),
    [],
  );
});

test("nonStringAllowlistKeys 找出含數字項目的欄位（數字寫法會失真）", () => {
  assert.deepEqual(
    nonStringAllowlistKeys({
      allowedGuildIds: [1506558362546995340],
      allowedChannelIds: ["1"],
      allowedUserIds: [],
    }),
    ["allowedGuildIds"],
  );
  assert.deepEqual(nonStringAllowlistKeys({}), []);
});
