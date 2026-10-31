import { buildCard, isCardDate, readCardDocument, type Card } from "./card.js";

export interface ImportOptions {
  slug?: string;
  today: string;
  existingIds: ReadonlySet<string>;
}

export type ImportResult =
  | { ok: true; card: Card; filename: string; notes: string[] }
  | { ok: false; error: string; code: "exists" | "invalid" };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ID_PREFIX: Record<string, string> = { requirement: "REQ", ticket: "TKT" };

function fail(
  error: string,
  code: "exists" | "invalid" = "invalid",
): ImportResult {
  return { ok: false, error, code };
}

function generateId(
  type: unknown,
  options: ImportOptions,
): { id: string } | { error: string } {
  if (typeof type !== "string" || !Object.hasOwn(ID_PREFIX, type))
    return { error: 'cannot generate an id without a valid "type"' };
  if (options.slug === undefined)
    return { error: "the card has no id: a slug is required to generate one" };
  if (!SLUG_PATTERN.test(options.slug))
    return { error: "slug must match [a-z0-9][a-z0-9-]{1,40}" };
  if (!isCardDate(options.today))
    return { error: "today must be a valid YYYY-MM-DD date" };
  const date = options.today.replaceAll("-", "");
  return { id: `${ID_PREFIX[type]}-${date}-${options.slug}` };
}

export function importCard(text: string, options: ImportOptions): ImportResult {
  const read = readCardDocument(text);
  if (!read.ok) return fail(read.error);
  const notes: string[] = [];
  if (!read.document.fields.has("id")) {
    const generated = generateId(read.document.fields.get("type"), options);
    if ("error" in generated) return fail(generated.error);
    read.document.fields.set("id", generated.id);
    notes.push(`id generated: ${generated.id}`);
  }
  const built = buildCard(read.document);
  if (!built.ok) return fail(built.error);
  if (options.existingIds.has(built.card.id))
    return fail(`card ${built.card.id} already exists`, "exists");
  const card = { ...built.card };
  if (card.status !== "draft") {
    notes.push(`status ${card.status} -> draft`);
    card.status = "draft";
  }
  if (card.external !== undefined) {
    if (Object.values(card.external).some((value) => value !== null))
      notes.push("external cleared");
    delete card.external;
  }
  return { ok: true, card, filename: `${card.id}.md`, notes };
}
