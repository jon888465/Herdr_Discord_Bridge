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

test("cardReview.toolchain: only a boolean is accepted, true is kept, false is omitted", () => {
  const base = { id: "agy-pod", ssh: "agy-pod", socket: "/s.sock" };
  const review = (toolchain?: unknown) =>
    validateMachines([
      { ...base, cardReview: { root: "/root/review", kinds: ["agy"], ...(toolchain === undefined ? {} : { toolchain }) } },
    ])[0].cardReview;
  assert.equal(review(true)?.toolchain, true);
  assert.equal("toolchain" in (review(false) ?? {}), false);
  assert.equal("toolchain" in (review() ?? {}), false);
  for (const bad of ["yes", 1, null, {}])
    assert.throws(() => review(bad), /toolchain, if set, must be a boolean/);
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
    if (method === "tab.create")
      return {
        root_pane: {
          pane_id: "w2:p7",
          workspace_id: "w2",
          terminal_id: "term_new",
        },
      };
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
    const tab = await hub.request<{
      root_pane: { pane_id: string; workspace_id: string; terminal_id: string };
    }>(
      "tab.create",
      { workspace_id: "agy:w2", cwd: "/repo", focus: false },
      { retries: 0 },
    );
    assert.deepEqual(tab.root_pane, {
      pane_id: "agy:w2:p7",
      workspace_id: "agy:w2",
      terminal_id: "agy:term_new",
      machine: "agy",
    });
    assert.equal(
      seen.at(-1),
      'remote:tab.create:{"workspace_id":"w2","cwd":"/repo","focus":false}',
    );
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

test("machineObservations records when a remote was last probed, and a failing local request does not refresh it (ISSUE-164)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bm-"));
  const local = await fake(join(dir, "l.sock"), () => ({ agents: [] }));
  const remote = await fake(join(dir, "r.sock"), () => ({ agents: [] }));
  const hub = new HerdrHub(
    [{ id: "agy", ssh: "agy", socket: "/r.sock" }],
    join(dir, "l.sock"),
    2000,
    10,
    () => {},
    () => join(dir, "r.sock"),
  );
  try {
    // 還沒請求過：沒有觀測時間。
    assert.deepEqual(hub.machineObservations(), [
      { id: "agy", reachable: false, disconnected: false },
    ]);
    const before = Date.now();
    await hub.listAgents();
    const [seen] = hub.machineObservations();
    assert.equal(seen?.reachable, true);
    assert.ok(seen?.observedAt !== undefined && seen.observedAt >= before);
    // 本機 socket 掛了：聚合請求在探測遠端之前就失敗，遠端的旗標與觀測時間都不會更新。
    local.close();
    await rm(join(dir, "l.sock"), { force: true });
    await assert.rejects(() => hub.listAgents());
    assert.deepEqual(hub.machineObservations(), [seen]);
  } finally {
    remote.close();
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

test("machines hookSocket validation and reverse-tunnel args (ISSUE-045)", async () => {
  const { hookTunnelArgs } = await import("../src/machines.js");
  const [m] = validateMachines([
    {
      id: "pod",
      ssh: "pod",
      socket: "/r/herdr.sock",
      hookSocket: "/root/.config/hb/hooks.sock",
    },
  ]);
  assert.equal(m.hookSocket, "/root/.config/hb/hooks.sock");
  assert.equal(
    validateMachines([{ id: "pod", ssh: "pod", socket: "/r/h.sock" }])[0]
      .hookSocket,
    undefined,
  );
  for (const bad of [
    "relative/h.sock",
    "/a b/h.sock",
    "/a/../h.sock",
    "/a'b/h.sock",
    5,
  ])
    assert.throws(() =>
      validateMachines([
        { id: "pod", ssh: "pod", socket: "/r/h.sock", hookSocket: bad },
      ]),
    );
  const args = hookTunnelArgs(m, "/local/hooks.sock");
  assert.deepEqual(args.slice(-3), [
    "-R",
    "/root/.config/hb/hooks.sock:/local/hooks.sock",
    "pod",
  ]);
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
});

test("manual disconnect skips aggregate/cache and rejects direct requests until reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-"));
  let probes = 0;
  const local = await fake(join(dir, "l.sock"), () => ({ agents: [] }));
  const remote = await fake(join(dir, "r.sock"), () => {
    probes++;
    return { agents: [{ terminal_id: "t", pane_id: "p", workspace_id: "w" }] };
  });
  let busy: string | undefined;
  const hub = new HerdrHub(
    [{ id: "agy", ssh: "unused", socket: "/r" }],
    join(dir, "l.sock"),
    1000,
    10,
    () => {},
    () => join(dir, "r.sock"),
    () => busy,
  );
  const state = hub["remotes"].get("agy")!;
  let starts = 0,
    stops = 0;
  state.tunnel.start = () => {
    starts++;
  };
  state.tunnel.stop = () => {
    stops++;
  };
  try {
    assert.deepEqual(hub.connectMachine("missing"), {
      ok: false,
      reason: "machine 不存在",
    });
    assert.deepEqual(hub.disconnectMachine("missing"), {
      ok: false,
      reason: "machine 不存在",
    });
    assert.equal(hub.connectMachine("agy").ok, true);
    assert.equal(starts, 0);
    assert.equal((await hub.listAgents()).length, 1);
    busy = "2 個進行中的回合";
    assert.deepEqual(hub.disconnectMachine("agy"), {
      ok: false,
      reason: "有進行中的工作：2 個進行中的回合，再按一次強制斷線",
      needsForce: true,
    });
    assert.equal(stops, 0);
    assert.deepEqual(hub.disconnectMachine("agy", { force: true }), {
      ok: true,
      status: "disconnected",
    });
    const before = hub.machineObservations();
    assert.deepEqual(hub.disconnectMachine("agy"), {
      ok: true,
      status: "disconnected",
      note: "已是斷線",
    });
    assert.equal(stops, 1);
    assert.deepEqual(await hub.listAgents(), []);
    await assert.rejects(hub.requestOn("agy", "agent.list"), /machine 已斷線/);
    await assert.rejects(hub.freshAgentsOn("agy"), /machine 已斷線/);
    await assert.rejects(
      hub.request("agent.read", { target: "agy:p" }),
      /machine 已斷線/,
    );
    assert.equal(probes, 1);
    assert.deepEqual(hub.machineObservations(), before);
    assert.equal(state.cache.size, 1);
    assert.deepEqual(hub.connectMachine("agy"), {
      ok: true,
      status: "connected",
    });
    assert.equal(starts, 1);
    assert.deepEqual(hub.connectMachine("agy"), {
      ok: true,
      status: "connected",
      note: "已在連線中",
    });
    assert.equal(starts, 1);
    assert.equal((await hub.listAgents()).length, 1);
    assert.equal(hub.machineObservations()[0].disconnected, false);
  } finally {
    local.close();
    remote.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("both tunnels restart after stop and ignore old process exit", async () => {
  const { MachineTunnel, HookReverseTunnel } =
    await import("../src/machines.js");
  const { EventEmitter } = await import("node:events");
  const { spawn } = await import("node:child_process");
  const children: import("node:child_process").ChildProcess[] = [];
  const spawnProcess: typeof spawn = (() => {
    const child =
      new EventEmitter() as import("node:child_process").ChildProcess;
    child.kill = () => true;
    children.push(child);
    return child;
  }) as typeof spawn;
  const dir = await mkdtemp(join(tmpdir(), "mt-"));
  const config = { id: "agy", ssh: "unused", socket: "/r", hookSocket: "/h" };
  const tunnel = new MachineTunnel(
    config,
    () => {},
    join(dir, "t.sock"),
    spawnProcess,
  );
  const hook = new HookReverseTunnel(config, "/local", () => {}, spawnProcess);
  try {
    for (const t of [tunnel, hook]) {
      t.start();
      const old = children.at(-1)!;
      t.stop();
      const count = children.length;
      t.start();
      assert.equal(children.length, count + 1);
      old.emit("exit", 0);
      assert.equal(children.length, count + 1);
      if (t === hook) {
        children.at(-1)!.emit("exit", 0);
        assert.equal(children.length, count + 2);
      }
      t.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-flight aggregate response cannot revive a manually disconnected remote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-"));
  const local = await fake(join(dir, "l.sock"), () => ({ agents: [] }));
  const hub = new HerdrHub(
    [{ id: "agy", ssh: "unused", socket: "/r" }],
    join(dir, "l.sock"),
    1000,
    10,
    () => {},
    () => join(dir, "r.sock"),
  );
  const remote = hub["remotes"].get("agy")!;
  remote.tunnel.stop = () => {};
  let release!: (result: unknown) => void;
  let started!: () => void;
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  remote.client.request = <T>() =>
    new Promise<T>((resolve) => {
      release = (value) => resolve(value as T);
      started();
    });
  try {
    const request = hub.listAgents();
    await probing;
    hub.disconnectMachine("agy");
    const before = hub.machineObservations();
    release({ agents: [{ terminal_id: "t" }] });
    assert.deepEqual(await request, []);
    assert.deepEqual(hub.machineObservations(), before);
    assert.equal(remote.cache.size, 0);
  } finally {
    local.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnect schedules a probe, records success/failure, and discards results after disconnect", async () => {
  const scheduled: Array<() => void> = [];
  const hub = new HerdrHub(
    [{ id: "pod", ssh: "unused", socket: "/unused" }],
    undefined,
    100,
    10,
    () => {},
    () => "/unused",
    undefined,
    (callback, delay) => {
      assert.equal(delay, 2000);
      scheduled.push(callback);
    },
  );
  const remote = hub["remotes"].get("pod")!;
  remote.tunnel.start = () => {};
  remote.tunnel.stop = () => {};
  for (const succeeds of [true, false]) {
    hub.disconnectMachine("pod");
    remote.client.request = async <T,>(
      _method: string,
      _params?: unknown,
      options?: { timeoutMs?: number; retries?: number },
    ) => {
      assert.deepEqual(options, { timeoutMs: 3000, retries: 0 });
      if (!succeeds) throw new Error("unreachable");
      return { agents: [] } as T;
    };
    hub.connectMachine("pod");
    assert.equal(hub.machineObservations()[0].observedAt, undefined);
    scheduled.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(hub.machineObservations()[0].reachable, succeeds);
    assert.equal(typeof hub.machineObservations()[0].observedAt, "number");
  }
  hub.disconnectMachine("pod");
  hub.connectMachine("pod");
  let release!: (value: unknown) => void;
  remote.client.request = <T,>() =>
    new Promise<T>((resolve) => {
      release = (value) => resolve(value as T);
    });
  scheduled.shift()!();
  hub.disconnectMachine("pod");
  const before = hub.machineObservations();
  release({ agents: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(hub.machineObservations(), before);
  hub.connectMachine("pod");
  hub.disconnectMachine("pod");
  remote.client.request = () => {
    throw new Error("stale timer must not probe");
  };
  scheduled.shift()!();
});
