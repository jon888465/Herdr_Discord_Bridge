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
