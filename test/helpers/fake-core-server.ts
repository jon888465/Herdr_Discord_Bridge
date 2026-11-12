import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CORE_REQUIRED_METHODS } from "../../src/runtime/core-adapter.js";

export interface FakeCoreRequest {
  jsonrpc: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
}
export interface FakeCoreOptions {
  generation?: number;
  methods?: string[];
  handler?: (request: FakeCoreRequest, socket: net.Socket) => boolean | void;
}
export async function fakeCoreServer(options: FakeCoreOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-"));
  const socketPath = path.join(directory, "c.sock");
  const calls: FakeCoreRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as FakeCoreRequest;
        buffer = buffer.slice(newline + 1);
        calls.push(request);
        if (options.handler?.(request, socket)) continue;
        const result =
          request.method === "hello"
            ? {
                generation: options.generation ?? 1,
                methods: options.methods ?? CORE_REQUIRED_METHODS,
                version: "0.1.20",
                core: { id: "fake-core" },
              }
            : request.method === "server.status"
              ? { version: "0.1.20", core: { id: "fake-core" } }
              : request.method === "terminal.list"
                ? { terminals: [] }
                : {};
        reply(socket, request, result);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    calls,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function reply(
  socket: net.Socket,
  request: FakeCoreRequest,
  result: unknown,
) {
  socket.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
}
