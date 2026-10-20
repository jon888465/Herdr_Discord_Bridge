import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";

export const MAX_OUTBOUND_FILES = 10;
export const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

const MARKER =
  /^[ \t]*(?:[⏺●•][ \t]*)?\[\[discord-attach:\s*(.+?)\s*\]\][ \t]*$/gim;
const SENSITIVE =
  /(^|[\\/])(\.env(\..*)?|\.git|\.ssh|\.aws|\.gnupg|id_rsa[^\\/]*|id_ed25519[^\\/]*)([\\/]|$)/i;

export interface OutboundExtraction {
  text: string;
  requested: string[];
}

/** Pull `[[discord-attach: /abs/path]]` lines out of an Agent reply. */
export function extractAttachMarkers(text: string): OutboundExtraction {
  const requested: string[] = [];
  const stripped = text.replace(MARKER, (_m, raw: string) => {
    requested.push(raw.trim().replace(/^["'`]|["'`]$/g, ""));
    return "";
  });
  return { text: stripped.replace(/\n{3,}/g, "\n\n").trim(), requested };
}

export interface OutboundResult {
  files: { path: string; name: string }[];
  rejected: string[];
}

/** Only regular files under one of `roots` are sent; symlinks resolve before the check. */
export async function resolveOutboundFiles(
  requested: string[],
  roots: string[],
): Promise<OutboundResult> {
  const files: OutboundResult["files"] = [];
  const rejected: string[] = [];
  const realRoots: string[] = [];
  for (const root of roots)
    try {
      realRoots.push(await realpath(root));
    } catch {
      /* unavailable root */
    }
  const seen = new Set<string>();
  for (const raw of requested) {
    try {
      if (!isAbsolute(raw)) throw new Error("path must be absolute");
      if (files.length >= MAX_OUTBOUND_FILES) throw new Error("too many files");
      const real = await realpath(raw);
      if (SENSITIVE.test(real)) throw new Error("sensitive path");
      const inside = realRoots.some((root) => {
        const rel = relative(root, real);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (!inside) throw new Error("outside the Agent working directory");
      const info = await stat(real);
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.size === 0 || info.size > MAX_OUTBOUND_BYTES)
        throw new Error("file is empty or larger than 8 MiB");
      if (seen.has(real)) continue;
      seen.add(real);
      files.push({ path: real, name: basename(real) });
    } catch (error) {
      rejected.push(
        `${basename(raw) || raw}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }
  }
  return { files, rejected };
}

const SEND_BLOCK =
  /^[ \t]*(?:[⏺●•][ \t]*)?\[\[discord-send\]\][ \t]*\n([\s\S]*?)\n[ \t]*\[\[\/discord-send\]\][ \t]*$/gim;
const PROMPT_LINE = /^\s*[❯›>]\s+\S/;

export interface DirectMarkers {
  /** key → payload; key is stable for de-duplication. */
  messages: { key: string; text: string }[];
  files: { key: string; path: string }[];
}

/**
 * Herdr 直接互動（非 Discord 發起）時，只看最後一次使用者輸入列之後的畫面，
 * 取出 `[[discord-send]]…[[/discord-send]]` 文字區塊與 `[[discord-attach: 路徑]]`。
 */
export function extractDirectMarkers(screen: string): DirectMarkers {
  const lines = screen.replace(/\r/g, "").split("\n");
  let last = -1;
  lines.forEach((line, i) => {
    if (PROMPT_LINE.test(line)) last = i;
  });
  const region = lines.slice(last + 1).join("\n");
  const messages: DirectMarkers["messages"] = [];
  for (const m of region.matchAll(SEND_BLOCK)) {
    const text = m[1].replace(/^[ \t]{0,2}/gm, "").trim();
    if (text) messages.push({ key: `send:${text}`, text });
  }
  const files = extractAttachMarkers(region).requested.map((path) => ({
    key: `file:${path}`,
    path,
  }));
  return { messages, files };
}
