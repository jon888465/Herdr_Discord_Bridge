import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HerdrClient } from "../src/herdr.js";

test("HerdrClient speaks newline-delimited JSON for the supported operations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-socket-"));
  const socketPath = path.join(directory, "herdr.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
      };
      const results: Record<string, unknown> = {
        ping: { type: "pong" },
        "workspace.list": {
          workspaces: [
            { workspace_id: "w1", label: "demo", path: "/safe/demo" },
          ],
        },
        "agent.list": {
          agents: [
            {
              terminal_id: "term-1",
              agent: "codex",
              agent_status: "idle",
              workspace_id: "w1",
              tab_id: "w1:t1",
              pane_id: "w1:p1",
            },
          ],
        },
        "agent.read": { read: { text: "observed output" } },
        "agent.prompt": { accepted: true },
        "agent.send": { accepted: true },
        "agent.wait": {
          agent: {
            terminal_id: "term-1",
            agent_status: "done",
            workspace_id: "w1",
            tab_id: "w1:t1",
            pane_id: "w1:p1",
          },
        },
        "agent.send_keys": { accepted: true },
      };
      socket.write(
        JSON.stringify({
          id: request.id,
          result: results[request.method] ?? {},
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(socketPath, () => resolve()).once("error", reject),
  );
  const client = new HerdrClient(socketPath, 1000, 1);
  assert.equal(await client.ping(), true);
  assert.equal((await client.listWorkspaces())[0].workspace_id, "w1");
  assert.equal((await client.listAgents())[0].pane_id, "w1:p1");
  assert.equal(await client.readAgent("w1:p1"), "observed output");
  await client.promptAgent("w1:p1", "safe JSON text");
  await client.sendAgent("w1:p1", "approval");
  assert.equal((await client.waitAgent("w1:p1"))?.agent_status, "done");
  await client.cancelAgent("w1:p1");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("socket failure has bounded retry rather than a retry loop", async () => {
  const socketPath = path.join(
    os.tmpdir(),
    `missing-herdr-${process.pid}-${Date.now()}.sock`,
  );
  const client = new HerdrClient(socketPath, 20, 1);
  const start = Date.now();
  await assert.rejects(client.request("agent.list"), /ENOENT|connect|socket/);
  assert.ok(Date.now() - start < 500, "retry should be bounded");
});

test("approval falls back to official pane.send_input on newer blocked Herdr", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-blocked-"));
  const socketPath = path.join(directory, "herdr.sock");
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
      };
      methods.push(request.method);
      if (request.method === "agent.send") {
        socket.write(
          JSON.stringify({
            id: request.id,
            error: { code: "method_not_found", message: "legacy method" },
          }) + "\n",
        );
      } else if (request.method === "agent.prompt") {
        socket.write(
          JSON.stringify({
            id: request.id,
            error: { code: "agent_blocked", message: "blocked" },
          }) + "\n",
        );
      } else {
        socket.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(socketPath, () => resolve()).once("error", reject),
  );
  await new HerdrClient(socketPath, 1000, 1).sendAgent(
    "w1:p1",
    "approval text",
  );
  assert.deepEqual(methods, ["agent.send", "agent.prompt", "pane.send_input"]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});
