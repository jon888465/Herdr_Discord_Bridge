// 工作樹指紋（追蹤清單 F5 階段 3d，使用者 2026-11-04 同意）：`git rev-parse HEAD` 加 `git status --porcelain`。
// review 前後各取一次，不同就代表 reviewer 動了工作樹（或新增了 commit），整份 review 不採用。
// 限制：抓得到檔案被改、新增或刪除與 commit 被新增，**抓不到只改了被 gitignore 的檔案**。
// 只用唯讀的 git 指令，不經 shell。

import type { Exec } from "./github.js";

export async function worktreeFingerprint(
  exec: Exec,
  cwd: string,
): Promise<string> {
  if (typeof cwd !== "string" || !cwd.startsWith("/"))
    throw new Error("worktree 路徑必須是絕對路徑（absolute path）");
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (head === "") throw new Error("無法讀取 worktree 的 HEAD");
  const status = (await exec("git", ["status", "--porcelain"], { cwd })).stdout;
  return `${head}\n${status}`;
}

function assertAbsolute(cwd: string): void {
  if (typeof cwd !== "string" || !cwd.startsWith("/"))
    throw new Error("worktree 路徑必須是絕對路徑（absolute path）");
}

/** HEAD 與工作樹有沒有未提交的修改（`card fix` 用：修正後必須有新 commit 且工作樹乾淨）。 */
export async function worktreeState(
  exec: Exec,
  cwd: string,
): Promise<{ head: string; dirty: boolean }> {
  assertAbsolute(cwd);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (head === "") throw new Error("無法讀取 worktree 的 HEAD");
  const status = (await exec("git", ["status", "--porcelain"], { cwd })).stdout;
  return { head, dirty: status.trim() !== "" };
}

/** 兩個 commit 之間改動的路徑；不做改名偵測，所以改名的新舊路徑都會出現（敏感路徑檢查才不會被搬檔案繞過）。 */
export async function changedFilesBetween(
  exec: Exec,
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  assertAbsolute(cwd);
  const sha = /^[0-9a-f]{40}$/;
  if (!sha.test(from) || !sha.test(to))
    throw new Error("只接受 40 位的 commit sha（invalid sha）");
  const output = (
    await exec(
      "git",
      ["diff", "--name-only", "--no-renames", from, to],
      { cwd },
    )
  ).stdout;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
