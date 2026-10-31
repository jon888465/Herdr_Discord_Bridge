import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCardId, parseCard, type Card } from "./card.js";
import { importCard } from "./card-import.js";
import { serializeCard } from "./card-serialize.js";

const CARD_FILE = /^(REQ|TKT)-.*\.md$/;
const MAX_FILE_BYTES = 256 * 1024;

export type StoreErrorCode =
  "not_found" | "invalid" | "unsafe" | "too_large" | "exists" | "conflict";

export interface StoreFailure {
  ok: false;
  code: StoreErrorCode;
  error: string;
}

export interface StoredCard {
  file: string;
  card: Card;
  hash: string;
}

export interface ListResult {
  cards: StoredCard[];
  errors: { file: string; error: string }[];
}

export type ReadResult = { ok: true; card: Card; hash: string } | StoreFailure;

export type CreateResult =
  { ok: true; file: string; hash: string } | StoreFailure;

export type ImportTextResult =
  | { ok: true; file: string; hash: string; card: Card; notes: string[] }
  | StoreFailure;

export type UpdateResult =
  { ok: true; card: Card; hash: string } | StoreFailure;

type FileRead = { ok: true; text: string } | StoreFailure;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function failure(code: StoreErrorCode, error: string): StoreFailure {
  return { ok: false, code, error };
}

// 只讀一般檔案：符號連結、目錄與超大檔案都拒絕。lstat 之後再以 O_NOFOLLOW
// 開檔並用 fstat 複核，避免檢查與讀取之間被換成符號連結。
function readRegularFile(file: string): FileRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return failure("not_found", "file not found");
    throw error;
  }
  if (stat.isSymbolicLink())
    return failure("unsafe", "symbolic link is not allowed");
  if (!stat.isFile()) return failure("unsafe", "not a regular file");
  if (stat.size > MAX_FILE_BYTES)
    return failure("too_large", "file exceeds 256 KiB");
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      return failure("unsafe", "symbolic link is not allowed");
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return failure("unsafe", "not a regular file");
    if (opened.size > MAX_FILE_BYTES)
      return failure("too_large", "file exceeds 256 KiB");
    return { ok: true, text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

export class CardStore {
  constructor(private readonly rootDir: string) {}

  private cardFileNames(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => CARD_FILE.test(name)).sort();
  }

  list(): ListResult {
    const cards: StoredCard[] = [];
    const errors: { file: string; error: string }[] = [];
    for (const file of this.cardFileNames()) {
      const read = readRegularFile(path.join(this.rootDir, file));
      if (!read.ok) {
        errors.push({ file, error: read.error });
        continue;
      }
      const parsed = parseCard(read.text, file);
      if (parsed.ok)
        cards.push({ file, card: parsed.card, hash: hashText(read.text) });
      else errors.push({ file, error: parsed.error });
    }
    return { cards, errors };
  }

  // 以檔名為準，包含內容不合格的檔案：壞檔仍占用它的 id，避免被覆蓋。
  existingIds(): Set<string> {
    return new Set(this.cardFileNames().map((name) => name.slice(0, -3)));
  }

  read(id: string): ReadResult {
    if (!isCardId(id)) return failure("invalid", `"${id}" is not a card id`);
    const read = readRegularFile(path.join(this.rootDir, `${id}.md`));
    if (!read.ok)
      return read.code === "not_found"
        ? failure("not_found", `card ${id} not found`)
        : read;
    const parsed = parseCard(read.text, `${id}.md`);
    if (!parsed.ok) return failure("invalid", parsed.error);
    return { ok: true, card: parsed.card, hash: hashText(read.text) };
  }

  // 先寫暫存檔再 link 到正式名稱：link 遇到任何既有項目（含失效的符號連結）都會失敗，
  // 因此不會覆蓋；寫入中途失敗也不會留下半截的正式檔。
  create(card: Card): CreateResult {
    const serialized = serializeCard(card);
    if (!serialized.ok) return failure("invalid", serialized.error);
    const file = `${card.id}.md`;
    const target = path.join(this.rootDir, file);
    fs.mkdirSync(this.rootDir, { recursive: true });
    const temp = path.join(
      this.rootDir,
      `.${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(temp, serialized.text, { flag: "wx", mode: 0o644 });
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return failure("exists", `card ${card.id} already exists`);
      throw error;
    } finally {
      fs.unlinkSync(temp);
    }
    return { ok: true, file, hash: hashText(serialized.text) };
  }

  // 樂觀並行控制：expectedHash 必須等於目前檔案內容的雜湊，否則視為被別人改過而放棄。
  // 寫入前會再比對一次以縮小空窗，但普通檔案系統無法做到真正的原子比對並取代，
  // 因此仍假設同一時間只有一個程式在寫（bridge），人手動編輯的衝突靠雜湊偵測。
  update(
    id: string,
    expectedHash: string,
    change: (card: Card) => Card,
  ): UpdateResult {
    if (!isCardId(id)) return failure("invalid", `"${id}" is not a card id`);
    const file = `${id}.md`;
    const target = path.join(this.rootDir, file);
    const current = readRegularFile(target);
    if (!current.ok)
      return current.code === "not_found"
        ? failure("not_found", `card ${id} not found`)
        : current;
    if (hashText(current.text) !== expectedHash)
      return failure("conflict", `card ${id} changed since it was read`);
    const parsed = parseCard(current.text, file);
    if (!parsed.ok) return failure("invalid", parsed.error);

    const next = change(structuredClone(parsed.card));
    if (next.id !== id)
      return failure("invalid", "a card id cannot be changed");
    const serialized = serializeCard(next);
    if (!serialized.ok) return failure("invalid", serialized.error);
    if (serialized.text === current.text)
      return { ok: true, card: next, hash: expectedHash };

    const temp = path.join(
      this.rootDir,
      `.${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(temp, serialized.text, { flag: "wx", mode: 0o644 });
    try {
      const again = readRegularFile(target);
      if (!again.ok || hashText(again.text) !== expectedHash)
        return failure("conflict", `card ${id} changed since it was read`);
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return { ok: true, card: next, hash: hashText(serialized.text) };
  }

  // 匯入不可信的卡片文字：強制 draft、清空 external，並把現有檔案（含壞檔）的 id
  // 當成已占用，之後交給 create 以不覆蓋的方式寫入。
  importText(
    text: string,
    options: { slug?: string; today: string },
  ): ImportTextResult {
    const imported = importCard(text, {
      slug: options.slug,
      today: options.today,
      existingIds: this.existingIds(),
    });
    if (!imported.ok) return failure(imported.code, imported.error);
    const created = this.create(imported.card);
    if (!created.ok) return created;
    return {
      ok: true,
      file: created.file,
      hash: created.hash,
      card: imported.card,
      notes: imported.notes,
    };
  }
}
