import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrHub, validateMachines } from "../src/machines.js";

type Handler = (method: string, params: Record<string, unknown>) => unknown;

function fake(path: string, handler: Handler): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        const result = handler(request.method, request.params);
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    });
    server.listen(path, () => resolve(server));
  });
}

test("validateMachines accepts good entries and rejects confusable ids", () => {
  const ok = validateMachines([
    { id: "agy-pod", ssh: "agy-pod", socket: "/root/.config/herdr/herdr.sock" },
  ]);
  assert.equal(ok.length, 1);
  assert.deepEqual(validateMachines(undefined), []);
  for (const id of ["w1", "term_x", "local", "a", "bad:id", "1abc"])
    assert.throws(() =>
      validateMachines([{ id, ssh: "h", socket: "/s.sock" }]),
    );
  assert.throws(() =>
    validateMachines([{ id: "abc", ssh: "-oProxyCommand=x", socket: "/s" }]),
  );
  assert.throws(() =>
    validateMachines([{ id: "abc", ssh: "h", socket: "relative.sock" }]),
  );
  assert.throws(() =>
    validateMachines([
      { id: "abc", ssh: "h", socket: "/s" },
      { id: "abc", ssh: "h", socket: "/s" },
    ]),
  );
});

test("hub routes unprefixed ids to local and prefixed ids to the machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bm-"));
  const seen: string[] = [];
  const local = await fake(join(dir, "l.sock"), (method, params) => {
    seen.push(`local:${method}:${JSON.stringify(params)}`);
    return {
      agents: [{ terminal_id: "term_l", pane_id: "w2:p1", workspace_id: "w2" }],
    };
  });
  const remote = await fake(join(dir, "agy.sock"), (method, params) => {
    seen.push(`remote:${method}:${JSON.stringify(params)}`);
    return {
      agents: [
        {
          terminal_id: "term_r",
          pane_id: "w2:p1",
          workspace_id: "w2",
          name: "worker",
        },
      ],
    };
  });
  const hub = new HerdrHub(
    [{ id: "agy", ssh: "agy", socket: "/r.sock" }],
    join(dir, "l.sock"),
    2000,
    10,
    () => undefined,
    () => join(dir, "agy.sock"),
  );
  try {
    const agents = await hub.listAgents();
    assert.deepEqual(
      agents.map((a) => a.pane_id),
      ["w2:p1", "agy:w2:p1"],
    );
    assert.equal(agents[1].terminal_id, "agy:term_r");
    assert.equal(agents[1].workspace_id, "agy:w2");
    assert.equal(agents[1].name, "worker");
    assert.equal(agents[1].machine, "agy");
    assert.equal(agents[0].machine, undefined);

    seen.length = 0;
    await hub.request("agent.read", { target: "w2:p1" });
    await hub.request("agent.read", { target: "agy:w2:p1" });
    assert.deepEqual(seen, [
      'local:agent.read:{"target":"w2:p1"}',
      'remote:agent.read:{"target":"w2:p1"}',
    ]);
    await assert.rejects(
      hub.request("pane.split", {
        target_pane_id: "agy:w2:p1",
        workspace_id: "w2",
      }),
      /mixes machine/,
    );
  } finally {
    local.close();
    remote.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreachable machine keeps its last known agents and never breaks local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bm-"));
  const local = await fake(join(dir, "l.sock"), () => ({ agents: [] }));
  let alive = true;
  const remote = await fake(join(dir, "r.sock"), () => ({
    agents: [{ terminal_id: "t", pane_id: "w1:p1", workspace_id: "w1" }],
  }));
  const messages: string[] = [];
  const hub = new HerdrHub(
    [{ id: "agy", ssh: "agy", socket: "/r.sock" }],
    join(dir, "l.sock"),
    2000,
    10,
    (m) => messages.push(m),
    () => join(dir, "r.sock"),
  );
  try {
    assert.equal((await hub.listAgents()).length, 1);
    remote.close();
    alive = false;
    await rm(join(dir, "r.sock"), { force: true });
    const stale = await hub.listAgents();
    assert.equal(alive, false);
    assert.equal(stale.length, 1);
    assert.ok(messages.some((m) => /unreachable/.test(m)));
  } finally {
    local.close();
    await rm(dir, { recursive: true, force: true });
  }
});
