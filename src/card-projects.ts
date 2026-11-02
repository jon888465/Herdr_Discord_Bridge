// 營運卡片的「異動專案」（ADR-0002 決定 4）：專案名稱與內文 `## 異動專案` 區塊。
//
// 專案名稱是 <機器 id>:<repo 目錄名>（使用者 2026-11-02 決定）。區塊和「流程紀錄」不同，
// 是「更新」而不是「只追加」：head commit 會變、PR 網址是後來才有。

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { PROJECT_NAME } from "./card.js";
import {
  absolutePath,
  BRANCH,
  bad,
  FieldError,
  MACHINE,
  sha12,
  text,
  url,
  type Fields,
} from "./card-fields.js";
import { redactSecrets } from "./redact.js";

export const PROJECTS_HEADING = "## 異動專案";
/** 單一欄位疑似含機敏內容時，該欄位改寫成這段固定訊息。 */
export const FIELD_OMITTED = "（已省略：疑似含機敏資料）";

export interface ProjectInfo {
  /** `local` 或 `machines` 設定裡的機器 id。 */
  machine: string;
  /** 絕對路徑；專案名稱取自它的最後一段。 */
  repoPath: string;
  branch?: string;
  worktreePath?: string;
  baseSha?: string;
  headSha?: string;
  prUrl?: string;
  remote?: string;
}

export type UpsertResult =
  | {
      ok: true;
      body: string;
      changed: boolean;
      name: string;
      /** 因疑似機敏而被省略的欄位名稱。 */
      omitted: string[];
    }
  | { ok: false; error: string };

function directoryPart(directory: string): string {
  const sanitized = directory.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (
    sanitized === directory &&
    directory.length <= 64 &&
    !/^\.+$/.test(directory)
  )
    return directory;
  // 名稱被改過就加上原始名稱的雜湊，避免 "My Project" 與 "My-Project" 撞名。
  const base = sanitized.replace(/^-+|-+$/g, "");
  const usable = base === "" || /^\.+$/.test(base) ? "p" : base.slice(0, 59);
  const hash = createHash("sha256")
    .update(directory, "utf8")
    .digest("hex")
    .slice(0, 4);
  return `${usable}-${hash}`;
}

/** `<機器 id>:<repo 目錄名>`；機器 id 不合法時回傳 null。 */
export function projectName(machine: string, directory: string): string | null {
  const name = `${machine}:${directoryPart(directory)}`;
  return PROJECT_NAME.test(name) ? name : null;
}

const FIELDS = [
  ["machine", "機器"],
  ["repoPath", "repo"],
  ["branch", "分支"],
  ["worktreePath", "worktree"],
  ["baseSha", "base"],
  ["headSha", "head"],
  ["prUrl", "PR"],
  ["remote", "remote"],
] as const;
type FieldKey = (typeof FIELDS)[number][0];
const LABEL_OF = new Map<string, FieldKey>(
  FIELDS.map(([key, label]) => [label, key]),
);
const KNOWN_LINE = new RegExp(
  `^- (${FIELDS.map(([, label]) => label).join("|")})：(.*)$`,
);
const HEADING_LINE = /^## 異動專案[ \t]*$/;
const ANY_H2 = /^## /;
const SUBSECTION = /^### (.+?)[ \t]*$/;

function remoteUrl(fields: Fields, key: string): string {
  const value = fields[key];
  const httpLike = /^(?:https?|ssh|git):\/\/\S+$/;
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/;
  if (
    typeof value !== "string" ||
    value.length > 150 ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    !(httpLike.test(value) || scpLike.test(value))
  )
    bad(key, "git remote URL without spaces, at most 150 characters");
  return redactSecrets(value);
}

/** 驗證並整理出要顯示的欄位值（sha 取前 12 位、網址已清理）；缺少的選填欄位不出現。 */
function collect(info: ProjectInfo): {
  name: string;
  values: Partial<Record<FieldKey, string>>;
  omitted: string[];
} {
  const fields = info as unknown as Fields;
  const machine = text(fields, "machine", MACHINE, "machine id");
  const repoPath = absolutePath(fields, "repoPath");
  if (redactSecrets(repoPath) !== repoPath)
    bad("repoPath", "looks like it contains a secret");
  const name = projectName(machine, posix.basename(repoPath));
  if (name === null)
    bad("machine", "not a valid machine id for a project name");
  if (redactSecrets(name) !== name)
    bad("repoPath", "its directory name looks like it contains a secret");

  const values: Partial<Record<FieldKey, string>> = { machine, repoPath };
  const present = (key: string): boolean => fields[key] !== undefined;
  if (present("branch"))
    values.branch = text(
      fields,
      "branch",
      BRANCH,
      "letters, digits, . _ / -, at most 80",
    );
  if (present("worktreePath"))
    values.worktreePath = absolutePath(fields, "worktreePath");
  if (present("baseSha")) values.baseSha = sha12(fields, "baseSha");
  if (present("headSha")) values.headSha = sha12(fields, "headSha");
  if (present("prUrl")) values.prUrl = url(fields, "prUrl");
  if (present("remote")) values.remote = remoteUrl(fields, "remote");

  const omitted: string[] = [];
  for (const key of Object.keys(values) as FieldKey[]) {
    const value = values[key] as string;
    if (
      key !== "machine" &&
      key !== "repoPath" &&
      redactSecrets(value) !== value
    ) {
      values[key] = FIELD_OMITTED;
      omitted.push(key);
    }
  }
  return { name, values, omitted };
}

interface Subsection {
  name: string;
  known: Map<FieldKey, string>;
  others: string[];
}

function parseSubsections(lines: string[]): {
  preamble: string[];
  subsections: Subsection[];
} {
  const preamble: string[] = [];
  const subsections: Subsection[] = [];
  let current: Subsection | undefined;
  for (const line of lines) {
    const heading = SUBSECTION.exec(line);
    if (heading) {
      current = { name: heading[1], known: new Map(), others: [] };
      subsections.push(current);
      continue;
    }
    if (!current) {
      preamble.push(line);
      continue;
    }
    const known = KNOWN_LINE.exec(line);
    if (known) {
      const key = LABEL_OF.get(known[1]) as FieldKey;
      if (!current.known.has(key)) current.known.set(key, known[2]);
    } else if (line.trim() !== "") {
      current.others.push(line);
    }
  }
  return { preamble, subsections };
}

function renderSubsection(sub: Subsection): string[] {
  const lines = ["### " + sub.name, ""];
  for (const [key, label] of FIELDS) {
    const value = sub.known.get(key);
    if (value !== undefined) lines.push(`- ${label}：${value}`);
  }
  return [...lines, ...sub.others, ""];
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * 在內文的「## 異動專案」更新或新增該專案的小節；沒有區塊就建在內文最後。
 * 提供的欄位會覆蓋，沒提供的欄位保留；人寫的行與說明保留；區塊以外的文字逐字不變。
 * 疑似機敏的欄位只省略該欄位（改成固定訊息）；專案名稱本身疑似機敏則整個拒絕。
 */
export function upsertProjectSection(
  body: string,
  info: ProjectInfo,
): UpsertResult {
  let collected;
  try {
    collected = collect(info);
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, error: error.message };
    throw error;
  }
  const { name, values, omitted } = collected;

  const lines = body.split("\n");
  const heading = lines.findIndex((line) => HEADING_LINE.test(line));

  const fresh: Subsection = {
    name,
    known: new Map(Object.entries(values) as [FieldKey, string][]),
    others: [],
  };

  if (heading < 0) {
    const base = body.replace(/\n+$/, "");
    const prefix = base === "" ? "" : `${base}\n\n`;
    const section = [PROJECTS_HEADING, "", ...renderSubsection(fresh)];
    return {
      ok: true,
      changed: true,
      name,
      omitted,
      body: `${prefix}${section.join("\n")}`,
    };
  }

  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (ANY_H2.test(lines[i])) {
      end = i;
      break;
    }
  }
  const { preamble, subsections } = parseSubsections(
    lines.slice(heading + 1, end),
  );
  const existing = subsections.find((sub) => sub.name === name);
  let changed = existing === undefined;
  if (existing) {
    for (const [key, value] of fresh.known) {
      if (existing.known.get(key) !== value) {
        existing.known.set(key, value);
        changed = true;
      }
    }
  } else {
    subsections.push(fresh);
  }
  if (!changed) return { ok: true, changed: false, name, omitted, body };

  const lead = trimBlank(preamble);
  const rebuilt = [
    PROJECTS_HEADING,
    "",
    ...(lead.length ? [...lead, ""] : []),
    ...subsections.flatMap(renderSubsection),
  ];
  return {
    ok: true,
    changed: true,
    name,
    omitted,
    body: [...lines.slice(0, heading), ...rebuilt, ...lines.slice(end)].join(
      "\n",
    ),
  };
}
