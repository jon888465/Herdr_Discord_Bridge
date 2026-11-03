// `card pr <id>`：把卡片的分支 push 並開 PR（追蹤清單 F3，L1）。這是 bridge 第一次對外 push，
// 所以前提很嚴：卡片 done、專案政策 L1 以上、分支有 commit 且 worktree 乾淨、origin 是 github.com。
// 所有外部動作經注入的 `Exec`；卡片的記錄由呼叫端（指令層）負責。
//
// PR 內容（使用者 2026-11-03 決定）：標題用卡片標題，內文只放卡片 id 與 bridge 產生的結構化事實，
// **不貼描述與驗收條件**（卡片不進 git、可能含 Mantis 內容，而 repo 是公開的）。

import path from "node:path";
import type { Card } from "./card.js";
import { section } from "./card-handoff.js";
import { projectName } from "./card-projects.js";
import type { CardPullRequest, CardPullRequestStore } from "./card-prs.js";
import {
  branchFacts,
  createPullRequest,
  findPullRequests,
  getDefaultBranch,
  getRemoteRepo,
  pushBranch,
  GithubError,
  type Exec,
} from "./github.js";
import { levelFor, type LoadedPolicy } from "./policy.js";
import { redactSecrets } from "./redact.js";

export interface PrFlowDeps {
  exec: Exec;
  policy(): LoadedPolicy;
  prs: Pick<CardPullRequestStore, "forCard" | "record" | "updateHead">;
  now(): string;
}

export interface PrFlowInput {
  card: Card;
  /** `path` 只在 worktree 還在時提供（用來檢查未提交修改）；已清理的 worktree 仍可用 repo 的分支開 PR。 */
  worktree: { repoPath: string; path?: string; branch: string };
  origin?: CardPullRequest["origin"];
}

export interface PrOutcome {
  /** false＝這個分支本來就有開著的 PR，只是把新的 commit push 上去。 */
  created: boolean;
  number: number;
  url: string;
  headSha: string;
  base: string;
  branch: string;
  repo: string;
  repoPath: string;
}

function baseShaOf(card: Card): string | undefined {
  return /^- base：([0-9a-f]{7,40})$/m.exec(
    section(card.body, "異動專案") ?? "",
  )?.[1];
}

function prBody(
  card: Card,
  input: { branch: string; baseSha: string; headSha: string; level: string },
): string {
  // ISSUE-068：只列最新的 task；先前失敗或卡住的嘗試留在卡片的流程紀錄，不公開到 PR。
  const tasks = (card.tasks ?? []).slice(-1);
  return [
    "## 摘要",
    "",
    `- 卡片：${card.id}（卡片不進 git，內容不隨 PR 公開）`,
    `- 分支：${input.branch}`,
    `- 基準：${input.baseSha.slice(0, 12)}`,
    `- head：${input.headSha.slice(0, 12)}`,
    ...(tasks.length ? [`- task：${tasks.join("、")}`] : []),
    "",
    `由 Herdr Discord Bridge 依專案政策（${input.level}）開啟；review 與 merge 由人決定。`,
  ].join("\n");
}

export async function openCardPullRequest(
  deps: PrFlowDeps,
  input: PrFlowInput,
): Promise<PrOutcome> {
  const { card, worktree } = input;
  if (card.status !== "done")
    throw new Error(
      `卡片 ${card.id} 的狀態是 ${card.status}；只有 done 的卡片可以開 PR`,
    );
  const baseSha = baseShaOf(card);
  if (!baseSha)
    throw new Error(
      "卡片沒有記錄基準 commit（`## 異動專案` 的 base），無法判斷要 push 哪些 commit",
    );

  const project = projectName("local", path.basename(worktree.repoPath));
  if (!project) throw new Error("無法由 repo 目錄名組出專案名稱");
  const loaded = deps.policy();
  const level = levelFor(loaded.policy, project);
  if (level === "L0")
    throw new Error(
      `專案 ${project} 的政策等級是 L0（不 push）${loaded.status === "invalid" || loaded.status === "unsafe" ? "，因為政策檔有問題而改用安全預設" : ""}；要開 PR 請在政策檔把它設成 L1 以上，可用 \`card policy ${project}\` 查看`,
    );

  const title = card.title.replace(/\s+/g, " ").trim();
  if (redactSecrets(title) !== title)
    throw new Error(
      "卡片標題疑似含機敏資料，不會放進 PR 標題；請先修改卡片標題",
    );

  const repo = await getRemoteRepo(deps.exec, worktree.repoPath);
  const slug = `${repo.owner}/${repo.repo}`;
  const facts = await branchFacts(deps.exec, {
    repoPath: worktree.repoPath,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseSha,
  });
  if (facts.dirty)
    throw new Error(
      "worktree 有未提交的修改，請先 commit 或處理，再重下 card pr",
    );
  if (facts.ahead < 1)
    throw new Error("這個分支沒有比基準多的 commit，沒有東西可以 push 或開 PR");

  const found = await findPullRequests(deps.exec, repo, worktree.branch);
  const open = found.find((pr) => pr.state === "OPEN");
  if (!open && found.length > 0) {
    const last = found[0];
    throw new Error(
      `這個分支先前的 PR #${last.number} 已${last.state === "MERGED" ? " merge" : "關閉"}（${last.url}）；bridge 不會自動再開一個，請換新的分支或手動處理`,
    );
  }

  await pushBranch(deps.exec, {
    repoPath: worktree.repoPath,
    branch: worktree.branch,
  });

  if (open) {
    const tracked = deps.prs
      .forCard(card.id)
      .some((pr) => pr.repo === slug && pr.number === open.number);
    if (tracked) deps.prs.updateHead(slug, open.number, facts.headSha);
    else
      deps.prs.record(
        {
          cardId: card.id,
          repo: slug,
          number: open.number,
          url: open.url,
          headSha: facts.headSha,
          ...(input.origin ? { origin: input.origin } : {}),
        },
        deps.now(),
      );
    return {
      created: false,
      number: open.number,
      url: open.url,
      headSha: facts.headSha,
      base: "",
      branch: worktree.branch,
      repo: slug,
      repoPath: worktree.repoPath,
    };
  }

  const base = await getDefaultBranch(deps.exec, repo);
  let created: { number: number; url: string };
  try {
    created = await createPullRequest(deps.exec, repo, {
      base,
      head: worktree.branch,
      title,
      body: prBody(card, {
        branch: worktree.branch,
        baseSha,
        headSha: facts.headSha,
        level,
      }),
    });
  } catch (error) {
    throw new Error(
      `分支 ${worktree.branch} 已 push，但開 PR 失敗：${error instanceof GithubError || error instanceof Error ? error.message : "unknown error"}。可以重下 \`card pr ${card.id}\`（已 push 的內容不會重複）`,
    );
  }
  deps.prs.record(
    {
      cardId: card.id,
      repo: slug,
      number: created.number,
      url: created.url,
      headSha: facts.headSha,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    deps.now(),
  );
  return {
    created: true,
    number: created.number,
    url: created.url,
    headSha: facts.headSha,
    base,
    branch: worktree.branch,
    repo: slug,
    repoPath: worktree.repoPath,
  };
}
