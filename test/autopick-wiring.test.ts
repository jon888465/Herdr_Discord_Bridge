import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { CardStore } from "../src/card-store.js";
import { closeAutopickLead } from "../src/card-cleanup.js";
import { runAutopick } from "../src/autopick.js";
import {
  createAutopickSteps,
  type AutopickWiringDeps,
} from "../src/autopick-wiring.js";
import type { AutopickJob } from "../src/autopick.js";
import type { Card } from "../src/card.js";
import type { AgentRecord } from "../src/types.js";

const job = (over: Partial<AutopickJob> = {}): AutopickJob => ({
  card: { id: "REQ-20261105-x" } as Card,
  project: "local:Herdr_Discord_Bridge",
  repoPath: os.tmpdir(),
  level: "L1",
  lead: "claude",
  ...over,
});

function harness(over: Partial<AutopickWiringDeps> = {}, leadStatus = "idle") {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  const commands: string[] = [];
  let clock = 0;
  const deps: AutopickWiringDeps = {
    port: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "workspace.create")
          return {
            workspace: { workspace_id: "w9" },
            root_pane: { pane_id: "w9:p1" },
          };
        return {};
      },
      listAgentsWithWorkspaceNames: async () =>
        [
          {
            pane_id: "w9:p1",
            terminal_id: "t",
            workspace_id: "w9",
            tab_id: "w9:t1",
            agent: "claude",
            agent_status: leadStatus,
          },
        ] as AgentRecord[],
    },
    command: async (text) => {
      commands.push(text);
      return "ok";
    },
    recordLeadWorkspace: () => {},
    taskIdForCard: () => "task-1",
    taskState: () => ({ state: "completed" }),
    cardStatus: () => "done",
    allowedWorkspaceIds: [],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    pollMs: 1000,
    ...over,
  };
  return { steps: createAutopickSteps(deps), requests, commands, deps };
}

test("the Lead gets its own workspace in the repo, is started there, and the autopick route points at it", async () => {
  const { steps, requests, commands } = harness();
  const lead = await steps.startLead(job());
  const create = requests.find((r) => r.method === "workspace.create");
  assert.equal(create?.params?.cwd, os.tmpdir());
  assert.equal(create?.params?.focus, false);
  const start = requests.find((r) => r.method === "agent.start");
  assert.equal(start?.params?.pane_id, "w9:p1");
  assert.equal(start?.params?.kind, "claude");
  assert.deepEqual(commands, ["wk use w9", "agent use w9:p1"]);
  assert.equal(
    requests.some((r) => r.method === "workspace.close"),
    false,
  );
  await lead.close();
  assert.deepEqual(requests.at(-1), {
    method: "workspace.close",
    params: { workspace_id: "w9" },
  });
});

test("a restricted workspace allowlist or a missing repo path is refused before anything is created", async () => {
  const restricted = harness({ allowedWorkspaceIds: ["w1"] });
  await assert.rejects(restricted.steps.startLead(job()), /白名單/);
  assert.equal(restricted.requests.length, 0);

  const missing = harness();
  await assert.rejects(
    missing.steps.startLead(job({ repoPath: "/no/such/repo" })),
    /不存在/,
  );
  assert.equal(missing.requests.length, 0);

  const file = harness();
  await assert.rejects(
    file.steps.startLead(job({ repoPath: import.meta.filename })),
    /不是資料夾/,
  );
  assert.equal(file.requests.length, 0);
});

test("a Lead that is not ready (for example blocked on a prompt) leaves no empty workspace behind", async () => {
  const { steps, requests, commands } = harness({}, "blocked");
  await assert.rejects(steps.startLead(job()), /沒有就緒/);
  assert.deepEqual(requests.at(-1), {
    method: "workspace.close",
    params: { workspace_id: "w9" },
  });
  assert.deepEqual(commands, []);
});

test("waitTask waits for a terminal state, but does not wait for a blocked task", async () => {
  const states = ["planning", "running", "completed"];
  const polled = harness({
    taskState: () => ({ state: states.shift() ?? "completed" }),
  });
  assert.deepEqual(await polled.steps.waitTask("c"), {
    completed: true,
    detail: "completed",
  });

  const blocked = harness({ taskState: () => ({ state: "blocked" }) });
  const result = await blocked.steps.waitTask("c");
  assert.equal(result.completed, false);
  assert.match(result.detail, /blocked/);

  const failed = harness({
    taskState: () => ({
      state: "failed",
      detail: "no successful verification",
    }),
  });
  const failure = await failed.steps.waitTask("c");
  assert.equal(failure.completed, false);
  assert.match(failure.detail, /no successful verification/);
});

test("waitTask gives up with the last state on timeout, and reports a missing task", async () => {
  const slow = harness({
    taskState: () => ({ state: "running" }),
    taskTimeoutMs: 5000,
  });
  const result = await slow.steps.waitTask("c");
  assert.equal(result.completed, false);
  assert.match(result.detail, /逾時.*running/);

  const none = harness({ taskIdForCard: () => undefined });
  assert.match((await none.steps.waitTask("c")).detail, /找不到/);
});

test("waitCardDone waits through the 60-second card sync, and gives up on timeout", async () => {
  const statuses = ["in_progress", "in_progress", "done"];
  const ok = harness({ cardStatus: () => statuses.shift() ?? "done" });
  assert.equal(await ok.steps.waitCardDone("c"), true);

  const never = harness({
    cardStatus: () => "in_progress",
    cardDoneTimeoutMs: 4000,
  });
  assert.equal(await never.steps.waitCardDone("c"), false);
});

test("loop only counts as merged when the reply says the PR was merged", async () => {
  const merged = harness({
    command: async () =>
      "loop 結束：REQ-20261105-x 的 review 已通過、CI 全綠，已 merge（共 3 個步驟）。",
  });
  assert.equal(
    (await merged.steps.loop("REQ-20261105-x", "codex")).merged,
    true,
  );

  const stopped = harness({
    command: async () =>
      "loop 停下來了：REQ-20261105-x（共 1 個步驟，停在 ci）。",
  });
  assert.equal(
    (await stopped.steps.loop("REQ-20261105-x", "codex")).merged,
    false,
  );

  const sent = harness();
  await sent.steps.loop("REQ-20261105-x", "codex");
  assert.deepEqual(sent.commands, [
    "card loop REQ-20261105-x --agent codex --merge",
  ]);
});

// ISSUE-101：`card loop` 一路印出進度（review 完成、已 merge…），最後才是「loop 結束」；
// 自動撿卡收到的是全部輸出，不能假設「loop 結束」在開頭（實機：PR 已被 bridge 合併，卻被誤報成停下來等人）。
test("ISSUE-101: a merge is recognised even when progress lines come before the final loop line", async () => {
  const progress = [
    "review 完成：REQ-20261105-x · PR #128（head c0bcc5c16557）· 第 1 輪",
    "https://github.com/jon888465/Herdr_Discord_Bridge/pull/128",
    "判定：pass",
    "已 merge：REQ-20261105-x · PR #128（squash，head c0bcc5c16557）",
  ].join("\n");
  const merged = harness({
    command: async () =>
      `${progress}\nloop 結束：REQ-20261105-x 的 review 已通過、CI 全綠，已 merge（共 3 個步驟）。`,
  });
  assert.equal(
    (await merged.steps.loop("REQ-20261105-x", "codex")).merged,
    true,
  );

  // 進度裡出現「已 merge」，但 loop 沒有以「結束…已 merge」收尾（例如 merge 後的清理步驟出錯）→ 不算。
  const noFinalLine = harness({
    command: async () =>
      `${progress}\nloop 停下來了：REQ-20261105-x（停在 merge）。`,
  });
  assert.equal(
    (await noFinalLine.steps.loop("REQ-20261105-x", "codex")).merged,
    false,
  );

  // 沒有 --merge 的 loop 結束（只是 review 通過）不是 merge。
  const reviewOnly = harness({
    command: async () =>
      `${progress}\nloop 結束：REQ-20261105-x 的 review 已通過（共 1 個步驟）。`,
  });
  assert.equal(
    (await reviewOnly.steps.loop("REQ-20261105-x", "codex")).merged,
    false,
  );
});

for (const kind of ["claude", "codex", "agy", "pi"] as const) {
  test(`autopick ${kind} label preserves kind, prefix and card head within 60 characters`, async () => {
    for (const id of ["REQ-short", "REQ-" + "x".repeat(100) + "-TAIL"]) {
      const { steps, requests } = harness();
      const lead = await steps.startLead(
        job({ lead: kind, card: { id } as Card }),
      );
      const label = requests.find((r) => r.method === "workspace.create")
        ?.params?.label;
      assert.equal(typeof label, "string");
      assert.ok((label as string).startsWith(`autopick-${kind}-REQ-`));
      assert.ok((label as string).length <= 60);
      if (id.length > 60) {
        assert.equal((label as string).length, 60);
        assert.ok(!(label as string).includes("TAIL"));
      } else assert.equal(label, `autopick-${kind}-REQ-short`);
      await lead.close();
      assert.deepEqual(requests.at(-1), {
        method: "workspace.close",
        params: { workspace_id: "w9" },
      });
    }
  });
}

test("records Lead identity before starting work and fails closed on persistence failure", async () => {
  const recorded: string[][] = [];
  const h = harness({
    recordLeadWorkspace: (...args) => {
      recorded.push(args);
    },
  });
  await h.steps.startLead(job());
  assert.deepEqual(recorded, [
    ["REQ-20261105-x", "w9", "autopick-claude-REQ-20261105-x"],
  ]);
  const failed = harness({
    recordLeadWorkspace: () => {
      throw new Error("disk");
    },
  });
  await assert.rejects(failed.steps.startLead(job()), /disk/);
  assert.equal(
    failed.requests.some((r) => r.method === "agent.start"),
    false,
  );
  assert.equal(failed.requests.at(-1)?.method, "workspace.close");
});

test("merge cleanup closes Lead before reached without turning a successful merge into failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopick-race-"));
  try {
    const cards = new CardStore(root);
    const card: Card = {
      id: "REQ-20261105-race",
      type: "requirement",
      status: "done",
      title: "race",
      version: 1,
      created: "2026-11-05",
      updated: "2026-11-05",
      body: "# race\n",
    };
    assert.ok(cards.create(card).ok);
    const h = harness();
    let exists = true;
    let closes = 0;
    const port = {
      ...h.deps.port,
      listWorkspaces: async () =>
        exists
          ? [{ workspace_id: "w9", label: `autopick-claude-${card.id}` }]
          : [],
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "workspace.close") {
          closes++;
          if (!exists) throw new Error("workspace not found");
          exists = false;
          return {};
        }
        if (method === "workspace.list")
          return { workspaces: await port.listWorkspaces() };
        return h.deps.port.request(method, params);
      },
    };
    const steps = createAutopickSteps({
      ...h.deps,
      port,
      recordLeadWorkspace: (id, workspace, label) => {
        assert.ok(cards.recordAutopickWorkspace(id, workspace, label).ok);
      },
    });
    steps.loop = async () => {
      await closeAutopickLead(cards, card.id, port, true);
      assert.equal(exists, false);
      return { merged: true, text: "merged" };
    };
    const report = await runAutopick(job({ card, level: "L2" }), steps);
    assert.equal(closes, 2);
    assert.equal(report.outcome, "reached");
    assert.equal(report.lastStep, "loop");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const snapshot of [
  { workspaces: [{ workspace_id: "w9" }] },
  {},
  { workspaces: [null] },
]) {
  test(
    "reached close still fails unless workspace absence is confirmed: " +
      JSON.stringify(snapshot),
    async () => {
      const h = harness();
      const steps = createAutopickSteps({
        ...h.deps,
        port: {
          ...h.deps.port,
          request: async (method, params) => {
            if (method === "workspace.close") throw new Error("close denied");
            if (method === "workspace.list") return snapshot;
            return h.deps.port.request(method, params);
          },
        },
      });
      const report = await runAutopick(job({ level: "L0" }), steps);
      assert.equal(report.outcome, "failed");
      assert.match(report.reason ?? "", /close denied/);
    },
  );
}

for (const kind of ["claude", "codex", "agy", "pi"] as const) {
  for (const settled of ["idle", "done"] as const) {
    test(`${kind} waits for working -> ${settled} before routing`, async () => {
      const h = harness({ readyPollMs: 1 });
      let reads = 0;
      h.deps.port.listAgentsWithWorkspaceNames = async () => [
        {
          pane_id: "w9:p1",
          terminal_id: "t",
          workspace_id: "w9",
          agent: kind,
          agent_status: reads++ === 0 ? "working" : settled,
        } as AgentRecord,
      ];
      await h.steps.startLead(job({ lead: kind }));
      assert.ok(reads >= 2);
      assert.equal(
        h.requests.find((r) => r.method === "agent.start")?.params?.kind,
        kind,
      );
      assert.deepEqual(h.commands, ["wk use w9", "agent use w9:p1"]);
    });
  }
}
test("startup timeout closes only the new Lead and does not route", async () => {
  const h = harness({ readyTimeoutMs: 0 }, "working");
  await assert.rejects(h.steps.startLead(job()), /Lead.*沒有就緒/);
  assert.deepEqual(h.commands, []);
  assert.equal(h.requests.at(-1)?.method, "workspace.close");
});

for (const kind of ["claude", "codex", "agy", "pi"] as const) {
  test(`${kind} startup blocked preserves approval safety and closes the source workspace`, async () => {
    const h = harness({}, "blocked");
    h.deps.port.listAgentsWithWorkspaceNames = async () => [
      {
        pane_id: "w9:p1",
        terminal_id: "t",
        workspace_id: "w9",
        agent: kind,
        agent_status: "blocked",
      } as AgentRecord,
    ];
    await assert.rejects(
      h.steps.startLead(job({ lead: kind })),
      /Lead.*blocked/,
    );
    assert.equal(
      h.requests.some((r) => r.method === "pane.send_keys"),
      false,
    );
    assert.equal(h.requests.at(-1)?.method, "workspace.close");
    assert.deepEqual(h.commands, []);
  });
}
test("Lead uses only the known Codex update skip and waits after it", async () => {
  const h = harness({ readyPollMs: 1 });
  let skipped = false;
  const request = h.deps.port.request;
  h.deps.port.request = async (method, params, options) => {
    if (method === "agent.read")
      return {
        text: skipped ? "ready" : "Update available · 0.163.0 → 0.167.1\n1. Update now\n2. Skip\n3. Skip until next version",
      };
    if (method === "pane.send_keys") {
      assert.deepEqual(params, { pane_id: "w9:p1", keys: ["2"] });
      assert.equal(options?.retries, 0);
      assert.equal(skipped, false);
      skipped = true;
      return {};
    }
    return request(method, params, options);
  };
  h.deps.port.listAgentsWithWorkspaceNames = async () => [
    {
      pane_id: "w9:p1",
      terminal_id: "t",
      workspace_id: "w9",
      agent: "codex",
      agent_status: skipped ? "idle" : "blocked",
    } as AgentRecord,
  ];
  await h.steps.startLead(job({ lead: "codex" }));
  assert.equal(skipped, true);
  assert.deepEqual(h.commands, ["wk use w9", "agent use w9:p1"]);
});
