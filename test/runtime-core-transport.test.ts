import test from "node:test";
import assert from "node:assert/strict";
import { CoreTransport } from "../src/runtime/core-transport.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { fakeCoreServer } from "./helpers/fake-core-server.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof RuntimeError && error.code === expected;

test("Core transport 配對 id 並重組分段 UTF-8 回應，每次建立新連線", async () => {
  const fake = await fakeCoreServer({
    handler(request, socket) {
      socket.write(
        JSON.stringify({ jsonrpc: "2.0", id: "other", result: "wrong" }) + "\n",
      );
      const bytes = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { text: "繁體中文" },
        }) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("繁")) + 1;
      socket.write(bytes.subarray(0, split));
      setTimeout(() => {
        if (!socket.destroyed) socket.write(bytes.subarray(split));
      }, 5);
      return true;
    },
  });
  try {
    const transport = new CoreTransport(fake.socketPath);
    for (let index = 0; index < 2; index++)
      assert.deepEqual(await transport.request("terminal.read"), {
        text: "繁體中文",
      });
    assert.equal(fake.calls.length, 2);
    assert.notEqual(fake.calls[0].id, fake.calls[1].id);
    assert.equal(fake.calls[0].jsonrpc, "2.0");
  } finally {
    await fake.close();
  }
});

test("Core transport 保留 numeric RPC code 與 data.kind，不洩漏 server message", async () => {
  const fake = await fakeCoreServer({
    handler(request, socket) {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "secret prompt",
            data: { kind: "blocked" },
          },
        }) + "\n",
      );
      return true;
    },
  });
  try {
    await assert.rejects(
      new CoreTransport(fake.socketPath).request("terminal.send"),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.details.rpcCode === -32000 &&
        error.details.rpcKind === "blocked" &&
        !error.message.includes("secret"),
    );
  } finally {
    await fake.close();
  }
});

for (const scenario of ["json", "timeout", "disconnect", "wrong-id"] as const)
  test(`Core transport 拒絕 ${scenario} 且有界結束`, async () => {
    const fake = await fakeCoreServer({
      handler(request, socket) {
        if (scenario === "json") socket.write("not json\n");
        if (scenario === "disconnect") socket.destroy();
        if (scenario === "wrong-id")
          socket.write(
            JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} }) + "\n",
          );
        return true;
      },
    });
    try {
      await assert.rejects(
        new CoreTransport(fake.socketPath, 40).request("hello"),
        code(
          scenario === "json" ? "RUNTIME_INCOMPATIBLE" : "RUNTIME_UNREACHABLE",
        ),
      );
    } finally {
      await fake.close();
    }
  });

test("Core transport socket 不存在回 UNREACHABLE，沒有送出", async () => {
  await assert.rejects(
    new CoreTransport(`/tmp/missing-core-${process.pid}.sock`, 40).request(
      "hello",
    ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "RUNTIME_UNREACHABLE" &&
      error.details.deliveryAttempted === false,
  );
});
