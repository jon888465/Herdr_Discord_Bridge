import test from "node:test";
import assert from "node:assert/strict";
import type { Card } from "../src/card.js";
import { openCardPullRequest, type PrFlowDeps } from "../src/card-pr-flow.js";
import type { CardPullRequest } from "../src/card-prs.js";
import type { Exec } from "../src/github.js";
import { DEFAULT_POLICY, type LoadedPolicy } from "../src/policy.js";

const cat = (...parts: string[]): string => parts.join("");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "card/REQ-20261103-work";

const card = (patch: Partial<Card> = {}): Card => ({
  id: "REQ-20261103-work",
  type: "requirement",
  status: "done",
  title: "加入匯出功能",
  version: 1,
  created: "2026-11-03",
  updated: "2026-11-03",
  tasks: ["task-aaa", "task-bbb"],
  body: [
    "# 加入匯出功能",
    "",
    "## 描述",
    "這是不該出現在 PR 裡的內部描述（來自 Mantis）。",
    "",
    "## 驗收條件",
    "- 不該出現在 PR 裡的驗收條件",
    "",
    "## 異動專案",
    "",
    "### local:repo",
    "",
    "- 機器：local",
    "- repo：/Users/example/git_wk/repo",
    `- 分支：${BRANCH}`,
    "- base：03364e63f79f",
    "",
  ].join("\n"),
  ...patch,
});

const worktree = {
  repoPath: "/Users/example/git_wk/repo",
  path: "/Users/example/.herdr/worktrees/repo/card-req-20261103-work",
  branch: BRANCH,
};

const policyOf = (level: "L0" | "L1" | "L2"): LoadedPolicy => ({
  status: "loaded",
  file: "/cfg/policy.yml",
  policy: { default: "L0", projects: { "local:repo": level } },
});

interface Setup {
  deps: PrFlowDeps;
  log: string[];
  recorded: Array<Omit<CardPullRequest, "openedAt" | "state">>;
  heads: string[];
}

function setup(
  options: {
    exec?: (file: string, args: string[]) => string | Error;
    policy?: LoadedPolicy;
    existing?: CardPullRequest[];
  } = {},
): Setup {
  const log: string[] = [];
  const recorded: Setup["recorded"] = [];
  const heads: string[] = [];
  const reply =
    options.exec ??
    ((file: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("remote get-url"))
        return "git@github.com:jon888465/Herdr_Discord_Bridge.git\n";
      if (joined.includes("rev-parse")) return `${HEAD}\n`;
      if (joined.includes("rev-list")) return "2\n";
      if (joined.includes("status")) return "";
      if (joined.includes("pr list")) return "[]";
      if (joined.includes("/files")) return "src/main.ts\ntest/main.test.ts\n";
      if (joined.includes("repo view")) return "main\n";
      if (joined.includes(" push ")) return "";
      if (joined.includes("pr create"))
        return "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42\n";
      throw new Error(`unexpected ${file} ${joined}`);
    });
  const exec: Exec = async (file, args) => {
    log.push(`${file} ${args.join(" ")}`);
    const result = reply(file, args);
    if (result instanceof Error) throw result;
    return { stdout: result };
  };
  return {
    deps: {
      exec,
      policy: () => options.policy ?? policyOf("L1"),
      prs: {
        forCard: () => options.existing ?? [],
        record: (entry) => recorded.push(entry),
        updateHead: (_repo, _number, sha) => heads.push(sha),
      },
      now: () => "2026-11-03T08:00:00Z",
    },
    log,
    recorded,
    heads,
  };
}

const origin = { guildId: "g", channelId: "c", threadId: "t" };

test("a done card with commits on a policy-L1 project gets its branch pushed and a PR opened, in that order", async () => {
  const { deps, log, recorded } = setup();
  const result = await openCardPullRequest(deps, {
    card: card(),
    worktree,
    origin,
  });
  assert.deepEqual(result, {
    created: true,
    number: 42,
    url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
    headSha: HEAD,
    base: "main",
    branch: BRANCH,
    repo: "jon888465/Herdr_Discord_Bridge",
    repoPath: "/Users/example/git_wk/repo",
    sensitivePaths: [],
  });
  const push = log.findIndex((line) => line.includes(" push "));
  const create = log.findIndex((line) => line.includes("pr create"));
  assert.ok(push >= 0 && create > push, log.join("\n"));
  assert.deepEqual(recorded, [
    {
      cardId: "REQ-20261103-work",
      repo: "jon888465/Herdr_Discord_Bridge",
      number: 42,
      url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
      headSha: HEAD,
      origin,
    },
  ]);
});

test("the PR title is the card title and the body holds only the card id and bridge-made facts", async () => {
  const { deps, log } = setup();
  await openCardPullRequest(deps, { card: card(), worktree });
  const create = log.find((line) => line.includes("pr create")) ?? "";
  assert.match(create, /--title 加入匯出功能/);
  assert.match(create, /REQ-20261103-work/);
  assert.match(create, /03364e63f79f/);
  assert.match(create, /012345678/);
  assert.match(create, /task-bbb/);
  assert.equal(create.includes("task-aaa"), false);
  assert.equal(create.includes("內部描述"), false);
  assert.equal(create.includes("驗收條件"), false);
  assert.equal(create.includes("Mantis"), false);
});

test("L2 projects may open PRs too", async () => {
  const { deps } = setup({ policy: policyOf("L2") });
  assert.equal(
    (await openCardPullRequest(deps, { card: card(), worktree })).created,
    true,
  );
});

test("nothing is pushed or opened when a precondition fails", async () => {
  const cases: Array<
    [
      string,
      {
        card?: Card;
        exec?: (f: string, a: string[]) => string | Error;
        policy?: LoadedPolicy;
      },
      RegExp,
    ]
  > = [
    [
      "a card that is not done",
      { card: card({ status: "in_progress" }) },
      /done/,
    ],
    [
      "no base commit on the card",
      { card: card({ body: "# t\n\n## 描述\nx\n" }) },
      /基準/,
    ],
    ["policy L0", { policy: policyOf("L0") }, /L0.*card policy|card policy/],
    [
      "a missing policy file",
      {
        policy: {
          status: "missing",
          file: "/cfg/policy.yml",
          policy: DEFAULT_POLICY,
        },
      },
      /L0/,
    ],
    [
      "an invalid policy file",
      {
        policy: {
          status: "invalid",
          file: "/cfg/policy.yml",
          policy: DEFAULT_POLICY,
          error: "line 2",
        },
      },
      /L0/,
    ],
    [
      "a remote that is not GitHub",
      {
        exec: (_f, a) =>
          a.join(" ").includes("remote get-url")
            ? "git@gitlab.com:o/r.git\n"
            : "",
      },
      /github\.com/,
    ],
    [
      "uncommitted changes",
      {
        exec: (_f, a) => {
          const j = a.join(" ");
          if (j.includes("remote get-url")) return "git@github.com:o/r.git\n";
          if (j.includes("rev-parse")) return `${HEAD}\n`;
          if (j.includes("rev-list")) return "2\n";
          if (j.includes("status")) return " M a.txt\n";
          return "";
        },
      },
      /未提交/,
    ],
    [
      "no commit ahead of the base",
      {
        exec: (_f, a) => {
          const j = a.join(" ");
          if (j.includes("remote get-url")) return "git@github.com:o/r.git\n";
          if (j.includes("rev-parse")) return `${HEAD}\n`;
          if (j.includes("rev-list")) return "0\n";
          return "";
        },
      },
      /沒有.*commit/,
    ],
  ];
  for (const [name, patch, message] of cases) {
    const { deps, log, recorded } = setup({
      exec: patch.exec,
      policy: patch.policy,
    });
    await assert.rejects(
      openCardPullRequest(deps, { card: patch.card ?? card(), worktree }),
      message,
      name,
    );
    assert.equal(
      log.some((l) => l.includes(" push ")),
      false,
      name,
    );
    assert.equal(
      log.some((l) => l.includes("pr create")),
      false,
      name,
    );
    assert.deepEqual(recorded, [], name);
  }
});

test("a card title that looks like a secret is refused before anything is pushed", async () => {
  const { deps, log } = setup();
  await assert.rejects(
    openCardPullRequest(deps, {
      card: card({ title: `連線 token=${cat("ghp_", "a".repeat(36))}` }),
      worktree,
    }),
    /標題/,
  );
  assert.equal(
    log.some((l) => l.includes(" push ")),
    false,
  );
});

const existing = (state: CardPullRequest["state"]): CardPullRequest => ({
  cardId: "REQ-20261103-work",
  repo: "jon888465/Herdr_Discord_Bridge",
  number: 41,
  url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/41",
  headSha: "a".repeat(40),
  openedAt: "2026-11-03T07:00:00Z",
  state,
});

function prListReply(state: string, head = "b".repeat(40)) {
  return (file: string, args: string[]) => {
    const j = args.join(" ");
    if (j.includes("remote get-url"))
      return "git@github.com:jon888465/Herdr_Discord_Bridge.git\n";
    if (j.includes("rev-parse")) return `${HEAD}\n`;
    if (j.includes("rev-list")) return "2\n";
    if (j.includes("status")) return "";
    if (j.includes("pr list"))
      return JSON.stringify([
        {
          number: 41,
          url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/41",
          state,
          headRefOid: head,
        },
      ]);
    if (j.includes(" push ")) return "";
    throw new Error(`unexpected ${file} ${j}`);
  };
}

test("an open PR for the branch is updated by pushing, not duplicated", async () => {
  const { deps, log, recorded, heads } = setup({
    exec: prListReply("OPEN"),
    existing: [existing("OPEN")],
  });
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.equal(result.created, false);
  assert.equal(result.number, 41);
  assert.equal(
    log.some((l) => l.includes("pr create")),
    false,
  );
  assert.ok(log.some((l) => l.includes(" push ")));
  assert.deepEqual(recorded, []);
  assert.deepEqual(heads, [HEAD]);
});

test("an open PR on GitHub that the bridge never tracked is adopted without opening another", async () => {
  const { deps, recorded } = setup({ exec: prListReply("OPEN"), existing: [] });
  const result = await openCardPullRequest(deps, {
    card: card(),
    worktree,
    origin,
  });
  assert.equal(result.created, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].number, 41);
});

test("a merged or closed PR for the branch is not reopened or duplicated", async () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const { deps, log } = setup({ exec: prListReply(state) });
    await assert.rejects(
      openCardPullRequest(deps, { card: card(), worktree }),
      /已經?(merge|關閉)|#41/,
      state,
    );
    assert.equal(
      log.some((l) => l.includes(" push ")),
      false,
      state,
    );
    assert.equal(
      log.some((l) => l.includes("pr create")),
      false,
      state,
    );
  }
});

test("a rejected push stops before opening a PR, and a failed create after a push says the push is done", async () => {
  const base = (file: string, args: string[]): string | Error => {
    const j = args.join(" ");
    if (j.includes("remote get-url"))
      return "git@github.com:jon888465/Herdr_Discord_Bridge.git\n";
    if (j.includes("rev-parse")) return `${HEAD}\n`;
    if (j.includes("rev-list")) return "2\n";
    if (j.includes("status")) return "";
    if (j.includes("pr list")) return "[]";
    if (j.includes("repo view")) return "main\n";
    return new Error(`unexpected ${file} ${j}`);
  };
  const pushRejected = setup({
    exec: (file, args) =>
      args.join(" ").includes(" push ")
        ? Object.assign(new Error("x"), {
            stderr: "! [rejected] card/x -> card/x (non-fast-forward)",
          })
        : base(file, args),
  });
  await assert.rejects(
    openCardPullRequest(pushRejected.deps, { card: card(), worktree }),
    /non-fast-forward/,
  );
  assert.equal(
    pushRejected.log.some((l) => l.includes("pr create")),
    false,
  );
  assert.deepEqual(pushRejected.recorded, []);

  const createFails = setup({
    exec: (file, args) => {
      const j = args.join(" ");
      if (j.includes(" push ")) return "";
      if (j.includes("pr create"))
        return Object.assign(new Error("x"), {
          stderr: "GraphQL: rate limited",
        });
      return base(file, args);
    },
  });
  await assert.rejects(
    openCardPullRequest(createFails.deps, { card: card(), worktree }),
    /已 push.*rate limited|rate limited.*已 push/s,
  );
  assert.deepEqual(createFails.recorded, []);
});

test("without a worktree path the dirty check is skipped and the repository is used for the branch", async () => {
  const { deps, log } = setup();
  await openCardPullRequest(deps, {
    card: card(),
    worktree: { repoPath: worktree.repoPath, branch: BRANCH },
  });
  assert.equal(
    log.some((l) => l.includes("status")),
    false,
  );
  assert.ok(log.some((l) => l.includes(`-C ${worktree.repoPath} push`)));
});

test("the PR body lists only the latest task, not earlier failed or stuck attempts (ISSUE-068)", async () => {
  const { deps, log } = setup();
  await openCardPullRequest(deps, {
    card: card({ tasks: ["task-old", "task-stuck", "task-final"] }),
    worktree,
  });
  const create = log.find((line) => line.includes("pr create")) ?? "";
  assert.match(create, /task-final/);
  assert.equal(create.includes("task-old"), false);
  assert.equal(create.includes("task-stuck"), false);
});

test("the PR body has no task line when the card has no task", async () => {
  const { deps, log } = setup();
  await openCardPullRequest(deps, { card: card({ tasks: [] }), worktree });
  const create = log.find((line) => line.includes("pr create")) ?? "";
  assert.equal(create.includes("- task："), false);
});

const withFiles = (files: string | Error) =>
  setup({
    exec: (file, args) => {
      const joined = args.join(" ");
      if (joined.includes("/files")) return files;
      if (joined.includes("remote get-url"))
        return "git@github.com:jon888465/Herdr_Discord_Bridge.git\n";
      if (joined.includes("rev-parse")) return `${HEAD}\n`;
      if (joined.includes("rev-list")) return "2\n";
      if (joined.includes("status")) return "";
      if (joined.includes("pr list")) return "[]";
      if (joined.includes("repo view")) return "main\n";
      if (joined.includes(" push ")) return "";
      if (joined.includes("pr create"))
        return "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42\n";
      throw new Error(`unexpected ${file} ${joined}`);
    },
  });

test("the outcome lists the sensitive paths the PR touches, after the PR exists (F6)", async () => {
  const { deps, log } = withFiles(
    "src/main.ts\n.github/workflows/ci.yml\nAGENTS.md\n",
  );
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.deepEqual(result.sensitivePaths, [
    ".github/workflows/ci.yml",
    "AGENTS.md",
  ]);
  const create = log.findIndex((line) => line.includes("pr create"));
  const files = log.findIndex((line) => line.includes("/files"));
  assert.ok(create >= 0 && files > create, log.join("\n"));
  assert.ok(log.some((line) => line.includes("pulls/42/files")));
});

test("a PR that only touches ordinary files reports an empty sensitive list", async () => {
  const { deps } = withFiles("src/main.ts\ndocs/x.md\n");
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.deepEqual(result.sensitivePaths, []);
});

test("when the file list cannot be read the PR is still opened and recorded, and the sensitivity is unknown (null)", async () => {
  const { deps, recorded } = withFiles(new Error("HTTP 502"));
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.equal(result.sensitivePaths, null);
  assert.equal(result.number, 42);
  assert.equal(recorded.length, 1);
});

test("an incomplete file list (GitHub's cap) is treated as unknown, not as clean", async () => {
  const many = Array.from({ length: 3000 }, (_, i) => `f${i}.ts`).join("\n");
  const { deps } = withFiles(many);
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.equal(result.sensitivePaths, null);
});

test("pushing more commits to an existing PR checks its files again", async () => {
  const { deps, log } = setup({
    exec: (file, args) => {
      const joined = args.join(" ");
      if (joined.includes("/files")) return "package.json\n";
      if (joined.includes("remote get-url"))
        return "git@github.com:jon888465/Herdr_Discord_Bridge.git\n";
      if (joined.includes("rev-parse")) return `${HEAD}\n`;
      if (joined.includes("rev-list")) return "2\n";
      if (joined.includes("status")) return "";
      if (joined.includes("pr list"))
        return JSON.stringify([
          {
            number: 7,
            url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/7",
            state: "OPEN",
            headRefOid: HEAD,
          },
        ]);
      if (joined.includes(" push ")) return "";
      throw new Error(`unexpected ${file} ${joined}`);
    },
  });
  const result = await openCardPullRequest(deps, { card: card(), worktree });
  assert.equal(result.created, false);
  assert.deepEqual(result.sensitivePaths, ["package.json"]);
  assert.ok(log.some((line) => line.includes("pulls/7/files")));
});

// ISSUE-123：`card attach-pr` 接手的 in_progress 卡片只能更新 GitHub 上仍開著的 PR，不能因此開新的 PR。
const takeover = { status: "in_progress" } as const;

test("an in_progress card with no registered PR cannot open one", async () => {
  const { deps, log } = setup();
  await assert.rejects(
    openCardPullRequest(deps, { card: card(takeover), worktree }),
    /done/,
  );
  assert.equal(
    log.some((l) => l.includes(" push ") || l.includes("pr create")),
    false,
  );
});

test("an in_progress card whose registered PR is closed cannot open or push", async () => {
  const { deps, log } = setup({ existing: [existing("CLOSED")] });
  await assert.rejects(
    openCardPullRequest(deps, { card: card(takeover), worktree }),
    /done/,
  );
  assert.equal(
    log.some((l) => l.includes(" push ") || l.includes("pr create")),
    false,
  );
});

test("an in_progress card with a registered open PR that GitHub no longer shows as open opens nothing and pushes nothing", async () => {
  // 登記資料過期（GitHub 上的 PR 已不存在）：不能因此走到「開新 PR」。
  const { deps, log } = setup({ existing: [existing("OPEN")] });
  await assert.rejects(
    openCardPullRequest(deps, { card: card(takeover), worktree }),
    /沒有這個分支開著的 PR/,
  );
  assert.equal(
    log.some((l) => l.includes(" push ") || l.includes("pr create")),
    false,
  );
});

test("an in_progress card with a registered open PR that is open on GitHub is updated by pushing, never duplicated", async () => {
  const { deps, log, recorded, heads } = setup({
    exec: prListReply("OPEN"),
    existing: [existing("OPEN")],
  });
  const result = await openCardPullRequest(deps, {
    card: card(takeover),
    worktree,
  });
  assert.equal(result.created, false);
  assert.equal(
    log.some((l) => l.includes("pr create")),
    false,
  );
  assert.ok(log.some((l) => l.includes(" push ")));
  assert.deepEqual(recorded, []);
  assert.deepEqual(heads, [HEAD]);
});
