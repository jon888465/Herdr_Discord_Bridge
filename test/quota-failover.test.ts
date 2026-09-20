import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  QuotaFailoverManager,
  QuotaFailoverStore,
} from "../src/quota-failover.js";
import type { AgentRecord } from "../src/types.js";
import type { HandoffRecord } from "../src/handoff-store.js";
import { handleCommand } from "../src/main.js";
import { createConsoleContext, parseConsoleCommand } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "quota-failover-"));
  const file = path.join(dir, "quota.json");
  const agent = (id: string): AgentRecord => ({
    terminal_id: id,
    pane_id: `w:${id}`,
    workspace_id: "w",
    tab_id: "tab",
    agent: "opencode",
    agent_status: "idle",
    agent_session: { kind: "id", value: id },
  });
  const source = agent("source"),
    a = agent("a"),
    b = agent("b");
  let live = [source, a, b];
  let now = Date.parse("2026-09-20T00:00:00Z");
  const store = new QuotaFailoverStore(file);
  const calls: string[] = [];
  let hook: (stage: string) => Promise<void> = async () => {};
  const cp = {
    id: "handoff-00000000-0000-0000-0000-000000000001",
    state: "checkpoint",
  } as HandoffRecord;
  const step = async (name: string, state: HandoffRecord["state"]) => {
    calls.push(name);
    await hook(name);
    return { ...cp, state };
  };
  const port = {
    checkpoint: async () => step("checkpoint", "checkpoint"),
    verify: async (_id: string, destination: AgentRecord) =>
      step(`verify:${destination.terminal_id}`, "verified"),
    accept: async () => step("accept", "accepted"),
    continue: async () => step("continue", "completed"),
    cancel: async () => step("cancel", "cancelled"),
  };
  const getLive = async () => structuredClone(live);
  const manager = new QuotaFailoverManager(
    store,
    port,
    getLive,
    ["w"],
    () => now,
  );
  const origin = { guildId: "g", channelId: "c", threadId: "t" };
  const arm = () =>
    manager.arm(
      source,
      [a, b],
      "Finish authorized work; do not deploy",
      origin,
    );
  const ready = async () => {
    const p = arm();
    await manager.report(a, "available", "pool-b", "operator");
    await manager.report(b, "available", "pool-c", "operator");
    await manager.report(source, "limited", "pool-a", "operator");
    return store.get(p.id);
  };
  return {
    dir,
    file,
    store,
    source,
    a,
    b,
    port,
    manager,
    calls,
    cp,
    arm,
    ready,
    getLive,
    setLive: (next: AgentRecord[]) => {
      live = next;
    },
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
    advance: (ms: number) => {
      now += ms;
    },
    restart: () =>
      new QuotaFailoverManager(
        new QuotaFailoverStore(file),
        port,
        getLive,
        ["w"],
        () => now,
      ),
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("quota signals persist, trigger one checkpoint and execute the ordered verified failover once", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = f.arm();
  await f.manager.report(f.source, "unknown", "pool-a", "operator");
  await f.manager.report(f.source, "available", "pool-a", "operator");
  assert.deepEqual(f.calls, []);
  f.setHook(async (stage) => {
    const saved = new QuotaFailoverStore(f.file).get(p.id);
    assert.equal(
      saved.state,
      stage === "checkpoint" ? "checkpointing" : "running",
    );
  });
  await f.manager.report(f.a, "available", "pool-b", "operator");
  await f.manager.report(f.source, "exhausted", "pool-a", "operator");
  await f.manager.report(f.source, "exhausted", "pool-a", "operator");
  assert.deepEqual(f.calls, ["checkpoint"]);
  assert.equal(f.store.get(p.id).state, "ready");
  const result = await f.manager.run(p.id, "operator", true);
  assert.equal(result.state, "completed");
  assert.deepEqual(f.calls, ["checkpoint", "verify:a", "accept", "continue"]);
  await assert.rejects(f.manager.run(p.id, "operator", true), /ready/);
  assert.equal(f.restart().store.get(p.id).state, "completed");
});

for (const reason of [
  "unknown",
  "expired",
  "same-budget",
  "shared-conflict",
  "source-available",
  "source-expired",
  "replaced",
  "busy",
  "clock-reversed",
])
  test(`reject ${reason} candidates before dispatch, retain ready for corrected observations`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const p = await f.ready();
    f.setLive([f.source, f.a]);
    if (reason === "unknown")
      await f.manager.report(f.a, "unknown", "pool-b", "operator");
    if (reason === "expired") {
      await f.manager.report(f.a, "available", "pool-b", "operator", 30);
      f.advance(30001);
    }
    if (reason === "same-budget")
      await f.manager.report(f.a, "available", "pool-a", "operator");
    if (reason === "shared-conflict") {
      f.setLive([f.source, f.a, f.b]);
      await f.manager.report(f.b, "exhausted", "pool-b", "operator");
    }
    if (reason === "source-available")
      await f.manager.report(f.source, "available", "pool-a", "operator");
    if (reason === "source-expired") {
      await f.manager.report(f.source, "limited", "pool-a", "operator", 30);
      f.advance(30001);
    }
    if (reason === "replaced")
      f.setLive([
        f.source,
        { ...f.a, agent_session: { kind: "id", value: "new" } },
      ]);
    if (reason === "busy")
      f.setLive([f.source, { ...f.a, agent_status: "working" }]);
    if (reason === "clock-reversed") f.advance(-1);
    await assert.rejects(f.manager.run(p.id, "operator", true), /eligible/);
    assert.equal(f.store.get(p.id).state, "ready");
    assert.deepEqual(f.calls, ["checkpoint"]);
  });

test("skip unavailable first candidate using only the frozen explicit ordered allowlist", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  await f.manager.report(f.a, "limited", "pool-b", "operator");
  assert.equal(
    (await f.manager.run(p.id, "operator", true)).destination?.terminal_id,
    "b",
  );
  assert.deepEqual(f.calls, ["checkpoint", "verify:b", "accept", "continue"]);
});

for (const stage of ["verify:a", "accept", "continue"])
  test(`uncertain ${stage} failure quarantines without retrying another destination`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const p = await f.ready();
    f.setHook(async (name) => {
      if (name === stage) throw new Error("acknowledgement lost");
    });
    await assert.rejects(
      f.manager.run(p.id, "operator", true),
      /acknowledgement/,
    );
    assert.equal(f.store.get(p.id).state, "blocked");
    assert.equal(f.store.get(p.id).destination?.terminal_id, "a");
    await assert.rejects(f.manager.run(p.id, "operator", true), /ready/);
    assert.ok(!f.calls.includes("verify:b"));
    f.restart().reconcile();
    assert.equal(f.store.get(p.id).state, "blocked");
  });

for (const stage of ["verify:a", "accept"])
  test(`quota expiration during ${stage} stops before continuation`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const p = await f.ready();
    f.setHook(async (name) => {
      if (name === stage) f.advance(900001);
    });
    await assert.rejects(f.manager.run(p.id, "operator", true), /expired/);
    assert.equal(f.store.get(p.id).state, "blocked");
    assert.ok(!f.calls.includes("continue"));
  });

test("stopped-writer attestation, workspace and exact report identity are required", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  await assert.rejects(
    f.manager.run(p.id, "operator", false),
    /confirm-source-stopped/,
  );
  await assert.rejects(f.manager.run(p.id, "", true), /operator/);
  await assert.rejects(
    f.manager.report(
      { ...f.a, workspace_id: "other" },
      "available",
      "pool",
      "operator",
    ),
    /authorized/,
  );
  await assert.rejects(
    f.manager.report(
      { ...f.a, agent_session: { kind: "id", value: "new" } },
      "available",
      "pool",
      "operator",
    ),
    /session/,
  );
  await assert.rejects(
    f.manager.report(f.a, "available", "secret/password", "operator"),
    /observation/,
  );
  await assert.rejects(
    f.manager.report(f.a, "available", "pool", "operator", 1),
    /validity/,
  );
  assert.deepEqual(f.calls, ["checkpoint"]);
});

test("arm validates unknown sessions, duplicate candidates, missing scope and oversized goal", (t) => {
  const f = fixture();
  t.after(f.close);
  const origin = { guildId: "g", channelId: "c" };
  assert.throws(
    () => f.manager.arm(f.source, [f.a, f.a], "goal", origin),
    /candidate/,
  );
  assert.throws(
    () =>
      f.manager.arm(
        f.source,
        [{ ...f.a, agent_session: undefined }],
        "goal",
        origin,
      ),
    /session/,
  );
  assert.throws(
    () => f.manager.arm(f.source, [f.a], "x".repeat(6001), origin),
    /6000/,
  );
  f.arm();
  assert.throws(f.arm, /active/);
});

test("checkpoint failure remains blocked and repeated reports do not retry", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = f.arm();
  f.setHook(async () => {
    throw new Error("repository changed during checkpoint");
  });
  await f.manager.report(f.source, "exhausted", "pool-a", "operator");
  assert.equal(f.store.get(p.id).state, "blocked");
  await f.manager.report(f.source, "exhausted", "pool-a", "operator");
  assert.deepEqual(f.calls, ["checkpoint"]);
});

for (const state of ["checkpointing", "running"] as const)
  test(`restart during ${state} quarantines without replay`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const p = state === "running" ? await f.ready() : f.arm();
    f.store.update("crash_fixture", (s) => {
      const r = s.policies.find((r) => r.id === p.id)!;
      r.state = state;
      if (state === "running") r.destination = f.a;
    });
    const before = [...f.calls];
    const restarted = f.restart();
    restarted.reconcile();
    assert.equal(restarted.store.get(p.id).state, "blocked");
    assert.deepEqual(f.calls, before);
    await assert.rejects(restarted.run(p.id, "operator", true), /ready/);
  });

test("concurrent run/cancel refuse while operation is active; cancellation respects handoff ownership", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setHook(async (name) => {
    if (name === "verify:a") {
      entered();
      await wait;
      throw new Error("blocked");
    }
  });
  const running = f.manager.run(p.id, "operator", true);
  const rejected = assert.rejects(running, /blocked/);
  await started;
  await assert.rejects(f.manager.run(p.id, "operator", true), /progress/);
  await assert.rejects(f.manager.cancel(p.id), /progress/);
  release();
  await rejected;
  f.setHook(async (name) => {
    if (name === "cancel") throw new Error("session still working");
  });
  await assert.rejects(f.manager.cancel(p.id), /working/);
  assert.equal(f.store.get(p.id).state, "blocked");
  f.setHook(async () => {});
  assert.equal((await f.manager.cancel(p.id)).state, "cancelled");
});

test("atomic persistence failure blocks dispatch and poisons subsequent mutation", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  fs.unlinkSync(f.file);
  fs.mkdirSync(f.file);
  await assert.rejects(f.manager.run(p.id, "operator", true));
  assert.deepEqual(f.calls, ["checkpoint"]);
  assert.equal(f.store.get(p.id).state, "ready");
  await assert.rejects(
    f.manager.report(f.a, "available", "pool-b", "operator"),
    /persistence/,
  );
});

test("registry rejects schema corruption, removed policies, changed identities and invalid execution transitions", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  assert.throws(
    () =>
      f.store.update("bad", (s) => {
        s.policies = [];
      }),
    /removed/,
  );
  assert.throws(
    () =>
      f.store.update("bad", (s) => {
        s.policies[0].goal = "changed";
      }),
    /identity/,
  );
  assert.throws(
    () =>
      f.store.update("bad", (s) => {
        s.policies[0].state = "completed";
      }),
    /destination/,
  );
  assert.throws(
    () =>
      f.store.update("bad", (s) => {
        s.policies[0].checkpointId = undefined;
      }),
    /checkpoint/,
  );
  assert.equal(f.store.get(p.id).state, "ready");
  const valid = fs.readFileSync(f.file, "utf8");
  fs.writeFileSync(
    f.file,
    valid.replace('"schemaVersion":1', '"schemaVersion":99'),
  );
  assert.throws(() => new QuotaFailoverStore(f.file), /schema/);
});

test("console commands are recognized; Discord policy actions are scoped to origin and workspace", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = await f.ready();
  const context = createConsoleContext(() => {});
  const routing = new RoutingStore(path.join(f.dir, "routing.json"));
  routing.bind(context.routing, { workspaceId: "w", paneId: f.source.pane_id });
  const output: string[] = [];
  const runtime = {
    failover: f.manager,
    routing,
    herdr: { listAgentsWithWorkspaceNames: f.getLive },
    config: { allowedWorkspaceIds: ["w"] },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  for (const command of ["quota", "failover"])
    assert.equal(
      parseConsoleCommand(`${command} status`, "/herdr")?.command,
      command,
    );
  await handleCommand("quota", ["status"], context, runtime);
  await handleCommand("failover", ["status", p.id], context, runtime);
  assert.match(output.join("\n"), /pool-b/);
  const wrong = {
    ...context,
    source: undefined,
    routing: { guildId: "g", channelId: "other", userId: "operator" },
  };
  routing.bind(wrong.routing, { workspaceId: "w" });
  for (const args of [
    ["status", p.id],
    ["cancel", p.id],
    ["run", p.id, "confirm-source-stopped"],
  ])
    await assert.rejects(
      handleCommand("failover", args, wrong, runtime),
      /context/,
    );
  output.length = 0;
  await handleCommand("failover", ["status"], wrong, runtime);
  assert.doesNotMatch(output.join("\n"), new RegExp(p.id));
  await handleCommand(
    "failover",
    ["run", p.id, "confirm-source-stopped"],
    context,
    runtime,
  );
  assert.equal(routing.resolve(context.routing)?.paneId, f.a.pane_id);
});

test("armed and ready policies survive restart without replay; explicit cancellation of armed sends nothing", async (t) => {
  const f = fixture();
  t.after(f.close);
  const armed = f.arm();
  const restarted = f.restart();
  restarted.reconcile();
  assert.equal(restarted.store.get(armed.id).state, "armed");
  assert.equal((await restarted.cancel(armed.id)).state, "cancelled");
  assert.deepEqual(f.calls, []);
  const p = restarted.arm(f.source, [f.a], "Continue", {
    guildId: "g",
    channelId: "c",
  });
  await restarted.report(f.source, "limited", "pool-a", "operator");
  const next = f.restart();
  next.reconcile();
  assert.equal(next.store.get(p.id).state, "ready");
  assert.deepEqual(f.calls, ["checkpoint"]);
});

test("quota command hides another Discord context's triggered checkpoint; workspace selection still enforced", async (t) => {
  const f = fixture();
  t.after(f.close);
  const p = f.arm();
  const consoleContext = createConsoleContext(() => {});
  const context = {
    ...consoleContext,
    source: undefined,
    routing: { guildId: "g", channelId: "other", userId: "operator" },
  };
  const routing = new RoutingStore(path.join(f.dir, "routing.json"));
  routing.bind(context.routing, { workspaceId: "w" });
  const output: string[] = [];
  const runtime = {
    failover: f.manager,
    routing,
    herdr: { listAgentsWithWorkspaceNames: f.getLive },
    config: { allowedWorkspaceIds: ["w", "other"] },
    discord: {
      reply: async (_: unknown, text: string) => {
        output.push(text);
      },
    },
  } as unknown as Parameters<typeof handleCommand>[3];
  await handleCommand(
    "quota",
    ["report", f.source.pane_id, "limited", "pool-a", "300"],
    context,
    runtime,
  );
  assert.equal(f.store.get(p.id).state, "ready");
  assert.doesNotMatch(output.join("\n"), /failover-|handoff-/);
  routing.bind(context.routing, { workspaceId: "other" });
  await assert.rejects(
    handleCommand(
      "quota",
      ["report", f.source.pane_id, "limited", "pool-a"],
      context,
      runtime,
    ),
    /workspace/,
  );
});
