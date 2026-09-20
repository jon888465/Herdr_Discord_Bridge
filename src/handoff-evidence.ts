import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { stripAnsi } from "./format.js";
import type { AgentRecord } from "./types.js";

const exec = promisify(execFile);
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export interface RepositoryEvidence {
  root: string;
  head: string;
  branch: string;
  status: string;
  fingerprint: string;
}
/** Never stores patch contents or untracked file contents in the registry. */
export async function inspectRepository(
  cwd: string,
): Promise<RepositoryEvidence> {
  if (!path.isAbsolute(cwd))
    throw new Error("handoff requires an absolute local repository cwd");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  let gitCwd = cwd;
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-c", "core.fsmonitor=false", "-C", gitCwd, ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 15000,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  const root = await fs.realpath(
    (await git("rev-parse", "--show-toplevel")).trim(),
  );
  gitCwd = root;
  if (
    (await git("ls-files", "--stage"))
      .split("\n")
      .some((line) => line.startsWith("160000 "))
  )
    throw new Error(
      "submodule repositories require manual handoff verification",
    );
  const head = (await git("rev-parse", "HEAD")).trim();
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
  const status = await git(
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );
  const staged = await git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
  );
  const unstaged = await git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
  );
  const files = (
    await git("ls-files", "--others", "--exclude-standard", "-z", "--full-name")
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (files.length > 10000)
    throw new Error("too many untracked files to verify handoff");
  let total = 0;
  const hashes: string[] = [];
  for (const name of files) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep))
      throw new Error("untracked path escapes repository");
    const stat = await fs.lstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error("unsupported untracked file type");
    total += stat.size;
    if (total > 32 * 1024 * 1024)
      throw new Error("untracked files exceed handoff verification limit");
    const content = stat.isSymbolicLink()
      ? await fs.readlink(file)
      : await fs.readFile(file);
    hashes.push(JSON.stringify([name, stat.mode, digest(content)]));
  }
  if (
    head !== (await git("rev-parse", "HEAD")).trim() ||
    status !==
      (await git("status", "--porcelain=v1", "-z", "--untracked-files=all"))
  )
    throw new Error("repository changed while capturing checkpoint");
  return {
    root,
    head,
    branch,
    status: status.replace(/\0/g, "\n"),
    fingerprint: digest(
      JSON.stringify([root, head, branch, status, staged, unstaged, hashes]),
    ),
  };
}
export function agentCwd(agent: AgentRecord): string {
  const cwd = agent.foreground_cwd || agent.cwd;
  if (!cwd) throw new Error("Agent has no verified local cwd");
  return cwd;
}
export function publicText(value: string, limit = 32000): string {
  const clean = stripAnsi(value)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "[redacted token]",
    )
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:token|password|secret)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]");
  if (clean.length <= limit) return clean;
  const beginning = Math.floor(limit / 4);
  return (
    clean.slice(0, beginning) +
    "\n[history omitted]\n" +
    clean.slice(-(limit - beginning - 20))
  );
}
export interface SessionEvidence {
  adapter: string;
  sessionId: string;
  source: "codex-jsonl" | "public-export-v1" | "checkpoint-only";
  coverage: string;
  text: string;
}
export function sessionIdentity(agent: AgentRecord): string {
  const s = agent.agent_session as
    { kind?: unknown; value?: unknown } | undefined;
  if (
    !s ||
    typeof s.kind !== "string" ||
    !s.kind ||
    typeof s.value !== "string" ||
    !s.value
  )
    throw new Error("handoff requires a known session identity");
  return s.value;
}
export function adapterName(agent: AgentRecord): string {
  const kind = agent.agent?.toLowerCase() || "unknown";
  if (kind.includes("antigravity") || kind === "agy") return "agy";
  return (
    ["codex", "claude", "copilot", "opencode", "gemini"].find((name) =>
      kind.includes(name),
    ) ?? kind
  );
}
/** Explicit public export is a bridge format, not an undocumented native CLI export. */
export async function readSessionEvidence(
  agent: AgentRecord,
  repository: RepositoryEvidence,
  exportFile?: string,
): Promise<SessionEvidence> {
  const adapter = adapterName(agent);
  const sessionId = sessionIdentity(agent);
  if (exportFile) {
    const file = await fs.realpath(path.resolve(repository.root, exportFile));
    if (!file.startsWith(repository.root + path.sep))
      throw new Error("export must be inside the source repository");
    if ((await fs.stat(file)).size > 4 * 1024 * 1024)
      throw new Error("export exceeds 4 MiB");
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      data.schemaVersion !== 1 ||
      data.harness !== adapter ||
      data.sessionId !== sessionId ||
      (await fs.realpath(data.cwd)) !== repository.root ||
      !Array.isArray(data.messages)
    )
      throw new Error("public export identity/schema mismatch");
    const messages = data.messages
      .filter(
        (m: { role?: string; channel?: string; text?: unknown }) =>
          (m.role === "user" ||
            (m.role === "assistant" &&
              ["commentary", "final"].includes(m.channel || ""))) &&
          typeof m.text === "string",
      )
      .map((m: { role: string; text: string }) => `${m.role}: ${m.text}`)
      .join("\n");
    return {
      adapter,
      sessionId,
      source: "public-export-v1",
      coverage:
        "Explicit public export; only user and commentary/final text retained; bounded, completeness unverified.",
      text: publicText(messages),
    };
  }
  if (adapter === "codex" && /^[a-f0-9-]{36}$/i.test(sessionId)) {
    const root = path.join(
      process.env.CODEX_HOME || path.join(homedir(), ".codex"),
      "sessions",
    );
    const matches: string[] = [];
    let scanned = 0;
    const scan = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++scanned > 10000)
          throw new Error("session catalog exceeds scan limit");
        if (entry.isDirectory() && depth < 3)
          await scan(path.join(dir, entry.name), depth + 1);
        else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`))
          matches.push(path.join(dir, entry.name));
      }
    };
    try {
      await scan(root, 0);
      if (matches.length !== 1)
        throw new Error("exact session not uniquely available");
      if ((await fs.stat(matches[0])).size > 4 * 1024 * 1024)
        throw new Error("native history exceeds read limit");
      const rows = (await fs.readFile(matches[0], "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const meta = rows.find((r) => r.type === "session_meta")?.payload;
      if (
        meta?.id !== sessionId ||
        (await fs.realpath(meta.cwd)) !== repository.root
      )
        throw new Error("native session identity mismatch");
      const messages = rows.flatMap((row) => {
        const p = row.payload;
        if (row.type !== "event_msg" || !p) return [];
        if (p.type === "user_message" && typeof p.message === "string")
          return [`user: ${p.message}`];
        if (
          p.type === "agent_message" &&
          ["commentary", "final_answer"].includes(p.phase) &&
          typeof p.message === "string"
        )
          return [`assistant: ${p.message}`];
        return [];
      });
      if (!messages.length) throw new Error("no supported public messages");
      return {
        adapter,
        sessionId,
        source: "codex-jsonl",
        coverage:
          "Exact ID/cwd matched. Public event_msg text only; tool events, reasoning and unsupported/compacted history omitted; bounded.",
        text: publicText(messages.join("\n")),
      };
    } catch {
      /* Missing/ambiguous/unsupported native evidence falls back without invoking source. */
    }
  }
  return {
    adapter,
    sessionId,
    source: "checkpoint-only",
    coverage:
      "Native history unavailable or unsupported. Only explicit goal, repository evidence and task artifacts; partial recovery.",
    text: "",
  };
}
