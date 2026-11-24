import test from "node:test";
import assert from "node:assert/strict";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";

/**
 * ISSUE-190：`team ask`／`team discuss` 的程式完全沒有處理附件，附件被默默丟掉，Agent 照純文字回答。
 * 選項 1：指令帶附件時直接拒絕並說明；附件是否真的交給 Agent 是後續需求（另開需求卡），這裡不處理。
 */
type Runtime = Parameters<typeof handleCommand>[3];

function contextWithAttachments(count: number) {
  const context = createConsoleContext(() => {});
  const attachments = context.message.attachments as unknown as Map<string, object>;
  for (let i = 0; i < count; i++)
    attachments.set(`a${i}`, { id: `a${i}`, name: `f${i}.png`, contentType: "image/png" });
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

for (const command of ["ask", "discuss"] as const) {
  test(`team ${command} with an attachment is rejected with a clear message before anything else runs`, async () => {
    await assert.rejects(
      handleCommand("team", [command, "請看附件"], contextWithAttachments(1), untouchable),
      (error: Error) => {
        assert.match(error.message, new RegExp(`team ${command} 目前不支援附件`));
        assert.match(error.message, /一般訊息/);
        assert.doesNotMatch(error.message, /runtime\./);
        return true;
      },
    );
  });

  test(`team ${command} with several attachments is rejected the same way`, async () => {
    await assert.rejects(
      handleCommand("team", [command, "請看附件"], contextWithAttachments(3), untouchable),
      new RegExp(`team ${command} 目前不支援附件`),
    );
  });

  test(`team ${command} without attachments is not rejected for attachments`, async () => {
    await assert.rejects(
      handleCommand("team", [command, "純文字"], contextWithAttachments(0), untouchable),
      (error: Error) => {
        assert.doesNotMatch(error.message, /不支援附件/);
        assert.match(error.message, /was touched/);
        return true;
      },
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
