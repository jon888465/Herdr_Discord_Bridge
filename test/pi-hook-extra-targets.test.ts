import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// scripts/pi 的 extension 是純 JS（只有 @ts-nocheck），複製成 .mjs 在暫時 HOME 下載入，不依賴 Node 的 type stripping。
async function load(home: string, defaultSocket: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-"));
  const file = path.join(dir, "ext.mjs");
  fs.copyFileSync(path.join(process.cwd(), "scripts/pi/herdr-discord-bridge.ts"), file);
  process.env.HOME = home;
  process.env.HERDR_DISCORD_HOOK_SOCKET = defaultSocket;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "p7";
  const mod = (await import(`${file}?${Math.random()}`)) as { default: (pi: unknown) => void };
  return { dir, mod };
}

function listen(file: string, got: unknown[]): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => (buffer += chunk));
      socket.on("end", () => got.push(JSON.parse(buffer.trim())));
    });
    server.listen(file, () => resolve(server));
  });
}

async function settle(mod: { default: (pi: unknown) => void }) {
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  mod.default({ on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => (handlers[name] = fn) });
  handlers.agent_start!({});
  handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最終回覆" }] }] });
  await handlers.agent_settled!({}, { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "sess-1" } });
}

test("ISSUE-226: pi extension 預設只送預設 socket；extra-hook-targets.json 有設定時，額外送到該 socket 且 paneId 帶 machine 前綴", async () => {
  const saved = { HOME: process.env.HOME, S: process.env.HERDR_DISCORD_HOOK_SOCKET, E: process.env.HERDR_ENV, P: process.env.HERDR_PANE_ID };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
  const sockDir = fs.mkdtempSync(path.join("/tmp", "pis-"));
  const main = path.join(sockDir, "m.sock");
  const extra = path.join(sockDir, "x.sock");
  const mainGot: Array<Record<string, unknown>> = [];
  const extraGot: Array<Record<string, unknown>> = [];
  const servers = [await listen(main, mainGot), await listen(extra, extraGot)];
  try {
    const { mod } = await load(home, main);
    // 沒有設定檔：只送預設 socket，paneId 不帶前綴。
    await settle(mod);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mainGot.length, 1);
    assert.equal(mainGot[0]!.paneId, "p7");
    assert.equal(extraGot.length, 0);
    // 有設定檔：兩邊都收到，額外目標的 paneId 帶前綴；設定檔壞掉或欄位不合法的項目被忽略。
    fs.mkdirSync(path.join(home, ".config", "herdr-discord-bridge"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "herdr-discord-bridge", "extra-hook-targets.json"),
      JSON.stringify([{ socket: extra, machine: "m1" }, { socket: "relative.sock", machine: "m2" }, { machine: "m3" }, { socket: main, machine: "dup" }]),
    );
    await settle(mod);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mainGot.length, 2);
    assert.equal(mainGot[1]!.paneId, "p7");
    assert.equal(extraGot.length, 1);
    assert.equal(extraGot[0]!.paneId, "m1:p7");
    assert.equal(extraGot[0]!.message, "最終回覆");
    fs.writeFileSync(path.join(home, ".config", "herdr-discord-bridge", "extra-hook-targets.json"), "{ not json");
    await settle(mod);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mainGot.length, 3);
    assert.equal(extraGot.length, 1);
  } finally {
    for (const server of servers) server.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
    for (const [key, value] of [["HOME", saved.HOME], ["HERDR_DISCORD_HOOK_SOCKET", saved.S], ["HERDR_ENV", saved.E], ["HERDR_PANE_ID", saved.P]] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
