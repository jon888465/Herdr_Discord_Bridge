import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type {
  CommandContext,
  CommandHandler,
  PromptHandler,
} from "../src/discord.js";
import { loadConfig } from "../src/config.js";
import { CoreAdapter } from "../src/runtime/core-adapter.js";
import {
  startCoreBridge,
  type CoreDiscordPort,
} from "../src/runtime/core-bridge.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { fakeCoreServer, reply } from "./helpers/fake-core-server.js";

class FakeDiscord implements CoreDiscordPort {
  command!: CommandHandler;
  prompt!: PromptHandler;
  replies: string[] = [];
  started = false;
  onCommand(handler: CommandHandler) {
    this.command = handler;
  }
  onPrompt(handler: PromptHandler) {
    this.prompt = handler;
  }
  async reply(_message: CommandContext["message"], text: string) {
    this.replies.push(text);
  }
  async start() {
    this.started = true;
  }
}
const context: CommandContext = {
  message: {} as CommandContext["message"],
  routing: { guildId: "g", channelId: "c", threadId: "thread", userId: "u" },
};
async function fixture(allowed: string[] = ["t1"]) {
  let disconnect = false;
  const fake = await fakeCoreServer({
    handler(request, socket) {
      if (request.method === "terminal.list") {
        reply(socket, request, {
          terminals: [
            {
              address: "t1",
              name: "helper",
              state: "live",
              reported: false,
              status: null,
            },
          ],
        });
        return true;
      }
      if (request.method === "terminal.get") {
        reply(socket, request, {
          address: request.params.terminal,
          state: "live",
          reported: true,
          status: { state: "idle" },
        });
        return true;
      }
      if (request.method === "terminal.read") {
        reply(socket, request, {
          text: "screen",
          complete: false,
          why: "working",
        });
        return true;
      }
      if (request.method === "terminal.send") {
        if (disconnect) socket.destroy();
        else reply(socket, request, { turn: 2, started: true });
        return true;
      }
      if (request.method === "terminal.keys") {
        reply(socket, request, { turn: 2 });
        return true;
      }
    },
  });
  const directory = path.dirname(fake.socketPath);
  const oldDirectory = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = directory;
  let config;
  try {
    config = {
      ...loadConfig(),
      coreAllowedTerminals: allowed,
      allowedWorkspaceIds: [],
      machines: [],
    };
  } finally {
    if (oldDirectory === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = oldDirectory;
  }
  const discord = new FakeDiscord();
  const adapter = new CoreAdapter(fake.socketPath, 50);
  return {
    fake,
    directory,
    config,
    discord,
    adapter,
    disconnect() {
      disconnect = true;
    },
    async start() {
      return startCoreBridge(config, adapter, { discord, directory });
    },
  };
}

test("Core Discord 列目標、runtime 狀態與 incomplete 畫面", async () => {
  const f = await fixture([]);
  try {
    await f.start();
    assert.equal(f.discord.started, true);
    await f.discord.command(context, "agents", []);
    assert.match(f.discord.replies.at(-1)!, /t1.*helper.*unknown/);
    await f.discord.command(context, "status", []);
    assert.match(
      f.discord.replies.at(-1)!,
      /runtime=core.*version=0.1.20.*generation=1/,
    );
    await f.discord.command(context, "read", ["t1"]);
    assert.match(f.discord.replies.at(-1)!, /screen.*\n.*working/);
    assert.deepEqual(f.fake.calls.at(-1)?.params, { terminal: "t1", lines: 0 });
  } finally {
    await f.fake.close();
  }
});

test("Core 白名單外與空白名單輸入拒絕，零 send／keys", async () => {
  const f = await fixture([]);
  try {
    await f.start();
    await f.discord.command(context, "ask", ["t1", "secret"]);
    assert.match(
      f.discord.replies.at(-1)!,
      /RUNTIME_IDENTITY_UNVERIFIED.*coreAllowedTerminals/,
    );
    await f.discord.command(context, "cancel", ["t1"]);
    assert.equal(
      f.fake.calls.filter((c) =>
        ["terminal.send", "terminal.keys"].includes(c.method),
      ).length,
      0,
    );
    assert.equal(
      f.fake.calls.filter((c) => c.method === "terminal.get").length,
      0,
    );
  } finally {
    await f.fake.close();
  }
});

test("Core 白名單內 send 一次，按鍵包含 Ctrl-C", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.discord.command(context, "ask", ["t1", "hello"]);
    assert.match(f.discord.replies.at(-1)!, /已送出/);
    assert.equal(
      f.fake.calls.filter((c) => c.method === "terminal.send").length,
      1,
    );
    assert.deepEqual(
      f.fake.calls.find((c) => c.method === "terminal.send")?.params,
      { terminal: "t1", text: "hello" },
    );
    await f.discord.command(context, "cancel", ["t1"]);
    assert.deepEqual(f.fake.calls.at(-1)?.params, {
      terminal: "t1",
      keys: ["ctrl+c"],
    });
    await f.discord.command(context, "agent", ["keys", "t1", "enter"]);
    assert.equal(f.fake.calls.at(-1)?.method, "terminal.keys");
  } finally {
    await f.fake.close();
  }
});

test("Core 送達不明回固定錯誤且零重送，不洩漏 prompt", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.disconnect();
    await f.discord.command(context, "ask", ["t1", "secret-prompt"]);
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_DELIVERY_UNKNOWN/);
    assert.doesNotMatch(f.discord.replies.at(-1)!, /secret/);
    assert.equal(
      f.fake.calls.filter((c) => c.method === "terminal.send").length,
      1,
    );
  } finally {
    await f.fake.close();
  }
});

test("Core 拒絕既有高階指令，不洩漏未知子指令", async () => {
  const f = await fixture();
  try {
    await f.start();
    const count = f.fake.calls.length;
    for (const command of [
      "workspaces",
      "workspace",
      "card",
      "team",
      "handoff",
      "worktree",
      "machines",
      "approval",
      "wait",
      "quota",
      "failover",
      "pool",
      "assign",
      "model",
      "usage",
      "hooks",
      "discord",
      "current",
      "attach",
      "watch",
      "detach",
    ]) {
      await f.discord.command(context, command, []);
      assert.match(f.discord.replies.at(-1)!, /RUNTIME_UNSUPPORTED_OPERATION/);
      assert.ok(f.discord.replies.at(-1)!.includes(command));
    }
    await f.discord.command(context, "agent", ["start"]);
    assert.match(f.discord.replies.at(-1)!, /agent start/);
    await f.discord.command(context, "agent", ["secret"]);
    assert.doesNotMatch(f.discord.replies.at(-1)!, /secret/);
    assert.equal(f.fake.calls.length, count);
  } finally {
    await f.fake.close();
  }
});

test("Core thread 自由文字僅在明確綁定後送出，狀態不碰 routing.json", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "routing.json"), "legacy sentinel");
    await f.start();
    await f.discord.prompt(context, "before");
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_IDENTITY_UNVERIFIED/);
    await f.discord.command(context, "target", ["t1"]);
    await f.discord.prompt(context, "after");
    assert.equal(
      f.fake.calls.filter((c) => c.method === "terminal.send").length,
      1,
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.directory, "core-routing.json"), "utf8"),
    );
    assert.equal(saved.runtime, "core");
    assert.equal(saved.coreId, "fake-core");
    assert.equal(
      fs.readFileSync(path.join(f.directory, "routing.json"), "utf8"),
      "legacy sentinel",
    );
    await f.discord.prompt(
      { ...context, routing: { ...context.routing, threadId: "different" } },
      "wrong thread",
    );
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_IDENTITY_UNVERIFIED/);
  } finally {
    await f.fake.close();
  }
});

for (const field of ["allowedWorkspaceIds", "machines"] as const)
  test(`Core 拒絕 ${field}，Discord 與 socket 尚未啟動`, async () => {
    const f = await fixture();
    try {
      const config =
        field === "allowedWorkspaceIds"
          ? { ...f.config, allowedWorkspaceIds: ["w1"] }
          : {
              ...f.config,
              machines: [
                { id: "remote", ssh: "remote", socket: "/tmp/legacy" },
              ],
            };
      await assert.rejects(
        startCoreBridge(config, f.adapter, {
          discord: f.discord,
          directory: f.directory,
        }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "RUNTIME_UNSUPPORTED_OPERATION" &&
          error.message.includes(field),
      );
      assert.equal(f.discord.started, false);
      assert.equal(f.fake.calls.length, 0);
    } finally {
      await f.fake.close();
    }
  });

test("Core health 失敗不啟動 Discord、不連舊 Herdr", async () => {
  const f = await fixture();
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = path.join(f.directory, "legacy.sock");
  try {
    await assert.rejects(
      startCoreBridge(
        f.config,
        new CoreAdapter(path.join(f.directory, "missing.sock"), 50),
        { discord: f.discord, directory: f.directory },
      ),
      (error: unknown) =>
        error instanceof RuntimeError && error.code === "RUNTIME_UNREACHABLE",
    );
    assert.equal(f.discord.started, false);
    assert.equal(f.fake.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
    await f.fake.close();
  }
});

test("Core 無法確認 target／非 live 時拒絕，零輸入", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.adapter.getTarget = async () => ({
      id: "t1",
      runtime: "core",
      coreId: "fake-core",
      state: "finished",
      status: "unknown",
    });
    await f.discord.command(context, "ask", ["t1", "secret"]);
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_IDENTITY_UNVERIFIED/);
    f.adapter.getTarget = async () => {
      throw new Error("secret-token");
    };
    await f.discord.command(context, "cancel", ["t1"]);
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_IDENTITY_UNVERIFIED/);
    assert.equal(
      f.fake.calls.filter((call) =>
        ["terminal.send", "terminal.keys"].includes(call.method),
      ).length,
      0,
    );
  } finally {
    await f.fake.close();
  }
});

test("Core 不沿用另一個 Core identity 的 thread 綁定", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(
      path.join(f.directory, "core-routing.json"),
      JSON.stringify({
        runtime: "core",
        coreId: "old-core",
        bindings: { [JSON.stringify(["g", "c", "thread"])]: "t1" },
      }),
    );
    await f.start();
    await f.discord.prompt(context, "secret");
    assert.match(f.discord.replies.at(-1)!, /RUNTIME_IDENTITY_UNVERIFIED/);
    assert.equal(
      f.fake.calls.filter((call) => call.method === "terminal.send").length,
      0,
    );
  } finally {
    await f.fake.close();
  }
});

test("Core 非 RuntimeError 僅回通用訊息，log 不含 prompt 或 token", async () => {
  const f = await fixture();
  try {
    const logs: string[] = [];
    await startCoreBridge(f.config, f.adapter, {
      discord: f.discord,
      directory: f.directory,
      log: (text) => logs.push(text),
    });
    f.adapter.read = async () => {
      throw new Error("secret-token");
    };
    await f.discord.command(context, "read", ["t1"]);
    assert.equal(f.discord.replies.at(-1), "處理失敗，已記錄");
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs.join(""), /secret/);
  } finally {
    await f.fake.close();
  }
});
