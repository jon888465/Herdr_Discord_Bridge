import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRecord } from "../src/types.js";
import type { AgentStartPort } from "../src/agent-start.js";
import { runCardReview, type ReviewFlowDeps } from "../src/card-review-flow.js";
import { runCardFix, type FixFlowDeps } from "../src/card-fix-flow.js";
import {
  preflightRoles,
  resolveFlowRole,
} from "../src/card-role-assignment.js";
import { startCardRoleSession } from "../src/card-role-session.js";
import { validateProfiles, type AgentProfile } from "../src/agent-pool.js";
import type { Card } from "../src/card.js";
import type { RoleIdentity } from "../src/card-events.js";
const profiles = validateProfiles([
  {
    id: "agy",
    kind: "agy",
    model: "gemini",
    modelFlag: "--custom-model",
    args: ["--quiet"],
    capabilities: ["implementation"],
  },
]);
const card: Card = {
  id: "REQ-20261110-flow",
  type: "requirement",
  status: "done",
  title: "role flow",
  version: 1,
  created: "2026-11-10",
  updated: "2026-11-10",
  roles: {
    reviewer: { agent: "agy", model: "gemini", machine: "local" },
    fixer: { agent: "agy", model: "gemini" },
  },
  body: "## 描述\n檢查\n\n## 驗收條件\n- 通過\n",
};
const author = {
  agent: "agy",
  paneId: "w1:p1",
  workspaceId: "w1",
  session: { kind: "id", value: "author" },
};
const fresh = (): AgentRecord => ({
  pane_id: "w1:p2",
  terminal_id: "new-term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "agy",
  agent_status: "idle",
  agent_session: { kind: "id", value: "new-session" },
});
const launch = profiles[0]!;
function fixture(patch: Partial<AgentRecord> = {}) {
  const calls: string[] = [];
  const args: string[][] = [];
  const identities: RoleIdentity[] = [];
  const port: AgentStartPort = {
    request: async (method) => {
      calls.push(method);
      if (method === "pane.layout")
        return {
          layout: {
            panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 40 } }],
          },
        };
      if (method === "pane.split")
        return {
          pane: {
            pane_id: "w1:p2",
            terminal_id: "new-term",
            workspace_id: "w1",
          },
        };
      if (method === "pane.get") return { pane: { terminal_id: "new-term" } };
      return {};
    },
    listAgentsWithWorkspaceNames: async () => [{ ...fresh(), ...patch }],
  };
  const common = {
    panePort: port,
    startAgent: async (input: { args?: string[] }) => {
      args.push(input.args ?? []);
      return fresh();
    },
    recordRoleStrict: (identity: RoleIdentity) => {
      identities.push(identity);
    },
    readyPollMs: 1,
    readyTimeoutMs: 10,
  };
  const review: ReviewFlowDeps = {
    ...common,
    fingerprint: async () => "same",
    runTurn: async () => {
      calls.push("prompt");
      return {
        state: "done",
        text: JSON.stringify({
          verdict: "pass",
          criteria: [{ index: 1, status: "met" }],
          findings: [],
        }),
      };
    },
  };
  let states = 0;
  const fix: FixFlowDeps = {
    ...common,
    state: async () => ({
      head: (++states === 1 ? "a" : "b").repeat(40),
      dirty: false,
    }),
    changedFiles: async () => ["src/file.ts"],
    runTurn: async () => {
      calls.push("prompt");
      return {
        state: "done",
        text: JSON.stringify({ fixed: ["F1"], skipped: [] }),
      };
    },
  };
  return { review, fix, calls, args, identities };
}
const reviewInput = {
  card,
  author,
  launch,
  requestedKind: "agy",
  worktreePath: "/repo",
  round: 1,
  scope: "whole",
  pr: { number: 1, headSha: "a".repeat(40) },
  material: { files: ["src/file.ts"], diff: "+ok" },
};
const fixInput = {
  card,
  author,
  launch,
  worktreePath: "/repo",
  round: 1,
  findings: [
    {
      id: "F1",
      round: 1,
      severity: "high" as const,
      path: "src/file.ts",
      summary: "bug",
      suggestion: "fix",
    },
  ],
};
test("reviewer and fixer use configured custom model flag/args each round and fresh pane", async () => {
  const f = fixture();
  for (let round = 1; round <= 2; round++) {
    const reviewed = await runCardReview(f.review, { ...reviewInput, round });
    assert.ok(reviewed.ok);
    const fixed = await runCardFix(f.fix, { ...fixInput, round });
    assert.ok(fixed.ok);
  }
  assert.equal(f.args.length, 4);
  for (const args of f.args)
    assert.deepEqual(args, ["--quiet", "--custom-model", "gemini"]);
  assert.equal(f.calls.filter((c) => c === "pane.split").length, 4);
  assert.equal(f.calls.filter((c) => c === "pane.close").length, 4);
  assert.equal(f.identities.length, 4);
  for (const identity of f.identities) {
    assert.equal(identity.model, "gemini");
    assert.equal(identity.source, "card");
    assert.equal(identity.modelEvidence, "launch");
  }
});
for (const role of ["reviewer", "fixer"] as const) {
  test(`${role} strict recording failure closes owned pane and never sends prompt`, async () => {
    const f = fixture();
    const deps = role === "reviewer" ? f.review : f.fix;
    deps.recordRoleStrict = () => {
      throw new Error("disk full");
    };
    await assert.rejects(
      role === "reviewer"
        ? runCardReview(f.review, reviewInput)
        : runCardFix(f.fix, fixInput),
      /disk full/,
    );
    assert.ok(f.calls.includes("pane.close"));
    assert.ok(!f.calls.includes("prompt"));
  });
  test(`${role} readiness replacement and same author session are blocked`, async () => {
    for (const patch of [
      { agent: "codex" },
      { model: "wrong" },
      { machine: "pod" },
      { agent_session: author.session },
    ]) {
      const f = fixture(patch);
      await assert.rejects(
        role === "reviewer"
          ? runCardReview(f.review, reviewInput)
          : runCardFix(f.fix, fixInput),
      );
      assert.ok(!f.calls.includes("prompt"));
      assert.ok(f.calls.includes("pane.close"));
    }
  });
}
test("resume args rejected before creating pane; CLI disagreement rejected by resolver", async () => {
  const f = fixture();
  await assert.rejects(
    runCardReview(f.review, {
      ...reviewInput,
      launch: { ...launch, args: ["--resume", "author"] },
    }),
    /resume/,
  );
  assert.equal(f.calls.length, 0);
  const snapshot = preflightRoles(card.roles!, { machineIds: [], profiles });
  assert.throws(
    () => resolveFlowRole(snapshot, "fixer", "agy", "codex"),
    /衝突/,
  );
});
test("task-scoped sessions do not share bindings across roles/models even with the same profile id", async () => {
  let serial = 0;
  const launched: AgentProfile[] = [];
  let current = fresh();
  const closed: string[] = [];
  const port = {
    request: async (method: string) => {
      if (method === "pane.get")
        return { pane: { terminal_id: current.terminal_id } };
      if (method === "pane.close") closed.push(current.pane_id);
      return {};
    },
    listAgentsWithWorkspaceNames: async () => [current],
    startProfile: async (
      _lead: AgentRecord,
      profile: AgentProfile,
      _name: string,
      created: (id: string, terminalId?: string) => void,
    ) => {
      launched.push(structuredClone(profile));
      serial++;
      current = {
        ...fresh(),
        pane_id: `w1:p${serial + 1}`,
        terminal_id: `term-${serial}`,
        agent_session: { kind: "id", value: `session-${serial}` },
      };
      created(current.pane_id, current.terminal_id);
      return current;
    },
  };
  const lead = { ...fresh(), pane_id: "w1:p1" };
  const first = await startCardRoleSession(port, lead, launch, "one");
  await first.cleanup();
  const second = await startCardRoleSession(
    port,
    lead,
    { ...launch, model: "another-allowed-model" },
    "two",
  );
  await second.cleanup();
  assert.notDeepEqual(first.agent.agent_session, second.agent.agent_session);
  assert.deepEqual(
    launched.map((p) => p.model),
    ["gemini", "another-allowed-model"],
  );
  assert.equal(closed.length, 2);
});

test("fresh launch failure cleans only creation-time terminal; replacement is preserved", async () => {
  for (const replaced of [false, true]) {
    let closes = 0;
    const port = {
      request: async (method: string) => {
        if (method === "pane.get")
          return { pane: { terminal_id: replaced ? "replacement" : "owned" } };
        if (method === "pane.close") closes++;
        return {};
      },
      listAgentsWithWorkspaceNames: async () => [],
      startProfile: async (
        _lead: AgentRecord,
        _profile: AgentProfile,
        _name: string,
        onPane: (id: string, terminalId?: string) => void,
      ): Promise<AgentRecord> => {
        onPane("w1:p2", "owned");
        throw new Error("CLI rejected model");
      },
    };
    await assert.rejects(
      startCardRoleSession(
        port,
        { ...fresh(), pane_id: "w1:p1" },
        launch,
        "failure",
      ),
      /CLI rejected model/,
    );
    assert.equal(closes, replaced ? 0 : 1);
  }
});
test("readiness-after-launch model mismatch closes the owned fresh pane", async () => {
  let closes = 0;
  const port = {
    request: async (method: string) => {
      if (method === "pane.get") return { pane: { terminal_id: "new-term" } };
      if (method === "pane.close") closes++;
      return {};
    },
    listAgentsWithWorkspaceNames: async () => [
      { ...fresh(), model: "unexpected" },
    ],
    startProfile: async (
      _lead: AgentRecord,
      _profile: AgentProfile,
      _name: string,
      onPane: (id: string, terminalId?: string) => void,
    ) => {
      onPane("w1:p2", "new-term");
      return fresh();
    },
  };
  await assert.rejects(
    startCardRoleSession(
      port,
      { ...fresh(), pane_id: "w1:p1" },
      launch,
      "model",
    ),
    /實際 model/,
  );
  assert.equal(closes, 1);
});
