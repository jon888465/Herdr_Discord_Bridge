import { isDeepStrictEqual } from "node:util";
import {
  formatByteLimit,
  parseCard,
  resolveMaxFileBytes,
  type Card,
  type ReadOptions,
} from "./card.js";

export type SerializeResult =
  | { ok: true; text: string }
  | { ok: false; error: string; code: "invalid" | "too_large" };

// 裸字串只在確定不會被讀成別的東西時使用；其餘一律加雙引號。
// 規則比本專案的解析器更保守，讓其他 YAML 工具也不會讀錯（例如開頭的 #）。
function needsQuotes(value: string): boolean {
  return (
    value === "" ||
    value !== value.trim() ||
    value === "null" ||
    /^-?\d+$/.test(value) ||
    /^[-#%@`'?!&*|>[\]{}",]/.test(value) ||
    /:(\s|$)|\s#|["\\,[\]{}]/.test(value)
  );
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatString(value: string): string {
  return needsQuotes(value) ? quote(value) : value;
}

function formatArray(values: string[]): string {
  return `[${values.map(formatString).join(", ")}]`;
}

function formatObject(entries: string[]): string {
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

function formatLinks(links: NonNullable<Card["links"]>): string {
  const entries: string[] = [];
  if (links.related_docs !== undefined)
    entries.push(`related_docs: ${formatArray(links.related_docs)}`);
  if (links.related_issues !== undefined)
    entries.push(`related_issues: ${formatArray(links.related_issues)}`);
  if (links.parent !== undefined)
    entries.push(`parent: ${formatString(links.parent)}`);
  return formatObject(entries);
}

function formatExternal(external: NonNullable<Card["external"]>): string {
  const entries: string[] = [];
  for (const key of ["notion", "github", "mantis"] as const) {
    const value = external[key];
    if (value === undefined) continue;
    entries.push(`${key}: ${value === null ? "null" : formatString(value)}`);
  }
  return formatObject(entries);
}

export function serializeCard(
  card: Card,
  options?: ReadOptions,
): SerializeResult {
  const lines = [
    `id: ${formatString(card.id)}`,
    `type: ${formatString(card.type)}`,
    `status: ${formatString(card.status)}`,
    `title: ${formatString(card.title)}`,
    `version: ${card.version}`,
    `created: ${formatString(card.created)}`,
    `updated: ${formatString(card.updated)}`,
  ];
  if (card.lead !== undefined) lines.push(`lead: ${formatString(card.lead)}`);
  if (card.notify !== undefined)
    lines.push(`notify: ${formatString(card.notify)}`);
  for (const key of [
    "autopick_workspace_id",
    "autopick_workspace_label",
  ] as const)
    if (card[key] !== undefined)
      lines.push(`${key}: ${formatString(card[key])}`);
  if (card.source !== undefined)
    lines.push(`source: ${formatString(card.source)}`);
  if (card.project !== undefined)
    lines.push(`project: ${formatString(card.project)}`);
  if (card.projects !== undefined)
    lines.push(`projects: ${formatArray(card.projects)}`);
  if (card.tasks !== undefined) lines.push(`tasks: ${formatArray(card.tasks)}`);
  if (card.links !== undefined) lines.push(`links: ${formatLinks(card.links)}`);
  if (card.external !== undefined)
    lines.push(`external: ${formatExternal(card.external)}`);
  const text = `---\n${lines.join("\n")}\n---\n\n${card.body}`;
  // 超過上限單獨回報，呼叫端才能與「內容不合格」分開處理。
  const maxFileBytes = resolveMaxFileBytes(options);
  if (Buffer.byteLength(text, "utf8") > maxFileBytes)
    return {
      ok: false,
      code: "too_large",
      error: `not serializable: card file exceeds ${formatByteLimit(maxFileBytes)}`,
    };
  // 寫出去的內容必須能被讀回成同一張卡；否則拒絕，避免產生讀不回來的檔案。
  const reread = parseCard(text, `${card.id}.md`, options);
  if (!reread.ok)
    return {
      ok: false,
      code: "invalid",
      error: `not serializable: ${reread.error}`,
    };
  if (!isDeepStrictEqual(reread.card, card))
    return {
      ok: false,
      code: "invalid",
      error: "not serializable: content changes when read back",
    };
  return { ok: true, text };
}
