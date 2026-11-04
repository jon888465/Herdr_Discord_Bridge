import test from "node:test";
import assert from "node:assert/strict";
import {
  GithubError,
  allowedMergeMethods,
  mergePullRequest,
  pullRequestMergeState,
  branchFacts,
  createPullRequest,
  findPullRequests,
  getDefaultBranch,
  getRemoteRepo,
  mergeMethod,
  parseGithubRemote,
  pullRequestChecks,
  pullRequestDiff,
  pullRequestFiles,
  pullRequestState,
  pushBranch,
  type Exec,
} from "../src/github.js";

interface Call {
  file: string;
  args: string[];
  cwd?: string;
}

function fakeExec(
  reply: (call: Call) => string | Error,
): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec = async (
    file: "git" | "gh",
    args: string[],
    options?: { cwd?: string },
  ) => {
    const call = { file, args, cwd: options?.cwd };
    calls.push(call);
    const result = reply(call);
    if (result instanceof Error) throw result;
    return { stdout: result };
  };
  return Object.assign(exec, { calls });
}

const failure = (stderr: string) =>
  Object.assign(new Error("Command failed"), { stderr, code: 1 });
const repo = { owner: "jon888465", repo: "Herdr_Discord_Bridge" };
const cat = (...parts: string[]): string => parts.join("");

test("parseGithubRemote accepts the usual github.com forms and nothing else", () => {
  for (const url of [
    "git@github.com:jon888465/Herdr_Discord_Bridge.git",
    "git@github.com:jon888465/Herdr_Discord_Bridge",
    "ssh://git@github.com/jon888465/Herdr_Discord_Bridge.git",
    "https://github.com/jon888465/Herdr_Discord_Bridge.git",
    "https://github.com/jon888465/Herdr_Discord_Bridge",
  ])
    assert.deepEqual(parseGithubRemote(url), repo, url);
  for (const url of [
    "git@gitlab.com:o/r.git",
    "https://github.com.evil.example/o/r.git",
    "https://example.com/github.com/o/r.git",
    "git@github.com:o/r/extra.git",
    "git@github.com:o r.git",
    "git@github.com:-bad/r.git",
    "https://user:pass@github.com/o/r.git",
    "file:///tmp/repo",
    "",
  ])
    assert.equal(parseGithubRemote(url), undefined, url);
});

test("getRemoteRepo reads origin of the given repository and refuses a non-GitHub remote", async () => {
  const exec = fakeExec(
    () => "git@github.com:jon888465/Herdr_Discord_Bridge.git\n",
  );
  assert.deepEqual(await getRemoteRepo(exec, "/r"), repo);
  assert.deepEqual(exec.calls, [
    {
      file: "git",
      args: ["-C", "/r", "remote", "get-url", "origin"],
      cwd: undefined,
    },
  ]);
  const other = fakeExec(() => "git@gitlab.com:o/r.git\n");
  await assert.rejects(
    getRemoteRepo(other, "/r"),
    (e: unknown) => e instanceof GithubError && e.code === "not_github",
  );
  const missing = fakeExec(() => failure("fatal: No such remote 'origin'"));
  await assert.rejects(getRemoteRepo(missing, "/r"), /origin/);
});

test("getDefaultBranch asks gh for the repository's default branch", async () => {
  const exec = fakeExec(() => "main\n");
  assert.equal(await getDefaultBranch(exec, repo), "main");
  assert.deepEqual(exec.calls[0].args, [
    "repo",
    "view",
    "jon888465/Herdr_Discord_Bridge",
    "--json",
    "defaultBranchRef",
    "-q",
    ".defaultBranchRef.name",
  ]);
  await assert.rejects(
    getDefaultBranch(
      fakeExec(() => "\n"),
      repo,
    ),
    /default branch/,
  );
});

test("branchFacts reports the head, how many commits are ahead of the base, and whether the worktree is dirty", async () => {
  const exec = fakeExec((call) => {
    const joined = call.args.join(" ");
    if (joined.includes("rev-parse"))
      return "0123456789abcdef0123456789abcdef01234567\n";
    if (joined.includes("rev-list")) return "3\n";
    if (joined.includes("status")) return " M a.txt\n";
    throw new Error(joined);
  });
  const facts = await branchFacts(exec, {
    repoPath: "/r",
    worktreePath: "/w",
    branch: "card/REQ-20261103-ab",
    baseSha: "03364e63f79f",
  });
  assert.deepEqual(facts, {
    headSha: "0123456789abcdef0123456789abcdef01234567",
    ahead: 3,
    dirty: true,
  });
  assert.deepEqual(
    exec.calls.map((c) => c.args),
    [
      ["-C", "/r", "rev-parse", "refs/heads/card/REQ-20261103-ab"],
      [
        "-C",
        "/r",
        "rev-list",
        "--count",
        "03364e63f79f..refs/heads/card/REQ-20261103-ab",
      ],
      ["-C", "/w", "status", "--porcelain"],
    ],
  );
  const clean = fakeExec((call) =>
    call.args.includes("status")
      ? ""
      : call.args.includes("rev-list")
        ? "1\n"
        : "0123456789abcdef0123456789abcdef01234567\n",
  );
  const noWorktree = await branchFacts(clean, {
    repoPath: "/r",
    branch: "card/REQ-20261103-ab",
    baseSha: "03364e6",
  });
  assert.equal(noWorktree.dirty, false);
  assert.equal(
    clean.calls.some((c) => c.args.includes("status")),
    false,
  );
});

test("branchFacts refuses a branch or base that does not look right before running anything", async () => {
  const exec = fakeExec(() => "");
  for (const patch of [
    { branch: "../x" },
    { branch: "-bad" },
    { branch: "a b" },
    { baseSha: "zz" },
    { baseSha: "--all" },
    { repoPath: "relative" },
  ])
    await assert.rejects(
      branchFacts(exec, {
        repoPath: "/r",
        branch: "card/REQ-20261103-ab",
        baseSha: "03364e63f79f",
        ...patch,
      }),
      GithubError,
      JSON.stringify(patch),
    );
  assert.equal(exec.calls.length, 0);
});

test("pushBranch pushes exactly the card branch to origin, never forced", async () => {
  const exec = fakeExec(() => "");
  await pushBranch(exec, { repoPath: "/r", branch: "card/REQ-20261103-ab" });
  assert.deepEqual(exec.calls, [
    {
      file: "git",
      args: [
        "-C",
        "/r",
        "push",
        "origin",
        "refs/heads/card/REQ-20261103-ab:refs/heads/card/REQ-20261103-ab",
      ],
      cwd: undefined,
    },
  ]);
  const flags = exec.calls[0].args.filter(
    (a) => a.startsWith("-") && a !== "-C",
  );
  assert.deepEqual(flags, []);
});

test("pushBranch only accepts card/ branches", async () => {
  const exec = fakeExec(() => "");
  for (const branch of [
    "main",
    "master",
    "feature/x",
    "card/",
    "card/../main",
    "refs/heads/main",
    "-f",
  ])
    await assert.rejects(
      pushBranch(exec, { repoPath: "/r", branch }),
      GithubError,
      branch,
    );
  assert.equal(exec.calls.length, 0);
});

test("a rejected push becomes a GithubError with the git message and without secrets", async () => {
  const token = cat("ghp_", "a".repeat(36));
  const exec = fakeExec(() =>
    failure(`! [rejected] card/x -> card/x (non-fast-forward) token ${token}`),
  );
  await assert.rejects(
    pushBranch(exec, { repoPath: "/r", branch: "card/REQ-20261103-ab" }),
    (error: unknown) =>
      error instanceof GithubError &&
      error.code === "push_failed" &&
      /non-fast-forward/.test(error.message) &&
      !error.message.includes(token),
  );
});

test("findPullRequests lists the pull requests of a head branch whatever their state", async () => {
  const exec = fakeExec(() =>
    JSON.stringify([
      {
        number: 41,
        url: "https://github.com/o/r/pull/41",
        state: "MERGED",
        headRefOid: "355561c76dfcb71db010992dde170015c7d2f92e",
      },
    ]),
  );
  const found = await findPullRequests(exec, repo, "card/REQ-20261103-ab");
  assert.deepEqual(found, [
    {
      number: 41,
      url: "https://github.com/o/r/pull/41",
      state: "MERGED",
      headSha: "355561c76dfcb71db010992dde170015c7d2f92e",
    },
  ]);
  assert.deepEqual(exec.calls[0].args, [
    "pr",
    "list",
    "--repo",
    "jon888465/Herdr_Discord_Bridge",
    "--head",
    "card/REQ-20261103-ab",
    "--state",
    "all",
    "--json",
    "number,url,state,headRefOid",
    "--limit",
    "10",
  ]);
  await assert.rejects(
    findPullRequests(
      fakeExec(() => "not json"),
      repo,
      "card/REQ-20261103-ab",
    ),
    /unexpected/,
  );
});

test("createPullRequest passes title and body as plain arguments and returns the new PR", async () => {
  const exec = fakeExec(
    () => "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42\n",
  );
  const created = await createPullRequest(exec, repo, {
    base: "main",
    head: "card/REQ-20261103-ab",
    title: "--title looks like a flag",
    body: "## 摘要\n- 卡片：REQ-20261103-ab",
  });
  assert.deepEqual(created, {
    number: 42,
    url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
  });
  assert.deepEqual(exec.calls[0].args, [
    "pr",
    "create",
    "--repo",
    "jon888465/Herdr_Discord_Bridge",
    "--base",
    "main",
    "--head",
    "card/REQ-20261103-ab",
    "--title",
    "--title looks like a flag",
    "--body",
    "## 摘要\n- 卡片：REQ-20261103-ab",
  ]);
});

test("createPullRequest refuses an unusable title, base or head and an output without a PR url", async () => {
  const ok = {
    base: "main",
    head: "card/REQ-20261103-ab",
    title: "t",
    body: "b",
  };
  const exec = fakeExec(() => "https://github.com/o/r/pull/1\n");
  for (const patch of [
    { title: "" },
    { title: "x".repeat(257) },
    { title: "line\nbreak" },
    { base: "--x" },
    { base: "a b" },
    { head: "main" },
    { body: "" },
    { body: "x".repeat(20_000) },
  ])
    await assert.rejects(
      createPullRequest(exec, repo, { ...ok, ...patch }),
      GithubError,
      JSON.stringify(patch),
    );
  assert.equal(exec.calls.length, 0);
  await assert.rejects(
    createPullRequest(
      fakeExec(() => "created something\n"),
      repo,
      ok,
    ),
    /pull request URL/,
  );
});

const check = (
  bucket: string,
  name = "ci",
  link = `https://github.com/o/r/actions/runs/${name}`,
) => ({ name, bucket, link, state: bucket.toUpperCase() });

test("pullRequestChecks summarises the checks: pending beats failure beats success", async () => {
  const table: Array<[unknown[], string]> = [
    [[check("pass", "a"), check("pass", "b")], "success"],
    [[check("pass", "a"), check("pending", "b")], "pending"],
    [[check("fail", "a"), check("pending", "b")], "pending"],
    [[check("pass", "a"), check("fail", "b")], "failure"],
    [[check("pass", "a"), check("cancel", "b")], "cancelled"],
    [[check("pass", "a"), check("skipping", "b")], "success"],
    [[check("skipping", "a")], "skipped"],
    [[], "none"],
  ];
  for (const [rows, expected] of table) {
    const exec = fakeExec(() => JSON.stringify(rows));
    const result = await pullRequestChecks(exec, repo, 42);
    assert.equal(result.conclusion, expected, JSON.stringify(rows));
  }
  const failing = await pullRequestChecks(
    fakeExec(() => JSON.stringify([check("pass", "a"), check("fail", "b")])),
    repo,
    42,
  );
  assert.equal(failing.url, "https://github.com/o/r/actions/runs/b");
});

test("pullRequestChecks treats gh's 'no checks reported' as none, and other failures as errors", async () => {
  const none = fakeExec(() =>
    failure("no checks reported on the 'card/x' branch"),
  );
  assert.equal((await pullRequestChecks(none, repo, 42)).conclusion, "none");
  const broken = fakeExec(() => failure("HTTP 502"));
  await assert.rejects(pullRequestChecks(broken, repo, 42), /502/);
  await assert.rejects(
    pullRequestChecks(
      fakeExec(() => "[]"),
      repo,
      0,
    ),
    GithubError,
  );
});

test("pullRequestState returns whether the PR is open, merged or closed", async () => {
  const merged = fakeExec(() =>
    JSON.stringify({
      state: "MERGED",
      headRefOid: "355561c76dfcb71db010992dde170015c7d2f92e",
      mergedAt: "2026-11-03T03:59:37Z",
      mergeCommit: { oid: "7a5332b51368f886e059185a41cce1351b3bc173" },
    }),
  );
  assert.deepEqual(await pullRequestState(merged, repo, 41), {
    state: "MERGED",
    headSha: "355561c76dfcb71db010992dde170015c7d2f92e",
    mergeSha: "7a5332b51368f886e059185a41cce1351b3bc173",
  });
  const open = fakeExec(() =>
    JSON.stringify({
      state: "OPEN",
      headRefOid: "355561c76dfcb71db010992dde170015c7d2f92e",
    }),
  );
  assert.equal((await pullRequestState(open, repo, 41)).state, "OPEN");
  await assert.rejects(
    pullRequestState(
      fakeExec(() => JSON.stringify({ state: "WEIRD" })),
      repo,
      41,
    ),
    /unexpected/,
  );
});

test("mergeMethod tells a merge commit, a squash merge and a rebase merge apart, and asks GitHub about exactly that commit", async () => {
  const sha = "e8f2cbeb211296cf5664491bbc0a6985c604ea43";
  const table: Array<[unknown, string]> = [
    [{ parents: 2, subject: "Merge pull request #45 from o/docs-x" }, "merge"],
    [{ parents: 1, subject: "docs: 更正 (#45)" }, "squash"],
    [{ parents: 1, subject: "docs: 更正" }, "rebase"],
    [{ parents: 1, subject: "docs: 更正 (#9)" }, "rebase"],
  ];
  for (const [reply, expected] of table) {
    const exec = fakeExec(() => JSON.stringify(reply));
    assert.equal(
      await mergeMethod(exec, repo, { number: 45, mergeSha: sha }),
      expected,
      JSON.stringify(reply),
    );
    assert.deepEqual(exec.calls[0].args.slice(0, 2), [
      "api",
      `repos/jon888465/Herdr_Discord_Bridge/commits/${sha}`,
    ]);
  }
});

test("mergeMethod refuses a bad sha or number and an unexpected answer", async () => {
  const exec = fakeExec(() => "{}");
  await assert.rejects(
    mergeMethod(exec, repo, { number: 45, mergeSha: "zz" }),
    GithubError,
  );
  await assert.rejects(
    mergeMethod(exec, repo, { number: 0, mergeSha: "a".repeat(40) }),
    GithubError,
  );
  assert.equal(exec.calls.length, 0);
  await assert.rejects(
    mergeMethod(
      fakeExec(() => "{}"),
      repo,
      { number: 45, mergeSha: "a".repeat(40) },
    ),
    /unexpected/,
  );
  await assert.rejects(
    mergeMethod(
      fakeExec(() => JSON.stringify({ parents: 0, subject: "x" })),
      repo,
      { number: 45, mergeSha: "a".repeat(40) },
    ),
    /unexpected/,
  );
});

test("pullRequestFiles lists every changed path of the PR, including where a renamed file used to live", async () => {
  const exec = fakeExec(() => "src/main.ts\n.github/workflows/ci.yml\nSPEC.md\ndocs/old.md\n");
  assert.deepEqual(await pullRequestFiles(exec, repo, 42), {
    files: ["src/main.ts", ".github/workflows/ci.yml", "SPEC.md", "docs/old.md"],
    complete: true,
  });
  const call = exec.calls[0];
  assert.equal(call.file, "gh");
  assert.deepEqual(call.args.slice(0, 2), ["api", "--paginate"]);
  assert.ok(call.args.includes("repos/jon888465/Herdr_Discord_Bridge/pulls/42/files"));
  assert.ok(call.args.some((arg) => arg.includes("previous_filename")));
});

test("pullRequestFiles says the list is incomplete when GitHub's 3000-file cap is reached", async () => {
  const many = Array.from({ length: 3000 }, (_, i) => `f${i}.ts`).join("\n");
  const result = await pullRequestFiles(fakeExec(() => many), repo, 42);
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 3000);
});

test("pullRequestFiles validates the PR number and wraps gh failures", async () => {
  await assert.rejects(pullRequestFiles(fakeExec(() => ""), repo, 0), GithubError);
  await assert.rejects(
    pullRequestFiles(fakeExec(() => failure("HTTP 404")), repo, 42),
    (error: unknown) => error instanceof GithubError && error.code === "gh_failed",
  );
});

test("pullRequestDiff reads the unified diff of one PR through gh, without colour and without writing", async () => {
  const exec = fakeExec(() => "diff --git a/x b/x\n+1\n");
  assert.equal(await pullRequestDiff(exec, repo, 42), "diff --git a/x b/x\n+1\n");
  const call = exec.calls[0];
  assert.equal(call.file, "gh");
  assert.deepEqual(call.args.slice(0, 5), ["pr", "diff", "42", "--repo", "jon888465/Herdr_Discord_Bridge"]);
  assert.ok(call.args.includes("--color=never"));
});

test("pullRequestDiff validates the PR number and wraps gh failures", async () => {
  await assert.rejects(pullRequestDiff(fakeExec(() => ""), repo, -1), GithubError);
  await assert.rejects(
    pullRequestDiff(fakeExec(() => failure("HTTP 404")), repo, 42),
    (error: unknown) => error instanceof GithubError && error.code === "gh_failed",
  );
});

const MERGE_HEAD = "0123456789abcdef0123456789abcdef01234567";

test("pullRequestMergeState reads the state, the head, the draft flag and GitHub's mergeability of one PR", async () => {
  const exec = fakeExec(() =>
    JSON.stringify({
      state: "OPEN",
      headRefOid: MERGE_HEAD,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
    }),
  );
  assert.deepEqual(await pullRequestMergeState(exec, repo, 42), {
    state: "OPEN",
    headSha: MERGE_HEAD,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    base: "main",
  });
  const call = exec.calls[0];
  assert.deepEqual(call.args.slice(0, 5), ["pr", "view", "42", "--repo", "jon888465/Herdr_Discord_Bridge"]);
  assert.ok(call.args.some((arg) => arg.includes("mergeStateStatus")));
});

test("pullRequestMergeState refuses unexpected output and validates the number", async () => {
  await assert.rejects(
    pullRequestMergeState(fakeExec(() => JSON.stringify({ state: "WEIRD" })), repo, 42),
    (error: unknown) => error instanceof GithubError && error.code === "unexpected",
  );
  await assert.rejects(pullRequestMergeState(fakeExec(() => "{}"), repo, 0), GithubError);
  await assert.rejects(
    pullRequestMergeState(fakeExec(() => failure("HTTP 404")), repo, 42),
    (error: unknown) => error instanceof GithubError && error.code === "gh_failed",
  );
});

test("allowedMergeMethods lists the merge methods the repository permits", async () => {
  const exec = fakeExec(() =>
    JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false }),
  );
  assert.deepEqual(await allowedMergeMethods(exec, repo), ["merge", "squash"]);
  assert.deepEqual(exec.calls[0].args.slice(0, 3), ["repo", "view", "jon888465/Herdr_Discord_Bridge"]);
  await assert.rejects(
    allowedMergeMethods(fakeExec(() => JSON.stringify({ squashMergeAllowed: "yes" })), repo),
    GithubError,
  );
});

test("mergePullRequest merges only the reviewed head, with the chosen method, and never forces, auto-merges or deletes the branch", async () => {
  for (const [method, flag] of [["squash", "--squash"], ["merge", "--merge"], ["rebase", "--rebase"]] as const) {
    const exec = fakeExec(() => "");
    await mergePullRequest(exec, repo, { number: 42, method, headSha: MERGE_HEAD });
    const args = exec.calls[0].args;
    assert.deepEqual(args.slice(0, 5), ["pr", "merge", "42", "--repo", "jon888465/Herdr_Discord_Bridge"], method);
    assert.ok(args.includes(flag), method);
    const at = args.indexOf("--match-head-commit");
    assert.ok(at > 0 && args[at + 1] === MERGE_HEAD, method);
    for (const forbidden of ["--admin", "--auto", "--delete-branch", "-d"])
      assert.equal(args.includes(forbidden), false, `${method} ${forbidden}`);
  }
});

test("mergePullRequest validates its input and wraps gh failures", async () => {
  const exec = fakeExec(() => "");
  await assert.rejects(mergePullRequest(exec, repo, { number: 0, method: "squash", headSha: MERGE_HEAD }), GithubError);
  await assert.rejects(mergePullRequest(exec, repo, { number: 42, method: "squash", headSha: "abc" }), /sha/);
  await assert.rejects(mergePullRequest(exec, repo, { number: 42, method: "force" as never, headSha: MERGE_HEAD }), /method/);
  assert.equal(exec.calls.length, 0);
  await assert.rejects(
    mergePullRequest(fakeExec(() => failure("Head branch was modified")), repo, { number: 42, method: "squash", headSha: MERGE_HEAD }),
    (error: unknown) => error instanceof GithubError && error.code === "gh_failed" && /modified/.test(error.message),
  );
});
