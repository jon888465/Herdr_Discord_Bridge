import test from "node:test";
import assert from "node:assert/strict";
import { HerdrError } from "../src/herdr.js";
import {
  REVIEWER_KINDS,
  chooseReviewerKind,
  closeReviewerPane,
  openReviewerPane,
} from "../src/review-pane.js";
import type { AgentStartPort } from "../src/agent-start.js";

test("by default the reviewer kind is the first preferred kind that differs from the author's", () => {
  assert.deepEqual(chooseReviewerKind({ authorKind: "agy" }), {
    ok: true,
    kind: REVIEWER_KINDS[0],
    sameKind: false,
  });
  const other = chooseReviewerKind({ authorKind: REVIEWER_KINDS[0] });
  assert.ok(other.ok && other.kind === REVIEWER_KINDS[1] && !other.sameKind);
});

test("with an unknown author kind the first preferred kind is used", () => {
  assert.deepEqual(chooseReviewerKind({}), {
    ok: true,
    kind: REVIEWER_KINDS[0],
    sameKind: false,
  });
});

test("an explicitly requested kind is used as given, and says when it is the author's own kind", () => {
  assert.deepEqual(chooseReviewerKind({ authorKind: "claude", requested: "codex" }), {
    ok: true,
    kind: "codex",
    sameKind: false,
  });
  assert.deepEqual(chooseReviewerKind({ authorKind: "claude", requested: "claude" }), {
    ok: true,
    kind: "claude",
    sameKind: true,
  });
});

test("a requested kind that is not a plain lowercase name is refused", () => {
  for (const requested of ["", "Claude", "a b", "../x", "x".repeat(33), "-a"]) {
    const result = chooseReviewerKind({ authorKind: "claude", requested });
    assert.equal(result.ok, false, requested);
  }
});

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

function fakePort(
  handlers: Record<string, (params?: Record<string, unknown>) => unknown>,
) {
  const calls: Call[] = [];
  const port: AgentStartPort = {
    request: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params);
    },
    listAgentsWithWorkspaceNames: async () => [],
  };
  return { port, calls };
}

const wide = { layout: { panes: [{ pane_id: "w5:p1", rect: { width: 200, height: 40 } }] } };
const narrow = { layout: { panes: [{ pane_id: "w5:p1", rect: { width: 100, height: 40 } }] } };
const tiny = { layout: { panes: [{ pane_id: "w5:p1", rect: { width: 60, height: 10 } }] } };
const split = (extra: Record<string, unknown> = {}) => ({
  pane: { pane_id: "w5:p9", workspace_id: "w5", terminal_id: "term_new", ...extra },
});

test("a reviewer pane is split from the base pane in its workspace, in the given directory, without taking focus", async () => {
  const { port, calls } = fakePort({
    "pane.layout": () => wide,
    "pane.split": () => split(),
  });
  const opened = await openReviewerPane(port, {
    basePaneId: "w5:p1",
    workspaceId: "w5",
    cwd: "/Users/example/.herdr/worktrees/repo/card-req-x",
  });
  assert.deepEqual(opened, { paneId: "w5:p9", terminalId: "term_new" });
  const splitCall = calls.find((call) => call.method === "pane.split");
  assert.deepEqual(splitCall?.params, {
    target_pane_id: "w5:p1",
    workspace_id: "w5",
    direction: "right",
    cwd: "/Users/example/.herdr/worktrees/repo/card-req-x",
    focus: false,
  });
});

test("a narrow pane splits downwards and a small layout opens a tab", async () => {
  const down = fakePort({ "pane.layout": () => narrow, "pane.split": () => split() });
  await openReviewerPane(down.port, { basePaneId: "w5:p1", workspaceId: "w5", cwd: "/x" });
  assert.equal(down.calls.find((c) => c.method === "pane.split")?.params?.direction, "down");

  const small = fakePort({ "pane.layout": () => tiny, "tab.create": () => ({ root_pane: split().pane }) });
  await openReviewerPane(small.port, { basePaneId: "w5:p1", workspaceId: "w5", cwd: "/x" });
  assert.equal(small.calls.some((c) => c.method === "pane.split"), false);
});

test("a split whose result has no terminal id or is in another workspace is refused, because the pane could not be closed safely later", async () => {
  for (const extra of [{ terminal_id: undefined }, { workspace_id: "w6" }, { pane_id: "" }]) {
    const { port } = fakePort({ "pane.layout": () => wide, "pane.split": () => split(extra) });
    await assert.rejects(
      openReviewerPane(port, { basePaneId: "w5:p1", workspaceId: "w5", cwd: "/x" }),
      /unexpected|identity/,
    );
  }
});

test("closing re-reads the pane, checks it is still the terminal we opened, then closes exactly that pane", async () => {
  const { port, calls } = fakePort({
    "pane.get": () => ({ pane: { pane_id: "w5:p9", terminal_id: "term_new" } }),
    "pane.close": () => ({}),
  });
  const result = await closeReviewerPane(port, { paneId: "w5:p9", terminalId: "term_new" });
  assert.deepEqual(result, { closed: true });
  assert.deepEqual(
    calls.map((c) => [c.method, c.params]),
    [
      ["pane.get", { pane_id: "w5:p9" }],
      ["pane.close", { pane_id: "w5:p9" }],
    ],
  );
});

test("a pane that now holds a different terminal is not closed", async () => {
  const { port, calls } = fakePort({
    "pane.get": () => ({ pane: { pane_id: "w5:p9", terminal_id: "term_other" } }),
    "pane.close": () => ({}),
  });
  const result = await closeReviewerPane(port, { paneId: "w5:p9", terminalId: "term_new" });
  assert.equal(result.closed, false);
  assert.match(result.note ?? "", /terminal/);
  assert.equal(calls.some((c) => c.method === "pane.close"), false);
});

test("a pane that is already gone counts as closed", async () => {
  const { port } = fakePort({
    "pane.get": () => {
      throw new HerdrError("pane.get", "pane_not_found", "no such pane");
    },
  });
  const result = await closeReviewerPane(port, { paneId: "w5:p9", terminalId: "term_new" });
  assert.equal(result.closed, true);
});

test("closing never throws: other errors are reported so the caller can tell the user", async () => {
  const getFails = fakePort({
    "pane.get": () => {
      throw new Error("socket closed");
    },
  });
  const a = await closeReviewerPane(getFails.port, { paneId: "w5:p9", terminalId: "term_new" });
  assert.equal(a.closed, false);
  assert.match(a.note ?? "", /socket closed/);

  const closeFails = fakePort({
    "pane.get": () => ({ pane: { terminal_id: "term_new" } }),
    "pane.close": () => {
      throw new HerdrError("pane.close", "pane_busy", "refused");
    },
  });
  const b = await closeReviewerPane(closeFails.port, { paneId: "w5:p9", terminalId: "term_new" });
  assert.equal(b.closed, false);
  assert.match(b.note ?? "", /pane_busy/);
});

test("closing refuses an empty pane id or terminal id instead of closing something unintended", async () => {
  const { port, calls } = fakePort({ "pane.close": () => ({}), "pane.get": () => ({}) });
  assert.equal((await closeReviewerPane(port, { paneId: "", terminalId: "t" })).closed, false);
  assert.equal((await closeReviewerPane(port, { paneId: "w5:p9", terminalId: "" })).closed, false);
  assert.equal(calls.length, 0);
});

test("reviewer label is display-only: renamed pane closes only with the original terminal id", async () => {
  const { port, calls } = fakePort({
    "pane.layout": () => wide,
    "pane.split": () => split(),
    "pane.rename": () => ({}),
    "pane.get": () => ({
      pane: { terminal_id: "term_new", label: "human renamed" },
    }),
    "pane.close": () => ({}),
  });
  const input = {
    basePaneId: "w5:p1",
    workspaceId: "w5",
    cwd: "/repo",
    kind: "codex",
  };
  const pane = await openReviewerPane(port, input);
  assert.deepEqual(calls.find((c) => c.method === "pane.rename")?.params, {
    pane_id: "w5:p9",
    label: "codex·reviewer",
  });
  // 分割出的 pane 不命名任何 tab。
  assert.equal(
    calls.some((c) => c.method === "tab.rename"),
    false,
  );
  assert.deepEqual(await closeReviewerPane(port, pane), { closed: true });
  assert.deepEqual(calls.at(-1), {
    method: "pane.close",
    params: { pane_id: "w5:p9" },
  });
});

test("a label failure leaves launch identity available for safe cleanup", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { port, calls } = fakePort({
    "pane.layout": () => wide,
    "pane.split": () => split(),
    "pane.rename": () => {
      throw new Error("method unavailable");
    },
    "pane.get": () => ({
      pane: { terminal_id: "replacement", label: "codex·reviewer" },
    }),
  });
  const pane = await openReviewerPane(port, {
    basePaneId: "w5:p1",
    workspaceId: "w5",
    cwd: "/repo",
    kind: "codex",
  });
  assert.deepEqual(pane, { paneId: "w5:p9", terminalId: "term_new" });
  assert.equal((await closeReviewerPane(port, pane)).closed, false);
  assert.equal(
    calls.some((c) => c.method === "pane.close"),
    false,
  );
});

test("a new tab shares the pane label, only the returned tab id is renamed, and cleanup stays id based", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const failRename of [false, true]) {
    const { port, calls } = fakePort({
      "pane.layout": () => tiny,
      "tab.create": () => ({
        tab: { tab_id: "w5:t9" },
        root_pane: split().pane,
      }),
      "tab.rename": () => {
        if (failRename) throw new Error("unsupported");
        return {};
      },
      "pane.rename": () => ({}),
      "pane.get": () => ({
        pane: { terminal_id: "term_new", label: "human changed" },
      }),
      "pane.close": () => ({}),
    });
    const opened = await openReviewerPane(port, {
      basePaneId: "w5:p1",
      workspaceId: "w5",
      cwd: "/x",
      kind: "codex",
      role: "agent",
      model: "chosen",
    });
    assert.deepEqual(opened, { paneId: "w5:p9", terminalId: "term_new" });
    // 新 tab 與 pane 用同一個名稱；只命名這次建立回傳的 tab id。
    assert.deepEqual(
      calls.filter((c) => c.method === "tab.rename").map((c) => c.params),
      [{ tab_id: "w5:t9", label: "codex·agent·chosen" }],
    );
    assert.equal(
      calls.find((c) => c.method === "pane.rename")?.params?.label,
      "codex·agent·chosen",
    );
    assert.deepEqual(
      calls
        .filter((c) => c.params && "tab_id" in c.params)
        .map((c) => c.params?.tab_id),
      ["w5:t9"],
    );
    // 關閉只靠 pane id 與 terminal id，不依名稱，也不關 tab。
    assert.deepEqual(await closeReviewerPane(port, opened), { closed: true });
    assert.deepEqual(calls.at(-1), {
      method: "pane.close",
      params: { pane_id: "w5:p9" },
    });
  }
});
