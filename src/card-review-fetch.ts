// 取得 review 用的 PR 材料（追蹤清單 F5 階段 3b）：head sha、動到的檔案清單、diff。全部唯讀（gh pr view／api／diff），
// 不 merge、不留言、不改任何東西。目的是讓 reviewer 看到的內容和「這個 head sha」精確對得上：
// - 只 review 開著的 PR；
// - 先讀 head、再讀檔案清單與 diff、最後再讀一次 head，兩次不同就整個拒絕（讀取期間有新 commit）；
// - diff 標頭列出的路徑必須和檔案清單完全一致，對不上就拒絕，不猜；
// - 檔案數與 diff 大小有上限，超過就拒絕並說明要請 Lead 把需求重新切分（使用者 2026-11-04：diff 太大代表規劃切太大）。

import {
  GithubError,
  pullRequestDiff,
  pullRequestFiles,
  pullRequestState,
  type Exec,
  type GithubRepo,
} from "./github.js";
export const MAX_REVIEW_FILES = 20;
/** ISSUE-111 raised this limit from 60,000 to 80,000. */
export const MAX_REVIEW_DIFF_CHARS = 80_000;

export function reviewLimit(kind: "files" | "diff", actual: number) {
  const limit = kind === "files" ? MAX_REVIEW_FILES : MAX_REVIEW_DIFF_CHARS;
  return actual > limit
    ? { kind, actual, limit, excess: actual - limit }
    : undefined;
}

export type ReviewLimit = NonNullable<ReturnType<typeof reviewLimit>>;

export function reviewLimitError({ kind, actual, limit }: ReviewLimit): string {
  const reason =
    kind === "files"
      ? `PR 動到 ${actual} 個檔案，超過 review 上限 ${limit} 個`
      : `PR 的 diff 有 ${actual} 字元，超過 review 上限 ${limit}`;
  return `${reason}；請 Lead 把需求重新切分成較小的部分`;
}

export function deliveryLimitMessage({
  kind,
  actual,
  limit,
  excess,
}: ReviewLimit): string {
  const name = kind === "files" ? "MAX_REVIEW_FILES" : "MAX_REVIEW_DIFF_CHARS";
  const unit = kind === "files" ? "個檔案" : "字元";
  return `PR 預檢超限 ${name}：實測 ${actual} ${unit}，上限 ${limit}，超過 ${excess}；成果已保留`;
}

/** Only forward the fixed summary and its numeric fields to the card's notify target. */
export function deliveryLimitNotification(text: string): string | undefined {
  return /PR 預檢超限 (?:MAX_REVIEW_FILES：實測 \d+ 個檔案|MAX_REVIEW_DIFF_CHARS：實測 \d+ 字元)，上限 \d+，超過 \d+；成果已保留$/.exec(
    text,
  )?.[0];
}

export interface ReviewMaterial {
  /** PR 讀取當時的 head commit（完整 sha）；review 的判定要綁在它上面。 */
  headSha: string;
  /** PR 動到的路徑，改名的檔案新舊路徑都在。 */
  files: string[];
  diff: string;
}

const HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
const SHOWN = 5;

const refuse = (message: string): GithubError =>
  new GithubError("invalid", message);

const shown = (paths: string[]): string =>
  paths.length > SHOWN
    ? `${paths.slice(0, SHOWN).join("、")} 等 ${paths.length} 個`
    : paths.join("、");

export async function fetchReviewMaterial(
  exec: Exec,
  repo: GithubRepo,
  number: number,
): Promise<ReviewMaterial> {
  const before = await pullRequestState(exec, repo, number);
  if (before.state !== "OPEN")
    throw refuse(
      `PR #${number} 已${before.state === "MERGED" ? " merge" : "關閉"}，不是開著的 PR，不需要 review`,
    );

  const listed = await pullRequestFiles(exec, repo, number);
  if (!listed.complete)
    throw refuse(
      "PR 動到的檔案多到無法取得完整清單；請 Lead 把需求重新切分成較小的部分",
    );
  const files = [...new Set(listed.files)];
  if (files.length === 0) throw refuse("PR 沒有動到任何檔案，沒有東西可以 review");
  const fileLimit = reviewLimit("files", files.length);
  if (fileLimit) throw refuse(reviewLimitError(fileLimit));

  let diff: string;
  try {
    diff = await pullRequestDiff(exec, repo, number);
  } catch (error) {
    if (error instanceof GithubError && /maxBuffer/i.test(error.message))
      throw refuse(
        `PR 的 diff 太大（超過可讀取的上限）；請 Lead 把需求重新切分成較小的部分`,
      );
    throw error;
  }
  if (diff.trim() === "") throw refuse("PR 的 diff 是空的，沒有東西可以 review");
  const diffLimit = reviewLimit("diff", diff.length);
  if (diffLimit) throw refuse(reviewLimitError(diffLimit));

  const inDiff = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = HEADER.exec(line);
    if (!match)
      throw refuse(`無法解析 diff 標頭，不猜測檔案清單：${line.slice(0, 120)}`);
    inDiff.add(match[1]);
    inDiff.add(match[2]);
  }
  const missing = files.filter((file) => !inDiff.has(file));
  const extra = [...inDiff].filter((file) => !files.includes(file));
  if (missing.length > 0 || extra.length > 0)
    throw refuse(
      `PR 的 diff 與檔案清單對不上${missing.length ? `：diff 裡沒有 ${shown(missing)}` : ""}${extra.length ? `${missing.length ? "；" : "："}diff 多出 ${shown(extra)}` : ""}`,
    );

  const after = await pullRequestState(exec, repo, number);
  if (after.headSha !== before.headSha)
    throw refuse(
      "讀取期間 PR 有新的 commit，這次取得的內容對不上單一 head；請重新執行",
    );
  return { headSha: before.headSha, files, diff };
}
