import {
  createAutopicker,
  pickNext,
  type AutopickSteps,
} from "../src/autopick.js";
import { parsePolicy } from "../src/policy.js";
import { createAutopickSteps } from "../src/autopick-wiring.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCard, type Card } from "../src/card.js";
import { serializeCard } from "../src/card-serialize.js";
import {
  CARD_ROLES,
  parseCardRoles,
  preflightRoles,
  resolveFlowRole,
  roleTargets,
  assertRoleMatches,
  assertFreshProfile,
  roleMetadata,
} from "../src/card-role-assignment.js";
import { AgentPool, validateProfiles } from "../src/agent-pool.js";
import {
  buildLogEntry,
  roleEvent,
  roleSummary,
  type RoleIdentity,
} from "../src/card-events.js";
import {
  appendLogEntries,
  logEntriesOf,
  rotateLog,
} from "../src/card-ledger.js";
import {
  malformedCardIdentity,
  recordMalformedRejection,
  readCardRejection,
} from "../src/card-role-rejections.js";
import { notificationReason } from "../src/card-notify.js";
import {
  runTeamTask,
  validateAssignmentPlan,
  type AssignmentPlan,
  type OrchestrationPort,
} from "../src/team-orchestration.js";
import {
  startCardRoleSession,
  assertReadyIdentity,
} from "../src/card-role-session.js";
import { TeamTaskStore } from "../src/team-task-store.js";
import type { AgentRecord } from "../src/types.js";
import { initialCodingState } from "../src/coding-workflow.js";

const profiles = validateProfiles([
  { id: "claude", kind: "claude", model: "sonnet" },
  { id: "opus", kind: "claude", model: "opus" },
  { id: "codex", kind: "codex", model: "gpt-6.1-sol" },
  {
    id: "agy",
    kind: "agy",
    model: "gemini",
    modelFlag: "--model",
    args: ["--quiet"],
    capabilities: ["implementation"],
  },
  { id: "pi", kind: "pi", capabilities: ["implementation"] },
]);
const context = { machineIds: ["pod"], profiles };
const card: Card = {
  id: "REQ-20261110-roles",
  type: "requirement",
  status: "ready",
  title: "roles",
  version: 1,
  created: "2026-11-10",
  updated: "2026-11-10",
  body: "## 描述\n無害測試\n\n## 驗收條件\n- 完成\n",
};
const actor = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  pane_id: "w1:p2",
  terminal_id: "term",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "claude",
  agent_status: "idle",
  ...patch,
});
const lead = actor({ pane_id: "w1:p1", terminal_id: "lead", agent: "codex" });
const snapshot = () =>
  preflightRoles(
    { implement: { machine: "local", agent: "claude", model: "sonnet" } },
    context,
  );
function plan(target = "role:implement:claude"): AssignmentPlan {
  return {
    assignments: [
      {
        id: "arbitrary-name",
        workerPaneId: target,
        instruction: "work",
        coding: {
          role: "implement",
          access: "write",
          writeScope: ["src/"],
          artifactRefs: [],
          findingRefs: [],
        },
      },
    ],
  };
}
const coding = { prior: [], findingIds: [], artifactIds: [] };

test("six roles parse, canonical roundtrip and absent roles retain exact old shape", () => {
  const roles = parseCardRoles(
    Object.fromEntries(
      CARD_ROLES.map((r) => [r, "local:claude:provider:model"]),
    ),
  );
  const serialized = serializeCard({ ...card, roles });
  assert.ok(serialized.ok);
  const parsed = parseCard(serialized.text);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.card, { ...card, roles });
  const old = serializeCard(card);
  assert.ok(old.ok);
  assert.ok(!old.text.includes("roles:"));
  assert.deepEqual(
    parseCardRoles({
      implement: ":claude",
      verify: "::sonnet",
      reviewer: "local",
    }),
    {
      implement: { agent: "claude" },
      verify: { model: "sonnet" },
      reviewer: { machine: "local" },
    },
  );
});
for (const value of [
  {},
  { nope: "local" },
  { review: "" },
  { implement: "::" },
  { implement: 1 },
  { implement: { agent: "claude" } },
  { implement: ":unknown" },
  { implement: ":claude:-model" },
  { implement: ":claude:model\n" },
  { implement: ":claude:" + "m".repeat(81) },
]) {
  test(`invalid declaration rejected: ${JSON.stringify(value)}`, () =>
    assert.throws(() => parseCardRoles(value)));
}
test("strict parser rejects repeated role and nested YAML without changing legacy parsing", () => {
  const serialized = serializeCard(card);
  assert.ok(serialized.ok);
  for (const text of [
    'roles: {implement: "local", implement: "local"}',
    "roles: {reviewer: {agent: claude}}",
    'roles: {typo: "local"}',
  ])
    assert.equal(
      parseCard(serialized.text.replace("---\n", `---\n${text}\n`)).ok,
      false,
    );
});
for (const [constraint, error] of [
  [{ machine: "missing" }, /不存在 machine/],
  [{ machine: "pod" }, /尚未支援 machine pod/],
  [{ agent: "pi" }, /未開放/],
  [{ model: "missing" }, /不合法 model/],
  [{ agent: "codex", model: "sonnet" }, /不合法 model/],
] as const)
  test(`preflight rejects ${JSON.stringify(constraint)}`, () =>
    assert.throws(
      () => preflightRoles({ implement: constraint }, context),
      error,
    ));
test("opt-in and configured flag/args are required and preserved, not guessed", () => {
  const resolved = preflightRoles(
    { reviewer: { agent: "agy", model: "gemini" } },
    context,
  );
  const selected = resolveFlowRole(resolved, "reviewer", "codex");
  assert.equal(selected.modelFlag, "--model");
  assert.deepEqual(selected.args, ["--quiet"]);
  assert.throws(
    () =>
      preflightRoles(
        { reviewer: { agent: "agy" } },
        {
          machineIds: [],
          profiles: [{ id: "agy", kind: "agy", capabilities: [] }],
        },
      ),
    /未開放/,
  );
  assert.throws(
    () =>
      preflightRoles(
        { reviewer: { agent: "agy", model: "gemini" } },
        {
          machineIds: [],
          profiles: [
            {
              id: "agy",
              kind: "agy",
              model: "gemini",
              capabilities: ["review"],
            },
          ],
        },
      ),
    /modelFlag/,
  );
});
test("fresh profile rejects resume and model override arguments", () => {
  for (const arg of [
    "--resume",
    "--continue=1",
    "--session",
    "--session-id=x",
    "resume",
    "-m",
    "--model=evil",
  ])
    assert.throws(() => assertFreshProfile({ ...profiles[0]!, args: [arg] }));
});
test("model-only selects compatible kind; CLI conflict never overrides card", () => {
  const s = preflightRoles({ reviewer: { model: "sonnet" } }, context);
  assert.equal(resolveFlowRole(s, "reviewer", "codex").kind, "claude");
  assert.throws(
    () => resolveFlowRole(s, "reviewer", "codex", "codex"),
    /沒有符合/,
  );
  const pinned = preflightRoles({ reviewer: { agent: "agy" } }, context);
  assert.throws(
    () => resolveFlowRole(pinned, "reviewer", "claude", "codex"),
    /衝突/,
  );
});
test("snapshot does not follow later card/config changes", () => {
  const mutable = structuredClone(context);
  const roles = { implement: { agent: "claude", model: "sonnet" } };
  const s = preflightRoles(roles, mutable);
  roles.implement.model = "opus";
  mutable.profiles[0]!.model = "wrong";
  assert.equal(s.roles.implement!.model, "sonnet");
  assert.equal(s.candidates.implement![0]!.model, "sonnet");
  assert.throws(
    () => preflightRoles(roles, { machineIds: [], profiles: [] }),
    /未開放/,
  );
});
test("plan checked by coding role, whole plan before acquire, cross-role and non-coding rejected", () => {
  const s = snapshot();
  const targets = roleTargets(s, "w1");
  validateAssignmentPlan(plan(), lead, targets, coding, s);
  const bad = plan();
  bad.assignments.push({
    ...plan().assignments[0]!,
    id: "second",
    workerPaneId: "wrong",
  });
  assert.throws(() => validateAssignmentPlan(bad, lead, targets, coding, s));
  assert.throws(
    () => validateAssignmentPlan(plan(), lead, targets, undefined, s),
    /coding/,
  );
  const wrongRole = plan();
  wrongRole.assignments[0]!.coding!.role = "diagnose";
  wrongRole.assignments[0]!.coding!.access = "read";
  wrongRole.assignments[0]!.coding!.writeScope = [];
  assert.throws(
    () => validateAssignmentPlan(wrongRole, lead, targets, coding, s),
    /跨角色/,
  );
  const unknown = plan();
  delete unknown.assignments[0]!.coding;
  assert.throws(
    () => validateAssignmentPlan(unknown, lead, targets, coding, s),
    /非 coding/,
  );
});
test("actual dispatch rejects machine/kind/model mismatch and unknown model", () => {
  const c = snapshot().roles.implement!;
  for (const a of [
    actor(),
    actor({ model: "opus" }),
    actor({ model: "sonnet", machine: "pod" }),
    actor({ model: "sonnet", agent: "codex" }),
  ])
    assert.throws(() => assertRoleMatches("implement", c, a), /派工不符/);
  assertRoleMatches("implement", c, actor({ model: "sonnet" }));
});
test("readiness rejects replacement terminal, kind, machine and known session; unknown session still allowed", () => {
  const original = actor({ agent_session: { kind: "id", value: "one" } });
  for (const patch of [
    { terminal_id: "new" },
    { agent: "codex" },
    { machine: "pod" },
    { agent_session: { kind: "id", value: "two" } },
  ])
    assert.throws(() =>
      assertReadyIdentity(original, actor(patch), "claude", "w1"),
    );
  assertReadyIdentity(
    actor(),
    actor({ agent_session: { kind: "id", value: "new" } }),
    "claude",
    "w1",
  );
});
test("v2 full-length metadata fits 300, survives parse/rotation; old hash and text unchanged", () => {
  const identity: RoleIdentity = {
    role: "a".repeat(64),
    assignmentId: "a".repeat(64),
    codingRole: "implement",
    agent: "claude",
    machine: "local",
    model: "m".repeat(80),
    profileId: "p".repeat(40),
    taskId: "t".repeat(64),
    round: 1000000,
    source: "card",
    selectionSources: { machine: "card", agent: "lead", model: "default" },
    modelEvidence: "launch",
  };
  const event = roleEvent(identity, "2026-11-10T00:00:00Z");
  const built = buildLogEntry(event);
  assert.ok(built.ok, JSON.stringify(built));
  assert.ok(Array.from(built.entry.text).length <= 300);
  assert.ok(built.entry.text.includes("ss=CLD"));
  assert.ok(built.entry.text.includes(identity.model!));
  const appended = appendLogEntries("", [built.entry]);
  assert.ok(appended.ok);
  assert.deepEqual(logEntriesOf(appended.body), [built.entry]);
  const rotated = rotateLog(appended.body, 0, "pointer");
  assert.ok(rotated);
  assert.equal(rotated.moved.length, 1);
  assert.ok(roleSummary([built.entry]).includes("claude"));
  const legacy = {
    role: "impl",
    agent: "claude",
    machine: "local",
    taskId: "task",
  };
  const old = buildLogEntry(roleEvent(legacy, "2026-11-10T00:00:00Z"));
  assert.ok(old.ok);
  assert.equal(old.entry.text, "impl：claude；machine=local；task=task");
  const rich = roleEvent(
    {
      ...legacy,
      ...roleMetadata(
        "implement",
        { agent: "claude" },
        actor(),
        "lead",
        "unknown",
      ),
    },
    "2026-11-10T00:00:00Z",
  );
  assert.notEqual(
    rich.eventId,
    roleEvent(legacy, "2026-11-10T00:00:00Z").eventId,
  );
});
test("rejection notification retains actual role/model cause", () => {
  assert.equal(
    notificationReason({
      event: "failed",
      text: "失敗：autopick_stopped；原因：卡片角色指定無效：reviewer：不合法 model x",
      time: "2026-11-10T00:00:00Z",
      eventId: "x",
    }),
    "卡片角色指定無效：reviewer：不合法 model",
  );
});

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "role-cards-"));
}
function malformed(notify = "discord:123"): string {
  return `---\nid: ${card.id}\nstatus: ready\nnotify: ${notify}\nroles: {unknown: "local"}\n---\n`;
}
test("malformed rejection query, retry after failed delivery, restart dedup; card never rewritten", async () => {
  const root = directory();
  const file = `${card.id}.md`;
  const raw = malformed();
  try {
    fs.writeFileSync(path.join(root, file), raw);
    let sends = 0;
    await recordMalformedRejection(root, file, "unknown role", async () => {
      sends++;
      throw new Error("offline");
    });
    assert.equal(readCardRejection(root, card.id)!.delivery, "pending");
    await recordMalformedRejection(
      root,
      file,
      "unknown role",
      async (destination, message) => {
        sends++;
        assert.equal(destination, "discord:123");
        assert.match(message, /unknown role/);
      },
    );
    assert.equal(readCardRejection(root, card.id)!.delivery, "sent");
    await recordMalformedRejection(root, file, "unknown role", async () => {
      sends++;
    });
    assert.equal(sends, 2);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), raw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("malformed route never inferred from duplicate, mismatched, oversized or symlink card", () => {
  const root = directory();
  const file = `${card.id}.md`;
  try {
    for (const raw of [
      malformed().replace(
        "status: ready",
        "status: ready\nnotify: discord:999",
      ),
      malformed().replace(`id: ${card.id}`, "id: REQ-20261110-other"),
      malformed().replace(
        "status: ready",
        "status: ready\nid: REQ-20261110-other",
      ),
      malformed("invalid"),
      "x".repeat(1024 * 1024 + 1),
    ]) {
      fs.writeFileSync(path.join(root, file), raw);
      assert.equal(malformedCardIdentity(root, file)!.notify, undefined);
    }
    fs.unlinkSync(path.join(root, file));
    fs.symlinkSync("/etc/passwd", path.join(root, file));
    assert.equal(malformedCardIdentity(root, file)!.notify, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("diagnostic write failure prevents delivery and retries after storage repaired", async () => {
  const root = directory();
  const file = `${card.id}.md`;
  let sends = 0;
  try {
    fs.writeFileSync(path.join(root, file), malformed());
    fs.writeFileSync(path.join(root, ".role-rejections"), "blocked");
    await assert.rejects(
      recordMalformedRejection(root, file, "invalid", async () => {
        sends++;
      }),
    );
    assert.equal(sends, 0);
    fs.unlinkSync(path.join(root, ".role-rejections"));
    await recordMalformedRejection(root, file, "invalid", async () => {
      sends++;
    });
    assert.equal(sends, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function framed(prompt: string, text: string): string {
  const begin = /Opening marker \(first line\): (BRIDGE_BEGIN_[a-f0-9]+)/.exec(
    prompt,
  )?.[1];
  const end = /Closing marker \(last line\): (BRIDGE_END_[a-f0-9]+)/.exec(
    prompt,
  )?.[1];
  return `${begin}\n${text}\n${end}`;
}
function taskPort(body: string) {
  const raw = JSON.parse(body) as AssignmentPlan;
  body = JSON.stringify({
    assignments: raw.assignments.map((a) => ({
      ...a,
      ...a.coding,
      coding: undefined,
    })),
  });
  const prompts = new Map<string, string>();
  let workerPrompts = 0;
  const port: OrchestrationPort = {
    promptAgent: async (target, prompt) => {
      prompts.set(target, prompt);
      if (target !== lead.pane_id) workerPrompts++;
    },
    waitAgent: async (target) => (target === lead.pane_id ? lead : actor()),
    readAgent: async (target) =>
      prompts.has(target) ? framed(prompts.get(target)!, body) : "history",
  };
  return { port, prompts, count: () => workerPrompts };
}
test("entire invalid plan rejects before acquisition across replanning", async () => {
  const s = snapshot();
  const wire = taskPort(JSON.stringify(plan("wrong")));
  let acquired = 0;
  await assert.rejects(
    runTeamTask(
      {
        taskId: "reject",
        prompt: "work",
        coding: true,
        lead,
        workers: roleTargets(s, "w1"),
        roleSnapshot: s,
        timeoutMs: 1000,
        acquireWorker: async () => {
          acquired++;
          return { agent: actor(), continuity: "new-session" };
        },
        codingHooks: {
          findingIds: () => [],
          artifactIds: () => [],
          evidenceSummary: () => ({}),
          assess: () => ({ reasons: ["missing"], fingerprint: "x" }),
          onAssignmentStart: () => {},
          onAssignmentDone: () => {},
        },
      },
      wire.port,
      () => {},
    ),
    /Plan rejection #3/,
  );
  assert.equal(acquired, 0);
  assert.equal(wire.count(), 0);
  assert.match(
    wire.prompts.get(lead.pane_id)!,
    /Bridge-enforced card role constraints/,
  );
});
test("strict role write failure releases fresh assignment and sends zero Worker prompts", async () => {
  const s = snapshot();
  const wire = taskPort(JSON.stringify(plan()));
  let cleaned = 0;
  let assignmentId: string | undefined;
  const result = await runTeamTask(
    {
      taskId: "strict",
      prompt: "work",
      coding: true,
      lead,
      workers: roleTargets(s, "w1"),
      roleSnapshot: s,
      timeoutMs: 1000,
      recordRoleStrict: () => {
        throw new Error("disk unavailable");
      },
      acquireWorker: async (_target, assignment) => {
        assignmentId = assignment?.id;
        return {
          agent: actor({ model: "sonnet", modelEvidence: "launch" }),
          continuity: "new-session",
          cleanup: async () => {
            cleaned++;
          },
        };
      },
      codingHooks: {
        findingIds: () => [],
        artifactIds: () => [],
        evidenceSummary: () => ({}),
        assess: () => ({ reasons: ["missing"], fingerprint: "x" }),
        onAssignmentStart: () => {},
        onAssignmentDone: () => {},
      },
    },
    wire.port,
    () => {},
  );
  assert.equal(result.reports[0]!.state, "failed");
  assert.match(result.reports[0]!.blocker!, /disk unavailable/);
  assert.equal(assignmentId, "arbitrary-name");
  assert.equal(cleaned, 1);
  assert.equal(wire.count(), 0);
});

test("durable role snapshot persists immutably; old journals omit it; corrupt candidates fail closed", () => {
  const root = directory();
  try {
    const store = new TeamTaskStore(root);
    store.create({ taskId: "legacy", lead, prompt: "old", workers: [actor()] });
    const baseline = {
      repository: "/repo",
      branch: "card/test",
      headSha: "a".repeat(40),
      stagedDiffSha256: "b".repeat(64),
      unstagedDiffSha256: "c".repeat(64),
      overflow: false,
      files: [],
    };
    const s = snapshot();
    store.create({
      taskId: "new",
      lead,
      prompt: "new",
      workers: roleTargets(s, "w1"),
      coding: true,
      codingBaseline: initialCodingState(baseline),
      roleSnapshot: s,
    });
    const loaded = new TeamTaskStore(root);
    assert.equal(loaded.get("legacy").roleSnapshot, undefined);
    assert.deepEqual(loaded.get("new").roleSnapshot, s);
    assert.throws(() =>
      loaded.update("new", "mutated", (t) => {
        t.roleSnapshot!.roles.implement!.model = "opus";
      }),
    );
    const journalFile = fs.readdirSync(root).find((f) => {
      const raw = fs.readFileSync(path.join(root, f), "utf8");
      return raw.includes('"taskId":"new"');
    });
    assert.ok(journalFile);
    const journal = JSON.parse(
      fs.readFileSync(path.join(root, journalFile), "utf8"),
    );
    journal.events[0].task.roleSnapshot.candidates.implement[0].args = [
      "--resume",
    ];
    fs.writeFileSync(path.join(root, journalFile), JSON.stringify(journal));
    assert.throws(() => new TeamTaskStore(root), /resume/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("non-coding and empty plans never authorize constrained implementation in synthesis", async () => {
  const s = snapshot();
  const wire = taskPort(JSON.stringify({ assignments: [] }));
  await assert.rejects(
    runTeamTask(
      {
        taskId: "noncoding",
        prompt: "work",
        lead,
        workers: roleTargets(s, "w1"),
        roleSnapshot: s,
      },
      wire.port,
      () => {},
    ),
    /--coding/,
  );
  const result = await runTeamTask(
    {
      taskId: "empty",
      prompt: "work",
      coding: true,
      lead,
      workers: roleTargets(s, "w1"),
      roleSnapshot: s,
      timeoutMs: 1000,
      codingHooks: {
        findingIds: () => [],
        artifactIds: () => [],
        evidenceSummary: () => ({}),
        assess: () => ({
          reasons: ["implementation missing"],
          fingerprint: "x",
        }),
        onAssignmentStart: () => {},
        onAssignmentDone: () => {},
      },
    },
    wire.port,
    () => {},
  );
  assert.equal(result.state, "failed");
  assert.equal(wire.count(), 0);
});

test("disabled profile cannot authorize a model of the same kind", () => {
  assert.throws(
    () =>
      preflightRoles(
        { reviewer: { agent: "agy", model: "gemini" } },
        { ...context, enabledProfileIds: ["claude"] },
      ),
    /未開放/,
  );
  assert.throws(
    () => assertFreshProfile({ ...profiles[3]!, modelFlag: "--session" }),
    /resume/,
  );
});

test("pre-pick role rejection never starts work and retries failed rejection writes", async () => {
  const parsed = parsePolicy(
    "version: 1\nprojects:\n  local:repo: L1\nautopick:\n  local:repo: /repo\n",
  );
  assert.ok(parsed.ok);
  let starts = 0;
  let attempts = 0;
  const steps: AutopickSteps = {
    startLead: async () => {
      starts++;
      return { close: async () => {} };
    },
    command: async () => "",
    waitTask: async () => ({ completed: true, detail: "" }),
    waitCardDone: async () => true,
    loop: async () => ({ merged: true, text: "" }),
  };
  const bad = {
    ...card,
    projects: ["local:repo"],
    roles: { implement: { machine: "pod" } },
  };
  const gate = (candidate: Card) => {
    try {
      preflightRoles(candidate.roles!, context);
    } catch (error) {
      return String(error);
    }
  };
  const picker = createAutopicker({
    policy: () => ({
      status: "loaded",
      policy: parsed.policy,
      file: "/policy.yml",
    }),
    readyCards: () => [bad],
    steps,
    onReport: () => {},
    roleGate: gate,
    onRejected: () => {
      attempts++;
      return attempts > 1;
    },
  });
  await picker.tick();
  await picker.tick();
  await picker.tick();
  assert.equal(starts, 0);
  assert.equal(attempts, 2);
  assert.equal(
    pickNext(parsed.policy, [bad], new Set(), undefined, gate),
    undefined,
  );
});
test("job snapshot changed after preflight is rejected before workspace mutation", async () => {
  let requests = 0;
  const steps = createAutopickSteps({
    validateJob: () => {
      throw new Error("changed snapshot");
    },
    port: {
      request: async () => {
        requests++;
        return {};
      },
      listAgentsWithWorkspaceNames: async () => [],
    },
    command: async () => "",
    recordLeadWorkspace: () => {},
    taskIdForCard: () => undefined,
    taskState: () => undefined,
    cardStatus: () => "ready",
    allowedWorkspaceIds: [],
    sleep: async () => {},
    now: () => 0,
  });
  await assert.rejects(
    steps.startLead({
      card: { ...card, roles: snapshot().roles },
      project: "local:repo",
      repoPath: "/repo",
      level: "L1",
      lead: "claude",
    }),
    /changed snapshot/,
  );
  assert.equal(requests, 0);
});

test("async dispatch gate runs after baseline and rejects replacement before prompt", async () => {
  const { runTeamTurn } = await import("../src/team-turn.js");
  let reads = 0;
  let prompts = 0;
  const port: OrchestrationPort = {
    promptAgent: async () => {
      prompts++;
    },
    readAgent: async () => {
      reads++;
      return "history";
    },
    waitAgent: async () => lead,
  };
  await assert.rejects(
    runTeamTurn(lead, "work", port, 1000, 80, {
      beforeDispatch: async () => {
        assert.ok(reads > 0);
        await Promise.resolve();
        throw new Error("identity replaced before dispatch");
      },
    }),
    /identity replaced/,
  );
  assert.equal(prompts, 0);
});

test("strict failure releases only the owned profile lease and preserves its binding", async () => {
  const root = directory();
  const worker = actor({ agent_session: { kind: "id", value: "stable" } });
  const profile = profiles[0]!;
  try {
    const pool = new AgentPool(
      path.join(root, "pool.json"),
      [profile],
      {
        listAgentsWithWorkspaceNames: async () => [worker],
        startProfile: async () => worker,
      },
      [],
    );
    pool.select("w1", profile.id, true);
    await pool.acquire("w1", profile.id, lead, "owner");
    pool.releaseProfile("w1", profile.id, "wrong-owner");
    await assert.rejects(
      pool.acquire("w1", profile.id, lead, "next"),
      /leased/,
    );
    pool.releaseProfile("w1", profile.id, "owner");
    const acquired = await pool.acquire("w1", profile.id, lead, "next");
    assert.equal(acquired.agent.pane_id, worker.pane_id);
    assert.equal(acquired.continuity, "same-session");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
