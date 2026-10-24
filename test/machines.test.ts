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

test("uploadFiles streams bytes to the remote path and rejects unsafe names", async () => {
  const { shellQuote, uploadFiles } = await import("../src/machines.js");
  const { writeFile, readFile, chmod } = await import("node:fs/promises");
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  const dir = await mkdtemp(join(tmpdir(), "bu-"));
  try {
    // 以 sh 取代 ssh：忽略選項與主機，直接執行最後一個參數（遠端指令）。
    const stub = join(dir, "fakessh");
    await writeFile(
      stub,
      '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n',
    );
    await chmod(stub, 0o755);
    const src = join(dir, "src.txt");
    await writeFile(src, "hello remote");
    const remoteDir = join(dir, "remote", "message-1");
    const [path] = await uploadFiles(
      { id: "agy", ssh: "x", socket: "/s" },
      remoteDir,
      [{ localPath: src, name: "1-note.txt" }],
      stub,
      10000,
    );
    assert.equal(path, join(remoteDir, "1-note.txt"));
    assert.equal(await readFile(path, "utf8"), "hello remote");
    await assert.rejects(
      uploadFiles(
        { id: "agy", ssh: "x", socket: "/s" },
        remoteDir,
        [{ localPath: src, name: "../evil" }],
        stub,
      ),
      /unsafe/,
    );
    await assert.rejects(
      uploadFiles({ id: "agy", ssh: "x", socket: "/s" }, "relative", [], stub),
      /absolute/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanupRemoteAttachments runs a scoped find and validates input", async () => {
  const { cleanupRemoteAttachments } = await import("../src/machines.js");
  const { writeFile, chmod, mkdir, utimes, stat } =
    await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "bq-"));
  const machine = { id: "agy", ssh: "x", socket: "/s" };
  try {
    const stub = join(dir, "fakessh");
    await writeFile(
      stub,
      '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n',
    );
    await chmod(stub, 0o755);
    const root = join(dir, "attachments");
    const old = join(root, "message-old");
    const fresh = join(root, "message-new");
    const other = join(root, "other");
    for (const d of [old, fresh, other]) await mkdir(d, { recursive: true });
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await utimes(old, past, past);
    await utimes(other, past, past);
    await cleanupRemoteAttachments(machine, root, 4320, stub);
    await assert.rejects(stat(old));
    await stat(fresh);
    await stat(other);
    await cleanupRemoteAttachments(machine, join(dir, "missing"), 4320, stub);
    await assert.rejects(
      cleanupRemoteAttachments(machine, "relative", 4320, stub),
      /absolute/,
    );
    await assert.rejects(
      cleanupRemoteAttachments(machine, root, 0, stub),
      /retention/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
