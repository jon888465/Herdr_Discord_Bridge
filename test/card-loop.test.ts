import test from "node:test";
import assert from "node:assert/strict";
import {
  runLoop,
  type LoopSteps,
  type LoopVerdict,
  type LoopView,
} from "../src/card-loop.js";

type ReviewPlan = LoopVerdict | Error;
type FixPlan =
  | { kind: "fixed"; sensitivePaths?: string[] }
  | { kind: "failed" }
  | Error;

/**
 * 假的卡片與步驟：review 依序用 `reviews`，fix 依序用 `fixes`；review 與 fix 會像真的一樣改變 `view`
 * （review 的結果成為最新判定；fix 成功後 open 的 finding 變成 0，因為都標成 fixed）。
 */
function setup(
  reviews: ReviewPlan[],
  fixes: FixPlan[] = [],
  options: {
    start?: LoopView;
    pushFails?: boolean;
    stopAfter?: number;
  } = {},
) {
  const log: string[] = [];
  const notices: string[] = [];
  let view: LoopView = options.start ?? { latestRound: 0, openFindings: 0 };
  let stepCount = 0;
  const steps: LoopSteps = {
    view: () => ({ ...view }),
    review: async () => {
      stepCount++;
      const plan = reviews.shift();
      if (plan === undefined) throw new Error("no more review plans");
      log.push("review");
      if (plan instanceof Error) throw plan;
      view = {
        latestRound: view.latestRound + 1,
        latestVerdict: plan,
        openFindings: plan === "changes_requested" ? 2 : 0,
      };
      return { text: `review ${view.latestRound}: ${plan}`, verdict: plan };
    },
    fix: async () => {
      stepCount++;
      const plan = fixes.shift();
      if (plan === undefined) throw new Error("no more fix plans");
      log.push("fix");
      if (plan instanceof Error) throw plan;
      if (plan.kind === "failed") return { kind: "failed", text: "fix failed" };
      view = { ...view, openFindings: 0 };
      return { kind: "fixed", text: "fix ok", sensitivePaths: plan.sensitivePaths ?? [] };
    },
    push: async () => {
      log.push("push");
      if (options.pushFails) throw new Error("push rejected");
      return { text: "pushed" };
    },
    stopRequested: () =>
      options.stopAfter !== undefined && stepCount >= options.stopAfter,
    notify: async (text) => {
      notices.push(text);
    },
  };
  return { steps, log, notices };
}

test("a first review that passes ends the loop at once, with one step", async () => {
  const { steps, log } = setup(["pass"]);
  const result = await runLoop(steps);
  assert.deepEqual(result, { status: "passed", steps: 1 });
  assert.deepEqual(log, ["review"]);
});

test("changes requested is fixed, pushed, and reviewed again until it passes", async () => {
  const { steps, log } = setup(["changes_requested", "pass"], [{ kind: "fixed" }]);
  const result = await runLoop(steps);
  assert.deepEqual(result, { status: "passed", steps: 4 });
  assert.deepEqual(log, ["review", "fix", "push", "review"]);
});

test("every step is reported as it happens, in order", async () => {
  const { steps, notices } = setup(["changes_requested", "pass"], [{ kind: "fixed" }]);
  await runLoop(steps);
  assert.deepEqual(notices, ["review 1: changes_requested", "fix ok", "pushed", "review 2: pass"]);
});

test("the loop stops after the third review that still asks for changes, and never starts a fourth", async () => {
  const { steps, log } = setup(
    ["changes_requested", "changes_requested", "changes_requested", "pass"],
    [{ kind: "fixed" }, { kind: "fixed" }],
  );
  const result = await runLoop(steps);
  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.step, "limit");
  assert.match(result.status === "stopped" ? result.reason : "", /3/);
  assert.deepEqual(log, ["review", "fix", "push", "review", "fix", "push", "review"]);
});

test("the round limit can be set, and an already exhausted card is not reviewed again", async () => {
  const one = setup(["changes_requested", "pass"], [{ kind: "fixed" }]);
  const result = await runLoop(one.steps, { maxRounds: 1 });
  assert.equal(result.status === "stopped" && result.step, "limit");
  assert.deepEqual(one.log, ["review"]);

  const exhausted = setup(["pass"], [], { start: { latestRound: 3, latestVerdict: "inconclusive", openFindings: 0 } });
  const stopped = await runLoop(exhausted.steps);
  assert.equal(stopped.status === "stopped" && stopped.step, "limit");
  assert.deepEqual(exhausted.log, []);
});

test("an inconclusive review is retried once on the same head and then stops", async () => {
  const retried = setup(["inconclusive", "pass"]);
  assert.deepEqual(await runLoop(retried.steps), { status: "passed", steps: 2 });
  assert.deepEqual(retried.log, ["review", "review"]);

  const twice = setup(["inconclusive", "inconclusive", "pass"]);
  const result = await runLoop(twice.steps);
  assert.equal(result.status === "stopped" && result.step, "inconclusive");
  assert.deepEqual(twice.log, ["review", "review"]);
});

test("the retry allowance is per head: a pushed fix starts a fresh allowance", async () => {
  const { steps, log } = setup(
    ["inconclusive", "changes_requested", "inconclusive", "pass"],
    [{ kind: "fixed" }],
  );
  const result = await runLoop(steps, { maxRounds: 10 });
  assert.equal(result.status, "passed");
  assert.deepEqual(log, ["review", "review", "fix", "push", "review", "review"]);
});

test("a card whose latest review was already inconclusive counts that as the first attempt", async () => {
  const { steps, log } = setup(["inconclusive"], [], {
    start: { latestRound: 1, latestVerdict: "inconclusive", openFindings: 0 },
  });
  const result = await runLoop(steps);
  assert.equal(result.status === "stopped" && result.step, "inconclusive");
  assert.deepEqual(log, ["review"]);
});

test("a card that already passed needs no loop", async () => {
  const { steps, log } = setup([], [], { start: { latestRound: 2, latestVerdict: "pass", openFindings: 0 } });
  const result = await runLoop(steps);
  assert.deepEqual(result, { status: "passed", steps: 0 });
  assert.deepEqual(log, []);
});

test("a card that already has changes requested and open findings resumes at the fix, not at a review", async () => {
  const { steps, log } = setup(["pass"], [{ kind: "fixed" }], {
    start: { latestRound: 1, latestVerdict: "changes_requested", openFindings: 2 },
  });
  const result = await runLoop(steps);
  assert.equal(result.status, "passed");
  assert.deepEqual(log, ["fix", "push", "review"]);
});

test("after a pushed fix the new head is always reviewed, even when some findings stayed open", async () => {
  const { steps, log } = setup(["changes_requested", "pass"], [{ kind: "fixed" }]);
  // fix 之後仍有 open 的 finding（作者略過了一筆）：新 head 還是要先 review，不能再 fix 一次
  const original = steps.fix;
  steps.fix = async () => {
    const outcome = await original();
    return outcome;
  };
  const view = steps.view;
  let afterFix = false;
  steps.view = () => {
    const current = view();
    return afterFix ? { ...current, openFindings: 1 } : current;
  };
  const push = steps.push;
  steps.push = async () => {
    afterFix = true;
    return push();
  };
  await runLoop(steps);
  assert.deepEqual(log, ["review", "fix", "push", "review"]);
});

test("a failed fix round stops the loop and nothing is pushed", async () => {
  const { steps, log } = setup(["changes_requested"], [{ kind: "failed" }]);
  const result = await runLoop(steps);
  assert.equal(result.status === "stopped" && result.step, "fix");
  assert.deepEqual(log, ["review", "fix"]);
});

test("a fix that touches sensitive paths stops before the push and names the paths", async () => {
  const { steps, log } = setup(["changes_requested"], [{ kind: "fixed", sensitivePaths: ["SPEC.md", ".github/ci.yml"] }]);
  const result = await runLoop(steps);
  assert.equal(result.status === "stopped" && result.step, "sensitive");
  const reason = result.status === "stopped" ? result.reason : "";
  assert.match(reason, /SPEC\.md/);
  assert.match(reason, /沒有 push/);
  assert.deepEqual(log, ["review", "fix"]);
});

test("an error from a review, a fix or a push stops the loop with that message", async () => {
  const review = setup([new Error("沒有開著的 PR")]);
  const a = await runLoop(review.steps);
  assert.equal(a.status === "stopped" && a.step, "review");
  assert.match(a.status === "stopped" ? a.reason : "", /沒有開著的 PR/);

  const fix = setup(["changes_requested"], [new Error("作者的 pane 已不在")]);
  const b = await runLoop(fix.steps);
  assert.equal(b.status === "stopped" && b.step, "fix");
  assert.match(b.status === "stopped" ? b.reason : "", /已不在/);

  const push = setup(["changes_requested"], [{ kind: "fixed" }], { pushFails: true });
  const c = await runLoop(push.steps);
  assert.equal(c.status === "stopped" && c.step, "push");
  assert.match(c.status === "stopped" ? c.reason : "", /push rejected/);
  assert.match(c.status === "stopped" ? c.reason : "", /fix/i);
});

test("a stop request takes effect between steps, never in the middle of one", async () => {
  const { steps, log } = setup(["changes_requested", "pass"], [{ kind: "fixed" }], { stopAfter: 1 });
  const result = await runLoop(steps);
  assert.equal(result.status === "stopped" && result.step, "cancel");
  assert.deepEqual(log, ["review"]);
});

test("a stop request before the first step does nothing at all", async () => {
  const { steps, log } = setup(["pass"], [], { stopAfter: 0 });
  const result = await runLoop(steps);
  assert.equal(result.status === "stopped" && result.step, "cancel");
  assert.deepEqual(log, []);
});

test("a failure of the progress notice never stops the loop", async () => {
  const { steps } = setup(["pass"]);
  steps.notify = async () => {
    throw new Error("discord down");
  };
  const result = await runLoop(steps);
  assert.deepEqual(result, { status: "passed", steps: 1 });
});

type CiPlan = "success" | "failure" | "timeout" | "cancelled" | Error;

/** 在 `setup` 的步驟上加上 `--merge` 要用的兩步：等 CI、merge。 */
function withMerge(
  base: ReturnType<typeof setup>,
  ci: CiPlan,
  mergeError?: Error,
) {
  base.steps.waitCi = async () => {
    base.log.push("waitCi");
    if (ci instanceof Error) throw ci;
    return { state: ci, text: `ci: ${ci}` };
  };
  base.steps.merge = async () => {
    base.log.push("merge");
    if (mergeError) throw mergeError;
    return { text: "merged" };
  };
  return base;
}

test("without the merge option a pass never waits for CI or merges", async () => {
  const run = withMerge(setup(["pass"]), "success");
  const result = await runLoop(run.steps);
  assert.deepEqual(result, { status: "passed", steps: 1 });
  assert.deepEqual(run.log, ["review"]);
});

test("with the merge option a pass waits for CI and then merges, once, last", async () => {
  const run = withMerge(setup(["changes_requested", "pass"], [{ kind: "fixed" }]), "success");
  const result = await runLoop(run.steps, { merge: true });
  assert.deepEqual(result, { status: "passed", steps: 6, merged: true });
  assert.deepEqual(run.log, ["review", "fix", "push", "review", "waitCi", "merge"]);
  assert.deepEqual(run.notices.slice(-2), ["ci: success", "merged"]);
});

test("a red CI stops the loop before merging and says so", async () => {
  const run = withMerge(setup(["pass"]), "failure");
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "ci");
  assert.deepEqual(run.log, ["review", "waitCi"]);
});

test("a CI wait that times out stops the loop without merging", async () => {
  const run = withMerge(setup(["pass"]), "timeout");
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "ci");
  assert.deepEqual(run.log, ["review", "waitCi"]);
});

test("a stop request during the CI wait stops the loop without merging", async () => {
  const run = withMerge(setup(["pass"]), "cancelled");
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "cancel");
  assert.deepEqual(run.log, ["review", "waitCi"]);
});

test("an error while waiting for CI stops the loop without merging", async () => {
  const run = withMerge(setup(["pass"]), new Error("gh down"));
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "ci");
  assert.match(result.status === "stopped" ? result.reason : "", /gh down/);
  assert.deepEqual(run.log, ["review", "waitCi"]);
});

test("a refused merge stops the loop and carries the reasons", async () => {
  const run = withMerge(setup(["pass"]), "success", new Error("不 merge PR #9（1 項條件不成立）"));
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "merge");
  assert.match(result.status === "stopped" ? result.reason : "", /不 merge PR #9/);
});

test("a stop request after the pass but before the CI wait never merges", async () => {
  const run = withMerge(setup(["pass"], [], { stopAfter: 1 }), "success");
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "cancel");
  assert.deepEqual(run.log, ["review"]);
});

test("a failed fix never reaches the CI wait", async () => {
  const run = withMerge(setup(["changes_requested"], [{ kind: "failed" }]), "success");
  const result = await runLoop(run.steps, { merge: true });
  assert.equal(result.status === "stopped" && result.step, "fix");
  assert.deepEqual(run.log, ["review", "fix"]);
});

test("the merge option without the two merge steps is refused up front", async () => {
  const run = setup(["pass"]);
  await assert.rejects(runLoop(run.steps, { merge: true }), /waitCi|merge/);
  assert.deepEqual(run.log, []);
});
