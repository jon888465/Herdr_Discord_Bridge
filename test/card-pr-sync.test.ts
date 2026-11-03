import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { CardStore } from "../src/card-store.js";
import { CardPullRequestStore } from "../src/card-prs.js";
import { syncPullRequests } from "../src/card-pr-sync.js";
import type { Exec } from "../src/github.js";

const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const REPO = "jon888465/Herdr_Discord_Bridge";
const URL42 = `https://github.com/${REPO}/pull/42`;
const ID = "REQ-20261103-work";
const origin = { guildId: "g", channelId: "c", threadId: "t" };

function setup(
  state: { value: string; head: string; mergeSha?: string },
  checks: { rows: unknown; error?: Error },
  merge: { commit?: unknown; error?: Error } = {
    commit: { parents: 2, subject: "Merge pull request #42 from o/b" },
  },
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "card-pr-sync-"));
  const rootDir = path.join(base, "cards");
  const cards = new CardStore(rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const card: Card = {
    id: ID,
    type: "requirement",
    status: "done",
    title: "t",
    version: 1,
    created: "2026-11-03",
    updated: "2026-11-03",
    body: "# t\n\n## 描述\nx\n",
  };
  cards.create(card);
  const prs = new CardPullRequestStore(path.join(base, "card-prs.json"));
  prs.record(
    { cardId: ID, repo: REPO, number: 42, url: URL42, headSha: HEAD1, origin },
    "2026-11-03T08:00:00Z",
  );
  const calls: string[] = [];
  const exec: Exec = async (_file, args) => {
    const joined = args.join(" ");
    calls.push(joined);
    if (joined.startsWith("pr view"))
      return {
        stdout: JSON.stringify({
          state: state.value,
          headRefOid: state.head,
          ...(state.mergeSha ? { mergeCommit: { oid: state.mergeSha } } : {}),
        }),
      };
    if (joined.startsWith("api repos/")) {
      if (merge.error) throw merge.error;
      return { stdout: JSON.stringify(merge.commit) };
    }
    if (joined.startsWith("pr checks")) {
      if (checks.error) throw checks.error;
      return { stdout: JSON.stringify(checks.rows) };
    }
    throw new Error(`unexpected ${joined}`);
  };
  const run = (onMerged?: Parameters<typeof syncPullRequests>[0]["onMerged"]) =>
    syncPullRequests({
      rootDir,
      prs,
      exec,
      now: () => "2026-11-03T09:00:00Z",
      ...(onMerged ? { onMerged } : {}),
    });
  return { rootDir, cards, prs, calls, run };
}

const row = (bucket: string, name = "ci") => ({
  name,
  bucket,
  state: bucket.toUpperCase(),
  link: `https://github.com/${REPO}/actions/runs/${name}`,
});

function eventsOf(cards: CardStore) {
  const log = cards.readLog(ID);
  return log.ok ? log.entries.map((e) => [e.event, e.text, e.eventId]) : [];
}

test("a finished green CI is logged on the card, reported once, and not reported again for the same head", async () => {
  const s = setup(
    { value: "OPEN", head: HEAD1 },
    { rows: [row("pass", "a"), row("pass", "b")] },
  );
  const first = await s.run();
  assert.deepEqual(
    first.reports.map((r) => [r.kind, r.cardId, r.number]),
    [["ci", ID, 42]],
  );
  assert.match(first.reports[0].text, /CI 通過/);
  assert.match(first.reports[0].text, new RegExp(URL42.replace(/\//g, "\\/")));
  assert.deepEqual(first.reports[0].origin, origin);
  assert.deepEqual(eventsOf(s.cards), [
    [
      "ci_result",
      `CI success https://github.com/${REPO}/actions/runs/a`,
      "ci-42-aaaaaaaaaaaa",
    ],
  ]);
  const again = await s.run();
  assert.deepEqual(again.reports, []);
  assert.equal(eventsOf(s.cards).length, 1);
});

test("a failing CI is reported with the failing check's link", async () => {
  const s = setup(
    { value: "OPEN", head: HEAD1 },
    { rows: [row("pass", "a"), row("fail", "b")] },
  );
  const result = await s.run();
  assert.match(result.reports[0].text, /CI 失敗/);
  assert.match(result.reports[0].text, /actions\/runs\/b/);
  assert.equal(eventsOf(s.cards)[0][0], "ci_result");
  assert.match(String(eventsOf(s.cards)[0][1]), /^CI failure /);
});

test("a pending CI or no CI yet reports nothing and keeps polling", async () => {
  for (const rows of [[row("pass", "a"), row("pending", "b")], []]) {
    const s = setup({ value: "OPEN", head: HEAD1 }, { rows });
    const result = await s.run();
    assert.deepEqual(result.reports, []);
    assert.deepEqual(eventsOf(s.cards), []);
    assert.equal(s.prs.open().length, 1);
  }
});

test("a new head after another push makes the CI result be reported again", async () => {
  const s = setup({ value: "OPEN", head: HEAD1 }, { rows: [row("pass")] });
  await s.run();
  const moved = setup({ value: "OPEN", head: HEAD2 }, { rows: [row("pass")] });
  await moved.run();
  const again = await moved.run();
  assert.deepEqual(again.reports, []);
  assert.equal(moved.prs.open()[0].headSha, HEAD2);
  assert.equal(moved.prs.open()[0].ciReportedSha, HEAD2);
  assert.equal(eventsOf(moved.cards)[0][2], "ci-42-bbbbbbbbbbbb");
});

test("a merged PR is reported once with the hint to clean up, marked ended, and no longer polled", async () => {
  const s = setup(
    { value: "MERGED", head: HEAD1, mergeSha: "c".repeat(40) },
    { rows: [] },
  );
  const result = await s.run();
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["merged"],
  );
  assert.match(result.reports[0].text, /已 merge/);
  assert.match(result.reports[0].text, new RegExp(`card cleanup ${ID}`));
  assert.deepEqual(s.prs.open(), []);
  assert.equal(s.prs.list()[0].state, "MERGED");
  assert.deepEqual((await s.run()).reports, []);
  assert.equal(s.calls.filter((c) => c.startsWith("pr checks")).length, 0);
});

test("a closed PR is reported as closed without merging", async () => {
  const s = setup({ value: "CLOSED", head: HEAD1 }, { rows: [] });
  const result = await s.run();
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["closed"],
  );
  assert.match(result.reports[0].text, /已關閉/);
  assert.equal(s.prs.list()[0].state, "CLOSED");
});

test("when GitHub cannot be reached the PR stays open, the problem is reported, and nothing is written", async () => {
  const s = setup(
    { value: "OPEN", head: HEAD1 },
    { rows: [], error: Object.assign(new Error("x"), { stderr: "HTTP 502" }) },
  );
  const result = await s.run();
  assert.deepEqual(result.reports, []);
  assert.match(result.problems.join("\n"), /#42.*502|502/);
  assert.equal(s.prs.open().length, 1);
  assert.deepEqual(eventsOf(s.cards), []);
});

test("a deleted card does not stop the report, and a failed card write does not lose the CI report", async () => {
  const s = setup({ value: "OPEN", head: HEAD1 }, { rows: [row("pass")] });
  fs.rmSync(path.join(s.rootDir, `${ID}.md`));
  const result = await s.run();
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["ci"],
  );
  assert.equal(s.prs.open()[0].ciReportedSha, HEAD1);
});

test("with no open PRs nothing runs", async () => {
  const s = setup({ value: "OPEN", head: HEAD1 }, { rows: [] });
  s.prs.markEnded(REPO, 42, "CLOSED", "2026-11-03T08:30:00Z");
  const result = await s.run();
  assert.deepEqual(result, { reports: [], problems: [] });
  assert.deepEqual(s.calls, []);
});

test("a merged PR is logged on the card as merged, with the merge commit and the method GitHub used", async () => {
  const merge = "c".repeat(40);
  for (const [commit, method] of [
    [{ parents: 2, subject: "Merge pull request #42 from o/b" }, "merge"],
    [{ parents: 1, subject: "t (#42)" }, "squash"],
    [{ parents: 1, subject: "t" }, "rebase"],
  ] as const) {
    const s = setup(
      { value: "MERGED", head: HEAD1, mergeSha: merge },
      { rows: [] },
      { commit },
    );
    const result = await s.run();
    assert.deepEqual(eventsOf(s.cards), [
      ["merged", `已合併 ${"c".repeat(12)}（${method}）`, "pr-42-merged"],
    ]);
    assert.match(result.reports[0].text, new RegExp(`已 merge（${method}）`));
  }
});

test("the cleanup hook's outcome is added to the merge report, and replaces the manual cleanup hint", async () => {
  const s = setup(
    { value: "MERGED", head: HEAD1, mergeSha: "c".repeat(40) },
    { rows: [] },
  );
  const seen: string[] = [];
  const result = await s.run(async (pr) => {
    seen.push(`${pr.cardId}#${pr.number}`);
    return "已自動清理 worktree（分支保留）。";
  });
  assert.deepEqual(seen, [`${ID}#42`]);
  assert.match(result.reports[0].text, /已自動清理 worktree/);
  assert.equal(result.reports[0].text.includes("card cleanup"), false);
});

test("a cleanup hook that fails does not lose the merge report, and tells the user to clean up by hand", async () => {
  const s = setup(
    { value: "MERGED", head: HEAD1, mergeSha: "c".repeat(40) },
    { rows: [] },
  );
  const result = await s.run(async () => {
    throw new Error("herdr unreachable");
  });
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["merged"],
  );
  assert.match(result.reports[0].text, /自動清理失敗.*herdr unreachable/);
  assert.match(result.reports[0].text, new RegExp(`card cleanup ${ID}`));
  assert.deepEqual(s.prs.open(), []);
});

test("if the merge method cannot be determined the PR is still reported and ended, the event is skipped and the problem is reported", async () => {
  const s = setup(
    { value: "MERGED", head: HEAD1, mergeSha: "c".repeat(40) },
    { rows: [] },
    { error: Object.assign(new Error("x"), { stderr: "HTTP 502" }) },
  );
  const result = await s.run();
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["merged"],
  );
  assert.match(result.problems.join("\n"), /502/);
  assert.deepEqual(eventsOf(s.cards), []);
  assert.deepEqual(s.prs.open(), []);
});

test("a closed PR gets no merged event and no cleanup", async () => {
  const s = setup({ value: "CLOSED", head: HEAD1 }, { rows: [] });
  let hooked = 0;
  const result = await s.run(async () => {
    hooked += 1;
    return "x";
  });
  assert.deepEqual(
    result.reports.map((r) => r.kind),
    ["closed"],
  );
  assert.equal(hooked, 0);
  assert.deepEqual(eventsOf(s.cards), []);
});
