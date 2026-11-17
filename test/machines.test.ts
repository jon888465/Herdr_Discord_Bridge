import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      '#!/bin/sh\n[ "$1" = -o ] && [ "$2" = BatchMode=yes ] && [ "$3" = -p ] && [ "$4" = 2222 ] && [ "$5" = alice@host ] || exit 91\nfor a; do last="$a"; done\nexec sh -c "$last"\n',
    );
    await chmod(stub, 0o755);
    const src = join(dir, "src.txt");
    await writeFile(src, "hello remote");
    const remoteDir = join(dir, "remote", "message-1");
    const [path] = await uploadFiles(
      { id: "agy", ssh: "herdr-test-unconfigured", host: "host", user: "alice", port: 2222, socket: "/s" },
      remoteDir,
      [{ localPath: src, name: "1-note.txt" }],
      stub,
      10000,
    );
    assert.equal(path, join(remoteDir, "1-note.txt"));
    assert.equal(await readFile(path, "utf8"), "hello remote");
    await assert.rejects(
      uploadFiles(
        { id: "agy", ssh: "herdr-test-unconfigured", host: "host", user: "alice", port: 2222, socket: "/s" },
        remoteDir,
        [{ localPath: src, name: "../evil" }],
        stub,
      ),
      /unsafe/,
    );
    await assert.rejects(
      uploadFiles({ id: "agy", ssh: "herdr-test-unconfigured", host: "host", user: "alice", port: 2222, socket: "/s" }, "relative", [], stub),
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
  const machine = { id: "agy", ssh: "herdr-test-unconfigured", host: "host", user: "alice", port: 2222, socket: "/s" };
  try {
    const stub = join(dir, "fakessh");
    await writeFile(
      stub,
      '#!/bin/sh\n[ "$1" = -o ] && [ "$2" = BatchMode=yes ] && [ "$3" = -p ] && [ "$4" = 2222 ] && [ "$5" = alice@host ] || exit 91\nfor a; do last="$a"; done\nexec sh -c "$last"\n',
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
  const calls: string[][] = [];
  const spawnProcess: typeof spawn = ((_cmd: string, args: string[]) => {
    calls.push(args);
    const child =
      new EventEmitter() as import("node:child_process").ChildProcess;
    child.kill = () => true;
    children.push(child);
    return child;
  }) as typeof spawn;
  const dir = await mkdtemp(join(tmpdir(), "mt-"));
  const config = { id: "agy", ssh: "unused", user: "alice", host: "host", port: 2222, socket: "/r", hookSocket: "/h" };
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
    for (const args of calls) {
      const p = args.indexOf("-p");
      assert.ok(p > args.indexOf("BatchMode=yes"));
      assert.deepEqual(args.slice(p, p + 3), ["-p", "2222", "alice@host"]);
      assert.ok(!args.includes("unused"));
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

// ISSUE-166 review F3／F6／F7：tunnel 啟動或停止失敗後，狀態要能重試。
function podHub() {
  const config = { id: "pod", ssh: "unused", socket: "/unused", hookSocket: "/h" };
  const hub = new HerdrHub([config], undefined, 100, 10, () => {}, () => "/unused", undefined, () => {});
  const remote = hub["remotes"].get("pod")!;
  const calls: Record<string, number> = { start: 0, hookStart: 0, stop: 0, hookStop: 0 };
  const fail: Record<string, boolean> = {};
  const wire = (name: string, tunnel: { start(): void; stop(): void }, key: "start" | "stop") => {
    tunnel[key] = () => {
      calls[name]!++;
      if (fail[name]) throw new Error("tunnel error");
    };
  };
  wire("start", remote.tunnel, "start");
  wire("stop", remote.tunnel, "stop");
  wire("hookStart", remote.hookTunnel!, "start");
  wire("hookStop", remote.hookTunnel!, "stop");
  return { hub, calls, fail };
}

test("a failed reconnect tries both tunnels, stops the started one and stays retryable (review F3, F7)", () => {
  const { hub, calls, fail } = podHub();
  hub.disconnectMachine("pod");
  fail.start = true; // 一般 tunnel 啟動丟錯：hook tunnel 仍要被嘗試
  assert.deepEqual(hub.connectMachine("pod"), { ok: false, reason: "連線失敗" });
  assert.equal(calls.hookStart, 1);
  assert.equal(hub.isDisconnected("pod"), true);
  fail.start = false;
  fail.hookStart = true; // hook tunnel 啟動丟錯：已啟動的一般 tunnel 要停掉
  const stops = calls.stop!;
  assert.equal(hub.connectMachine("pod").ok, false);
  assert.equal(calls.stop, stops + 1);
  fail.hookStart = false;
  assert.deepEqual(hub.connectMachine("pod"), { ok: true, status: "connected" });
});

test("a tunnel that fails to stop leaves the other one stopped, and disconnecting again retries (review F6)", () => {
  const { hub, calls, fail } = podHub();
  fail.stop = true;
  assert.equal(hub.disconnectMachine("pod").ok, false, "沒停乾淨不能回成功");
  assert.equal(hub.isDisconnected("pod"), true);
  assert.equal(calls.hookStop, 1, "一般 tunnel 丟錯，hook tunnel 仍要停");
  fail.stop = false;
  assert.deepEqual(hub.disconnectMachine("pod"), { ok: true, status: "disconnected" });
  assert.deepEqual([calls.stop, calls.hookStop], [2, 2]);
  const noop = { ok: true, status: "disconnected", note: "已是斷線" };
  assert.deepEqual(hub.disconnectMachine("pod"), noop, "清理完成後才是 no-op");
  fail.stop = true; // 待清理時重新連線會清掉待清理，之後的斷線走一般流程
  hub.connectMachine("pod");
  assert.equal(hub.disconnectMachine("pod").ok, false);
  assert.equal(hub.connectMachine("pod").ok, true);
  fail.stop = false;
  assert.deepEqual(hub.disconnectMachine("pod"), { ok: true, status: "disconnected" });
});

test("a stop that cannot reach its process keeps the child for a retry, and a spawn error recovers (review F8, F10, F11)", async () => {
  const { MachineTunnel, HookReverseTunnel } = await import("../src/machines.js");
  const { EventEmitter } = await import("node:events");
  type Spawn = typeof import("node:child_process").spawn;
  type Child = import("node:child_process").ChildProcess;
  const dir = await mkdtemp(join(tmpdir(), "mt-"));
  const config = { id: "agy", ssh: "unused", socket: "/r", hookSocket: "/h" };
  const sock = join(dir, "t.sock");
  const makers = [
    (s: Spawn) => new MachineTunnel(config, () => {}, sock, s),
    (s: Spawn) => new HookReverseTunnel(config, "/local", () => {}, s),
  ];
  const fakeSpawn = (children: Child[], kill: (c: Child) => boolean): Spawn =>
    (() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as Child;
      child.kill = () => kill(child);
      children.push(child);
      return child;
    }) as Spawn;
  try {
    // F8／F10：kill 丟錯，或回 false 而程序還活著：stop 丟錯並保留同一個子程序，重試才真的停到它。
    for (const mode of ["throws", "returns false"] as const)
      for (const make of makers) {
        const children: Child[] = [];
        let kills = 0;
        let reachable = false;
        const t = make(
          fakeSpawn(children, () => {
            kills++;
            if (reachable) return true;
            if (mode === "throws") throw new Error("kill failed");
            return false;
          }),
        );
        t.start();
        assert.throws(() => t.stop(), /kill failed|SIGTERM/, mode);
        reachable = true;
        t.stop();
        assert.deepEqual([kills, children.length], [2, 1], `${mode}: 同一個子程序再停一次，沒有多開`);
        t.start();
        assert.equal(children.length, 2, mode);
        t.stop();
      }
    // 程序已經結束時 kill 回 false 不算失敗。
    const done: Child[] = [];
    const exited = new MachineTunnel(config, () => {}, sock, fakeSpawn(done, (c) => {
      Object.assign(c, { exitCode: 0 });
      return false;
    }));
    exited.start();
    assert.doesNotThrow(() => exited.stop());
    // F11：spawn 失敗只發 error、不發 exit，也要清掉 child 並排程重連，之後才能再啟動。
    const failed: Child[] = [];
    const t = new MachineTunnel(config, () => {}, sock, fakeSpawn(failed, () => true));
    t.start();
    failed[0]!.emit("error", new Error("spawn ssh ENOENT"));
    t.start();
    assert.equal(failed.length, 2, "error 之後 child 已清掉，start 會重新 spawn");
    t.stop();
    // F12：有 pid 的 error 是信號失敗（例如 EPERM），程序還活著，不能被當成 spawn 失敗清掉。
    for (const make of makers) {
      const alive: Child[] = [];
      const u = make(fakeSpawn(alive, () => true));
      u.start();
      Object.assign(alive[0]!, { pid: 4242 });
      alive[0]!.emit("error", new Error("EPERM"));
      u.start();
      assert.equal(alive.length, 1, "仍活著的 child 沒被清掉");
      u.stop();
    }
    // F14：hook 準備程序 kill 失敗後自己退出，不能留著舊 child 擋住之後的重新啟動。
    const kids: Child[] = [];
    let reachable = false;
    const hook = new HookReverseTunnel(config, "/local", () => {}, fakeSpawn(kids, () => {
      if (!reachable) throw new Error("kill failed");
      return true;
    }));
    hook.start();
    assert.throws(() => hook.stop(), /kill failed/);
    kids[0]!.emit("exit", 0);
    hook.start();
    assert.equal(kids.length, 2, "舊程序已退出，重新啟動要真的 spawn");
    reachable = true;
    hook.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct SSH operations are refused on a manually disconnected machine (review F13)", async () => {
  const { hub } = podHub();
  hub.disconnectMachine("pod");
  await assert.rejects(hub.uploadTo("pod", "/d", []), /已斷線/);
  await assert.rejects(hub.cleanupAttachments("pod", "/d", 1), /已斷線/);
});

test("structured SSH validation and target precedence", async () => {
  const { sshTargetArgs } = await import("../src/machines.js");
  const base = { id: "remote", socket: "/r.sock" };
  for (const host of ["example.com", "host", "example.com.", "127.0.0.1", "::1", "2001:db8::1"])
    for (const port of [1, 22, 65535])
      assert.equal(validateMachines([{ ...base, host, port, user: "alice_1.x-y" }])[0]!.host, host);
  for (const host of ["", "-x", "a..b", "a/b", "a b", "a\n", "a\u0080", "a;cmd", "[::1]", "fe80::1%eth0", "x".repeat(64), "x.".repeat(128)])
    assert.throws(() => validateMachines([{ ...base, host }]));
  for (const user of ["", "-x", "x y", "a/b", "a;cmd", "x\n", "x".repeat(201), null, 2])
    assert.throws(() => validateMachines([{ ...base, host: "host", user }]));
  for (const port of ["22", "22abc", 0, -1, 65536, 1.5, null, NaN, Infinity])
    assert.throws(() => validateMachines([{ ...base, host: "host", port }]));
  for (const extra of [{}, { ssh: "alias", user: "alice" }, { ssh: "alias", port: 22 }])
    assert.throws(() => validateMachines([{ ...base, ...extra }]));
  assert.deepEqual(sshTargetArgs({ ...base, ssh: "legacy@alias" }), ["legacy@alias"]);
  assert.deepEqual(sshTargetArgs({ ...base, host: "host" }), ["-p", "22", "host"]);
  const both = validateMachines([{ ...base, ssh: "alias", user: "alice", host: "host", port: 2222 }])[0]!;
  // 同時有 ssh 與 host：ssh 是 ~/.ssh/config 已設定的 Host 就直接用 alias，否則回退 user／host／port（review round 1 F1）。
  assert.deepEqual(sshTargetArgs(both, () => true), ["alias"]);
  assert.deepEqual(sshTargetArgs(both, () => false), ["-p", "2222", "alice@host"]);
  assert.deepEqual(sshTargetArgs({ ...base, ssh: "legacy@alias" }, () => false), ["legacy@alias"], "只有 ssh 時不管 config 都原樣用");
  assert.deepEqual(sshTargetArgs({ ...base, host: "host" }, () => true), ["-p", "22", "host"]);
  const { sshTargetLabel } = await import("../src/machines.js");
  assert.equal(sshTargetLabel(both, () => true), "alias");
  assert.equal(sshTargetLabel(both, () => false), "alice@host:2222");
  assert.throws(() => sshTargetArgs(base as never), /no SSH target/);
});

test("sshConfigHasHost 交給 ssh -G 判斷：hostname 與輸入不同才算已設定（review F1/F2/F5/F6）", async () => {
  const { sshConfigHasHost } = await import("../src/machines.js");
  const dir = await mkdtemp(join(tmpdir(), "ssh-config-"));
  try {
    const config = join(dir, "config");
    await mkdir(join(dir, "hosts"));
    await writeFile(join(dir, "hosts", "extra.conf"), "Host nested-top\n  HostName nested.example\nHost pod-in-other\n  HostName x.example\n");
    await writeFile(
      config,
      [
        "Host *",
        "  ServerAliveInterval 15",
        "Host pod",
        "  HostName 192.0.2.2",
        "Host nohost",
        "  User alice",
        "Host same",
        "  Port 2200",
        "Match user bob host matched",
        "  HostName match.example",
        "Host other # pod-comment",
        "  HostName other.example",
        "Host other2",
        "  Include hosts/extra.conf",
        "",
      ].join("\n"),
    );
    assert.equal(sshConfigHasHost("pod", config), true);
    assert.equal(sshConfigHasHost("alice@pod", config), true, "user@alias 只比對 alias");
    assert.equal(sshConfigHasHost("nested-top", config), false, "Include 掛在 Host other2 底下，查別的名字不套用（F5）");
    assert.equal(sshConfigHasHost("pod-comment", config), false, "行尾註解不是 Host pattern（F6）");
    assert.equal(sshConfigHasHost("nohost", config), true, "只有 User 的 Host 也算已設定（F7）");
    assert.equal(sshConfigHasHost("same", config), true, "只有 Port／IdentityFile 的 Host 也算已設定（F7）");
    assert.equal(sshConfigHasHost("bob@matched", config), true, "Match user 以完整 user@alias 解析（F8）");
    assert.equal(sshConfigHasHost("alice@matched", config), false, "Match user 不符時不算已設定（F8）");
    assert.equal(sshConfigHasHost("unknown", config), false);
    assert.equal(sshConfigHasHost("a", config), false, "短名字不能因為輸出裡別處含有同樣字母而誤判（F10）");
    assert.equal(sshConfigHasHost("pod", join(dir, "absent")), false, "設定檔讀不到當作沒有");
    assert.equal(sshConfigHasHost("-oProxyCommand=x", config), false, "以 - 開頭不傳給 ssh");
    assert.equal(sshConfigHasHost("", config), false);
    const { refreshSshConfigHost } = await import("../src/machines.js");
    assert.equal(await refreshSshConfigHost("pod", config), true, "非同步版本同一結果（F9）");
    assert.equal(await refreshSshConfigHost("unknown", config), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
