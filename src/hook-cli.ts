#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { requestPermission, sendHookEvent } from "./hook-events.js";

/**
 * Claude hook 命令：從 stdin 讀 hook 輸入，把 `Stop` 轉給 bridge。任何失敗都靜默結束
 * （exit 0），不影響 Claude；bridge 沒收到時仍會用畫面 parser 收尾。
 */
async function main(): Promise<void> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const name = input.hook_event_name;
  if (name !== "Stop" && name !== "PermissionRequest") return;
  // 子 agent 的 Stop 不代表主回合結束。
  if (typeof input.agent_id === "string" && input.agent_id) return;
  if (typeof input.session_id !== "string" || !input.session_id) return;
  if (name === "PermissionRequest") {
    const decision = await requestPermission(
      {
        event: "PermissionRequest",
        sessionId: input.session_id,
        paneId: process.env.HERDR_PANE_ID || undefined,
        promptId:
          typeof input.prompt_id === "string" ? input.prompt_id : undefined,
        message: "",
        toolName: typeof input.tool_name === "string" ? input.tool_name : "",
        toolInput: JSON.stringify(input.tool_input ?? "").slice(0, 1500),
      },
      undefined,
      // 比 Claude 的 hook timeout 略短，讓我們自己先結束而不是被強制取消。
      Number(process.env.HERDR_DISCORD_HOOK_WAIT_MS) || 290000,
    );
    if (decision)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: decision },
          },
        }),
      );
    return;
  }
  await sendHookEvent({
    event: "Stop",
    sessionId: input.session_id,
    paneId: process.env.HERDR_PANE_ID || undefined,
    promptId: typeof input.prompt_id === "string" ? input.prompt_id : undefined,
    message:
      typeof input.last_assistant_message === "string"
        ? input.last_assistant_message
        : "",
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
