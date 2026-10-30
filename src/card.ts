import path from "node:path";

export type CardType = "requirement" | "ticket";

export interface CardLinks {
  related_docs?: string[];
  related_issues?: string[];
  parent?: string;
}

export interface CardExternal {
  notion?: string | null;
  github?: string | null;
  mantis?: string | null;
}

export interface Card {
  id: string;
  type: CardType;
  status: string;
  title: string;
  version: number;
  created: string;
  updated: string;
  source?: string;
  project?: string;
  links?: CardLinks;
  external?: CardExternal;
  body: string;
}

export type ParseResult =
  { ok: true; card: Card } | { ok: false; error: string };

const REQUIRED_KEYS = [
  "id",
  "type",
  "status",
  "title",
  "version",
  "created",
  "updated",
] as const;

const KNOWN_KEYS = new Set<string>([
  ...REQUIRED_KEYS,
  "source",
  "project",
  "links",
  "external",
]);

const CARD_TYPES: readonly string[] = ["requirement", "ticket"];
const CARD_STATUSES: readonly string[] = [
  "draft",
  "discussing",
  "refined",
  "recorded",
  "ready",
  "in_progress",
  "done",
  "cancelled",
];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FRONTMATTER_BYTES = 8 * 1024;
const MAX_TITLE_LENGTH = 120;

const ID_PATTERN = /^(REQ|TKT)-\d{8}-[a-z0-9][a-z0-9-]{1,40}$/;

// key: value，key 以字母開頭；縮排、清單項目與 "<<" 合併鍵都不符合。
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$/;
const INNER_KEY = /^[A-Za-z][A-Za-z0-9_-]*/;

type Scalar = string | number | null;
type Value = Scalar | Scalar[] | { [key: string]: Scalar | Scalar[] };

class CardError extends Error {}

function reject(message: string): never {
  throw new CardError(message);
}

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos] ?? "";
  }

  skipSpaces(): number {
    const start = this.pos;
    while (this.peek() === " " || this.peek() === "\t") this.pos += 1;
    return this.pos - start;
  }
}

function readQuoted(cursor: Cursor): string {
  cursor.pos += 1;
  let out = "";
  while (!cursor.done) {
    const ch = cursor.peek();
    cursor.pos += 1;
    if (ch === '"') return out;
    if (ch === "\\") {
      const next = cursor.peek();
      if (next !== '"' && next !== "\\") reject("unsupported escape sequence");
      out += next;
      cursor.pos += 1;
    } else {
      out += ch;
    }
  }
  return reject("unterminated quoted string");
}

function toScalar(token: string): Scalar {
  if (token === "null") return null;
  if (/^-?\d+$/.test(token)) return Number(token);
  return token;
}

function readBare(cursor: Cursor, inline: boolean): Scalar {
  const rest = cursor.text.slice(cursor.pos);
  const stop = inline ? rest.search(/[,\]}]/) : rest.search(/\s#/);
  const token = (stop < 0 ? rest : rest.slice(0, stop)).trim();
  cursor.pos += stop < 0 ? rest.length : stop;
  if (token === "") reject("empty value");
  if (/^[&*!|>]/.test(token)) reject("unsupported value syntax");
  if (/:(\s|$)/.test(token)) reject("unquoted value must not contain ': '");
  return toScalar(token);
}

function readScalar(cursor: Cursor, inline: boolean): Scalar {
  cursor.skipSpaces();
  const ch = cursor.peek();
  if (ch === '"') return readQuoted(cursor);
  if (ch === "[" || ch === "{") reject("nesting is not allowed here");
  return readBare(cursor, inline);
}

function readArray(cursor: Cursor): Scalar[] {
  cursor.pos += 1;
  const items: Scalar[] = [];
  cursor.skipSpaces();
  if (cursor.peek() === "]") {
    cursor.pos += 1;
    return items;
  }
  for (;;) {
    items.push(readScalar(cursor, true));
    cursor.skipSpaces();
    const ch = cursor.peek();
    cursor.pos += 1;
    if (ch === "]") return items;
    if (ch !== ",") reject("unbalanced inline array");
  }
}

function readObject(cursor: Cursor): { [key: string]: Scalar | Scalar[] } {
  cursor.pos += 1;
  const entries: { [key: string]: Scalar | Scalar[] } = {};
  cursor.skipSpaces();
  if (cursor.peek() === "}") {
    cursor.pos += 1;
    return entries;
  }
  for (;;) {
    cursor.skipSpaces();
    const keyMatch = INNER_KEY.exec(cursor.text.slice(cursor.pos));
    if (!keyMatch) reject("invalid key in inline object");
    const key = keyMatch[0];
    cursor.pos += key.length;
    if (cursor.peek() !== ":") reject("expected ':' in inline object");
    cursor.pos += 1;
    if (key in entries) reject(`duplicate key "${key}" in inline object`);
    cursor.skipSpaces();
    entries[key] =
      cursor.peek() === "[" ? readArray(cursor) : readScalar(cursor, true);
    cursor.skipSpaces();
    const ch = cursor.peek();
    cursor.pos += 1;
    if (ch === "}") return entries;
    if (ch !== ",") reject("unbalanced inline object");
  }
}

function parseValue(raw: string): Value {
  const cursor = new Cursor(raw);
  const ch = cursor.peek();
  let value: Value;
  if (ch === "[") value = readArray(cursor);
  else if (ch === "{") value = readObject(cursor);
  else if (ch === '"') value = readQuoted(cursor);
  else value = readBare(cursor, false);
  const skipped = cursor.skipSpaces();
  if (!cursor.done) {
    if (cursor.peek() !== "#" || skipped === 0)
      reject("unexpected text after value");
  }
  return value;
}

function asString(key: string, value: Value | undefined): string {
  if (typeof value !== "string") return reject(`"${key}" must be a string`);
  return value;
}

function asStringArray(key: string, value: Value | undefined): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return reject(`"${key}" must be an array of strings`);
  return value as string[];
}

function asRecord(
  key: string,
  value: Value | undefined,
  allowed: readonly string[],
): { [key: string]: Scalar | Scalar[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return reject(`"${key}" must be an inline object`);
  for (const inner of Object.keys(value)) {
    if (!allowed.includes(inner)) reject(`unknown key "${key}.${inner}"`);
  }
  return value;
}

function buildLinks(value: Value | undefined): CardLinks {
  const record = asRecord("links", value, [
    "related_docs",
    "related_issues",
    "parent",
  ]);
  const links: CardLinks = {};
  if ("related_docs" in record)
    links.related_docs = asStringArray(
      "links.related_docs",
      record.related_docs,
    );
  if ("related_issues" in record)
    links.related_issues = asStringArray(
      "links.related_issues",
      record.related_issues,
    );
  if ("parent" in record) {
    const parent = asString("links.parent", record.parent);
    if (!ID_PATTERN.test(parent)) reject('"links.parent" is not a card id');
    links.parent = parent;
  }
  return links;
}

function buildExternal(value: Value | undefined): CardExternal {
  const record = asRecord("external", value, ["notion", "github", "mantis"]);
  const external: CardExternal = {};
  for (const key of ["notion", "github", "mantis"] as const) {
    if (!(key in record)) continue;
    const inner = record[key];
    if (inner !== null && typeof inner !== "string")
      reject(`"external.${key}" must be a string or null`);
    external[key] = inner;
  }
  return external;
}

function checkDate(key: string, value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const [year, month, day] = [match[1], match[2], match[3]].map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    )
      return value;
  }
  return reject(`"${key}" must be a valid YYYY-MM-DD date`);
}

function checkRequired(
  fields: Map<string, Value>,
  filename: string | undefined,
): Omit<Card, "body"> {
  for (const key of REQUIRED_KEYS) {
    if (!fields.has(key)) reject(`missing required field "${key}"`);
  }
  const id = asString("id", fields.get("id"));
  if (!ID_PATTERN.test(id)) reject('"id" does not match the card id format');
  if (filename !== undefined && path.basename(filename) !== `${id}.md`)
    reject(`filename must be ${id}.md`);
  const type = asString("type", fields.get("type"));
  if (!CARD_TYPES.includes(type))
    reject('"type" must be requirement or ticket');
  const status = asString("status", fields.get("status"));
  if (!CARD_STATUSES.includes(status)) reject(`unknown status "${status}"`);
  const title = asString("title", fields.get("title"));
  const titleLength = Array.from(title).length;
  if (titleLength < 1 || titleLength > MAX_TITLE_LENGTH)
    reject(`"title" must be 1 to ${MAX_TITLE_LENGTH} characters`);
  const version = fields.get("version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    reject('"version" must be a positive integer');
  return {
    id,
    type: type as CardType,
    status,
    title,
    version,
    created: checkDate("created", asString("created", fields.get("created"))),
    updated: checkDate("updated", asString("updated", fields.get("updated"))),
  };
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function parseFields(lines: string[]): Map<string, Value> {
  const fields = new Map<string, Value>();
  for (const line of lines) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = KEY_LINE.exec(line);
    if (!match) reject(`unsupported frontmatter line: ${line}`);
    const key = match[1];
    if (fields.has(key)) reject(`duplicate key "${key}"`);
    if (!KNOWN_KEYS.has(key) && !key.startsWith("x-"))
      reject(`unknown key "${key}"`);
    const raw = match[2] ?? "";
    if (raw === "") reject(`empty value for "${key}"`);
    fields.set(key, parseValue(raw));
  }
  return fields;
}

export function parseCard(text: string, filename?: string): ParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES)
    return fail("card file exceeds 256 KiB");
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  if (lines[0] !== "---") return fail("missing frontmatter start delimiter");
  const end = lines.indexOf("---", 1);
  if (end < 0) return fail("unterminated frontmatter block");
  const frontmatter = lines.slice(1, end);
  if (Buffer.byteLength(frontmatter.join("\n"), "utf8") > MAX_FRONTMATTER_BYTES)
    return fail("frontmatter exceeds 8 KiB");

  try {
    const fields = parseFields(frontmatter);
    const card: Card = {
      ...checkRequired(fields, filename),
      body: lines
        .slice(end + 1)
        .join("\n")
        .replace(/^\n/, ""),
    };
    if (fields.has("source"))
      card.source = asString("source", fields.get("source"));
    if (fields.has("project"))
      card.project = asString("project", fields.get("project"));
    if (fields.has("links")) card.links = buildLinks(fields.get("links"));
    if (fields.has("external"))
      card.external = buildExternal(fields.get("external"));
    return { ok: true, card };
  } catch (error) {
    if (error instanceof CardError) return fail(error.message);
    throw error;
  }
}
