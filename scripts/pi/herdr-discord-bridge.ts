// Herdr Discord bridge hook for pi (ISSUE-045).
// Install: cp scripts/pi/herdr-discord-bridge.ts ~/.pi/agent/extensions/
// When a run settles, sends the final assistant message to the bridge's hook socket.
// Any failure is silent; the bridge falls back to its screen parser.
// @ts-nocheck

import fs from "node:fs";
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

// ISSUE-226：這台 machine 同時被另一個（本機）bridge 透過 `ssh -R` 驅動時，事件也要送到那個 bridge 的 socket，
// 而且 paneId 要帶 machine 前綴（與 bridge 看到的遠端 pane_id 相同，見 scripts/remote/herdr-discord-hook.py 的 `--machine`）。
// 額外的目標寫在 `~/.config/herdr-discord-bridge/extra-hook-targets.json`：`[{ "socket": "/abs/path.sock", "machine": "<id>" }]`，
// 每次事件都重讀，改檔不用重開 pi；檔案不存在或壞掉就只送預設 socket（與以前完全相同）。
function extraTargets() {
  try {
    const file = path.join(os.homedir(), ".config", "herdr-discord-bridge", "extra-hook-targets.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(parsed) ? parsed : []).filter(
      (t) => t && typeof t.socket === "string" && t.socket.startsWith("/") && t.socket !== socketPath,
    );
  } catch {
    return [];
  }
}

async function sendAll(event) {
  await send(event);
  for (const target of extraTargets()) {
    const paneId =
      event.paneId && typeof target.machine === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(target.machine)
        ? `${target.machine}:${event.paneId}`
        : event.paneId;
    await send({ ...event, paneId }, target.socket);
  }
}

function send(event, file = socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(file);
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
    await sendAll({
      event: "Stop",
      sessionId,
      paneId: process.env.HERDR_PANE_ID || undefined,
      message,
    });
  });
}
