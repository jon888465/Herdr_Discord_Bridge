// 專案政策（追蹤清單 F1，使用者 2026-11-03 決定）：每個專案的自動化等級。
//
// - **只放在 plugin 設定目錄**（`<config dir>/policy.yml`），**不放在專案 repo**：Agent 在 worktree
//   裡改 repo 內的檔案不會影響 bridge 的權限。bridge 只讀、永不寫這個檔案。
// - 受限 YAML 子集、自己解析（與卡片 frontmatter 同一套做法，不加相依套件）：只認下面的結構，
//   未知的 key、不合法的值一律拒絕。
// - **安全預設**：檔案不存在、不合法或不安全時，所有專案都是 L0（不 push）。
// - 等級：L0 只在 worktree／分支工作、不 push；L1 push 分支並開 PR、由人 merge；L2 review 與
//   測試與 CI 都過後自動 merge。**目前只有載入與查詢，還沒有任何動作依政策行為。**
//
// 檔案格式：
//   version: 1
//   default: L0
//   projects:
//     local:Herdr_Discord_Bridge: L1
//
// H2 自動撿卡（使用者 2026-11-05 決定）：政策檔明確選用才會有任何專案被自動撿卡——
//   autopick_lead: claude, codex   # claude、codex、agy、pi，可列多個（預設 claude）；第一個是預設，卡片的 `lead` 只能選清單內的；一次仍只做一張卡
//   autopick:
//     local:Herdr_Discord_Bridge: /path/to/Herdr_Discord_Bridge   # 專案 → repo 絕對路徑
// 規則：autopick 的專案必須也明確列在 projects 裡（不能靠 default，避免寬鬆的 default 讓工作自己開始）；
// 自動做到哪一步由該專案的等級決定（L0 到 commit、L1 到 PR、L2 一路到 merge），見 `src/autopick.ts`。
//
// 限制：同一個 OS 使用者的任何程序（包含 Agent）都能改這個檔案；這裡只拒絕「別人可寫」的檔案，
// 不能防止同一使用者的 Agent。

import fs from "node:fs";
import { PROJECT_NAME } from "./card.js";

export type PolicyLevel = "L0" | "L1" | "L2";
export const AUTOPICK_LEADS = ["claude", "codex", "agy", "pi"] as const;
export type AutopickLead = (typeof AUTOPICK_LEADS)[number];

export function autopickLeadLabel(kind: AutopickLead, cardId: string): string {
  return `autopick-${kind}-${cardId}`.slice(0, 60);
}
export interface Policy {
  default: PolicyLevel;
  projects: Record<string, PolicyLevel>;
  /** 專案 → repo 絕對路徑；沒有 autopick 區塊時整個欄位不存在。 */
  autopick?: Record<string, string>;
  /** 自動撿卡預設的 Lead 種類（`autopick_lead` 清單的第一個）；只有設定過才存在，預設 claude。 */
  autopickLead?: AutopickLead;
  /** `autopick_lead` 允許的全部 Lead 種類（依設定順序）；卡片的 `lead` 只能從這裡選。 */
  autopickLeads?: AutopickLead[];
}

export const DEFAULT_POLICY: Policy = Object.freeze({
  default: "L0",
  projects: Object.freeze({}) as Record<string, PolicyLevel>,
}) as Policy;

const LEVELS: readonly string[] = ["L0", "L1", "L2"];
const MAX_LINE_CHARS = 200;
const MAX_PROJECTS = 200;
export const POLICY_MAX_BYTES = 16 * 1024;
const TOP_KEYS = [
  "version",
  "default",
  "projects",
  "autopick",
  "autopick_lead",
];
const MAX_AUTOPICK = 20;

export type ParsePolicyResult =
  { ok: true; policy: Policy } | { ok: false; error: string };

const isLevel = (value: string | undefined): value is PolicyLevel =>
  value !== undefined && LEVELS.includes(value);

export function parsePolicy(text: string): ParsePolicyResult {
  const fail = (line: number, message: string): ParsePolicyResult => ({
    ok: false,
    error: `line ${line}: ${message}`,
  });
  const seen = new Set<string>();
  const policy: Policy = { default: "L0", projects: {} };
  let version: string | undefined;
  let section: "projects" | "autopick" | undefined;
  let count = 0;
  let autopickCount = 0;

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, raw] of lines.entries()) {
    const n = index + 1;
    if (Array.from(raw).length > MAX_LINE_CHARS)
      return fail(n, `longer than ${MAX_LINE_CHARS} characters`);
    if (raw.includes("\t")) return fail(n, "tabs are not allowed; use spaces");
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const match = /^([A-Za-z_]+):(?: +(.*))?$/.exec(line);
      if (!match) return fail(n, 'expected "key: value"');
      const [, key, value] = match;
      if (!TOP_KEYS.includes(key)) return fail(n, `unknown key "${key}"`);
      if (seen.has(key)) return fail(n, `duplicate key "${key}"`);
      seen.add(key);
      section = key === "projects" || key === "autopick" ? key : undefined;
      if (key === "autopick_lead") {
        const kinds = (value ?? "").split(",").map((item) => item.trim());
        if (
          value === undefined ||
          kinds.some(
            (kind) => !AUTOPICK_LEADS.some((known) => known === kind),
          ) ||
          new Set(kinds).size !== kinds.length
        )
          return fail(
            n,
            `invalid "autopick_lead"; use one or more distinct of ${AUTOPICK_LEADS.join(", ")}, separated by commas`,
          );
        policy.autopickLeads = kinds as AutopickLead[];
        policy.autopickLead = policy.autopickLeads[0];
      } else if (key === "version") {
        if (value !== "1")
          return fail(n, 'unsupported version; only "version: 1" is known');
        version = value;
      } else if (key === "default") {
        if (!isLevel(value))
          return fail(n, `invalid level for "default"; use L0, L1 or L2`);
        policy.default = value;
      } else if (
        value !== undefined &&
        (key === "projects" || key === "autopick")
      )
        return fail(
          n,
          `"${key}" must be followed by an indented block, not a value`,
        );
      continue;
    }

    if (indent !== 2 || !section) return fail(n, "unexpected indentation");
    if (section === "autopick") {
      const entry = line.slice(2);
      const at = entry.indexOf(": ");
      if (at < 0) return fail(n, 'expected "<project>: <repo absolute path>"');
      const name = entry.slice(0, at);
      const repoPath = entry.slice(at + 2).trim();
      if (!PROJECT_NAME.test(name))
        return fail(
          n,
          `invalid project name "${name}"; use <machine>:<directory>, for example local:Foo`,
        );
      if (
        !repoPath.startsWith("/") ||
        repoPath.split("/").includes("..") ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f]/.test(repoPath)
      )
        return fail(
          n,
          `autopick path for ${name} must be an absolute path without ".." or control characters`,
        );
      policy.autopick ??= {};
      if (Object.hasOwn(policy.autopick, name))
        return fail(n, `duplicate autopick project ${name}`);
      if (++autopickCount > MAX_AUTOPICK)
        return fail(n, `more than ${MAX_AUTOPICK} autopick projects`);
      policy.autopick[name] = repoPath;
      continue;
    }
    const entry = line.slice(2);
    const split = entry.lastIndexOf(": ");
    if (split < 0) return fail(n, 'expected "<project>: <level>"');
    const name = entry.slice(0, split);
    const level = entry.slice(split + 2);
    if (!PROJECT_NAME.test(name))
      return fail(
        n,
        `invalid project name "${name}"; use <machine>:<directory>, for example local:Foo`,
      );
    if (!isLevel(level))
      return fail(n, `invalid level for ${name}; use L0, L1 or L2`);
    if (Object.hasOwn(policy.projects, name))
      return fail(n, `duplicate project ${name}`);
    if (++count > MAX_PROJECTS)
      return fail(n, `more than ${MAX_PROJECTS} projects`);
    policy.projects[name] = level;
  }
  if (version === undefined)
    return { ok: false, error: 'missing "version: 1"' };
  for (const name of Object.keys(policy.autopick ?? {}))
    if (!Object.hasOwn(policy.projects, name))
      return {
        ok: false,
        error: `autopick project ${name} must also be listed under "projects" with an explicit level`,
      };
  return { ok: true, policy };
}

/** 專案名稱（`<機器 id>:<repo 目錄名>`）的等級；沒列出的專案用 default。 */
export function levelFor(policy: Policy, projectName: string): PolicyLevel {
  return Object.hasOwn(policy.projects, projectName)
    ? policy.projects[projectName]
    : policy.default;
}

/** 這個專案是否被選用自動撿卡：回傳 repo 路徑、等級與 Lead 種類；沒有選用回傳 undefined。 */
export function autopickFor(
  policy: Policy,
  projectName: string,
  requestedLead?: string,
): { repoPath: string; level: PolicyLevel; lead: AutopickLead } | undefined {
  if (!policy.autopick || !Object.hasOwn(policy.autopick, projectName))
    return undefined;
  const allowed = policy.autopickLeads ?? [policy.autopickLead ?? "claude"];
  // 卡片指定的 Lead 不在政策清單內就不撿（回傳 undefined），不默默改用別的 Lead，也不能靠卡片提權。
  const lead = requestedLead ?? allowed[0];
  if (!allowed.some((kind) => kind === lead)) return undefined;
  return {
    repoPath: policy.autopick[projectName],
    level: levelFor(policy, projectName),
    lead: lead as AutopickLead,
  };
}

export interface LoadedPolicy {
  /** missing＝沒有這個檔案（不是錯誤）；invalid／unsafe 時 `policy` 是安全預設（全部 L0）。 */
  status: "loaded" | "missing" | "invalid" | "unsafe";
  policy: Policy;
  file: string;
  error?: string;
}

export function loadPolicy(file: string): LoadedPolicy {
  const fallback = (
    status: "invalid" | "unsafe",
    error: string,
  ): LoadedPolicy => ({ status, policy: DEFAULT_POLICY, file, error });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing", policy: DEFAULT_POLICY, file };
    throw error;
  }
  if (stat.isSymbolicLink())
    return fallback("unsafe", `${file} is a symbolic link; refusing to use it`);
  if (!stat.isFile())
    return fallback("unsafe", `${file} is not a regular file`);
  if (stat.size > POLICY_MAX_BYTES)
    return fallback("unsafe", `${file} is larger than 16 KiB`);
  const mode = stat.mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o022) !== 0)
    return fallback(
      "unsafe",
      `${file} can be modified by group or others (mode ${mode.toString(8)}); run: chmod 600 ${file}`,
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(file),
    );
  } catch {
    return fallback("invalid", `${file} is not valid UTF-8`);
  }
  const parsed = parsePolicy(text);
  if (!parsed.ok) return fallback("invalid", parsed.error);
  return { status: "loaded", policy: parsed.policy, file };
}
