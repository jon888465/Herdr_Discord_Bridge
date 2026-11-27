import test from "node:test";
import assert from "node:assert/strict";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";

type Runtime = Parameters<typeof handleCommand>[3];

function contextWithAttachments(count: number) {
  const context = createConsoleContext(() => {});
  const attachments = context.message.attachments as unknown as Map<
    string,
    object
  >;
  for (let i = 0; i < count; i++)
    attachments.set(`a${i}`, {
      id: `a${i}`,
      name: `f${i}.png`,
      contentType: "image/png",
    });
  return context;
}

/** 拒絕發生在任何 runtime 存取之前：runtime 一碰就丟出不同的錯誤，所以測得出「有沒有先擋」。 */
const untouchable = new Proxy(
  {},
  {
    get(_target, key) {
      throw new Error(`runtime.${String(key)} was touched`);
    },
  },
) as Runtime;

for (const count of [1, 3]) {
  test(`team ask rejects ${count} attachments before accessing runtime`, async () => {
    await assert.rejects(
      handleCommand(
        "team",
        ["ask", "請看附件"],
        contextWithAttachments(count),
        untouchable,
      ),
      /team ask 目前不支援附件.*一般訊息/,
    );
  });
}

for (const [command, count] of [
  ["ask", 0],
  ["discuss", 1],
] as const) {
  test(`team ${command} with ${count} attachments proceeds to runtime`, async () => {
    await assert.rejects(
      handleCommand(
        "team",
        [command, "topic"],
        contextWithAttachments(count),
        untouchable,
      ),
      /was touched/,
    );
  });
}

test("other team subcommands are not affected by an attachment", async () => {
  await assert.rejects(
    handleCommand("team", ["status"], contextWithAttachments(1), untouchable),
    (error: Error) => {
      assert.doesNotMatch(error.message, /不支援附件/);
      return true;
    },
  );
});
