import test from "node:test";
import assert from "node:assert/strict";
import { GithubError, type Exec } from "../src/github.js";
import { fetchReviewMaterial } from "../src/card-review-fetch.js";
import { MAX_REVIEW_DIFF_CHARS, MAX_REVIEW_FILES } from "../src/card-review.js";

const repo = { owner: "jon888465", repo: "Herdr_Discord_Bridge" };
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const diffOf = (...paths: string[]): string =>
  paths
    .map(
      (file) =>
        `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`,
    )
    .join("");

interface Plan {
  state?: string;
  heads?: string[];
  files?: string;
  diff?: string | Error;
  filesError?: Error;
}

function fake(plan: Plan = {}) {
  const calls: string[] = [];
  const heads = [...(plan.heads ?? [HEAD, HEAD])];
  const exec: Exec = async (file, args) => {
    const joined = `${file} ${args.join(" ")}`;
    calls.push(joined);
    if (joined.startsWith("gh pr view"))
      return {
        stdout: JSON.stringify({
          state: plan.state ?? "OPEN",
          headRefOid: heads.shift() ?? HEAD,
        }),
      };
    if (joined.includes("/files")) {
      if (plan.filesError) throw plan.filesError;
      return { stdout: plan.files ?? "src/a.ts\ntest/a.test.ts\n" };
    }
    if (joined.startsWith("gh pr diff")) {
      if (plan.diff instanceof Error) throw plan.diff;
      return { stdout: plan.diff ?? diffOf("src/a.ts", "test/a.test.ts") };
    }
    throw new Error(`unexpected ${joined}`);
  };
  return { exec, calls };
}

async function refused(plan: Plan, reason: RegExp, label = "") {
  const { exec } = fake(plan);
  await assert.rejects(
    fetchReviewMaterial(exec, repo, 42),
    (error: unknown) =>
      error instanceof GithubError &&
      error.code === "invalid" &&
      reason.test(error.message),
    label,
  );
}

test("it returns the head sha, the changed files and the diff of an open PR, reading the head before and after", async () => {
  const { exec, calls } = fake();
  const material = await fetchReviewMaterial(exec, repo, 42);
  assert.equal(material.headSha, HEAD);
  assert.deepEqual(material.files, ["src/a.ts", "test/a.test.ts"]);
  assert.match(material.diff, /^diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  const order = calls.map((call) =>
    call.startsWith("gh pr view")
      ? "view"
      : call.includes("/files")
        ? "files"
        : "diff",
  );
  assert.deepEqual(order, ["view", "files", "diff", "view"]);
});

test("every call is read-only and targets the one PR", async () => {
  const { exec, calls } = fake();
  await fetchReviewMaterial(exec, repo, 42);
  for (const call of calls) {
    assert.match(call, /^gh (pr view|pr diff|api --paginate) /, call);
    assert.ok(call.includes("jon888465/Herdr_Discord_Bridge"), call);
    assert.equal(/ (-X|--method|--input|-f|-F|--field)\b/.test(call), false, call);
  }
});

test("a PR that is not open is refused", async () => {
  await refused({ state: "MERGED" }, /已 merge|已關閉|不是開著/);
  await refused({ state: "CLOSED" }, /已 merge|已關閉|不是開著/);
});

test("a head that moved while reading is refused so the review always matches one head sha", async () => {
  await refused({ heads: [HEAD, OTHER] }, /新的 commit|重新/);
});

test("too many files are refused before the diff is fetched, and the reason says to split the work", async () => {
  const files = Array.from({ length: MAX_REVIEW_FILES + 1 }, (_, i) => `src/f${i}.ts`);
  const { exec, calls } = fake({ files: `${files.join("\n")}\n` });
  await assert.rejects(
    fetchReviewMaterial(exec, repo, 42),
    (error: unknown) => error instanceof GithubError && /切分/.test(error.message),
  );
  assert.equal(calls.some((call) => call.startsWith("gh pr diff")), false);
});

test("a diff over the size limit or over gh's output buffer is refused as too large", async () => {
  await refused({ diff: `${diffOf("src/a.ts", "test/a.test.ts")}${"+x\n".repeat(MAX_REVIEW_DIFF_CHARS)}` }, /切分/, "over the limit");
  await refused(
    { diff: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) },
    /切分/,
    "maxBuffer",
  );
});

test("an empty diff or no files is refused", async () => {
  await refused({ diff: "" }, /diff/, "empty diff");
  await refused({ files: "", diff: "" }, /檔案|diff/, "no files");
});

test("a diff that does not list exactly the PR's files is refused, naming the difference", async () => {
  await refused({ diff: diffOf("src/a.ts") }, /test\/a\.test\.ts/, "diff is missing a file");
  await refused({ diff: diffOf("src/a.ts", "test/a.test.ts", "src/extra.ts") }, /src\/extra\.ts/, "diff has an extra file");
});

test("a renamed file counts under both its old and new path", async () => {
  const diff =
    "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\nindex 1..2 100644\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n" +
    diffOf("test/a.test.ts");
  const { exec } = fake({ files: "src/new.ts\nsrc/old.ts\ntest/a.test.ts\n", diff });
  const material = await fetchReviewMaterial(exec, repo, 42);
  assert.deepEqual(material.files, ["src/new.ts", "src/old.ts", "test/a.test.ts"]);
});

test("a diff header that cannot be read is refused instead of guessed", async () => {
  await refused(
    { diff: 'diff --git "a/src/a b.ts" "b/src/a b.ts"\n--- a\n+++ b\n' },
    /標頭|無法解析/,
  );
});

test("a failing gh call is passed through as a GithubError", async () => {
  const { exec } = fake({ filesError: Object.assign(new Error("boom"), { stderr: "HTTP 404" }) });
  await assert.rejects(
    fetchReviewMaterial(exec, repo, 42),
    (error: unknown) => error instanceof GithubError && error.code === "gh_failed",
  );
});

test("the PR number is validated", async () => {
  const { exec } = fake();
  await assert.rejects(fetchReviewMaterial(exec, repo, 0), GithubError);
});
