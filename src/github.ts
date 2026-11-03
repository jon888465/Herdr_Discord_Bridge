// GitHub／git 轉接層（追蹤清單 F3）：push 卡片分支、開 PR、查 PR 與 CI。
//
// 這是 bridge 第一次對外 push，所以刻意很窄：
// - 只能 push `card/<…>` 分支到 `origin`，用明確的 refspec，**永不強制、不帶任何旗標**；
// - 只做 gh 的 pr list／create／checks／view 與 repo view，不 merge、不改設定；
// - 所有輸入送出前驗證；外部程式一律用參數陣列（不經 shell）；
// - 錯誤訊息先遮蔽機敏資料再截斷。
// 憑證用使用者現有的 `gh`／ssh 登入（使用者 2026-11-03 決定，L2 前必須改成獨立身分）。

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "./redact.js";

export type Exec = (
  file: "git" | "gh",
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string }>;

export type GithubErrorCode =
  | "invalid"
  | "not_github"
  | "git_failed"
  | "push_failed"
  | "gh_failed"
  | "unexpected";

export class GithubError extends Error {
  constructor(
    public readonly code: GithubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 60_000;

/** 真正執行外部程式：不經 shell、不互動、逾時 60 秒。 */
export const defaultExec: Exec = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    cwd: options?.cwd,
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    },
  });
  return { stdout: String(stdout) };
};

const CONTROL = /[\u0000-\u001F\u007F]/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const CARD_BRANCH = /^card\/[A-Za-z0-9][A-Za-z0-9._-]{0,69}$/;
const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_TITLE = 256;
const MAX_BODY = 10_000;

export interface GithubRepo {
  owner: string;
  repo: string;
}

const slug = (repo: GithubRepo): string => `${repo.owner}/${repo.repo}`;

function failureText(error: unknown): string {
  const record = (error ?? {}) as { stderr?: unknown; message?: unknown };
  const raw =
    typeof record.stderr === "string" && record.stderr.trim()
      ? record.stderr
      : typeof record.message === "string"
        ? record.message
        : "unknown error";
  return redactSecrets(raw.trim()).slice(0, 300);
}

async function run(
  exec: Exec,
  file: "git" | "gh",
  args: string[],
  code: GithubErrorCode,
): Promise<string> {
  try {
    return (await exec(file, args)).stdout;
  } catch (error) {
    throw new GithubError(
      code,
      `${file} ${args[0] === "-C" ? args[2] : args[0]} failed: ${failureText(error)}`,
    );
  }
}

function assertCardBranch(branch: string): void {
  if (
    !CARD_BRANCH.test(branch) ||
    branch.includes("..") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  )
    throw new GithubError(
      "invalid",
      `only card/<id> branches are allowed, got "${branch}"`,
    );
}

function assertAbsolute(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    CONTROL.test(value) ||
    value.length > 1024
  )
    throw new GithubError("invalid", `${label} must be an absolute path`);
}

function assertNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 9_999_999)
    throw new GithubError("invalid", "invalid pull request number");
}

/** `git@github.com:o/r.git`、`ssh://git@github.com/o/r.git`、`https://github.com/o/r(.git)`；其他一律 undefined。 */
export function parseGithubRemote(url: string): GithubRepo | undefined {
  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match && OWNER.test(match[1]) && REPO_NAME.test(match[2]))
      return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

export async function getRemoteRepo(
  exec: Exec,
  repoPath: string,
): Promise<GithubRepo> {
  assertAbsolute(repoPath, "repository path");
  const url = (
    await run(
      exec,
      "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      "git_failed",
    )
  ).trim();
  const parsed = parseGithubRemote(url);
  if (!parsed)
    throw new GithubError("not_github", "origin is not a github.com remote");
  return parsed;
}

export async function getDefaultBranch(
  exec: Exec,
  repo: GithubRepo,
): Promise<string> {
  const out = (
    await run(
      exec,
      "gh",
      [
        "repo",
        "view",
        slug(repo),
        "--json",
        "defaultBranchRef",
        "-q",
        ".defaultBranchRef.name",
      ],
      "gh_failed",
    )
  ).trim();
  if (!BASE_BRANCH.test(out) || out.includes(".."))
    throw new GithubError(
      "unexpected",
      "could not determine the default branch",
    );
  return out;
}

export interface BranchFacts {
  headSha: string;
  /** 比基準多幾個 commit。 */
  ahead: number;
  /** worktree 有未提交的修改（含未追蹤檔）。沒有 worktree 路徑時一律 false。 */
  dirty: boolean;
}

export async function branchFacts(
  exec: Exec,
  input: {
    repoPath: string;
    worktreePath?: string;
    branch: string;
    baseSha: string;
  },
): Promise<BranchFacts> {
  assertAbsolute(input.repoPath, "repository path");
  if (input.worktreePath !== undefined)
    assertAbsolute(input.worktreePath, "worktree path");
  assertCardBranch(input.branch);
  if (!SHA.test(input.baseSha))
    throw new GithubError("invalid", "invalid base sha");
  const ref = `refs/heads/${input.branch}`;
  const headSha = (
    await run(
      exec,
      "git",
      ["-C", input.repoPath, "rev-parse", ref],
      "git_failed",
    )
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new GithubError("unexpected", "unexpected rev-parse output");
  const countText = (
    await run(
      exec,
      "git",
      ["-C", input.repoPath, "rev-list", "--count", `${input.baseSha}..${ref}`],
      "git_failed",
    )
  ).trim();
  const ahead = Number(countText);
  if (!Number.isInteger(ahead) || ahead < 0)
    throw new GithubError("unexpected", "unexpected rev-list output");
  const dirty = input.worktreePath
    ? (
        await run(
          exec,
          "git",
          ["-C", input.worktreePath, "status", "--porcelain"],
          "git_failed",
        )
      ).trim() !== ""
    : false;
  return { headSha, ahead, dirty };
}

/** push `card/<…>` 分支到 origin。明確 refspec，不帶任何旗標（沒有 --force）。 */
export async function pushBranch(
  exec: Exec,
  input: { repoPath: string; branch: string },
): Promise<void> {
  assertAbsolute(input.repoPath, "repository path");
  assertCardBranch(input.branch);
  const refspec = `refs/heads/${input.branch}:refs/heads/${input.branch}`;
  await run(
    exec,
    "git",
    ["-C", input.repoPath, "push", "origin", refspec],
    "push_failed",
  );
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubError("unexpected", "unexpected non-JSON output from gh");
  }
}

const isState = (value: unknown): value is PullRequestInfo["state"] =>
  value === "OPEN" || value === "MERGED" || value === "CLOSED";

export async function findPullRequests(
  exec: Exec,
  repo: GithubRepo,
  branch: string,
): Promise<PullRequestInfo[]> {
  assertCardBranch(branch);
  const data = parseJson(
    await run(
      exec,
      "gh",
      [
        "pr",
        "list",
        "--repo",
        slug(repo),
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state,headRefOid",
        "--limit",
        "10",
      ],
      "gh_failed",
    ),
  );
  if (!Array.isArray(data))
    throw new GithubError("unexpected", "unexpected gh pr list output");
  const found: PullRequestInfo[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    if (
      typeof item.number !== "number" ||
      typeof item.url !== "string" ||
      !isState(item.state) ||
      typeof item.headRefOid !== "string"
    )
      throw new GithubError("unexpected", "unexpected gh pr list entry");
    found.push({
      number: item.number,
      url: item.url,
      state: item.state,
      headSha: item.headRefOid,
    });
  }
  return found;
}

export async function createPullRequest(
  exec: Exec,
  repo: GithubRepo,
  input: { base: string; head: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  assertCardBranch(input.head);
  if (!BASE_BRANCH.test(input.base) || input.base.includes(".."))
    throw new GithubError("invalid", "invalid base branch");
  if (
    !input.title ||
    Array.from(input.title).length > MAX_TITLE ||
    CONTROL.test(input.title)
  )
    throw new GithubError(
      "invalid",
      `the title must be a single line of 1 to ${MAX_TITLE} characters`,
    );
  if (
    !input.body ||
    input.body.length > MAX_BODY ||
    input.body.includes("\u0000")
  )
    throw new GithubError(
      "invalid",
      `the body must be 1 to ${MAX_BODY} characters`,
    );
  const out = await run(
    exec,
    "gh",
    [
      "pr",
      "create",
      "--repo",
      slug(repo),
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    "gh_failed",
  );
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(
    out,
  );
  if (!match)
    throw new GithubError("unexpected", "gh did not return a pull request URL");
  return { number: Number(match[1]), url: match[0] };
}

export type ChecksConclusion =
  "pending" | "success" | "failure" | "cancelled" | "skipped" | "none";

export interface ChecksSummary {
  conclusion: ChecksConclusion;
  /** 失敗（或第一個）檢查的連結，沒有檢查時沒有。 */
  url?: string;
}

interface CheckRow {
  name?: unknown;
  bucket?: unknown;
  link?: unknown;
}

/** 彙整 PR 的 checks：有進行中 → pending；失敗 → failure；取消 → cancelled；全部略過 → skipped；沒有 → none。 */
export async function pullRequestChecks(
  exec: Exec,
  repo: GithubRepo,
  number: number,
): Promise<ChecksSummary> {
  assertNumber(number);
  let text: string;
  try {
    text = (
      await exec("gh", [
        "pr",
        "checks",
        String(number),
        "--repo",
        slug(repo),
        "--json",
        "name,state,bucket,link",
      ])
    ).stdout;
  } catch (error) {
    const record = error as { stdout?: unknown };
    // gh 在檢查失敗或進行中時以非 0 結束，但 stdout 仍有完整的 JSON。
    if (
      typeof record.stdout === "string" &&
      record.stdout.trim().startsWith("[")
    )
      text = record.stdout;
    else if (/no checks reported/i.test(failureText(error)))
      return { conclusion: "none" };
    else
      throw new GithubError(
        "gh_failed",
        `gh pr checks failed: ${failureText(error)}`,
      );
  }
  const rows = parseJson(text);
  if (!Array.isArray(rows))
    throw new GithubError("unexpected", "unexpected gh pr checks output");
  if (rows.length === 0) return { conclusion: "none" };
  const checks = rows as CheckRow[];
  const linkOf = (row: CheckRow | undefined): string | undefined =>
    typeof row?.link === "string" && row.link.startsWith("https://")
      ? row.link
      : undefined;
  const find = (bucket: string) => checks.find((row) => row.bucket === bucket);
  const failed = find("fail");
  if (find("pending")) return { conclusion: "pending" };
  if (failed) return { conclusion: "failure", url: linkOf(failed) };
  const cancelled = find("cancel");
  if (cancelled) return { conclusion: "cancelled", url: linkOf(cancelled) };
  if (checks.every((row) => row.bucket === "skipping"))
    return { conclusion: "skipped", url: linkOf(checks[0]) };
  return { conclusion: "success", url: linkOf(checks[0]) };
}

export interface PullRequestState {
  state: PullRequestInfo["state"];
  headSha: string;
  mergeSha?: string;
}

export async function pullRequestState(
  exec: Exec,
  repo: GithubRepo,
  number: number,
): Promise<PullRequestState> {
  assertNumber(number);
  const data = parseJson(
    await run(
      exec,
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        slug(repo),
        "--json",
        "state,headRefOid,mergedAt,mergeCommit",
      ],
      "gh_failed",
    ),
  ) as Record<string, unknown>;
  if (!data || !isState(data.state) || typeof data.headRefOid !== "string")
    throw new GithubError("unexpected", "unexpected gh pr view output");
  const merge = data.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    state: data.state,
    headSha: data.headRefOid,
    ...(typeof merge?.oid === "string" ? { mergeSha: merge.oid } : {}),
  };
}
