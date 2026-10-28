// Herdr Discord bridge hook for pi (ISSUE-045).
// Install: cp scripts/pi/herdr-discord-bridge.ts ~/.pi/agent/extensions/
// When a run settles, sends the final assistant message to the bridge's hook socket.
// Any failure is silent; the bridge falls back to its screen parser.
// @ts-nocheck

import net from "node:net";
import os from "node:os";
import path from "node:path";

const socketPath =
  process.env.HERDR_DISCORD_HOOK_SOCKET ||
  path.join(os.homedir(), ".config", "herdr-discord-bridge", "hooks.sock");

function lastAssistantText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || m.stopReason !== "stop") continue;
    const text = (m.content || [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function send(event) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(2000, done);
    socket.on("error", done);
    socket.on("close", done);
    socket.on("connect", () => socket.end(JSON.stringify(event) + "\n"));
  });
}

export default function (pi) {
  if (process.env.HERDR_ENV !== "1") return;
  let final = "";

  pi.on("agent_start", () => {
    final = "";
  });
  pi.on("agent_end", (event) => {
    final = lastAssistantText(event?.messages);
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (event?.aborted || ctx?.mode !== "tui" || ctx?.isIdle?.() !== true) return;
    if (!final) return;
    let sessionId;
    try {
      sessionId =
        ctx.sessionManager?.getSessionFile?.() ||
        ctx.sessionManager?.getSessionId?.();
    } catch {
      /* ignore */
    }
    if (typeof sessionId !== "string" || !sessionId) return;
    const message = final;
    final = "";
    await send({
      event: "Stop",
      sessionId,
      paneId: process.env.HERDR_PANE_ID || undefined,
      message,
    });
  });
}
