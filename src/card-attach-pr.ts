// `card attach-pr`（ISSUE-123）：把「已存在的 PR」登記到卡片，給任務失敗後由人或 Agent 接手開 PR 的情況用。
// **不是讓任意 PR 登記**：只接受開著、來源是卡片專案 origin（非 fork）、head 分支 `card/<卡片 id>`、base 是預設分支的 PR。
// 只讀 GitHub，不 push、不 merge、不改 PR；任何前提不成立就列出所有原因並拒絕、什麼都不寫。
// 寫入只有一筆 `card-prs.json` 登記（與 `card pr` 同一份）；`pr_opened` 事件由指令層寫。

import path from "node:path";
import type { Card } from "./card.js";
import { projectName } from "./card-projects.js";
import type { CardPullRequest, CardPullRequestStore } from "./card-prs.js";
import {
  getDefaultBranch,
  getRemoteRepo,
  pullRequestAttachFacts,
  GithubError,
  type Exec,
  type GithubRepo,
} from "./github.js";
import { levelFor, type LoadedPolicy } from "./policy.js";

export interface AttachDeps {
  exec: Exec;
  policy(): LoadedPolicy;
  prs: Pick<CardPullRequestStore, "list" | "record">;
  now(): string;
}

export interface AttachInput {
  card: Card;
  worktree: { repoPath: string };
  /** PR 編號或完整 PR 網址。 */
  ref: string;
  /** 「卡片有工作在跑」的原因；非空就拒絕。 */
  busy: string[];
  origin?: CardPullRequest["origin"];
}

export interface AttachOutcome {
  /** false＝同一張卡已登記過這個 PR，沒有寫任何東西。 */
  created: boolean;
  number: number;
  url: string;
  headSha: string;
  base: string;
  branch: string;
  repo: string;
  repoPath: string;
}

const PR_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([0-9]+)\/?$/;

function parseRef(ref: string): { number: number; repo?: string } | undefined {
  if (/^[0-9]{1,7}$/.test(ref)) {
    const number = Number(ref);
    return number >= 1 ? { number } : undefined;
  }
  const match = PR_URL.exec(ref);
  if (!match || match[3].length > 7) return undefined;
  return { number: Number(match[3]), repo: `${match[1]}/${match[2]}` };
}

function message(error: unknown): string {
  return error instanceof GithubError || error instanceof Error
    ? error.message
    : "unknown error";
}

function refuse(reasons: string[]): never {
  throw new Error(
    `不登記 PR（${reasons.length} 項條件不成立，什麼都沒有寫入）：\n${reasons.map((reason) => `- ${reason}`).join("\n")}`,
  );
}

export async function attachCardPullRequest(
  deps: AttachDeps,
  input: AttachInput,
): Promise<AttachOutcome> {
  const { card } = input;
  const reasons: string[] = [];
  const branch = `card/${card.id}`;

  if (card.status !== "in_progress" && card.status !== "done")
    reasons.push(
      `卡片 ${card.id} 的狀態是 ${card.status}；只有 in_progress 或 done 的卡片可以登記 PR`,
    );
  reasons.push(...input.busy);

  const project = projectName("local", path.basename(input.worktree.repoPath));
  if (!project) reasons.push("無法由 repo 目錄名組出專案名稱");
  else {
    const loaded = deps.policy();
    if (levelFor(loaded.policy, project) === "L0")
      reasons.push(
        `專案 ${project} 的政策等級是 L0；要登記 PR 請在政策檔設成 L1 以上（\`card policy ${project}\`）`,
      );
  }

  const parsed = parseRef(input.ref);
  if (!parsed)
    reasons.push(
      `「${input.ref.slice(0, 80)}」不是 PR 編號，也不是完整的 PR 網址（https://github.com/<owner>/<repo>/pull/<編號>）`,
    );

  let repo: GithubRepo | undefined;
  try {
    repo = await getRemoteRepo(deps.exec, input.worktree.repoPath);
  } catch (error) {
    reasons.push(`無法確認專案的 origin 是 github.com：${message(error)}`);
  }
  if (!repo || !parsed) refuse(reasons);
  const slug = `${repo.owner}/${repo.repo}`;
  if (parsed.repo && parsed.repo.toLowerCase() !== slug.toLowerCase()) {
    reasons.push(
      `PR 網址的 repo 是 ${parsed.repo}，不是卡片專案的 origin（${slug}）`,
    );
    refuse(reasons);
  }

  let facts: Awaited<ReturnType<typeof pullRequestAttachFacts>> | undefined;
  try {
    facts = await pullRequestAttachFacts(deps.exec, repo, parsed.number);
  } catch (error) {
    reasons.push(`無法讀取 PR #${parsed.number}：${message(error)}`);
  }
  let defaultBranch: string | undefined;
  try {
    defaultBranch = await getDefaultBranch(deps.exec, repo);
  } catch (error) {
    reasons.push(`無法確認專案的預設分支：${message(error)}`);
  }

  if (facts) {
    if (facts.state !== "OPEN")
      reasons.push(
        `PR #${facts.number} 的狀態是 ${facts.state}，已${facts.state === "MERGED" ? " merge" : "關閉"}；只能登記開著的 PR`,
      );
    if (facts.headBranch !== branch)
      reasons.push(
        `PR 的 head 分支是 ${facts.headBranch}，必須是這張卡的分支 ${branch}`,
      );
    if (facts.isCrossRepository)
      reasons.push(
        `PR 的來源是別的 repo（fork）；只接受來源就是 ${slug} 的 PR`,
      );
    if (defaultBranch && facts.base !== defaultBranch)
      reasons.push(
        `PR 的 base 是 ${facts.base}，必須是專案的預設分支 ${defaultBranch}`,
      );
  }

  const entries = deps.prs.list();
  const same = entries.find(
    (entry) => entry.repo === slug && entry.number === parsed.number,
  );
  if (same && same.cardId !== card.id)
    reasons.push(`PR #${parsed.number} 已登記在卡片 ${same.cardId}`);
  const otherOpen = entries.find(
    (entry) =>
      entry.cardId === card.id &&
      entry.state === "OPEN" &&
      !(entry.repo === slug && entry.number === parsed.number),
  );
  if (otherOpen)
    reasons.push(
      `卡片 ${card.id} 已登記另一個開著的 PR #${otherOpen.number}（${otherOpen.url}）`,
    );

  if (reasons.length > 0 || !facts || !defaultBranch) refuse(reasons);

  const outcome: AttachOutcome = {
    created: !same,
    number: facts.number,
    url: facts.url,
    headSha: facts.headSha,
    base: defaultBranch,
    branch,
    repo: slug,
    repoPath: input.worktree.repoPath,
  };
  if (same) return outcome;
  deps.prs.record(
    {
      cardId: card.id,
      repo: slug,
      number: facts.number,
      url: facts.url,
      headSha: facts.headSha,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    deps.now(),
  );
  return outcome;
}
