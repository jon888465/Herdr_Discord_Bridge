// `card commit <id>`（追蹤清單 H4 的缺口，使用者 2026-11-05 決定）：`--coding` 任務走到 ready-to-integrate 後，
// 驗證過的版本只是 worktree 裡的未提交修改，而 Worker 與 bridge 都不 commit，`card pr` 卻要求分支上有 commit
// 且 worktree 乾淨。這個模組讓 bridge 在嚴格條件下替卡片的分支做一次 commit，**不 push、不 merge**。
//
// 條件（全部成立才 commit）：最新 coding 任務已完成且階段是 ready-to-integrate；任務的 repository 就是這張
// 卡的 worktree；目前分支是卡片的分支；工作樹的版本指紋與驗證通過的指紋完全相同（驗證之後沒有被改動）；
// 版本是「全部未提交」（已經有 commit 就不重複做）；暫存區原本是空的。只 stage 已驗證版本裡的檔案。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { Card } from "./card.js";
import {
  captureCodingTree,
  versionFromBaseline,
  type CodingTreeSnapshot,
  type CodingVersion,
} from "./coding-version.js";
import type { CodingTaskState } from "./coding-workflow.js";
import { redactSecrets } from "./redact.js";

export interface CommitTaskView {
  taskId: string;
  state: string;
  coding?: Pick<
    CodingTaskState,
    "stage" | "versionFingerprint" | "baseline" | "repository"
  >;
}

export interface CommitDeps {
  /** 在 `cwd` 執行 git，回傳 stdout；失敗丟錯。可注入以便測試。 */
  git(cwd: string, args: string[]): string;
  /** 目前工作樹相對於基準的版本。可注入以便測試。 */
  currentVersion(
    baseline: CodingTreeSnapshot,
    repository: string,
  ): CodingVersion;
}

export interface CommitOutcome {
  sha: string;
  branch: string;
  files: string[];
  fingerprint: string;
  taskId: string;
}

export const defaultCommitDeps: CommitDeps = {
  git(cwd, args) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    // 路徑一律當字面值，不展開萬用字元或 pathspec magic。
    env.GIT_LITERAL_PATHSPECS = "1";
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  },
  currentVersion(baseline, repository) {
    return versionFromBaseline(baseline, captureCodingTree(repository));
  },
};

function realpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function commitMessage(card: Card, task: CommitTaskView, fingerprint: string) {
  const title = card.title.replace(/\s+/g, " ").trim();
  if (redactSecrets(title) !== title)
    throw new Error(
      "卡片標題疑似含機敏資料，不會放進 commit 訊息；請先修改卡片標題",
    );
  return [
    title,
    [
      `卡片：${card.id}`,
      `task：${task.taskId}`,
      `驗證版本：${fingerprint.slice(0, 12)}`,
      "",
      "由 Herdr Discord Bridge 在 coding 任務通過獨立 review 與驗證後提交（card commit）。",
    ].join("\n"),
  ];
}

export function commitVerifiedVersion(
  input: {
    card: Card;
    branch: string;
    worktreePath: string;
    task: CommitTaskView | undefined;
  },
  deps: CommitDeps = defaultCommitDeps,
): CommitOutcome {
  const { card, branch, worktreePath, task } = input;
  if (!task)
    throw new Error(
      `卡片 ${card.id} 沒有 task（用 \`card assign ${card.id} --worktree --coding\` 指派）`,
    );
  const coding = task.coding;
  if (!coding)
    throw new Error(
      `task ${task.taskId} 不是 --coding 任務，沒有驗證過的版本可以 commit`,
    );
  if (task.state !== "completed" || coding.stage !== "ready-to-integrate")
    throw new Error(
      `task ${task.taskId} 還沒通過 review 與驗證（狀態 ${task.state}，階段 ${coding.stage}）；只有 ready-to-integrate 的任務可以 commit`,
    );
  if (realpath(coding.repository) !== realpath(worktreePath))
    throw new Error(
      `task ${task.taskId} 的工作目錄（${coding.repository}）不是這張卡的 worktree（${worktreePath}）`,
    );

  const head = deps
    .git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    .trim();
  if (head !== branch)
    throw new Error(`worktree 目前的分支是 ${head}，不是卡片的分支 ${branch}`);

  const version = deps.currentVersion(coding.baseline, worktreePath);
  if (version.overflow)
    throw new Error("版本太大，指紋不完整，不能自動 commit");
  if (version.fingerprint !== coding.versionFingerprint)
    throw new Error(
      "worktree 的內容和通過驗證的版本不同（驗證之後被改動過）；請重新跑 review 與驗證，或自行處理",
    );
  if (version.mode === "committed")
    throw new Error("這個版本已經 commit 了，沒有需要提交的修改");
  if (version.mode === "mixed")
    throw new Error(
      "worktree 同時有已 commit 與未提交的修改，無法只 commit 驗證過的部分；請自行處理",
    );
  const files = [...version.deliveryPaths];
  if (!files.length) throw new Error("驗證過的版本沒有任何要提交的檔案");
  if (
    files.some((file) => !file || file.startsWith("-") || file.includes("\0"))
  )
    throw new Error("檔案路徑不安全，不能自動 commit");

  const alreadyStaged = deps
    .git(worktreePath, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  if (alreadyStaged.length)
    throw new Error(
      `暫存區原本就有東西（${alreadyStaged.slice(0, 3).join("、")}…），不會混進 commit；請先處理`,
    );

  const [subject, body] = commitMessage(card, task, version.fingerprint);
  deps.git(worktreePath, ["add", "--", ...files]);
  const staged = deps
    .git(worktreePath, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const expected = [...files].sort();
  if (staged.join("\0") !== expected.join("\0")) {
    deps.git(worktreePath, ["restore", "--staged", "--", ...staged]);
    throw new Error(
      "暫存的檔案和驗證過的版本不一致，已取消 commit 並還原暫存區",
    );
  }
  deps.git(worktreePath, ["commit", "-q", "-m", subject, "-m", body]);
  const sha = deps.git(worktreePath, ["rev-parse", "HEAD"]).trim();
  return {
    sha,
    branch,
    files: expected,
    fingerprint: version.fingerprint,
    taskId: task.taskId,
  };
}
