import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/discord.js";
import { RoutingStore } from "../src/routing.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "discord.js";

function fixture() {
  const routing = new RoutingStore(
    join(mkdtempSync(join(tmpdir(), "bridge-inbound-")), "routing.json"),
  );
  const adapter = new DiscordAdapter(
    {
      enabled: true,
      botToken: "",
      allowedGuildIds: ["g"],
      allowedChannelIds: ["c"],
      allowedUserIds: ["u"],
      messageContent: true,
      commandPrefix: "/herdr",
      requireMention: true,
    },
    routing,
  );
  Object.defineProperty(adapter["client"], "user", { value: { id: "bot" } });
  const prompts: string[] = [];
  const replies: string[] = [];
  adapter.onPrompt(async (_ctx, p) => {
    prompts.push(p);
  });
  const message = {
    author: { id: "u", bot: false },
    guildId: "g",
    channelId: "t",
    content: "follow up",
    attachments: new Map(),
    reference: { messageId: "r", channelId: "t" },
    fetchReference: async () => ({
      author: { id: "bot" },
      channelId: "t",
      guildId: "g",
    }),
    mentions: { has: () => false },
    channel: { id: "t", parentId: "c", isThread: () => true },
    reply: async (s: string) => {
      replies.push(s);
    },
  } as unknown as Message;
  return { adapter, message, prompts, replies };
}
test("reply to this bot in thread is accepted without another mention", async () => {
  const f = fixture();
  await f.adapter["handleMessage"](f.message);
  assert.deepEqual(f.prompts, ["follow up"]);
});
test("image-only reply reaches prompt handler", async () => {
  const f = fixture();
  f.message.content = "";
  (f.message.attachments as unknown as Map<string, object>).set("a", {
    id: "a",
    contentType: "image/png",
  });
  await f.adapter["handleMessage"](f.message);
  assert.equal(f.prompts.length, 1);
});
test("reply to a different bot does not bypass mention requirement", async () => {
  const f = fixture();
  Object.assign(f.message, {
    fetchReference: async () => ({
      author: { id: "other" },
      channelId: "t",
      guildId: "g",
    }),
  });
  await f.adapter["handleMessage"](f.message);
  assert.deepEqual(f.prompts, []);
});
function channelFixture(content: string) {
  const f = fixture();
  Object.assign(f.message, {
    content,
    reference: null,
    channelId: "c",
    channel: { id: "c", isThread: () => false },
  });
  return f;
}
test("mention in a channel is sent to the user-route agent", async () => {
  const f = channelFixture("<@bot> hi");
  f.adapter["routing"].bind({ guildId: "g", channelId: "c", userId: "u" }, {
    workspaceId: "w4",
    paneId: "w4:p1",
    terminalId: "t",
  } as never);
  await f.adapter["handleMessage"](f.message);
  assert.deepEqual(f.prompts, ["hi"]);
});
test("mention in a channel without a route gets guidance, not silence", async () => {
  const f = channelFixture("<@bot> hi");
  await f.adapter["handleMessage"](f.message);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.replies.length, 1);
});
test("unmentioned channel chatter is ignored", async () => {
  const f = channelFixture("hi");
  await f.adapter["handleMessage"](f.message);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.replies, []);
});
