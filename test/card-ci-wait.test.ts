import test from "node:test";
import assert from "node:assert/strict";
import { waitForChecks } from "../src/card-ci-wait.js";
import type { ChecksConclusion } from "../src/github.js";

function setup(
  conclusions: Array<ChecksConclusion | Error>,
  options: { timeoutMs?: number; stopAfterSleeps?: number } = {},
) {
  const plans = [...conclusions];
  const sleeps: number[] = [];
  let now = 0;
  const wait = () =>
    waitForChecks({
      read: async () => {
        const next = plans.shift();
        if (next === undefined) throw new Error("no more plans");
        if (next instanceof Error) throw next;
        return { conclusion: next };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
      intervalMs: 10_000,
      timeoutMs: options.timeoutMs ?? 60_000,
      stopRequested: () =>
        options.stopAfterSleeps !== undefined &&
        sleeps.length >= options.stopAfterSleeps,
    });
  return { wait, sleeps };
}

test("checks that are already green return at once without sleeping", async () => {
  const { wait, sleeps } = setup(["success"]);
  assert.equal((await wait()).state, "success");
  assert.deepEqual(sleeps, []);
});

test("pending checks are polled until they turn green", async () => {
  const { wait, sleeps } = setup(["pending", "pending", "success"]);
  assert.equal((await wait()).state, "success");
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test("checks that have not been registered yet (none) count as still waiting", async () => {
  const { wait } = setup(["none", "pending", "success"]);
  assert.equal((await wait()).state, "success");
});

test("a failed, cancelled or all-skipped result ends the wait as failure and names it", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped"] as const) {
    const { wait } = setup(["pending", conclusion]);
    const result = await wait();
    assert.equal(result.state, "failure");
    assert.match(result.text, new RegExp(conclusion));
  }
});

test("checks that never finish end as a timeout after the limit, not forever", async () => {
  const { wait, sleeps } = setup(Array(20).fill("pending"), { timeoutMs: 30_000 });
  const result = await wait();
  assert.equal(result.state, "timeout");
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
});

test("a stop request between polls ends the wait as cancelled", async () => {
  const { wait } = setup(["pending", "pending", "success"], { stopAfterSleeps: 1 });
  assert.equal((await wait()).state, "cancelled");
});

test("a transient read error is retried; repeated errors surface instead of waiting forever", async () => {
  const flaky = setup([new Error("gh blip"), "success"]);
  assert.equal((await flaky.wait()).state, "success");

  const broken = setup([
    new Error("gh down"),
    new Error("gh down"),
    new Error("gh down"),
    "success",
  ]);
  await assert.rejects(broken.wait(), /gh down/);
});
