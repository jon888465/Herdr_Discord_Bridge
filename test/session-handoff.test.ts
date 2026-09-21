import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  QuotaFailoverManager,
  QuotaFailoverStore,
} from "../src/quota-failover.js";
import { HandoffStore, renderHandoff } from "../src/handoff-store.js";
import { SessionHandoffRuntime } from "../src/session-handoff.js";
import {
  inspectRepository,
  readSessionEvidence,
  publicText,
  adapterName,
} from "../src/handoff-evidence.js";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";
import type { AgentRecord } from "../src/types.js";

const exec = promisify(execFile);
async function fixture() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "handoff-runtime-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repo, ...args])).stdout;
  await git("init", "-q");
  await fs.writeFile(path.join(repo, "file.txt"), "initial\n");
  await git("add", "file.txt");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  const source: AgentRecord = {
    terminal_id: "source",
    pane_id: "w:p1",
    workspace_id: "w",
    tab_id: "tab",
    agent: "agy",
    agent_status: "idle",
    cwd: repo,
    agent_session: { kind: "id", value: "source-session" },
  };
  const destination: AgentRecord = {
    ...source,
    terminal_id: "destination",
    pane_id: "w:p2",
    agent: "opencode",
    agent_session: { kind: "id", value: "destination-session" },
  };
  let live = structuredClone([source, destination]);
  const prompts: string[] = [];
  let badReceipt = false;
  let beforeReport: (() => Promise<void>) | undefined;
  let dispatchError = false;
  const streams = new Set<string>();
  const store = new HandoffStore(path.join(dir, "state"));
  const port = {
    listAgentsWithWorkspaceNames: async () => structuredClone(live),
    promptAgent: async (target: string, text: string) => {
      assert.equal(target, destination.pane_id);
      const id = text.match(/# Session handoff (handoff-[a-f0-9-]+)/)![1];
      const record = new HandoffStore(store.directory).get(id);
      assert.ok(["verifying", "running"].includes(record.state));
      prompts.push(text);
      if (dispatchError) throw new Error("dispatch acknowledgement lost");
      live.find((a) => a.pane_id === target)!.agent_status = "working";
    },
    waitAgent: async () => {
      await beforeReport?.();
      live[1].agent_status = "done";
      return structuredClone(live[1]);
    },
    readAgent: async () => {
      const prompt = prompts.at(-1);
      if (!prompt) return "old output";
      let body = "Remaining work completed; tests passed in fixture only.";
      const receipt = prompt.match(
        /Return only a JSON receipt with exactly these fields: (\{[^\n]+\})/,
      );
      if (receipt) {
        const data = JSON.parse(receipt[1]);
        data.nextAction = "Read AGENTS.md, then implement remaining test";
        data.accepted = !badReceipt;
        body = JSON.stringify(data);
      }
      return `${prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)![0]}\n${body}\n${prompt.match(/BRIDGE_END_[a-f0-9]+/)![0]}`;
    },
  };
  const runtime = new SessionHandoffRuntime(store, port, streams, ["w"], 500);
  const checkpoint = () =>
    runtime.checkpoint(source, "Complete feature; preserve existing changes", {
      guildId: "g",
      channelId: "c",
      threadId: "t",
    });
  return {
    dir,
    repo,
    git,
    source,
    destination,
    store,
    runtime,
    port,
    streams,
    prompts,
    checkpoint,
    live: () => live,
    setLive: (next: AgentRecord[]) => {
      live = next;
    },
    badReceipt: () => {
      badReceipt = true;
    },
    dispatchError: () => {
      dispatchError = true;
    },
    beforeReport: (fn: () => Promise<void>) => {
      beforeReport = fn;
    },
    close: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

test("durable checkpoint -> read-only verification -> accepted ownership -> one continuation", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.repo, "file.txt"), "user dirty change\n");
    await fs.writeFile(path.join(f.repo, "new.txt"), "untracked work\n");
    const cp = await f.checkpoint();
    assert.equal(cp.evidence.source, "checkpoint-only");
    assert.equal(f.prompts.length, 0);
    assert.match(
      await fs.readFile(f.store.packetPath(cp.id), "utf8"),
      /user|Goal and constraints/,
    );
    assert.deepEqual(new HandoffStore(f.store.directory).get(cp.id), cp);
    const verified = await f.runtime.verify(
      cp.id,
      f.destination,
      "operator",
      true,
    );
    assert.equal(verified.state, "verified");
    assert.equal(verified.owner, "source");
    assert.ok(f.runtime.blocks(f.source));
    assert.ok(f.runtime.blocks(f.destination));
    assert.match(f.prompts[0], /READ-ONLY/);
    assert.match(f.prompts[0], /# Session handoff/);
    await assert.rejects(f.runtime.continue(cp.id), /accepted/);
    const accepted = await f.runtime.accept(cp.id);
    assert.equal(accepted.owner, "destination");
    const result = await f.runtime.continue(cp.id);
    assert.equal(result.state, "completed");
    assert.equal(f.prompts.length, 2);
    assert.equal(f.streams.size, 0);
    assert.equal(f.runtime.blocks(f.source), false);
    assert.equal(
      await fs.readFile(path.join(f.repo, "file.txt"), "utf8"),
      "user dirty change\n",
    );
    await assert.rejects(f.runtime.continue(cp.id));
    assert.match(renderHandoff(result), /destination-session/);
  } finally {
    await f.close();
  }
});

for (const change of [
  "head",
  "tracked",
  "untracked",
  "staged",
  "branch",
] as const)
  test(`reject stale checkpoint after ${change} change, including same porcelain status`, async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.repo, "file.txt"), "dirty A\n");
      await fs.writeFile(path.join(f.repo, "new.txt"), "A\n");
      const cp = await f.checkpoint();
      if (change === "head") {
        await f.git("add", ".");
        await f.git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=f@example.invalid",
          "commit",
          "-qm",
          "next",
        );
      }
      if (change === "tracked")
        await fs.writeFile(path.join(f.repo, "file.txt"), "dirty B\n");
      if (change === "untracked")
        await fs.writeFile(path.join(f.repo, "new.txt"), "B\n");
      if (change === "staged") await f.git("add", "file.txt");
      if (change === "branch") await f.git("checkout", "-qb", "other");
      await assert.rejects(
        f.runtime.verify(cp.id, f.destination, "operator", true),
        /repository/,
      );
      assert.equal(f.prompts.length, 0);
      assert.equal(f.streams.size, 0);
    } finally {
      await f.close();
    }
  });

for (const mode of [
  "source-active",
  "unknown-session",
  "replacement",
  "other-worker",
  "active-team",
  "missing-attestation",
  "workspace",
  "same-session",
] as const)
  test(`handoff refuses ${mode} without dispatch`, async () => {
    const f = await fixture();
    try {
      const cp = await f.checkpoint();
      let destination = f.destination;
      if (mode === "source-active") f.live()[0].agent_status = "working";
      if (mode === "unknown-session") delete f.live()[0].agent_session;
      if (mode === "replacement")
        f.live()[1].agent_session = { kind: "id", value: "other" };
      if (mode === "other-worker")
        f.live().push({
          ...f.source,
          terminal_id: "third",
          pane_id: "w:p3",
          agent_status: "working",
        });
      if (mode === "active-team") f.streams.add(f.source.terminal_id);
      if (mode === "workspace")
        destination = { ...destination, workspace_id: "other" };
      if (mode === "same-session") destination = f.source;
      await assert.rejects(
        f.runtime.verify(
          cp.id,
          destination,
          "operator",
          mode !== "missing-attestation",
        ),
      );
      assert.equal(f.prompts.length, 0);
    } finally {
      await f.close();
    }
  });

test("bad receipt and edits during verification quarantine ownership instead of accepting", async () => {
  for (const mutate of [false, true]) {
    const f = await fixture();
    try {
      const cp = await f.checkpoint();
      if (mutate)
        f.beforeReport(async () => {
          await fs.writeFile(path.join(f.repo, "file.txt"), "unexpected write");
        });
      else f.badReceipt();
      await assert.rejects(
        f.runtime.verify(cp.id, f.destination, "operator", true),
      );
      assert.equal(f.store.get(cp.id).state, "blocked");
      assert.equal(f.store.get(cp.id).owner, "source");
      assert.ok(f.runtime.blocks(f.source));
      await assert.rejects(f.runtime.accept(cp.id));
      assert.equal((await f.runtime.cancel(cp.id)).state, "cancelled");
      assert.equal(f.streams.size, 0);
    } finally {
      await f.close();
    }
  }
});

test("unknown dispatch delivery never retries and restart quarantines verified handoffs", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    f.dispatchError();
    await assert.rejects(
      f.runtime.verify(cp.id, f.destination, "operator", true),
      /acknowledgement/,
    );
    await assert.rejects(
      f.runtime.verify(cp.id, f.destination, "operator", true),
    );
    assert.equal(f.prompts.length, 1);
    const recovered = new SessionHandoffRuntime(
      new HandoffStore(f.store.directory),
      f.port,
      new Set(),
      ["w"],
    );
    await recovered.reconcile();
    assert.equal(recovered.store.get(cp.id).state, "blocked");
    assert.match(recovered.store.get(cp.id).detail!, /restarted/);
    await assert.rejects(recovered.accept(cp.id));
    assert.equal(f.prompts.length, 1);
  } finally {
    await f.close();
  }
});

test("concurrent handoff verification and cancellation cannot race in-flight dispatch", async () => {
  const f = await fixture();
  try {
    const one = await f.checkpoint();
    const two = await f.checkpoint();
    let release!: () => void;
    f.beforeReport(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const running = f.runtime.verify(one.id, f.destination, "operator", true);
    for (let i = 0; i < 100 && !release; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(release);
    await assert.rejects(
      f.runtime.verify(two.id, f.destination, "operator", true),
      /held/,
    );
    await assert.rejects(f.runtime.cancel(one.id), /progress/);
    release();
    await running;
    assert.equal(f.prompts.length, 1);
    await f.runtime.cancel(one.id);
  } finally {
    await f.close();
  }
});

test("accept rechecks dirty content and does not transfer stale ownership", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    await f.runtime.verify(cp.id, f.destination, "operator", true);
    await fs.writeFile(path.join(f.repo, "file.txt"), "external change");
    await assert.rejects(f.runtime.accept(cp.id), /repository/);
    assert.equal(f.store.get(cp.id).owner, "source");
    assert.equal(f.store.get(cp.id).state, "blocked");
  } finally {
    await f.close();
  }
});

test("registry rejects corrupt schema, immutable checkpoint mutation, and fails closed after atomic failure", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    assert.throws(
      () =>
        f.store.update(cp.id, "tamper", (r) => {
          r.goal = "different";
        }),
      /immutable/,
    );
    assert.throws(
      () =>
        f.store.update(cp.id, "tamper", (r) => {
          r.owner = "destination";
        }),
      /ownership/,
    );
    const file = path.join(f.store.directory, `${cp.id}.json`);
    const original = await fs.readFile(file, "utf8");
    const data = JSON.parse(original);
    data.schemaVersion = 99;
    await fs.writeFile(file, JSON.stringify(data));
    assert.throws(() => new HandoffStore(f.store.directory), /schema/);
    await fs.writeFile(file, original);
    await fs.rename(f.store.directory, path.join(f.dir, "saved"));
    await fs.writeFile(f.store.directory, "not a directory");
    assert.throws(() =>
      f.store.update(cp.id, "cancel", (r) => {
        r.state = "cancelled";
      }),
    );
    assert.throws(
      () => f.store.update(cp.id, "retry", () => {}),
      /persistence failed/,
    );
    assert.equal(
      new HandoffStore(path.join(f.dir, "saved")).get(cp.id).state,
      "checkpoint",
    );
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.close();
  }
});

test("public export adapters filter private channels, validate exact ID/cwd, and keep AGY distinct", async () => {
  const f = await fixture();
  try {
    assert.equal(adapterName(f.source), "agy");
    assert.equal(adapterName({ ...f.source, agent: "gemini" }), "gemini");
    const exported = {
      schemaVersion: 1,
      harness: "agy",
      sessionId: "source-session",
      cwd: f.repo,
      messages: [
        { role: "user", text: "Goal" },
        { role: "assistant", channel: "final", text: "Next action" },
        { role: "assistant", channel: "analysis", text: "PRIVATE_REASONING" },
        { role: "tool", text: "PRIVATE_TOOL" },
      ],
    };
    await fs.writeFile(
      path.join(f.repo, "export.json"),
      JSON.stringify(exported),
    );
    const repo = await inspectRepository(f.repo);
    const evidence = await readSessionEvidence(f.source, repo, "export.json");
    assert.equal(evidence.source, "public-export-v1");
    assert.match(evidence.text, /Goal/);
    assert.doesNotMatch(evidence.text, /PRIVATE/);
    await assert.rejects(
      readSessionEvidence(
        { ...f.source, agent_session: { kind: "id", value: "wrong" } },
        repo,
        "export.json",
      ),
      /identity/,
    );
    await fs.symlink(
      path.join(f.dir, "outside.json"),
      path.join(f.repo, "escape.json"),
    );
    await fs.writeFile(
      path.join(f.dir, "outside.json"),
      JSON.stringify(exported),
    );
    await assert.rejects(
      readSessionEvidence(f.source, repo, "escape.json"),
      /inside/,
    );
    assert.doesNotMatch(
      publicText(
        "password=secret\n-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
      ),
      /KEY|password=secret/,
    );
  } finally {
    await f.close();
  }
});

test("Codex native adapter reads only an exact session and public supported events", async () => {
  const f = await fixture();
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(f.dir, "codex");
    await fs.mkdir(path.join(process.env.CODEX_HOME, "sessions"), {
      recursive: true,
    });
    const id = "00000000-0000-0000-0000-000000000001";
    const source = {
      ...f.source,
      agent: "codex",
      agent_session: { kind: "id", value: id },
    };
    const file = path.join(
      process.env.CODEX_HOME,
      "sessions",
      `rollout-${id}.jsonl`,
    );
    await fs.writeFile(
      file,
      [
        { type: "session_meta", payload: { id, cwd: f.repo } },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "original goal" },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "public report",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "analysis",
            message: "PRIVATE",
          },
        },
        {
          type: "response_item",
          payload: { type: "reasoning", text: "PRIVATE" },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const repo = await inspectRepository(f.repo);
    const evidence = await readSessionEvidence(source, repo);
    assert.equal(evidence.source, "codex-jsonl");
    assert.match(evidence.text, /original goal/);
    assert.doesNotMatch(evidence.text, /PRIVATE/);
    await fs.copyFile(
      file,
      path.join(process.env.CODEX_HOME, "sessions", `duplicate-${id}.jsonl`),
    );
    assert.equal(
      (await readSessionEvidence(source, repo)).source,
      "checkpoint-only",
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await f.close();
  }
});

test("command contexts restrict packets and replies, block normal prompts while ownership is held", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    const context = createConsoleContext(() => {});
    const routing = new RoutingStore(path.join(f.dir, "routing.json"));
    routing.bind(context.routing, {
      workspaceId: "w",
      paneId: f.source.pane_id,
    });
    const output: string[] = [];
    const runtime = {
      handoffs: f.runtime,
      herdr: f.port,
      routing,
      activeStreams: f.streams,
      config: { allowedWorkspaceIds: ["w"] },
      discord: {
        reply: async (_: unknown, text: string) => {
          output.push(text);
        },
      },
    } as unknown as Parameters<typeof handleCommand>[3];
    await handleCommand("handoff", ["status", cp.id], context, runtime);
    assert.match(output.join("\n"), /checkpoint/);
    const wrong = {
      ...context,
      source: undefined,
      routing: {
        guildId: "g",
        channelId: "other",
        threadId: "other",
        userId: "user",
      },
    };
    routing.bind(wrong.routing, { workspaceId: "w" });
    await assert.rejects(
      handleCommand("handoff", ["packet", cp.id], wrong, runtime),
      /context/,
    );
    await f.runtime.verify(cp.id, f.destination, "operator", true);
    await assert.rejects(
      handleCommand("ask", ["hello"], context, runtime),
      /handoff/,
    );
    await assert.rejects(
      handleCommand("cancel", [f.source.pane_id], context, runtime),
      /handoff/,
    );
    await handleCommand("handoff", ["accept", cp.id], context, runtime);
    assert.equal(
      routing.resolve(context.routing)?.paneId,
      f.destination.pane_id,
    );
  } finally {
    await f.close();
  }
});

test("legacy prompt transport opts out of retries after lost acknowledgement", async () => {
  const { HerdrClient } = await import("../src/herdr.js");
  const calls: unknown[] = [];
  class Client extends HerdrClient {
    override async request<T = unknown>(
      ...args: Parameters<InstanceType<typeof HerdrClient>["request"]>
    ): Promise<T> {
      calls.push(args);
      throw new Error("ack lost");
    }
  }
  await assert.rejects(
    new Client().promptAgent("w:p2", "continue"),
    /ack lost/,
  );
  assert.deepEqual(calls, [
    ["agent.prompt", { target: "w:p2", text: "continue" }, { retries: 0 }],
  ]);
});

test("restart after ownership acceptance blocks continuation and does not release a busy session", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    await f.runtime.verify(cp.id, f.destination, "operator", true);
    await f.runtime.accept(cp.id);
    const recovered = new SessionHandoffRuntime(
      new HandoffStore(f.store.directory),
      f.port,
      new Set(),
      ["w"],
    );
    await recovered.reconcile();
    assert.equal(recovered.store.get(cp.id).owner, "destination");
    await assert.rejects(recovered.continue(cp.id));
    f.live()[1].agent_status = "working";
    await assert.rejects(recovered.cancel(cp.id), /settle/);
    assert.ok(recovered.blocks(f.source));
    f.live()[1].agent_status = "idle";
    assert.equal((await recovered.cancel(cp.id)).state, "cancelled");
    assert.equal(f.prompts.length, 1);
  } finally {
    await f.close();
  }
});

test("persistence failure before verification dispatch has no Agent side effect", async () => {
  const f = await fixture();
  try {
    const cp = await f.checkpoint();
    const update = f.store.update.bind(f.store);
    f.store.update = (id, event, mutate) => {
      if (event === "verification_intent") throw new Error("disk full");
      return update(id, event, mutate);
    };
    await assert.rejects(
      f.runtime.verify(cp.id, f.destination, "operator", true),
      /disk full/,
    );
    assert.equal(f.prompts.length, 0);
    assert.equal(f.store.get(cp.id).state, "checkpoint");
    assert.equal(f.streams.size, 0);
  } finally {
    await f.close();
  }
});

test("nested Agent cwd fingerprints the whole repository including untracked files outside that directory", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.repo, "nested"));
    await fs.writeFile(path.join(f.repo, "outside.txt"), "A");
    const root = await inspectRepository(f.repo);
    const nested = await inspectRepository(path.join(f.repo, "nested"));
    assert.equal(root.fingerprint, nested.fingerprint);
    await fs.writeFile(path.join(f.repo, "outside.txt"), "B");
    assert.notEqual(
      (await inspectRepository(path.join(f.repo, "nested"))).fingerprint,
      nested.fingerprint,
    );
  } finally {
    await f.close();
  }
});

test("Phase 4 quota failover runs real handoff verification and continuation with preserved dirty work", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await fs.writeFile(path.join(f.repo, "file.txt"), "existing user work\n");
  const manager = new QuotaFailoverManager(
    new QuotaFailoverStore(path.join(f.dir, "quota.json")),
    f.runtime,
    f.port.listAgentsWithWorkspaceNames,
    ["w"],
  );
  const policy = manager.arm(
    f.source,
    [f.destination],
    "Continue work without reverting user changes",
    { guildId: "g", channelId: "c" },
  );
  await manager.report(
    f.destination,
    "available",
    "destination-budget",
    "operator",
  );
  await manager.report(f.source, "exhausted", "source-budget", "operator");
  assert.equal(f.prompts.length, 0);
  const ready = manager.store.get(policy.id);
  assert.equal(ready.state, "ready");
  const result = await manager.run(policy.id, "operator", true);
  assert.equal(result.state, "completed");
  assert.equal(f.store.get(ready.checkpointId!).owner, "destination");
  assert.equal(f.prompts.length, 2);
  assert.equal(
    await fs.readFile(path.join(f.repo, "file.txt"), "utf8"),
    "existing user work\n",
  );
});
