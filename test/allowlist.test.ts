import test from "node:test";
import assert from "node:assert/strict";
import { emptyDiscordAllowlists, inAllowlist } from "../src/allowlist.js";

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
