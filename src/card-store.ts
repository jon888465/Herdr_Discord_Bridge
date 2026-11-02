import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  formatByteLimit,
  isCardDate,
  isCardId,
  parseCard,
  resolveMaxFileBytes,
  type Card,
  type ReadOptions,
} from "./card.js";
import { importCard } from "./card-import.js";
import { buildLogEntry, type CardEvent } from "./card-events.js";
import { appendLogEntries, type LogEntry } from "./card-ledger.js";
import { serializeCard } from "./card-serialize.js";

const CARD_FILE = /^(REQ|TKT)-.*\.md$/;

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

export type AppendLogResult =
  { ok: true; card: Card; hash: string; added: number } | StoreFailure;

/** bridge 只能把狀態設成這兩個，且只能依這個順序（ADR-0001 決定 5、ADR-0002 決定 2）。 */
const BRIDGE_STATUS_FROM: Record<string, readonly string[]> = {
  in_progress: ["ready", "in_progress"],
  done: ["in_progress", "done"],
};
const MAX_ATTEMPTS = 3;

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
function readRegularFile(file: string, maxBytes: number): FileRead {
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
  if (stat.size > maxBytes)
    return failure("too_large", `file exceeds ${formatByteLimit(maxBytes)}`);
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
    if (opened.size > maxBytes)
      return failure("too_large", `file exceeds ${formatByteLimit(maxBytes)}`);
    return { ok: true, text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

export class CardStore {
  private readonly options: ReadOptions;
  private readonly maxFileBytes: number;

  /** options.maxFileBytes 是這個 store 讀寫的整檔上限（預設匯入上限，最大 1 MiB）。 */
  constructor(
    private readonly rootDir: string,
    options?: ReadOptions,
  ) {
    this.maxFileBytes = resolveMaxFileBytes(options);
    this.options = { maxFileBytes: this.maxFileBytes };
  }

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
      const read = readRegularFile(
        path.join(this.rootDir, file),
        this.maxFileBytes,
      );
      if (!read.ok) {
        errors.push({ file, error: read.error });
        continue;
      }
      const parsed = parseCard(read.text, file, this.options);
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
    const read = readRegularFile(
      path.join(this.rootDir, `${id}.md`),
      this.maxFileBytes,
    );
    if (!read.ok)
      return read.code === "not_found"
        ? failure("not_found", `card ${id} not found`)
        : read;
    const parsed = parseCard(read.text, `${id}.md`, this.options);
    if (!parsed.ok) return failure("invalid", parsed.error);
    return { ok: true, card: parsed.card, hash: hashText(read.text) };
  }

  // 先寫暫存檔再 link 到正式名稱：link 遇到任何既有項目（含失效的符號連結）都會失敗，
  // 因此不會覆蓋；寫入中途失敗也不會留下半截的正式檔。
  create(card: Card): CreateResult {
    const serialized = serializeCard(card, this.options);
    if (!serialized.ok) return failure(serialized.code, serialized.error);
    const file = `${card.id}.md`;
    const target = path.join(this.rootDir, file);
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const temp = path.join(
      this.rootDir,
      `.${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(temp, serialized.text, { flag: "wx", mode: 0o600 });
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
    const current = readRegularFile(target, this.maxFileBytes);
    if (!current.ok)
      return current.code === "not_found"
        ? failure("not_found", `card ${id} not found`)
        : current;
    if (hashText(current.text) !== expectedHash)
      return failure("conflict", `card ${id} changed since it was read`);
    const parsed = parseCard(current.text, file, this.options);
    if (!parsed.ok) return failure("invalid", parsed.error);

    const next = change(structuredClone(parsed.card));
    if (next.id !== id)
      return failure("invalid", "a card id cannot be changed");
    const serialized = serializeCard(next, this.options);
    if (!serialized.ok) return failure(serialized.code, serialized.error);
    if (serialized.text === current.text)
      return { ok: true, card: next, hash: expectedHash };

    const temp = path.join(
      this.rootDir,
      `.${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(temp, serialized.text, { flag: "wx", mode: 0o600 });
    try {
      const again = readRegularFile(target, this.maxFileBytes);
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

  /**
   * 重讀目前內容、套用 prepare 的結果，雜湊衝突（人剛好在編輯）就重讀重試，最多 MAX_ATTEMPTS 次。
   * 呼叫端不需要先持有雜湊；prepare 回傳 StoreFailure 表示拒絕，不寫檔。
   */
  private mutate(
    id: string,
    prepare: (card: Card) => Card | StoreFailure,
  ): UpdateResult {
    let last: UpdateResult = failure("conflict", `card ${id} kept changing`);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = this.read(id);
      if (!current.ok) return current;
      const proposal = prepare(current.card);
      if ("ok" in proposal) return proposal;
      last = this.update(id, current.hash, () => proposal);
      if (last.ok || last.code !== "conflict") return last;
    }
    return failure("conflict", `card ${id} kept changing`);
  }

  /** bridge 專用：只改 status 與 updated；只允許 ready → in_progress → done。 */
  setStatus(id: string, status: string, today: string): UpdateResult {
    if (!Object.hasOwn(BRIDGE_STATUS_FROM, status))
      return failure("invalid", "the bridge may only set in_progress or done");
    if (!isCardDate(today))
      return failure("invalid", "today must be a valid YYYY-MM-DD date");
    return this.mutate(id, (card) => {
      if (!BRIDGE_STATUS_FROM[status].includes(card.status))
        return failure(
          "invalid",
          `cannot move from ${card.status} to ${status}`,
        );
      return {
        ...card,
        status,
        updated: today > card.updated ? today : card.updated,
      };
    });
  }

  /**
   * bridge 專用：把紀錄追加到內文的「## 流程紀錄」。事件 id 去重（冪等）；
   * 沒有新紀錄時不重寫檔案；只在有新增時把 updated 推進到最後一筆的日期。
   */
  appendLog(id: string, entries: LogEntry[]): AppendLogResult {
    let added = 0;
    const result = this.mutate(id, (card) => {
      const appended = appendLogEntries(card.body, entries);
      if (!appended.ok) return failure("invalid", appended.error);
      added = appended.added;
      if (appended.added === 0) return card;
      const lastDate = entries[entries.length - 1].time.slice(0, 10);
      return {
        ...card,
        body: appended.body,
        updated: lastDate > card.updated ? lastDate : card.updated,
      };
    });
    return result.ok ? { ...result, added } : result;
  }

  /**
   * bridge 專用：把有型別的事件以固定模板記入「## 流程紀錄」（ADR-0002 決定 11）。
   * 欄位不合格回 invalid；疑似機敏時說明改為固定訊息，事件本身仍記錄。
   * 這是 bridge 應該使用的通道；低階的 appendLog 接受任意已驗證的說明文字，不套用模板與機敏檢查。
   */
  recordEvent(id: string, event: CardEvent): AppendLogResult {
    const built = buildLogEntry(event);
    if (!built.ok) return failure("invalid", built.error);
    return this.appendLog(id, [built.entry]);
  }
}
