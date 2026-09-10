import test from "node:test";
import assert from "node:assert/strict";
import { parseConsoleCommand } from "../src/console.js";

test("pane console accepts plain and prefixed bridge commands", () => {
  assert.deepEqual(parseConsoleCommand("agent", "/herdr"), {
    command: "agent",
    args: [],
  });
  assert.deepEqual(parseConsoleCommand("agent use w2:p1", "/herdr"), {
    command: "agent",
    args: ["use", "w2:p1"],
  });
  assert.deepEqual(parseConsoleCommand("wk", "/herdr"), {
    command: "wk",
    args: [],
  });
  assert.deepEqual(parseConsoleCommand("/herdr team list", "/herdr"), {
    command: "team",
    args: ["list"],
  });
  assert.deepEqual(
    parseConsoleCommand("ask w2:p1 inspect the current task", "/herdr"),
    {
      command: "ask",
      args: ["w2:p1", "inspect", "the", "current", "task"],
    },
  );
  assert.equal(parseConsoleCommand("   ", "/herdr"), null);
});

test("console shares a selected thread bidirectionally and retains selection after reload", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoutingStore } = await import("../src/routing.js");
  const { createConsoleContext, routeConsoleCommand } =
    await import("../src/console.js");
  const dir = mkdtempSync(join(tmpdir(), "bridge-shared-route-"));
  let store = new RoutingStore(join(dir, "routing.json"));
  const config = {
    allowedWorkspaceIds: ["w1"],
    discord: { allowedGuildIds: ["g"], allowedChannelIds: ["c"] },
  } as Parameters<typeof routeConsoleCommand>[4];
  const thread = {
    guildId: "g",
    channelId: "c",
    threadId: "t1",
    userId: "discord-user",
  };
  const target = { workspaceId: "w1", paneId: "w1:p1" };
  const local = createConsoleContext(() => {});
  try {
    store.bind(thread, target);
    store.bind({ ...thread, threadId: "t2" }, { ...target, paneId: "w1:p9" });
    await routeConsoleCommand("thread", ["t1"], local, store, config);
    const shared = await routeConsoleCommand(
      "current",
      [],
      local,
      store,
      config,
    );
    assert.ok(shared);
    assert.equal(store.resolve(shared.routing)?.paneId, "w1:p1");
    store.bind(shared.routing, { ...target, paneId: "w1:p2" });
    assert.equal(store.resolve(thread)?.paneId, "w1:p2");
    assert.equal(store.resolve({ ...thread, threadId: "t2" })?.paneId, "w1:p9");
    store.bind(thread, { ...target, paneId: "w1:p3" });
    assert.equal(store.resolve(shared.routing)?.paneId, "w1:p3");
    assert.equal(store.threadTargets(shared.routing).length, 3);
    store.flush();
    store = new RoutingStore(join(dir, "routing.json"));
    const restored = await routeConsoleCommand(
      "current",
      [],
      local,
      store,
      config,
    );
    assert.equal(restored?.routing.threadId, "t1");
    assert.equal(restored && store.resolve(restored.routing)?.paneId, "w1:p3");
    await assert.rejects(
      routeConsoleCommand("current", [], local, store, {
        ...config,
        allowedWorkspaceIds: ["w2"],
      }),
      /unauthorized/,
    );
    await assert.rejects(
      routeConsoleCommand("thread", ["missing"], local, store, config),
      /Unknown/,
    );
    await routeConsoleCommand("thread", ["off"], local, store, config);
    assert.deepEqual(
      (await routeConsoleCommand("current", [], local, store, config))?.routing,
      local.routing,
    );
    assert.equal(store.resolve(thread)?.paneId, "w1:p3");
    assert.equal(local.message.attachments.size, 0);
  } finally {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});
