import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deliveryAddArgs } from "./card-commit.js";
import { reviewLimit } from "./card-review-fetch.js";
import type { CodingVersion } from "./coding-version.js";

const exec = promisify(execFile);
const TIMEOUT_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/;

export type DeliveryPrecheckWarningCode = "missing_worktree" | "missing_base";

export class DeliveryPrecheckError extends Error {
  constructor(readonly code: DeliveryPrecheckWarningCode, message: string) {
    super(message);
  }
}

function validPath(file: string): boolean {
  return (
    !/[\x00-\x1f\x7f\\\uFFFD]/.test(file) &&
    file
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      )
  );
}

async function patchLength(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const child = spawn("git", args, {
    cwd,
    env,
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const count = async () => {
    let length = 0;
    // Node's UTF-8 decoder replaces malformed bytes, as in the GitHub runner.
    for await (const chunk of child.stdout.setEncoding("utf8"))
      length += chunk.length;
    return length;
  };
  const [[code, signal], length] = await Promise.all([
    once(child, "close"),
    count(),
  ]);
  if (code !== 0)
    throw new Error(`git diff 讀取 patch 失敗（${signal ?? code}）`);
  return length;
}

export async function measureDelivery(
  cwd: string,
  baseHead: string,
  version: Pick<CodingVersion, "headSha" | "worktreePaths">,
  readPatch = patchLength,
) {
  if (!SHA.test(baseHead) || !SHA.test(version.headSha))
    throw new Error("PR base 或交付 HEAD 不合法");
  if (!version.worktreePaths || !version.worktreePaths.every(validPath))
    throw new Error("無法確認交付路徑");
  const temporary = await mkdtemp(path.join(tmpdir(), "hdb-precheck-"));
  try {
    const sourceEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    sourceEnv.GIT_LITERAL_PATHSPECS = "1";
    sourceEnv.GIT_NO_LAZY_FETCH = "1";
    const patchEnv = {
      ...sourceEnv,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
    };
    const patchOptions = ["-c", "core.attributesFile=/dev/null"];
    const runGit = async (
      directory: string,
      env: NodeJS.ProcessEnv,
      options: string[],
      ...args: string[]
    ) => {
      try {
        return (
          await exec("git", [...options, ...args], {
            cwd: directory,
            env,
            timeout: TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout;
      } catch (error) {
        const failure = error as {
          stderr?: string;
          code?: string | number;
          signal?: string;
        };
        const detail =
          failure.stderr?.trim().split("\n")[0] ||
          failure.signal ||
          failure.code;
        throw new Error(`git ${args[0]} 失敗（${detail ?? "未知原因"}）`);
      }
    };

    const objects = (
      await runGit(
        cwd,
        sourceEnv,
        [],
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      )
    ).replace(/\n$/, "");
    if (!path.isAbsolute(objects) || /[\r\n]/.test(objects))
      throw new Error("無法確認本機 Git 物件目錄");
    const git = (...args: string[]) =>
      runGit(temporary, patchEnv, patchOptions, ...args);
    await git("init", "--quiet", "--template=", "--object-format=sha1");
    const objectDir = path.join(temporary, ".git", "objects");
    await writeFile(path.join(objectDir, "info", "alternates"), objects + "\n");
    try {
      await git("cat-file", "-e", `${baseHead}^{commit}`);
    } catch {
      throw new DeliveryPrecheckError(
        "missing_base",
        "git merge-base 無法執行（本機缺少 PR base commit）",
      );
    }
    const base = (await git("merge-base", baseHead, version.headSha)).trim();
    if (!SHA.test(base)) throw new Error("無法確認 PR merge-base");
    let tree = version.headSha;
    if (version.worktreePaths.length) {
      const stageEnv = {
        ...sourceEnv,
        GIT_INDEX_FILE: path.join(temporary, "delivery-index"),
        GIT_OBJECT_DIRECTORY: objectDir,
      };
      const stage = (...args: string[]) =>
        runGit(
          cwd,
          stageEnv,
          [
            "-c",
            "core.splitIndex=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
          ],
          ...args,
        );
      // Apply the same clean conversion and worktree contents as card commit.
      await stage("read-tree", version.headSha);
      await stage(...deliveryAddArgs(version.worktreePaths));
      tree = (await stage("write-tree")).trim();
      if (!SHA.test(tree)) throw new Error("無法確認交付 tree");
    }

    // An empty worktree lets Git resolve diff attributes from the delivered tree.
    await git("read-tree", tree);
    const diff = ["diff", "--cached", "--no-ext-diff", "--no-textconv"];
    // Listing without rename detection includes both sides of each rename.
    const names = await git(
      ...diff,
      "--no-renames",
      "--no-relative",
      "--name-only",
      "-z",
      base,
      "--",
    );
    const paths = names === "" ? [] : names.slice(0, -1).split("\0");
    if ((names !== "" && !names.endsWith("\0")) || !paths.every(validPath))
      throw new Error("無法確認 PR 差異路徑");
    const files = [...new Set(paths)];
    const fileLimit = reviewLimit("files", files.length);
    if (fileLimit) return { files, exceeded: fileLimit };

    const chars = await readPatch(
      temporary,
      [
        ...patchOptions,
        ...diff,
        "--patch",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--abbrev=7",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--unified=3",
        "--inter-hunk-context=0",
        "--find-renames=50%",
        base,
        "--",
      ],
      patchEnv,
    );
    return { files, chars, exceeded: reviewLimit("diff", chars) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
