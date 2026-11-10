/** Malformed cards cannot use CardStore's normal ledger. Never rewrite the card. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureCardsDirectory } from "./card-directory.js";
import {
  isCardId,
  LEDGER_MAX_FILE_BYTES,
  parseNotifyTarget,
  PROJECT_NAME,
} from "./card.js";
import { classifyRoleRejection } from "./card-notify.js";
import { autopickFor, type LoadedPolicy } from "./policy.js";
import { redactSecrets } from "./redact.js";

export interface CardRejection {
  id: string;
  fingerprint: string;
  reason: string;
  updatedAt: string;
  notify?: string;
  delivery: "pending" | "sent" | "no_trusted_route";
  attempts: number;
  lastError?: string;
}
function diagnosticDirectory(cards: string): string {
  const root = ensureCardsDirectory(cards, { create: false });
  if (!root.ok || !root.exists)
    throw new Error(root.ok ? "cards directory missing" : root.error);
  const directory = path.join(cards, ".role-rejections");
  const checked = ensureCardsDirectory(directory, { create: true });
  if (!checked.ok) throw new Error(checked.error);
  return directory;
}
export function readCardRejection(
  cards: string,
  id: string,
): CardRejection | undefined {
  if (!isCardId(id)) return;
  const file = path.join(diagnosticDirectory(cards), `${id}.json`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192)
      throw new Error("unsafe rejection diagnostic");
    const value = JSON.parse(fs.readFileSync(fd, "utf8")) as CardRejection;
    if (
      value.id !== id ||
      typeof value.reason !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      !["pending", "sent", "no_trusted_route"].includes(value.delivery) ||
      (value.notify !== undefined && !parseNotifyTarget(value.notify))
    )
      throw new Error("invalid rejection diagnostic");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function save(cards: string, value: CardRejection): void {
  const directory = diagnosticDirectory(cards);
  const temporary = path.join(directory, `${value.id}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, path.join(directory, `${value.id}.json`));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
/** Only a bounded regular file with exactly one unambiguous id/status/notify
 * can supply a route. Symlinks, duplicate identity keys, quoted escapes and
 * mismatched filename/id never supply notification destinations. */
export function malformedCardIdentity(
  cards: string,
  file: string,
):
  | {
      id: string;
      fingerprint: string;
      notify?: string;
      status?: string;
      projects?: string[];
    }
  | undefined {
  const id = path.basename(file, ".md");
  if (!isCardId(id) || path.basename(file) !== `${id}.md`) return;
  const checked = ensureCardsDirectory(cards, { create: false });
  if (!checked.ok || !checked.exists) throw new Error("unsafe cards directory");
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path.join(cards, `${id}.md`),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > LEDGER_MAX_FILE_BYTES)
      return {
        id,
        fingerprint: createHash("sha256")
          .update(`unsafe:${stat.size}:${stat.mtimeMs}`)
          .digest("hex"),
      };
    const bytes = fs.readFileSync(fd);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const lines = raw
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    const end = lines.indexOf("---", 1);
    if (
      lines[0] !== "---" ||
      end < 0 ||
      Buffer.byteLength(lines.slice(1, end).join("\n")) > 8192
    )
      return { id, fingerprint };
    const header = lines.slice(1, end);
    const scalar = (key: string): string | undefined => {
      const matches = header.filter((l) =>
        new RegExp(`^\\s*${key}\\s*:`).test(l),
      );
      if (matches.length !== 1) return;
      const m = new RegExp(`^${key}: +(?:"([^"\\\\]*)"|([^"'\\\\#]+))$`).exec(
        matches[0]!,
      );
      return (m?.[1] ?? m?.[2])?.trim();
    };
    const inlineProjects = (): string[] => {
      const matches = header.filter((l) => /^\s*projects\s*:/.test(l));
      if (matches.length !== 1) return [];
      const m = /^projects: +\[([^\]]*)\]\s*(?:#.*)?$/.exec(matches[0]!);
      if (!m) return [];
      const body = m[1]!.trim();
      if (!body) return [];
      const out: string[] = [];
      for (const part of body.split(",")) {
        const item =
          /^"(?:([^"\\]*))"|^([^"'\\#]+)$/.exec(part.trim())?.[1]?.trim() ??
          /^"(?:([^"\\]*))"|^([^"'\\#]+)$/.exec(part.trim())?.[2]?.trim();
        if (!item || !PROJECT_NAME.test(item)) return [];
        out.push(item);
      }
      return out;
    };
    const validId = scalar("id") === id;
    const status = validId ? scalar("status") : undefined;
    const singleProject = validId ? scalar("project") : undefined;
    const projects = validId
      ? [
          ...inlineProjects(),
          ...(singleProject && PROJECT_NAME.test(singleProject)
            ? [singleProject]
            : []),
        ]
      : [];
    const notify = scalar("notify");
    return {
      id,
      fingerprint,
      ...(status ? { status } : {}),
      ...(projects.length ? { projects } : {}),
      ...(validId && status === "ready" && notify && parseNotifyTarget(notify)
        ? { notify }
        : {}),
    };
  } catch (error) {
    // No destination is extracted from an unreadable or unsafe source.
    return {
      id,
      fingerprint: createHash("sha256")
        .update(
          `unreadable:${(error as NodeJS.ErrnoException).code ?? "invalid"}`,
        )
        .digest("hex"),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function malformedCardAutopickEligible(
  cards: string,
  file: string,
  loaded: LoadedPolicy,
): boolean {
  if (loaded.status !== "loaded") return false;
  const identity = malformedCardIdentity(cards, file);
  if (!identity || identity.status !== "ready" || !identity.projects?.length)
    return false;
  return identity.projects.some((project) =>
    Boolean(autopickFor(loaded.policy, project)),
  );
}
export function classifyMalformedReason(reason: string): string {
  if (reason.includes("卡片角色指定無效")) return classifyRoleRejection(reason);
  if (reason.startsWith("unsupported frontmatter line"))
    return "unsupported frontmatter line";
  if (reason.startsWith("unknown status")) return "unknown status";
  if (reason.startsWith("duplicate key ")) return "duplicate key";
  if (reason.startsWith("unknown key ")) return "unknown key";
  if (reason.startsWith("empty value for ")) return "empty value";
  if (reason.startsWith('"tasks" has a duplicate entry'))
    return '"tasks" has a duplicate entry';
  if (reason.startsWith('"projects" has a duplicate entry'))
    return '"projects" has a duplicate entry';
  if (reason.startsWith("filename must be ")) return "filename mismatch";
  if (
    /^(?:missing|unterminated|frontmatter|card file|unsupported|empty|unquoted|nesting|unbalanced|invalid|expected|unknown role|"[a-z_.]+" (?:must|is|has|does|entries))/.test(
      reason,
    ) &&
    !/[\r\n]/.test(reason) &&
    reason.length <= 120
  )
    return redactSecrets(reason);
  return "卡片格式或欄位無效";
}
export async function recordMalformedRejection(
  cards: string,
  file: string,
  reason: string,
  deliver: (destination: string, message: string) => Promise<void>,
): Promise<void> {
  const identity = malformedCardIdentity(cards, file);
  if (!identity) return;
  const safeReason = classifyMalformedReason(reason)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 200);
  const fingerprint = createHash("sha256")
    .update(`${identity.fingerprint}:${safeReason}:${identity.notify ?? ""}`)
    .digest("hex");
  const previous = readCardRejection(cards, identity.id);
  const value: CardRejection =
    previous?.fingerprint === fingerprint
      ? previous
      : {
          id: identity.id,
          ...(identity.notify ? { notify: identity.notify } : {}),
          fingerprint,
          reason: safeReason,
          updatedAt: new Date().toISOString(),
          delivery: identity.notify ? "pending" : "no_trusted_route",
          attempts: 0,
        };
  save(cards, value); // Persistence must succeed before delivery; failure retries next sweep.
  if (value.delivery !== "pending" || !value.notify) return;
  value.attempts++;
  try {
    await deliver(
      value.notify,
      `[bridge 通知] ${value.id} · 卡片解析／角色指定無效 · ${value.reason}（未撿卡）`,
    );
    value.delivery = "sent";
    delete value.lastError;
  } catch {
    value.lastError = "通知未送達；下一次掃描重試（送達不確定時可能重複）";
  }
  value.updatedAt = new Date().toISOString();
  save(cards, value);
}
