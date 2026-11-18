// 遠端寫入角色（ISSUE-171，設計見 docs/remote-write-roles.md）：把遠端 agent 在快照目錄裡的改動取回本機。
// 遠端產物不可信：本機自己重新計算 tree、路徑與檔案模式，全部通過才 commit；任何失敗都還原到派工前的 HEAD。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LONG_MS, RemoteFailure, SHA, SHORT_MS, assertRemoteValue, must, type RemoteExec } from "./remote-checkout.js";
import type { LocalGit } from "./remote-snapshot.js";
import { shellQuote, sshTargetArgs, type MachineConfig } from "./machines.js";

export const MAX_PATCH_BYTES = 10 * 1024 * 1024;
export const MAX_RESULT_FILES = 500;
const PATCH_FILE = "hdb-result.patch";
const INDEX_FILE = "hdb-result-index";

/** 取回大量輸出：回傳原始位元組（RemoteExec 只留最後 64 KiB，不夠放 patch）；超過 maxBytes 就中止。 */
export type RemoteFetch = (argv: string[], timeoutMs: number, maxBytes: number) => Promise<{ code: number; data: Buffer; truncated: boolean }>;

/** 遠端：暫時 index（不碰 agent 自己的 index）→ add -A → write-tree；印出結果 tree sha。 */
const TREE_SCRIPT = [
  `cd -P -- "$1" || exit 1`,
  `export GIT_INDEX_FILE="$1/.git/${INDEX_FILE}"`,
  `rm -f "$GIT_INDEX_FILE"`,
  `G="git -c core.hooksPath=/dev/null"`,
  `$G read-tree "$2" && $G add -A && $G write-tree`,
  `rc=$?`,
  `rm -f "$GIT_INDEX_FILE"`,
  `exit $rc`,
].join("; ");

/** 遠端：把 T_S→T_R 的 patch 寫到 .git 底下的檔案並印出位元組數（不經 pipe，才拿得到 git 的 exit code）。 */
const PATCH_SCRIPT = [
  `cd -P -- "$1" || exit 1`,
  `git -c core.hooksPath=/dev/null diff --binary --full-index --no-renames --no-ext-diff --no-textconv --no-color "$2" "$3" > "$1/.git/${PATCH_FILE}" || exit 1`,
  `wc -c < "$1/.git/${PATCH_FILE}"`,
].join("; ");

export type RemoteResult = { tree: string; patch: Buffer };

/**
 * 派工後在遠端算出結果並取回。patch 超過上限、tree 或大小輸出格式不對、取回被截斷都丟 RemoteFailure（不採用）。
 * 檔案留在遠端目錄的 .git 底下，隨目錄一起清理。
 */
export async function fetchRemoteResult(
  exec: RemoteExec,
  fetch: RemoteFetch,
  input: { dir: string; baseTree: string; maxBytes?: number },
): Promise<RemoteResult> {
  const { dir, baseTree } = input;
  const maxBytes = input.maxBytes ?? MAX_PATCH_BYTES;
  assertRemoteValue("dir", dir);
  if (!SHA.test(baseTree)) throw new RemoteFailure("參數不合法", "baseTree");
  const tree = (await must(exec, ["sh", "-c", TREE_SCRIPT, "sh", dir, baseTree], "取回結果失敗：遠端 tree", LONG_MS)).trim();
  if (!SHA.test(tree)) throw new RemoteFailure("取回結果失敗：遠端 tree", "輸出不是 sha");
  const sizeText = (await must(exec, ["sh", "-c", PATCH_SCRIPT, "sh", dir, baseTree, tree], "取回結果失敗：遠端 patch", LONG_MS)).trim();
  if (!/^\d{1,12}$/.test(sizeText)) throw new RemoteFailure("取回結果失敗：遠端 patch", "大小輸出格式不對");
  const size = Number(sizeText);
  if (size > maxBytes) throw new RemoteFailure("遠端改動超過大小上限", `${size} bytes`);
  const fetched = await fetch(["cat", "--", `${dir}/.git/${PATCH_FILE}`], LONG_MS, maxBytes);
  if (fetched.code !== 0) throw new RemoteFailure("取回結果失敗：讀取 patch", `exit ${fetched.code}`);
  if (fetched.truncated || fetched.data.length !== size) throw new RemoteFailure("取回結果失敗：patch 不完整", `${fetched.data.length}/${size}`);
  return { tree, patch: fetched.data };
}

export type RawEntry = { oldMode: string; newMode: string; status: string; path: string };

/** 解析 `git diff --raw -z --no-renames` 的輸出（`:old new oldsha newsha S\0path\0`）。 */
export function parseRawDiff(output: string): RawEntry[] {
  const parts = output.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(parts[i]!);
    if (!meta) throw new RemoteFailure("遠端改動不合法", "diff 輸出格式");
    entries.push({ oldMode: meta[1]!, newMode: meta[2]!, status: meta[3]!, path: parts[i + 1]! });
  }
  return entries;
}

/** 路徑、模式與數量檢查；回傳違規原因，沒有問題回 undefined。 */
export function resultViolation(entries: readonly RawEntry[], maxFiles = MAX_RESULT_FILES): string | undefined {
  if (entries.length > maxFiles) return `檔案數超過上限（${entries.length}）`;
  for (const entry of entries) {
    const file = entry.path;
    if (!file || file.startsWith("/") || file.includes("\\")) return "不合法的路徑";
    const segments = file.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) return "不合法的路徑";
    if (segments.some((s) => s.toLowerCase() === ".git")) return "動到 .git 路徑";
    if (segments.length === 1 && segments[0]!.toLowerCase() === ".gitmodules") return "動到 .gitmodules";
    if (entry.newMode === "120000") return "新增或修改了符號連結";
    if (entry.newMode === "160000" || entry.oldMode === "160000") return "動到 submodule";
  }
  return undefined;
}

export type AppliedResult = { headBefore: string; headAfter: string; files: string[] };

const COMMIT_IDENTITY = Object.fromEntries(
  ["AUTHOR", "COMMITTER"].flatMap((w) => [
    [`GIT_${w}_NAME`, "hdb-remote"],
    [`GIT_${w}_EMAIL`, "hdb-remote@invalid"],
  ]),
);

/**
 * 在本機 worktree 套用遠端 patch 並 commit。前提：呼叫者已確認本機工作樹自快照後沒被改動（digest），
 * 而且寫入模式要求派工前工作樹是乾淨的（快照 tree 等於 HEAD tree，由 `assertCleanBase` 檢查）。
 * 驗證：套用後本機自己算的 tree 必須等於遠端回報的 tree；路徑與模式檢查通過才 commit。
 * 任何失敗都 `reset --hard` 回派工前的 HEAD，丟 RemoteFailure。
 */
export function applyRemoteResult(
  git: LocalGit,
  input: { patch: Buffer; expectedTree: string; message: string; maxFiles?: number },
): AppliedResult {
  if (!SHA.test(input.expectedTree)) throw new RemoteFailure("參數不合法", "expectedTree");
  if (input.patch.length === 0) throw new RemoteFailure("遠端沒有產生任何改動");
  const headBefore = git(["rev-parse", "HEAD"]).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hdb-result-"));
  const file = path.join(dir, "result.patch");
  const rollback = () => {
    try {
      git(["reset", "--hard", "--quiet", headBefore]);
    } catch (error) {
      console.error(`remote write: 還原失敗，請人工檢查 worktree：${String(error)}`);
    }
  };
  try {
    fs.writeFileSync(file, input.patch, { mode: 0o600 });
    try {
      git(["apply", "--index", "--whitespace=nowarn", file]);
    } catch (error) {
      throw new RemoteFailure("遠端改動無法套用", String(error));
    }
    const tree = git(["write-tree"]).trim();
    if (tree !== input.expectedTree) throw new RemoteFailure("遠端改動與回報的 tree 不符", `${tree} != ${input.expectedTree}`);
    const entries = parseRawDiff(git(["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames", headBefore]));
    const violation = resultViolation(entries, input.maxFiles);
    if (violation) throw new RemoteFailure("遠端改動不被接受", violation);
    git(["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", input.message], COMMIT_IDENTITY);
    const headAfter = git(["rev-parse", "HEAD"]).trim();
    return { headBefore, headAfter, files: entries.map((e) => e.path) };
  } catch (error) {
    rollback();
    throw error instanceof RemoteFailure ? error : new RemoteFailure("套用遠端改動失敗", String(error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 寫入模式的前提：快照 tree 等於 HEAD tree（本機工作樹含未追蹤檔都是乾淨的），否則不派工。 */
export function assertCleanBase(git: LocalGit, snapshotTree: string): void {
  if (git(["rev-parse", "HEAD^{tree}"]).trim() !== snapshotTree) throw new RemoteFailure("本機工作樹不乾淨，遠端寫入角色不派工", "快照 tree 不等於 HEAD tree");
}

/** ssh 取回位元組：與 sshRemoteExec 相同的參數與遠端 timeout 包裝，但保留完整 stdout 到 maxBytes。 */
export function sshRemoteFetch(machine: MachineConfig, sshCommand = "ssh"): RemoteFetch {
  return (argv, timeoutMs, maxBytes) =>
    new Promise((resolve, reject) => {
      if (!argv.length || argv.some((a) => !a || /[\u0000-\u001F\u007F]/.test(a))) return reject(new RemoteFailure("參數不合法", "argv"));
      const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
      const command = ["timeout", "-k", "10", seconds, ...argv].map(shellQuote).join(" ");
      const options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes"];
      const child = spawn(sshCommand, [...options, ...sshTargetArgs(machine), command], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new RemoteFailure("逾時", "local timer", true));
      }, timeoutMs + SHORT_MS);
      child.stdout?.on("data", (c: Buffer) => {
        if (truncated) return;
        total += c.length;
        if (total > maxBytes) {
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(c);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new RemoteFailure("連線失敗", error.message, true));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (truncated) resolve({ code: 0, data: Buffer.concat(chunks), truncated: true });
        else if (code === 255 || code === null) reject(new RemoteFailure("連線失敗", "ssh", true));
        else if (code === 124 || code === 137) reject(new RemoteFailure("逾時", `exit ${code}`));
        else resolve({ code, data: Buffer.concat(chunks), truncated: false });
      });
    });
}
