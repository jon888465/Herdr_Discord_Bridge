import test from "node:test";
import assert from "node:assert/strict";
import { HerdrError } from "../src/herdr.js";
import {
  MIN_HERDR_VERSION,
  WorktreeError,
  branchForCard,
  checkWorktreeSupport,
  closeBridgeRepoWorkspace,
  createWorktree,
  listWorktrees,
  removeWorktree,
  type WorktreePort,
} from "../src/worktree.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakePort(
  reply: (call: Call) => unknown | Promise<unknown>,
): WorktreePort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      const call = { method, params };
      calls.push(call);
      return (await reply(call)) as T;
    },
  };
}

const created = {
  type: "worktree_created",
  workspace: { workspace_id: "w9", label: "card" },
  worktree: {
    path: "/Users/example/.herdr/worktrees/repo/card-REQ-20261102-a",
    branch: "card/REQ-20261102-a",
    is_linked_worktree: true,
  },
  root_pane: {
    pane_id: "w9:p1",
    cwd: "/Users/example/.herdr/worktrees/repo/card-REQ-20261102-a",
  },
  tab: { tab_id: "w9:t1" },
};

test("branchForCard names the branch card/<id> and refuses anything that is not a card id", () => {
  assert.equal(branchForCard("REQ-20261102-ab"), "card/REQ-20261102-ab");
  assert.equal(
    branchForCard("TKT-20261102-fix-login"),
    "card/TKT-20261102-fix-login",
  );
  for (const bad of [
    "",
    "../x",
    "REQ-1",
    "card/REQ-20261102-a",
    "REQ-20261102-a b",
  ])
    assert.throws(() => branchForCard(bad), /card id/, bad);
});

test("createWorktree sends only the safe parameters and returns where the work will happen", async () => {
  const port = fakePort(() => created);
  const result = await createWorktree(port, {
    repoPath: "/Users/example/git_wk/repo",
    branch: "card/REQ-20261102-a",
  });
  // ISSUE-221：建立前先列一次 workspace（用來判斷 repo 主 workspace 是不是這次才開出來的）；列不出來就不猜。
  assert.deepEqual(port.calls.map((call) => call.method), ["workspace.list", "worktree.create"]);
  assert.deepEqual(port.calls.filter((call) => call.method === "worktree.create"), [
    {
      method: "worktree.create",
      params: {
        cwd: "/Users/example/git_wk/repo",
        branch: "card/REQ-20261102-a",
        focus: false,
      },
    },
  ]);
  assert.deepEqual(result, {
    workspaceId: "w9",
    path: "/Users/example/.herdr/worktrees/repo/card-REQ-20261102-a",
    branch: "card/REQ-20261102-a",
    rootPaneId: "w9:p1",
    tabId: "w9:t1",
  });
});

test("an explicit base is passed through, and trust_repository, force and path are never sent", async () => {
  const port = fakePort(() => created);
  await createWorktree(port, {
    repoPath: "/repo",
    branch: "card/REQ-20261102-a",
    base: "origin/main",
  });
  const params = port.calls.find((call) => call.method === "worktree.create")!.params;
  assert.equal(params.base, "origin/main");
  for (const key of ["trust_repository", "force", "path", "label"])
    assert.equal(Object.hasOwn(params, key), false, key);
});

test("invalid repository paths, branches and bases are refused before anything is sent", async () => {
  const cases: Array<[string, Partial<Parameters<typeof createWorktree>[1]>]> =
    [
      ["relative repo path", { repoPath: "repo" }],
      ["control character in repo path", { repoPath: "/repo\n/x" }],
      ["empty branch", { branch: "" }],
      ["branch with a space", { branch: "card/a b" }],
      ["branch with ..", { branch: "card/a..b" }],
      ["branch starting with -", { branch: "-card" }],
      ["branch starting with /", { branch: "/card" }],
      ["branch ending with /", { branch: "card/" }],
      ["branch with //", { branch: "card//a" }],
      ["branch ending with .lock", { branch: "card/a.lock" }],
      ["branch ending with a dot", { branch: "card/a." }],
      ["branch over 80 characters", { branch: `card/${"a".repeat(80)}` }],
      ["branch with ~", { branch: "card/a~1" }],
      ["base starting with -", { base: "--force" }],
      ["base with a space", { base: "main x" }],
    ];
  for (const [name, patch] of cases) {
    const port = fakePort(() => created);
    await assert.rejects(
      createWorktree(port, {
        repoPath: "/repo",
        branch: "card/REQ-20261102-a",
        ...patch,
      }),
      WorktreeError,
      name,
    );
    assert.equal(port.calls.length, 0, name);
  }
});

test("Herdr's create failures become WorktreeError with the git message, other errors pass through", async () => {
  const failing = fakePort(() => {
    throw new HerdrError(
      "worktree.create",
      "worktree_create_failed",
      "fatal: a branch named 'x' already exists",
    );
  });
  await assert.rejects(
    createWorktree(failing, {
      repoPath: "/repo",
      branch: "card/REQ-20261102-a",
    }),
    (error: unknown) =>
      error instanceof WorktreeError &&
      error.code === "create_failed" &&
      /already exists/.test(error.message),
  );
  const broken = fakePort(() => {
    throw new Error("socket closed");
  });
  await assert.rejects(
    createWorktree(broken, {
      repoPath: "/repo",
      branch: "card/REQ-20261102-a",
    }),
    /socket closed/,
  );
});

test("a create response without a workspace or path is refused instead of guessed", async () => {
  for (const reply of [
    { type: "worktree_created" },
    { ...created, workspace: {} },
    { ...created, worktree: {} },
    { ...created, root_pane: {} },
  ]) {
    const port = fakePort(() => reply);
    await assert.rejects(
      createWorktree(port, {
        repoPath: "/repo",
        branch: "card/REQ-20261102-a",
      }),
      /unexpected/,
      JSON.stringify(reply),
    );
  }
});

test("listWorktrees returns path, branch and the open workspace of each checkout", async () => {
  const port = fakePort(() => ({
    type: "worktree_list",
    source: {
      repo_key: "k",
      repo_name: "repo",
      repo_root: "/repo",
      source_checkout_path: "/repo",
    },
    worktrees: [
      {
        path: "/repo",
        branch: "main",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: false,
        label: "main",
        open_workspace_id: "w1",
      },
      {
        path: "/wt/a",
        branch: "card/REQ-20261102-a",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        label: "a",
        open_workspace_id: null,
      },
    ],
  }));
  const list = await listWorktrees(port, "/repo");
  assert.deepEqual(port.calls, [
    { method: "worktree.list", params: { cwd: "/repo" } },
  ]);
  assert.deepEqual(list, [
    { path: "/repo", branch: "main", linked: false, openWorkspaceId: "w1" },
    {
      path: "/wt/a",
      branch: "card/REQ-20261102-a",
      linked: true,
      openWorkspaceId: undefined,
    },
  ]);
});

test("removeWorktree never sends force, and reports a dirty checkout as kept instead of throwing", async () => {
  const ok = fakePort(() => ({
    type: "worktree_removed",
    workspace_id: "w9",
    forced: false,
    worktree: { path: "/wt/a" },
  }));
  assert.deepEqual(await removeWorktree(ok, "w9"), { ok: true });
  assert.deepEqual(ok.calls, [
    { method: "worktree.remove", params: { workspace_id: "w9" } },
  ]);
  assert.equal(Object.hasOwn(ok.calls[0].params, "force"), false);

  const dirty = fakePort(() => {
    throw new HerdrError(
      "worktree.remove",
      "dirty_worktree_requires_force",
      "worktree has uncommitted changes",
    );
  });
  assert.deepEqual(await removeWorktree(dirty, "w9"), {
    ok: false,
    reason: "dirty_worktree",
  });

  const other = fakePort(() => {
    throw new HerdrError(
      "worktree.remove",
      "workspace_not_found",
      "no such workspace",
    );
  });
  await assert.rejects(removeWorktree(other, "w9"), /workspace_not_found/);
});

test("a remove response that says it was forced is treated as an error", async () => {
  const port = fakePort(() => ({
    type: "worktree_removed",
    workspace_id: "w9",
    forced: true,
    worktree: { path: "/wt/a" },
  }));
  await assert.rejects(removeWorktree(port, "w9"), /forced/);
});

test("removeWorktree refuses a workspace id that does not look like one", async () => {
  const port = fakePort(() => ({}));
  for (const bad of ["", "w 9", "--force", "w9\n"])
    await assert.rejects(removeWorktree(port, bad), WorktreeError, bad);
  assert.equal(port.calls.length, 0);
});

test("checkWorktreeSupport accepts the tested version and newer, and refuses older or unknown ones", async () => {
  const supported = async (version: unknown) =>
    checkWorktreeSupport(fakePort(() => ({ type: "pong", version })));
  assert.equal(MIN_HERDR_VERSION, "0.9.1");
  assert.deepEqual(await supported("0.9.1"), { ok: true, version: "0.9.1" });
  assert.deepEqual(await supported("0.9.5"), { ok: true, version: "0.9.5" });
  assert.deepEqual(await supported("0.10.0"), { ok: true, version: "0.10.0" });
  assert.deepEqual(await supported("1.0.0"), { ok: true, version: "1.0.0" });
  assert.deepEqual(await supported("0.9.5-rc1"), {
    ok: true,
    version: "0.9.5-rc1",
  });
  for (const old of ["0.9.0", "0.8.9", "0.7.11"]) {
    const result = await supported(old);
    assert.equal(result.ok, false, old);
    assert.match(result.ok ? "" : result.reason, /0\.9\.1/);
  }
  for (const unknown of [undefined, "", "banana", 5]) {
    const result = await supported(unknown);
    assert.equal(result.ok, false, String(unknown));
  }
});

test("checkWorktreeSupport reports an unreachable Herdr instead of throwing", async () => {
  const port = fakePort(() => {
    throw new Error("connect ENOENT");
  });
  const result = await checkWorktreeSupport(port);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /ENOENT/);
});

const REPO = "/Users/example/git_wk/repo";
const ws = (id: string, over: Record<string, unknown> = {}) => ({
  workspace_id: id,
  pane_count: 1,
  agent_status: "unknown",
  worktree: { is_linked_worktree: false, repo_root: REPO, checkout_path: REPO },
  ...over,
});

test("ISSUE-221: createWorktree 只把「建立前沒有、建立後多出」的 repo 主 workspace 當成 bridge 開的", async () => {
  let listed = 0;
  const port = fakePort((call) => {
    if (call.method === "workspace.list") return { workspaces: listed++ === 0 ? [ws("w3", { worktree: undefined })] : [ws("w3", { worktree: undefined }), ws("w8"), ws("w9", { worktree: { is_linked_worktree: true, repo_root: REPO } })] };
    return created;
  });
  const result = await createWorktree(port, { repoPath: REPO, branch: "card/REQ-20261103-one" });
  assert.equal(result.openedRepoWorkspaceId, "w8");

  // 使用者原本就開著的主 workspace：建立前後都在，不算 bridge 開的。
  const existing = fakePort((call) => (call.method === "workspace.list" ? { workspaces: [ws("w8"), ws("w9", { worktree: { is_linked_worktree: true, repo_root: REPO } })] } : created));
  assert.equal((await createWorktree(existing, { repoPath: REPO, branch: "card/REQ-20261103-one" })).openedRepoWorkspaceId, undefined);

  // 列不出 workspace：不猜，當作沒有。
  const broken = fakePort((call) => {
    if (call.method === "workspace.list") throw new Error("boom");
    return created;
  });
  assert.equal((await createWorktree(broken, { repoPath: REPO, branch: "card/REQ-20261103-one" })).openedRepoWorkspaceId, undefined);

  // 別的 repo 多出來的 workspace 不算。
  let n = 0;
  const other = fakePort((call) => (call.method === "workspace.list" ? { workspaces: n++ === 0 ? [] : [ws("w8", { worktree: { is_linked_worktree: false, repo_root: "/elsewhere" } })] } : created));
  assert.equal((await createWorktree(other, { repoPath: REPO, branch: "card/REQ-20261103-one" })).openedRepoWorkspaceId, undefined);
});

test("ISSUE-221: closeBridgeRepoWorkspace 只關仍是空的單一 pane 主 workspace；有 agent、多 pane、已是 linked 或對不上 repo 就保留", async () => {
  const run = async (workspace: Record<string, unknown> | undefined) => {
    const port = fakePort((call) => (call.method === "workspace.list" ? { workspaces: workspace ? [workspace] : [] } : {}));
    const outcome = await closeBridgeRepoWorkspace(port, "w8", REPO);
    return { outcome, closed: port.calls.filter((c) => c.method === "workspace.close").map((c) => c.params.workspace_id) };
  };
  assert.deepEqual(await run(ws("w8")), { outcome: "closed", closed: ["w8"] });
  assert.deepEqual(await run(undefined), { outcome: "gone", closed: [] });
  assert.deepEqual(await run(ws("w8", { agent_status: "working" })), { outcome: "kept", closed: [] });
  assert.deepEqual(await run(ws("w8", { pane_count: 2 })), { outcome: "kept", closed: [] });
  assert.deepEqual(await run(ws("w8", { worktree: { is_linked_worktree: true, repo_root: REPO } })), { outcome: "kept", closed: [] });
  assert.deepEqual(await run(ws("w8", { worktree: { is_linked_worktree: false, repo_root: "/elsewhere" } })), { outcome: "kept", closed: [] });
  // 關閉被 Herdr 拒絕（例如仍有 linked worktree）：保留，不丟錯。
  const refusing = fakePort((call) => {
    if (call.method === "workspace.list") return { workspaces: [ws("w8")] };
    throw new Error("workspace_group_close_required");
  });
  assert.equal(await closeBridgeRepoWorkspace(refusing, "w8", REPO), "kept");
});
