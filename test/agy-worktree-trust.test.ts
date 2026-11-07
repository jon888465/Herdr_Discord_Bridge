import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgyWorktreeTrust } from "../src/agy-worktree-trust.js";

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agy-trust-")),
  );
  const home = path.join(root, "home");
  const cwd = path.join(home, ".herdr/worktrees/repo/card-req-test");
  fs.mkdirSync(cwd, { recursive: true });
  const settings = path.join(root, "settings.json");
  assert.ok(!settings.startsWith(os.homedir() + path.sep));
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(state, "card-worktrees.json"),
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          cardId: "REQ-20261107-test",
          workspaceId: "w1",
          sourceWorkspaceId: "w0",
          path: cwd,
          repoPath: root,
          branch: "card/test",
          createdAt: "2026-11-07T00:00:00Z",
        },
      ],
    }),
  );
  const original = {
    trustedWorkspaces: ["/user/original"],
    permissions: { a: "unchanged" },
    unknown: [1, "two"],
  };
  fs.writeFileSync(settings, JSON.stringify(original), { mode: 0o640 });
  const logs: string[] = [];
  const events: unknown[] = [];
  const options = {
    home,
    stateDirectory: state,
    settingsPath: settings,
    log: (s: string) => logs.push(s),
    event: (_id: string, e: unknown) => events.push(e),
  };
  const trust = new AgyWorktreeTrust(options);
  return {
    root,
    home,
    cwd,
    settings,
    state,
    original,
    logs,
    events,
    options,
    trust,
    read: () => JSON.parse(fs.readFileSync(settings, "utf8")),
  };
}

test("registered local agy path is added once; ownership survives restart and cleanup preserves user entries", () => {
  const f = fixture();
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.deepEqual(f.read(), {
    ...f.original,
    trustedWorkspaces: ["/user/original", f.cwd],
  });
  assert.equal(fs.statSync(f.settings).mode & 0o777, 0o640);
  const text = fs.readFileSync(f.settings, "utf8");
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.equal(fs.readFileSync(f.settings, "utf8"), text);
  new AgyWorktreeTrust(f.options).cleanup("REQ-20261107-test", f.cwd);
  assert.deepEqual(f.read(), f.original);
  assert.equal(f.logs.length, 3);
  assert.equal(f.events.length, 3);
});

test("preexisting user trust is never owned or removed; other kinds and unindexed paths never edit", () => {
  const f = fixture();
  const original = JSON.stringify({
    ...f.original,
    trustedWorkspaces: ["/user/original", f.cwd],
  });
  fs.writeFileSync(f.settings, original);
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  f.trust.cleanup("REQ-20261107-test", f.cwd);
  for (const kind of ["claude", "codex", "pi", "opencode"])
    f.trust.beforeLaunch(kind, "w1:p1", f.cwd);
  for (const cwd of [
    f.home,
    f.root,
    path.dirname(f.cwd),
    path.dirname(path.dirname(f.cwd)),
    path.join(f.root, "user"),
  ])
    f.trust.beforeLaunch("agy", "w1:p1", cwd);
  assert.equal(fs.readFileSync(f.settings, "utf8"), original);
  assert.ok(!fs.existsSync(path.join(f.state, "agy-worktree-trust.json")));
});

test("indexed parents, home, main repo and symlinks escaping the worktree root are rejected", () => {
  const f = fixture();
  const file = path.join(f.state, "card-worktrees.json");
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  const symlink = path.join(path.dirname(f.cwd), "card-req-escape");
  fs.symlinkSync(f.root, symlink);
  for (const cwd of [
    f.home,
    f.root,
    path.dirname(f.cwd),
    path.dirname(path.dirname(f.cwd)),
    symlink,
  ]) {
    index.worktrees[0].path = cwd;
    fs.writeFileSync(file, JSON.stringify(index));
    f.trust.beforeLaunch("agy", "w1:p1", cwd);
    assert.deepEqual(f.read(), f.original);
  }
});

test("missing, invalid JSON and malformed arrays are unchanged and clearly reported", () => {
  for (const text of [
    undefined,
    "{broken",
    '{"trustedWorkspaces":{}}',
    '{"trustedWorkspaces":[1]}',
    "{}",
  ]) {
    const f = fixture();
    if (text === undefined) fs.unlinkSync(f.settings);
    else fs.writeFileSync(f.settings, text);
    f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
    if (text === undefined) assert.equal(fs.existsSync(f.settings), false);
    else assert.equal(fs.readFileSync(f.settings, "utf8"), text);
    assert.match(f.logs[0], /add error.*settings.json/);
    assert.equal(f.events.length, 1);
  }
});

test("concurrent settings edit is reread and preserved before atomic replacement", () => {
  const f = fixture();
  let once = true;
  const trust = new AgyWorktreeTrust({
    ...f.options,
    beforeRecheck: () => {
      if (!once) return;
      once = false;
      fs.writeFileSync(
        f.settings,
        JSON.stringify({
          ...f.original,
          editorAdded: "keep",
          trustedWorkspaces: ["/user/original", "/editor"],
        }),
      );
    },
  });
  trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.deepEqual(f.read(), {
    ...f.original,
    editorAdded: "keep",
    trustedWorkspaces: ["/user/original", "/editor", f.cwd],
  });
  assert.deepEqual(
    fs.readdirSync(f.root).filter((s) => s.endsWith(".tmp")),
    [],
  );
});

test("cleanup failure only warns and retains ownership for retry", () => {
  const f = fixture();
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  fs.writeFileSync(f.settings, "broken");
  assert.doesNotThrow(() => f.trust.cleanup("REQ-20261107-test", f.cwd));
  assert.match(f.logs.at(-1)!, /remove error/);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.state, "agy-worktree-trust.json"), "utf8"),
    ).length,
    1,
  );
});

test("remote indexed agy warns without reading or touching local settings", () => {
  const f = fixture();
  fs.unlinkSync(f.settings);
  f.trust.beforeLaunch("agy", "agy-pod:w1:p1", f.cwd);
  assert.equal(fs.existsSync(f.settings), false);
  assert.match(f.logs[0], /remote agy trust needs manual handling/);
  assert.equal(f.events.length, 1);
});

test("text outside the array and escaped existing entries remain byte-for-byte unchanged", () => {
  const f = fixture();
  const original =
    '{ "unknown" : {"trustedWorkspaces": ["nested"]}, "trustedWorkspaces" : ["\\u002fuser\\/original"], "permissions" : { "z":true } }\n';
  fs.writeFileSync(f.settings, original);
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.equal(
    fs.readFileSync(f.settings, "utf8"),
    original.replace(
      '["\\u002fuser\\/original"]',
      '["\\u002fuser\\/original",' + JSON.stringify(f.cwd) + "]",
    ),
  );
  f.trust.cleanup("REQ-20261107-test", f.cwd);
  assert.equal(fs.readFileSync(f.settings, "utf8"), original);
});

import { startAgentInPane } from "../src/agent-start.js";
import { runAgentStart } from "../src/agent-launch.js";
import { cleanupCardWorktree } from "../src/card-worktree-flow.js";
import { HerdrClient } from "../src/herdr.js";
import type { AgentRecord } from "../src/types.js";

function agent(cwd: string): AgentRecord {
  return {
    pane_id: "w1:p2",
    terminal_id: "t2",
    workspace_id: "w1",
    tab_id: "w1:t1",
    agent: "agy",
    agent_status: "idle",
    cwd,
  };
}

test("fake launch port sees trust before starting; malformed settings never prevent launch", async () => {
  for (const malformed of [false, true]) {
    const f = fixture();
    if (malformed) fs.writeFileSync(f.settings, "broken");
    let launched = false;
    const port = {
      prepareWorkspaceTrust: (kind: string, pane: string, cwd?: string) =>
        f.trust.beforeLaunch(kind, pane, cwd),
      async request(method: string) {
        assert.equal(method, "agent.start");
        if (!malformed) assert.ok(f.read().trustedWorkspaces.includes(f.cwd));
        launched = true;
        return {};
      },
      async listAgentsWithWorkspaceNames() {
        return [agent(f.cwd)];
      },
    };
    await startAgentInPane(port, {
      paneId: "w1:p2",
      kind: "agy",
      name: "test",
      cwd: f.cwd,
    });
    assert.equal(launched, true);
  }
});

test("agent start --cwd cannot authorize even an indexed worktree", async () => {
  const f = fixture();
  const port = {
    prepareWorkspaceTrust: () =>
      assert.fail("agent start must not request preauthorization"),
    async request(method: string) {
      if (method === "pane.layout")
        return {
          layout: {
            panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 60 } }],
          },
        };
      if (method === "pane.split")
        return {
          pane: { pane_id: "w1:p2", workspace_id: "w1", terminal_id: "t2" },
        };
      if (method === "pane.get") return { pane: { terminal_id: "t2" } };
      return {};
    },
    async listAgentsWithWorkspaceNames() {
      return [agent(f.cwd)];
    },
  };
  await runAgentStart(
    {
      port,
      selected: { ...agent(f.cwd), pane_id: "w1:p1" },
      machineIds: [],
      allowedWorkspaceIds: [],
      workspacePath: f.cwd,
    },
    { spec: "agy", cwd: f.cwd },
  );
  assert.deepEqual(f.read(), f.original);
});

test("card cleanup removes owned trust only after successful worktree removal", async () => {
  const f = fixture();
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  const entry = JSON.parse(
    fs.readFileSync(path.join(f.state, "card-worktrees.json"), "utf8"),
  ).worktrees[0];
  const result = await cleanupCardWorktree(
    {
      port: {
        async request<T>() {
          return { type: "worktree_removed", forced: false } as T;
        },
        cleanupWorkspaceTrust: (id, cwd) => f.trust.cleanup(id, cwd),
      },
      worktrees: { active: () => entry, markRemoved: () => {} },
      deauthorize: () => {},
      now: () => "2026-11-07T00:00:00Z",
    },
    "REQ-20261107-test",
  );
  assert.equal(result.removed, true);
  assert.deepEqual(f.read(), f.original);
});

test("Herdr profile launches preauthorize through injected manager before agent.start", async () => {
  const f = fixture();
  const lead = { ...agent(f.cwd), pane_id: "w1:p1" };
  class FakeHerdr extends HerdrClient {
    override async listAgents() {
      return [lead, agent(f.cwd)];
    }
    override async listAgentsWithWorkspaceNames() {
      return [lead, agent(f.cwd)];
    }
    override async request<T>(method: string): Promise<T> {
      if (method === "pane.layout")
        return {
          layout: {
            panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 60 } }],
          },
        } as T;
      if (method === "pane.split")
        return {
          pane: { pane_id: "w1:p2", workspace_id: "w1", terminal_id: "t2" },
        } as T;
      if (method === "pane.get") return { pane: { terminal_id: "t2" } } as T;
      if (method === "agent.start")
        assert.ok(f.read().trustedWorkspaces.includes(f.cwd));
      return {} as T;
    }
  }
  const client = new FakeHerdr("unused", 1, 1, f.trust);
  await client.startProfile(lead, { id: "agy", kind: "agy" }, "test", () => {});
  assert.ok(f.read().trustedWorkspaces.includes(f.cwd));
});

test("trust implementation has no terminal key or input path and emits no stdout", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/agy-worktree-trust.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /send.?keys|send_input|sendKeys|console\.log|process\.stdout|pane\.request/,
  );
  const f = fixture();
  const write = process.stdout.write;
  let writes = 0;
  process.stdout.write = (() => {
    writes++;
    return true;
  }) as typeof write;
  try {
    f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
    f.trust.cleanup("REQ-20261107-test", f.cwd);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(writes, 0);
});

test("remote agy outside local index still reports manual handling without settings access", () => {
  const f = fixture();
  f.trust.beforeLaunch("agy", "agy-pod:w1:p2", "/remote/project");
  assert.match(f.logs[0] ?? "", /remote agy trust needs manual handling/);
  assert.deepEqual(f.read(), f.original);
});

test("cleanup also finds the bridge-owned canonical entry after an internal symlink is removed", () => {
  const f = fixture();
  const alias = path.join(path.dirname(f.cwd), "card-req-alias");
  fs.symlinkSync(f.cwd, alias);
  const indexPath = path.join(f.state, "card-worktrees.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.worktrees[0].path = alias;
  fs.writeFileSync(indexPath, JSON.stringify(index));
  f.trust.beforeLaunch("agy", "w1:p1", alias);
  assert.ok(f.read().trustedWorkspaces.includes(f.cwd));
  fs.unlinkSync(alias);
  f.trust.cleanup("REQ-20261107-test", alias);
  assert.deepEqual(f.read(), f.original);
});

// 使用者真實的設定是多行縮排的 JSON：加入只多一行，cleanup 後逐位元組還原。
test("a pretty-printed settings file gets exactly one added line and is restored byte-for-byte after cleanup", () => {
  const f = fixture();
  const pretty =
    JSON.stringify(
      { ...f.original, trustedWorkspaces: ["/user/a", "/user/b"] },
      null,
      2,
    ) + "\n";
  fs.writeFileSync(f.settings, pretty, { mode: 0o640 });
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.equal(
    fs.readFileSync(f.settings, "utf8"),
    pretty.replace(
      '"/user/b"\n  ]',
      `"/user/b",\n    ${JSON.stringify(f.cwd)}\n  ]`,
    ),
  );
  new AgyWorktreeTrust(f.options).cleanup("REQ-20261107-test", f.cwd);
  assert.equal(fs.readFileSync(f.settings, "utf8"), pretty);
});

// symlink 的設定檔不能被 rename 換成一般檔案。
test("a settings.json that is a symlink is left alone and reported", () => {
  const f = fixture();
  const real = path.join(f.root, "real-settings.json");
  fs.renameSync(f.settings, real);
  fs.symlinkSync(real, f.settings);
  const before = fs.readFileSync(real, "utf8");
  f.trust.beforeLaunch("agy", "w1:p1", f.cwd);
  assert.ok(fs.lstatSync(f.settings).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), before);
  assert.ok(f.logs.some((line) => /symlink/.test(line)));
});
