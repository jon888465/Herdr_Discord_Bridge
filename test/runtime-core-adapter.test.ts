import test from "node:test";
import assert from "node:assert/strict";
import {
  CoreAdapter,
  CORE_REQUIRED_METHODS,
} from "../src/runtime/core-adapter.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { HERDR_OPERATIONS, type HerdrOperation } from "../src/runtime/types.js";
import { fakeCoreServer, reply } from "./helpers/fake-core-server.js";

for (const incompatible of ["generation", "method"])
  test(`Core hello ${incompatible} 不相容即停止`, async () => {
    const fake = await fakeCoreServer(
      incompatible === "generation"
        ? { generation: 2 }
        : {
            methods: CORE_REQUIRED_METHODS.filter(
              (method) => method !== "terminal.send",
            ),
          },
    );
    try {
      await assert.rejects(
        new CoreAdapter(fake.socketPath).health(),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "RUNTIME_INCOMPATIBLE" &&
          (incompatible !== "method" ||
            error.message.includes("terminal.send")),
      );
      assert.equal(fake.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

test("Core health／targets 不推測 status，read 保留 incomplete 且只讀 lines:0", async () => {
  const terminal = {
    address: "t1",
    reported: false,
    status: { state: "idle" },
    foreground: { name: "codex" },
  };
  const fake = await fakeCoreServer({
    handler(request, socket) {
      if (request.method === "terminal.list") {
        reply(socket, request, {
          terminals: [
            terminal,
            { address: "t2", reported: true, status: null },
            { address: "t3", reported: true, status: { state: "error" } },
          ],
        });
        return true;
      }
      if (request.method === "terminal.get") {
        reply(socket, request, terminal);
        return true;
      }
      if (request.method === "terminal.read") {
        reply(socket, request, {
          text: "screen",
          complete: false,
          why: "working",
          how: "screen",
        });
        return true;
      }
    },
  });
  try {
    const adapter = new CoreAdapter(fake.socketPath);
    assert.equal(await adapter.health(), true);
    assert.equal(adapter.generation, 1);
    assert.equal(adapter.version, "0.1.20");
    assert.deepEqual(
      (await adapter.listTargets()).map((target) => target.status),
      ["unknown", "unknown", "error"],
    );
    assert.equal((await adapter.getTarget("t1")).status, "unknown");
    assert.deepEqual(await adapter.read("t1"), {
      text: "screen",
      complete: false,
      why: "working",
      how: "screen",
    });
    assert.deepEqual(fake.calls.at(-1)?.params, { terminal: "t1", lines: 0 });
    await assert.rejects(adapter.read("t1", "recent"), RuntimeError);
    for (const operation of Object.keys(HERDR_OPERATIONS) as HerdrOperation[])
      await assert.rejects(
        adapter.herdrOperation(operation),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "RUNTIME_UNSUPPORTED_OPERATION",
      );
  } finally {
    await fake.close();
  }
});

test("Core send 不帶 force、保存 turn／started，Ctrl-C 走 terminal.keys", async () => {
  const fake = await fakeCoreServer({
    handler(request, socket) {
      reply(socket, request, { turn: 4, started: null, status: "working" });
      return true;
    },
  });
  try {
    const adapter = new CoreAdapter(fake.socketPath);
    assert.deepEqual(await adapter.prompt("t1", "hello"), {
      turn: 4,
      started: null,
      status: "working",
    });
    assert.deepEqual(fake.calls[0].params, { terminal: "t1", text: "hello" });
    await adapter.keys("t1", ["ctrl+c"]);
    assert.equal(fake.calls[1].method, "terminal.keys");
    assert.deepEqual(fake.calls[1].params, {
      terminal: "t1",
      keys: ["ctrl+c"],
    });
  } finally {
    await fake.close();
  }
});

for (const scenario of ["disconnect", "timeout", "json"])
  test(`Core send ${scenario} 為送達不明且零重送`, async () => {
    const fake = await fakeCoreServer({
      handler(_request, socket) {
        if (scenario === "disconnect") socket.destroy();
        if (scenario === "json") socket.write("bad json\n");
        return true;
      },
    });
    try {
      await assert.rejects(
        new CoreAdapter(fake.socketPath).send("t1", "secret", {
          timeoutMs: 40,
          retries: 9,
        }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "RUNTIME_DELIVERY_UNKNOWN",
      );
      assert.equal(fake.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

for (const reason of [
  "status",
  "exit",
  "output",
  "timeout",
  "not_started",
  "message",
])
  test(`Core wait 保留 ${reason} 與 ended，毫秒轉秒`, async () => {
    const ended = ["status", "exit", "output"].includes(reason);
    const fake = await fakeCoreServer({
      handler(request, socket) {
        reply(socket, request, {
          terminal: "t1",
          ended,
          reason,
          turn: 7,
          status: "done",
        });
        return true;
      },
    });
    try {
      const result = await new CoreAdapter(fake.socketPath).wait(
        "t1",
        undefined,
        1250,
      );
      assert.deepEqual(result, {
        target: "t1",
        ended,
        reason,
        turn: 7,
        status: "done",
      });
      assert.deepEqual(fake.calls[0].params, { terminal: "t1", timeout: 1.25 });
    } finally {
      await fake.close();
    }
  });
