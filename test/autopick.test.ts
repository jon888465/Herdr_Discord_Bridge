import test from "node:test";
import assert from "node:assert/strict";
import {
  createAutopicker,
  leadRejection,
  pickNext,
  runAutopick,
  type AutopickJob,
  type AutopickReport,
  type AutopickSteps,
} from "../src/autopick.js";
import type { Card } from "../src/card.js";
import {
  parsePolicy,
  type LoadedPolicy,
  type Policy,
  type PolicyLevel,
} from "../src/policy.js";

const REPO = "/Users/example/git_wk/Herdr_Discord_Bridge";

function policyFor(level: PolicyLevel, lead = "claude"): Policy {
  const parsed = parsePolicy(
    [
      "version: 1",
      `autopick_lead: ${lead}`,
      "projects:",
      `  local:Herdr_Discord_Bridge: ${level}`,
      "  local:NotPicked: L2",
      "autopick:",
      `  local:Herdr_Discord_Bridge: ${REPO}`,
      "",
    ].join("\n"),
  );
  assert.ok(parsed.ok);
  return parsed.policy;
}

const card = (id: string, over: Partial<Card> = {}): Card =>
  ({
    id,
    type: "requirement",
    status: "ready",
    title: id,
    version: 1,
    created: "2026-11-05",
    updated: "2026-11-05",
    projects: ["local:Herdr_Discord_Bridge"],
    body: "",
    ...over,
  }) as Card;

test("the oldest ready card of an opted-in project is picked; others are ignored", () => {
  const policy = policyFor("L1");
  const cards = [
    card("REQ-20261105-b"),
    card("REQ-20261104-z", { created: "2026-11-04" }),
    card("REQ-20261103-draft", { status: "draft", created: "2026-11-03" }),
    card("REQ-20261103-other", {
      created: "2026-11-03",
      projects: ["local:NotPicked"],
    }),
    card("REQ-20261103-none", { created: "2026-11-03", projects: undefined }),
  ];
  const job = pickNext(policy, cards);
  assert.equal(job?.card.id, "REQ-20261104-z");
  assert.equal(job?.repoPath, REPO);
  assert.equal(job?.level, "L1");
  assert.equal(job?.lead, "claude");
});

test("the legacy project field counts, and cards already tried by this process are skipped", () => {
  const policy = policyFor("L0");
  const legacy = card("REQ-20261105-legacy", {
    projects: undefined,
    project: "local:Herdr_Discord_Bridge",
  });
  assert.equal(pickNext(policy, [legacy])?.card.id, "REQ-20261105-legacy");
  assert.equal(
    pickNext(policy, [legacy], new Set(["REQ-20261105-legacy"])),
    undefined,
  );
});

test("nothing is picked when no project is opted in", () => {
  const parsed = parsePolicy(
    "version: 1\nprojects:\n  local:Herdr_Discord_Bridge: L2\n",
  );
  assert.ok(parsed.ok);
  assert.equal(pickNext(parsed.policy, [card("REQ-20261105-a")]), undefined);
});

function fakeSteps(over: Partial<AutopickSteps> = {}) {
  const calls: string[] = [];
  let closed = 0;
  const steps: AutopickSteps = {
    startLead: async () => {
      calls.push("startLead");
      return {
        close: async () => {
          closed += 1;
        },
      };
    },
    command: async (text) => {
      calls.push(text);
      return "ok";
    },
    waitTask: async () => ({ completed: true, detail: "" }),
    waitCardDone: async () => true,
    loop: async (id, reviewer) => {
      calls.push(`loop ${id} ${reviewer}`);
      return { merged: true, text: "merged" };
    },
    ...over,
  };
  return { steps, calls, closed: () => closed };
}

function job(
  level: PolicyLevel,
  lead: "claude" | "codex" | "agy" | "pi" = "claude",
): AutopickJob {
  return {
    card: card("REQ-20261105-x"),
    project: "local:Herdr_Discord_Bridge",
    repoPath: REPO,
    level,
    lead,
  };
}

test("L2 runs the whole chain in order and closes its Lead workspace at the end", async () => {
  const { steps, calls, closed } = fakeSteps();
  const report = await runAutopick(job("L2"), steps);
  assert.deepEqual(calls, [
    "startLead",
    "card assign REQ-20261105-x --worktree --coding",
    "card commit REQ-20261105-x",
    "card pr REQ-20261105-x",
    "loop REQ-20261105-x codex",
  ]);
  assert.equal(report.outcome, "reached");
  assert.equal(report.lastStep, "loop");
  assert.equal(closed(), 1);
});

test("the reviewer is the other kind when the Lead is codex", async () => {
  const { steps, calls } = fakeSteps();
  await runAutopick(job("L2", "codex"), steps);
  assert.ok(calls.includes("loop REQ-20261105-x claude"));
});

test("L1 stops after the pull request, and L0 stops after the commit; neither merges", async () => {
  const l1 = fakeSteps();
  const r1 = await runAutopick(job("L1"), l1.steps);
  assert.equal(r1.lastStep, "pr");
  assert.equal(r1.outcome, "reached");
  assert.equal(
    l1.calls.some((c) => c.startsWith("loop")),
    false,
  );

  const l0 = fakeSteps();
  const r0 = await runAutopick(job("L0"), l0.steps);
  assert.equal(r0.lastStep, "commit");
  assert.equal(r0.outcome, "reached");
  assert.equal(
    l0.calls.some((c) => c.includes("card pr")),
    false,
  );
});

test("a failing step stops everything after it and keeps the Lead workspace for inspection", async () => {
  const { steps, calls, closed } = fakeSteps({
    command: async (text) => {
      calls.push(text);
      if (text.startsWith("card commit"))
        throw new Error("worktree 的內容和通過驗證的版本不同");
      return "ok";
    },
  });
  const report = await runAutopick(job("L2"), steps);
  assert.equal(report.outcome, "failed");
  assert.equal(report.lastStep, "commit");
  assert.match(report.reason ?? "", /驗證的版本不同/);
  assert.equal(
    calls.some((c) => c.includes("card pr")),
    false,
  );
  assert.equal(closed(), 0);
});

test("an unfinished task, a card that never becomes done, or a loop that did not merge stops for a human", async () => {
  const notDone = await runAutopick(
    job("L2"),
    fakeSteps({
      waitTask: async () => ({
        completed: false,
        detail: "failed: no successful verification",
      }),
    }).steps,
  );
  assert.equal(notDone.outcome, "stopped");
  assert.equal(notDone.lastStep, "task");
  assert.match(notDone.reason ?? "", /no successful verification/);

  const stale = fakeSteps({ waitCardDone: async () => false });
  const staleReport = await runAutopick(job("L2"), stale.steps);
  assert.equal(staleReport.lastStep, "card_done");
  assert.equal(
    stale.calls.some((c) => c.includes("card commit")),
    false,
  );

  const noMerge = fakeSteps({
    loop: async () => ({
      merged: false,
      text: "loop 停下來了：CI 沒有全部通過",
    }),
  });
  const loopReport = await runAutopick(job("L2"), noMerge.steps);
  assert.equal(loopReport.outcome, "stopped");
  assert.equal(loopReport.lastStep, "loop");
  assert.match(loopReport.reason ?? "", /CI/);
  assert.equal(noMerge.closed(), 0);
});

test("if the Lead cannot be started nothing else runs", async () => {
  const { steps, calls } = fakeSteps({
    startLead: async () => {
      throw new Error("repo 不存在");
    },
  });
  const report = await runAutopick(job("L2"), steps);
  assert.equal(report.outcome, "failed");
  assert.equal(report.lastStep, "lead");
  assert.deepEqual(calls, []);
});

const loaded = (
  policy: Policy,
  status: LoadedPolicy["status"] = "loaded",
): LoadedPolicy => ({
  status,
  policy,
  file: "/x/policy.yml",
});

test("the picker works one card at a time and does not retry a card it already tried", async () => {
  const reports: AutopickReport[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const picker = createAutopicker({
    policy: () => loaded(policyFor("L0")),
    readyCards: () => [card("REQ-20261105-a"), card("REQ-20261105-b")],
    steps: fakeSteps({
      waitTask: async () => (await gate, { completed: true, detail: "" }),
    }).steps,
    onReport: (report) => {
      reports.push(report);
    },
  });
  const first = picker.tick();
  assert.ok(first);
  assert.equal(picker.busy, true);
  assert.equal(
    picker.tick(),
    undefined,
    "a second card must not start while one is running",
  );
  release();
  await first;
  assert.equal(picker.busy, false);
  assert.deepEqual(
    reports.map((r) => r.cardId),
    ["REQ-20261105-a"],
  );
  await picker.tick();
  assert.deepEqual(
    reports.map((r) => r.cardId),
    ["REQ-20261105-a", "REQ-20261105-b"],
  );
  assert.equal(picker.tick(), undefined, "both cards were already tried");
});

test("a policy that is missing, invalid or unsafe picks nothing", () => {
  for (const status of ["missing", "invalid", "unsafe"] as const) {
    const picker = createAutopicker({
      policy: () => loaded(policyFor("L2"), status),
      readyCards: () => [card("REQ-20261105-a")],
      steps: fakeSteps().steps,
      onReport: () => {},
    });
    assert.equal(picker.tick(), undefined, status);
  }
});

test("a failed picked notification never prevents autopick execution", async () => {
  let commands = 0,
    picked = 0;
  const reports: AutopickReport[] = [];
  const picker = createAutopicker({
    policy: () => ({
      status: "loaded",
      policy: policyFor("L0"),
      file: "/policy",
    }),
    readyCards: () => [card("REQ-20261107-notify")],
    onPicked: async () => {
      picked++;
      throw Error("notification unavailable");
    },
    steps: {
      startLead: async () => ({ close: async () => {} }),
      command: async () => {
        commands++;
        return "";
      },
      waitTask: async () => ({ completed: true, detail: "" }),
      waitCardDone: async () => true,
      loop: async () => ({ merged: true, text: "" }),
    },
    onReport: (r) => {
      reports.push(r);
    },
  });
  await picker.tick();
  assert.equal(picked, 1);
  assert.equal(commands, 2);
  assert.equal(reports[0].outcome, "reached");
});

for (const kind of ["claude", "codex", "agy", "pi"] as const) {
  test(`${kind} Lead keeps the explicit reviewer preference and closes on L2 success`, async () => {
    const h = fakeSteps();
    const report = await runAutopick(job("L2", kind), h.steps);
    assert.equal(report.outcome, "reached");
    assert.ok(
      h.calls.includes(
        `loop REQ-20261105-x ${kind === "codex" ? "claude" : "codex"}`,
      ),
    );
    assert.equal(h.closed(), 1);
  });
}

test("a card's lead selects the Lead kind when the policy allows it, otherwise the card is rejected once and not picked", async () => {
  const parsed = parsePolicy(
    [
      "version: 1",
      "autopick_lead: claude, codex",
      "projects:",
      "  local:Herdr_Discord_Bridge: L1",
      "autopick:",
      `  local:Herdr_Discord_Bridge: ${REPO}`,
      "",
    ].join("\n"),
  );
  assert.ok(parsed.ok);
  const policy = parsed.policy;
  assert.equal(
    pickNext(policy, [card("REQ-20261105-a", { lead: "codex" })])?.lead,
    "codex",
  );
  assert.equal(pickNext(policy, [card("REQ-20261105-b")])?.lead, "claude");
  const bad = card("REQ-20261105-c", { lead: "agy" });
  assert.equal(pickNext(policy, [bad]), undefined);
  assert.match(leadRejection(policy, bad) ?? "", /agy.*claude、codex/);
  assert.equal(leadRejection(policy, card("REQ-20261105-d")), undefined);
  assert.equal(
    leadRejection(
      policy,
      card("REQ-20261105-e", { lead: "agy", status: "draft" }),
    ),
    undefined,
  );
  const rejected: string[] = [];
  const picker = createAutopicker({
    policy: () => loaded(policy),
    readyCards: () => [bad],
    steps: fakeSteps().steps,
    onReport: () => undefined,
    onRejected: (c) => rejected.push(c.id),
  });
  assert.equal(picker.tick(), undefined);
  assert.equal(picker.tick(), undefined);
  assert.deepEqual(rejected, ["REQ-20261105-c"], "reported once per card");
});
