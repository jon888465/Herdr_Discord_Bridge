import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_MAX_FILE_BYTES, type Card } from "../src/card.js";
import { CardStore } from "../src/card-store.js";
import { CardPullRequestStore } from "../src/card-prs.js";
import { createCardNotifier } from "../src/card-notify.js";
import { syncPullRequests } from "../src/card-pr-sync.js";
import { attachCardPullRequest } from "../src/card-attach-pr.js";
import { mergeCardPullRequest } from "../src/card-merge-wiring.js";
import { runCardCommand, type CardCommandDeps } from "../src/card-command.js";
import { recordFindingBatch } from "../src/card-findings.js";
import type { Exec } from "../src/github.js";
import { DEFAULT_POLICY, type LoadedPolicy } from "../src/policy.js";

const ID = "REQ-20261107-attach";
const BRANCH = `card/${ID}`;
const REPO = "jon888465/Herdr_Discord_Bridge";
const URL42 = `https://github.com/${REPO}/pull/42`;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPO_PATH = "/Users/jon/git_wk/Herdr_Discord_Bridge";
const NOW = "2026-11-07T08:00:00Z";
const policyOf = (level: "L0" | "L1" | "L2"): LoadedPolicy => ({
  status: "loaded",
  file: "/cfg/policy.yml",
  policy: { default: "L0", projects: { "local:Herdr_Discord_Bridge": level } },
});
const card = (patch: Partial<Card> = {}): Card => ({
  id: ID,
  type: "requirement",
  status: "in_progress",
  title: "接手",
  version: 1,
  created: "2026-11-07",
  updated: "2026-11-07",
  body: "# 接手\n\n## 描述\n內容\n",
  ...patch,
});

// 假 GitHub：只回答讀取類呼叫；push、merge、改 PR 等其他呼叫會丟錯並留在 log。
function fakeGithub(
  view: Record<string, unknown> = {},
  remote = "git@github.com:jon888465/Herdr_Discord_Bridge.git",
) {
  const log: string[] = [];
  const exec: Exec = async (file, args) => {
    const j = args.join(" ");
    log.push(`${file} ${j}`);
    if (j.includes("remote get-url")) return { stdout: `${remote}\n` };
    if (j.startsWith("repo view")) return { stdout: "main\n" };
    if (j.startsWith("pr view"))
      return {
        stdout: JSON.stringify({
          number: 42,
          url: URL42,
          state: "OPEN",
          headRefOid: HEAD,
          headRefName: BRANCH,
          baseRefName: "main",
          isCrossRepository: false,
          ...view,
        }),
      };
    throw new Error(`unexpected ${file} ${j}`);
  };
  return { exec, log };
}
const readOnly = (log: string[]) =>
  assert.ok(
    log.every((l) => /remote get-url|^gh repo view|^gh pr view/.test(l)),
    log.join("\n"),
  );

function flow(
  o: {
    gh?: Record<string, unknown>;
    level?: "L0" | "L1";
    remote?: string;
  } = {},
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "attach-flow-"));
  const file = path.join(base, "card-prs.json");
  const prs = new CardPullRequestStore(file);
  const gh = fakeGithub(o.gh, o.remote);
  const deps = {
    exec: gh.exec,
    policy: () => policyOf(o.level ?? "L1"),
    prs,
    now: () => NOW,
  };
  const attach = (ref = "42", c = card(), busy: string[] = []) =>
    attachCardPullRequest(deps, {
      card: c,
      worktree: { repoPath: REPO_PATH },
      ref,
      busy,
    });
  return { prs, gh, attach, file };
}

test("a legal attach registers the PR by reading GitHub only; a full URL and a done card also work", async () => {
  const s = flow();
  assert.deepEqual(await s.attach("42"), {
    created: true,
    number: 42,
    url: URL42,
    headSha: HEAD,
    base: "main",
    branch: BRANCH,
    repo: REPO,
    repoPath: REPO_PATH,
  });
  assert.deepEqual(
    s.prs.forCard(ID).map((e) => [e.number, e.url, e.headSha, e.state]),
    [[42, URL42, HEAD, "OPEN"]],
  );
  readOnly(s.gh.log);
  assert.equal(
    (await flow().attach(URL42, card({ status: "done" }))).number,
    42,
  );
});

test("every refusal condition names its reason and writes nothing; all reasons are listed together", async () => {
  const fork = { isCrossRepository: true };
  const cases: Array<[Parameters<typeof flow>[0], Card, string[], RegExp]> = [
    [{}, card({ status: "draft" }), [], /draft/],
    [{}, card({ status: "ready" }), [], /ready/],
    [{}, card({ status: "cancelled" }), [], /cancelled/],
    [{}, card(), ["任務 task-1（running）還在跑"], /還在跑/],
    [{ level: "L0" }, card(), [], /L0/],
    [{ gh: { state: "CLOSED" } }, card(), [], /CLOSED/],
    [{ gh: { state: "MERGED" } }, card(), [], /MERGED/],
    [{ gh: { headRefName: "feature/other" } }, card(), [], /feature\/other/],
    [{ gh: fork }, card(), [], /fork/],
    [{ gh: { baseRefName: "release" } }, card(), [], /release/],
    [{ remote: "git@gitlab.com:o/r.git" }, card(), [], /github/i],
  ];
  for (const [o, c, busy, expected] of cases) {
    const s = flow(o);
    await assert.rejects(s.attach("42", c, busy), expected);
    assert.equal(fs.existsSync(s.file), false);
  }
  for (const ref of [
    "https://github.com/someone/else/pull/42",
    "http://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
    "0",
    "42 --admin",
  ]) {
    const s = flow();
    await assert.rejects(s.attach(ref), Error, ref);
    assert.equal(fs.existsSync(s.file), false);
  }
  const all = flow({
    level: "L0",
    gh: { state: "CLOSED", headRefName: "x/y", baseRefName: "dev", ...fork },
  });
  await assert.rejects(
    all.attach("42", card({ status: "ready" }), ["忙"]),
    (e: unknown) =>
      [/ready/, /忙/, /L0/, /CLOSED/, /x\/y/, /dev/, /fork/].every((r) =>
        r.test((e as Error).message),
      ),
  );
});

test("same PR again is idempotent; another open PR or another card's PR is refused", async () => {
  const s = flow();
  await s.attach("42");
  const before = fs.readFileSync(s.file, "utf8");
  assert.equal((await s.attach(URL42)).created, false);
  assert.equal(fs.readFileSync(s.file, "utf8"), before);
  const other = flow({ gh: { number: 43, url: `${URL42.slice(0, -2)}43` } });
  other.prs.record(
    {
      cardId: ID,
      repo: REPO,
      number: 41,
      url: `${URL42.slice(0, -2)}41`,
      headSha: HEAD,
    },
    NOW,
  );
  await assert.rejects(other.attach("43"), /#41/);
  const mine = flow();
  mine.prs.record(
    {
      cardId: "REQ-20261107-other",
      repo: REPO,
      number: 42,
      url: URL42,
      headSha: HEAD,
    },
    NOW,
  );
  await assert.rejects(mine.attach("42"), /REQ-20261107-other/);
});

function command(notify?: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "attach-command-"));
  const rootDir = path.join(base, "cards");
  const store = new CardStore(rootDir, { maxFileBytes: LEDGER_MAX_FILE_BYTES });
  const prs = new CardPullRequestStore(path.join(base, "card-prs.json"));
  const gh = fakeGithub();
  store.create(card(notify ? { notify } : {}));
  const tasks = new Map<string, string>();
  const no = async (): Promise<never> => {
    throw new Error("not expected");
  };
  const deps: CardCommandDeps = {
    rootDir,
    today: () => "2026-11-07",
    source: "console",
    attachments: [],
    download: no,
    readLocalFile: no as never,
    now: () => NOW,
    assignments: {
      record: () => undefined,
      forCard: (cardId) =>
        [...tasks.keys()].map((taskId) => ({
          taskId,
          cardId,
          type: "requirement",
          assignedAt: NOW,
        })),
    },
    taskInfo: (t) =>
      tasks.has(t)
        ? {
            originalPrompt: "",
            lead: { agent: "codex", machine: "local" },
            state: tasks.get(t)!,
          }
        : undefined,
    openPullRequest: no,
    attachPullRequest: (c, ref, busy) =>
      attachCardPullRequest(
        { exec: gh.exec, policy: () => policyOf("L1"), prs, now: () => NOW },
        { card: c, worktree: { repoPath: REPO_PATH }, ref, busy },
      ),
    policy: () => ({
      status: "missing" as const,
      policy: DEFAULT_POLICY,
      file: "/cfg/policy.yml",
    }),
    prepareWorktree: no,
    cleanupWorktree: no,
    reviewPullRequest: no,
    fixCard: no,
    mergePullRequest: no,
    waitForCi: no,
    startTask: no,
  };
  const events = () => {
    const l = store.readLog(ID);
    return l.ok ? l.entries.map((e) => [e.event, e.eventId]) : [];
  };
  return {
    rootDir,
    store,
    prs,
    gh,
    tasks,
    events,
    run: (...a: string[]) => runCardCommand(a, deps),
  };
}

test("card attach-pr registers, logs pr_opened once, keeps the card in_progress, and refuses a running task", async () => {
  const s = command();
  await assert.rejects(s.run("attach-pr", ID), /usage/);
  await assert.rejects(
    s.run("attach-pr", "REQ-20261107-nope", "42"),
    /找不到卡片/,
  );
  s.tasks.set("task-1", "running");
  await assert.rejects(s.run("attach-pr", ID, "42"), /task-1/);
  assert.deepEqual([s.prs.list(), s.events()], [[], []]);
  s.tasks.set("task-1", "failed");
  assert.ok((await s.run("attach-pr", ID, "42")).includes(URL42));
  assert.match(await s.run("attach-pr", ID, URL42), /已登記/);
  assert.deepEqual(s.events(), [["pr_opened", "pr-42-opened"]]);
  const text = (s.store.readLog(ID) as { entries: Array<{ text: string }> })
    .entries[0].text;
  assert.ok(
    text.includes(URL42) &&
      text.includes("42") &&
      text.includes(HEAD.slice(0, 12)),
    text,
  );
  const read = s.store.read(ID);
  assert.ok(
    read.ok &&
      read.card.status === "in_progress" &&
      read.card.body.includes(`- PR：${URL42}`),
  );
  readOnly(s.gh.log);
});

function passedBody(
  verdict: "pass" | "changes_requested",
  headSha = HEAD,
): string {
  const r = recordFindingBatch("# x\n\n## 描述\n內容\n", {
    round: 1,
    scope: "whole",
    headSha,
    verdict,
    findings:
      verdict === "pass"
        ? []
        : [{ severity: "high", path: "src/a.ts", summary: "壞了" }],
  });
  assert.ok(r.ok);
  return r.ok ? r.body : "";
}

test("after attach-pr the card merges only through the unchanged guards", async () => {
  const s = command();
  await s.run("attach-pr", ID, "42");
  const wiring = (
    o: {
      checks?: "success" | "failure";
      files?: string[];
      level?: "L1" | "L2";
    } = {},
  ) => {
    const merges: number[] = [];
    const worktree = {
      cardId: ID,
      workspaceId: "w7",
      sourceWorkspaceId: "w1",
      path: "/wt",
      repoPath: REPO_PATH,
      branch: BRANCH,
      createdAt: NOW,
    };
    const deps = {
      worktrees: { latest: () => worktree },
      prs: s.prs,
      policy: () => policyOf(o.level ?? "L2"),
      github: {
        mergeState: async () => ({
          state: "OPEN" as const,
          headSha: HEAD,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          base: "main",
        }),
        checks: async () => ({ conclusion: o.checks ?? "success" }) as never,
        files: async () => ({ files: o.files ?? ["src/a.ts"], complete: true }),
        allowedMethods: async () => ["squash" as const],
        merge: async (_r: unknown, i: { number: number }) => {
          merges.push(i.number);
        },
      },
    };
    return { merges, deps };
  };
  const pass = passedBody("pass");
  const ok = wiring();
  assert.equal(
    (await mergeCardPullRequest(ok.deps, card({ body: pass }), {})).pr.number,
    42,
  );
  assert.deepEqual(ok.merges, [42]);
  const refusals: Array<[Parameters<typeof wiring>[0], Partial<Card>, RegExp]> =
    [
      [{}, { body: passedBody("changes_requested") }, /review/],
      [{}, {}, /review/],
      [{}, { body: passedBody("pass", "f".repeat(40)) }, /head/],
      [{ checks: "failure" }, { body: pass }, /CI/],
      [{ files: ["AGENTS.md"] }, { body: pass }, /敏感路徑/],
      [{ level: "L1" }, { body: pass }, /L2/],
      [{}, { status: "ready", body: pass }, /done/],
      [{}, { status: "cancelled", body: pass }, /done/],
    ];
  for (const [o, patch, expected] of refusals) {
    const m = wiring(o);
    await assert.rejects(
      mergeCardPullRequest(m.deps, card(patch), {}),
      expected,
    );
    assert.deepEqual(m.merges, []);
  }
});

test("a card with notify gets pr_opened, ci_result and merged notified per ISSUE-120", async () => {
  const s = command("discord:12345");
  await s.run("attach-pr", ID, "42");
  const sent: string[] = [];
  const notifier = createCardNotifier({
    store: s.store,
    now: () => "2026-11-07T09:00:00Z",
    startedAt: "2026-11-07T00:00:00Z",
    prUrl: () => URL42,
    discord: async (thread, text) => {
      sent.push(`${thread}|${text}`);
    },
    pane: async () => undefined,
    agent: async () => undefined,
    log: () => undefined,
  });
  await notifier.tick();
  assert.match(sent[0], /^12345\|.*pr_opened.*PR 已開出/s);
  let state = "OPEN";
  const exec: Exec = async (_f, args) => {
    const j = args.join(" ");
    if (j.startsWith("pr view"))
      return {
        stdout: JSON.stringify({
          state,
          headRefOid: HEAD,
          ...(state === "MERGED"
            ? { mergeCommit: { oid: "b".repeat(40) } }
            : {}),
        }),
      };
    if (j.startsWith("pr checks"))
      return {
        stdout: JSON.stringify([
          {
            name: "ci",
            bucket: "pass",
            state: "SUCCESS",
            link: `https://github.com/${REPO}/actions/runs/1`,
          },
        ]),
      };
    if (j.startsWith("api repos/"))
      return { stdout: JSON.stringify({ parents: 1, subject: "x (#42)" }) };
    throw new Error(`unexpected ${j}`);
  };
  const sync = () =>
    syncPullRequests({
      rootDir: s.rootDir,
      prs: s.prs,
      exec,
      now: () => "2026-11-07T09:01:00Z",
    });
  assert.deepEqual(
    (await sync()).reports.map((r) => r.kind),
    ["ci"],
  );
  state = "MERGED";
  assert.deepEqual(
    (await sync()).reports.map((r) => r.kind),
    ["merged"],
  );
  await notifier.tick();
  assert.equal(sent.length, 3);
  assert.match(sent[1], /ci_result/);
  assert.match(sent[2], /merged.*PR 已合併/s);
});

test("the attach source has no push, merge, force or PR-editing call", () => {
  const text = fs.readFileSync("src/card-attach-pr.ts", "utf8");
  for (const w of [
    "pushBranch",
    "mergePullRequest",
    "createPullRequest",
    "--force",
    "pr edit",
    "pr merge",
    "pr close",
  ])
    assert.equal(text.includes(w), false, w);
});
