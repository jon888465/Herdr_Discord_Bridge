import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Local Git identity for one coding task. This module only reads; it never
 * commits, merges, pushes, checks out, resets, or cleans. */

const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 8_388_608;
const MAX_FILES = 200;
const MAX_DIFF_BYTES = 1_048_576;
export const MAX_ARTIFACT_BYTES = 262_144;

export interface CodingFileRecord {
  path: string;
  indexSha256: string | null;
  worktreeSha256: string | null;
  untrackedSha256: string | null;
  bytes: number;
  mode: number | null;
}

export interface CodingTreeSnapshot {
  repository: string;
  branch: string;
  headSha: string;
  stagedDiffSha256: string;
  unstagedDiffSha256: string;
  overflow: boolean;
  files: CodingFileRecord[];
}

export interface CodingVersion {
  mode: "committed" | "uncommitted" | "mixed";
  baseSha: string;
  headSha: string;
  branch: string;
  fingerprint: string;
  stagedDiffSha256: string;
  unstagedDiffSha256: string;
  deliveryPaths: string[];
  untracked: Array<{ path: string; sha256: string; bytes: number }>;
  overflow: boolean;
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function gitText(root: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", root, ...args],
    {
      env: gitEnv(),
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    },
  );
}

function gitBuffer(root: string, args: string[]): Buffer | "overflow" {
  try {
    return execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, ...args],
      {
        env: gitEnv(),
        timeout: 20000,
        maxBuffer: MAX_DIFF_BYTES + 1,
      },
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "overflow";
    throw error;
  }
}

function nulSplit(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function assertRepoPath(root: string, name: string): string {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").includes("..")
  )
    throw new Error("coding version path escapes the repository");
  const file = path.resolve(root, name);
  if (file !== root && !file.startsWith(root + path.sep))
    throw new Error("coding version path escapes the repository");
  return file;
}

function hashWorktree(
  root: string,
  name: string,
): { sha256: string; bytes: number; mode: number } | "overflow" | null {
  const file = assertRepoPath(root, name);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(file);
    return {
      sha256: digest(`symlink:${link}`),
      bytes: Buffer.byteLength(link),
      mode: stat.mode,
    };
  }
  if (!stat.isFile()) throw new Error("unsupported coding version file type");
  if (stat.size > MAX_FILE_BYTES) return "overflow";
  return {
    sha256: digest(fs.readFileSync(file)),
    bytes: stat.size,
    mode: stat.mode,
  };
}

export function captureCodingTree(cwd: string): CodingTreeSnapshot {
  if (!path.isAbsolute(cwd))
    throw new Error("coding workflow requires an absolute repository cwd");
  const repository = fs.realpathSync(
    gitText(cwd, ["rev-parse", "--show-toplevel"]).trim(),
  );
  if (
    gitText(repository, ["ls-files", "--stage"])
      .split("\n")
      .some((line) => line.startsWith("160000 "))
  )
    throw new Error("coding v1 does not fingerprint submodules");
  let headSha: string;
  try {
    headSha = gitText(repository, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new Error(
      "coding workflow needs a local commit to use as the base SHA",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("unexpected git SHA");
  const branch = gitText(repository, ["rev-parse", "--abbrev-ref", "HEAD"])
    .trim()
    .slice(0, 200);
  const staged = gitBuffer(repository, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
  ]);
  const unstaged = gitBuffer(repository, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
  ]);
  const overflow = staged === "overflow" || unstaged === "overflow";
  const stagedNames = nulSplit(
    gitText(repository, ["diff", "--name-only", "-z", "--cached"]),
  );
  const unstagedNames = nulSplit(
    gitText(repository, ["diff", "--name-only", "-z"]),
  );
  const untrackedNames = nulSplit(
    gitText(repository, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--full-name",
    ]),
  );
  const names = [
    ...new Set([...stagedNames, ...unstagedNames, ...untrackedNames]),
  ].sort();
  if (names.length > MAX_FILES)
    throw new Error("too many changed files to fingerprint");
  const files: CodingFileRecord[] = [];
  let total = 0;
  let fileOverflow = false;
  for (const name of names) {
    const untracked = untrackedNames.includes(name);
    const hashed = hashWorktree(repository, name);
    if (hashed === "overflow") {
      fileOverflow = true;
      break;
    }
    const bytes = hashed?.bytes ?? 0;
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      fileOverflow = true;
      break;
    }
    let indexSha256: string | null = null;
    if (!untracked) {
      try {
        const blob = gitText(repository, [
          "rev-parse",
          "--verify",
          `:${name}`,
        ]).trim();
        indexSha256 = /^[0-9a-f]{40}$/.test(blob) ? blob : null;
      } catch {
        indexSha256 = null;
      }
    }
    files.push({
      path: name,
      indexSha256,
      worktreeSha256: untracked ? null : (hashed?.sha256 ?? null),
      untrackedSha256: untracked ? (hashed?.sha256 ?? null) : null,
      bytes,
      mode: hashed?.mode ?? null,
    });
  }
  return {
    repository,
    branch,
    headSha,
    stagedDiffSha256: staged === "overflow" ? "overflow" : digest(staged),
    unstagedDiffSha256: unstaged === "overflow" ? "overflow" : digest(unstaged),
    overflow: overflow || fileOverflow,
    files,
  };
}

export function baselineFingerprint(snapshot: CodingTreeSnapshot): string {
  return digest(
    JSON.stringify({
      repository: snapshot.repository,
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      stagedDiffSha256: snapshot.stagedDiffSha256,
      unstagedDiffSha256: snapshot.unstagedDiffSha256,
      overflow: snapshot.overflow,
      files: snapshot.files,
    }),
  );
}

function sameFile(
  left: CodingFileRecord | undefined,
  right: CodingFileRecord,
): boolean {
  if (!left) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function versionFromBaseline(
  baseline: CodingTreeSnapshot,
  current: CodingTreeSnapshot,
): CodingVersion {
  if (baseline.repository !== current.repository)
    throw new Error("coding version repository changed");
  const baseFiles = new Map(baseline.files.map((file) => [file.path, file]));
  const changed = current.files.filter(
    (file) => !sameFile(baseFiles.get(file.path), file),
  );
  for (const file of baseline.files)
    if (!current.files.some((item) => item.path === file.path))
      changed.push({
        ...file,
        worktreeSha256: null,
        untrackedSha256: null,
        indexSha256: null,
        bytes: 0,
        mode: null,
      });
  let committed: string[] = [];
  if (current.headSha !== baseline.headSha) {
    if (
      !/^[0-9a-f]{40}$/.test(baseline.headSha) ||
      !/^[0-9a-f]{40}$/.test(current.headSha)
    )
      throw new Error("unexpected git SHA");
    committed = nulSplit(
      gitText(current.repository, [
        "diff",
        "--name-only",
        "-z",
        baseline.headSha,
        current.headSha,
      ]),
    );
  }
  const deliveryPaths = [
    ...new Set([...changed.map((file) => file.path), ...committed]),
  ].sort();
  const dirty =
    changed.length > 0 ||
    current.stagedDiffSha256 !== baseline.stagedDiffSha256 ||
    current.unstagedDiffSha256 !== baseline.unstagedDiffSha256;
  const headMoved = current.headSha !== baseline.headSha;
  const mode = headMoved ? (dirty ? "mixed" : "committed") : "uncommitted";
  const untracked = changed
    .filter((file) => file.untrackedSha256)
    .map((file) => ({
      path: file.path,
      sha256: file.untrackedSha256!,
      bytes: file.bytes,
    }));
  const overflow = baseline.overflow || current.overflow;
  const fingerprint = digest(
    JSON.stringify({
      mode,
      baseSha: baseline.headSha,
      headSha: current.headSha,
      stagedDiffSha256: current.stagedDiffSha256,
      unstagedDiffSha256: current.unstagedDiffSha256,
      delivery: changed,
      committed,
      overflow,
    }),
  );
  return {
    mode,
    baseSha: baseline.headSha,
    headSha: current.headSha,
    branch: current.branch,
    fingerprint,
    stagedDiffSha256: current.stagedDiffSha256,
    unstagedDiffSha256: current.unstagedDiffSha256,
    deliveryPaths,
    untracked,
    overflow,
  };
}

export function captureCodingBaseline(cwd: string): CodingTreeSnapshot {
  return captureCodingTree(cwd);
}

export function assertArtifactsOutsideWorktree(
  artifactDir: string,
  repository: string,
): void {
  const repo = fs.realpathSync(repository);
  const resolved = path.resolve(artifactDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const artifact = fs.realpathSync(resolved);
  if (
    artifact === repo ||
    artifact.startsWith(repo + path.sep) ||
    repo.startsWith(artifact + path.sep)
  )
    throw new Error("coding artifacts must stay outside the worktree");
}

export function writeCodingArtifact(
  journalDir: string,
  repository: string,
  taskId: string,
  artifactId: string,
  body: unknown,
): string {
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId) ||
    !/^a-[A-Za-z0-9_-]{1,120}$/.test(artifactId)
  )
    throw new Error("invalid coding artifact identity");
  const root = path.resolve(journalDir, "artifacts", taskId);
  assertArtifactsOutsideWorktree(root, repository);
  const file = path.resolve(root, `${artifactId}.json`);
  if (!file.startsWith(fs.realpathSync(root) + path.sep))
    throw new Error("artifact path escapes task scope");
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_ARTIFACT_BYTES)
    throw new Error("coding artifact exceeds the size limit");
  const tmp = `${file}.${createHash("sha256").update(payload).digest("hex").slice(0, 12)}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

export function readCodingArtifact(
  journalDir: string,
  taskId: string,
  artifactId: string,
): unknown {
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId) ||
    !/^a-[A-Za-z0-9_-]{1,120}$/.test(artifactId)
  )
    throw new Error("invalid coding artifact identity");
  const root = path.resolve(journalDir, "artifacts", taskId);
  const file = path.resolve(root, `${artifactId}.json`);
  const rootReal = fs.realpathSync(root);
  const fileReal = fs.realpathSync(file);
  if (!fileReal.startsWith(rootReal + path.sep))
    throw new Error("artifact path escapes task scope");
  const stat = fs.statSync(fileReal);
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
    throw new Error("coding artifact exceeds the read limit");
  return JSON.parse(fs.readFileSync(fileReal, "utf8"));
}
