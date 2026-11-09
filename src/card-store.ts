import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  formatByteLimit,
  isCardDate,
  isCardId,
  LEDGER_MAX_FILE_BYTES,
  MAX_PROJECTS,
  MAX_TASKS,
  parseCard,
  resolveMaxFileBytes,
  type Card,
  type ReadOptions,
} from "./card.js";
import { importCard } from "./card-import.js";
import { buildLogEntry, type CardEvent } from "./card-events.js";
import { upsertProjectSection, type ProjectInfo } from "./card-projects.js";
import {
  recordFindingBatch,
  setFindingStatus as setFindingStatusInBody,
  type FindingBatch,
  type FindingStatus,
} from "./card-findings.js";
import {
  appendLogEntries,
  logEntriesOf,
  logPointerLine,
  parseLogLine,
  POINTER_PREFIX,
  rotateLog,
  type LogEntry,
} from "./card-ledger.js";
import { serializeCard } from "./card-serialize.js";

const CARD_FILE = /^(REQ|TKT)-.*\.md$/;

export type StoreErrorCode =
  | "not_found"
  | "invalid"
  | "unsafe"
  | "too_large"
  | "exists"
  | "conflict"
  | "io";

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

export type ReadLogResult = { ok: true; entries: LogEntry[] } | StoreFailure;

export type AppendLogResult =
  { ok: true; card: Card; hash: string; added: number } | StoreFailure;

/** bridge 只能把狀態設成這兩個，且只能依這個順序（ADR-0001 決定 5、ADR-0002 決定 2）。 */
const BRIDGE_STATUS_FROM: Record<string, readonly string[]> = {
  in_progress: ["ready", "in_progress"],
  done: ["in_progress", "done"],
};
const MAX_ATTEMPTS = 3;
/** 輪替後卡片保留的最新紀錄筆數（ADR-0002 決定 10，使用者決定）。 */
const KEEP_RECENT = 5;
/** 輪替門檻 = 整檔硬上限的 75%（營運卡片 1 MiB → 768 KiB）。 */
const ROTATE_RATIO = 0.75;
const SIDE_FILE = /^(\d{4})\.md$/;
const MAX_SIDE_FILES = 9999;
/**
 * 單次 appendLog 最多幾筆。旁檔內容最多是「輪替門檻（硬上限的 75%）加上一批」，
 * 一批最多 200 筆（每筆約 350 位元組、約 70 KiB），所以一定小於 1 MiB 的絕對上限。
 */
const MAX_ENTRIES_PER_APPEND = 200;

function sideFileName(number: number): string {
  return `${String(number).padStart(4, "0")}.md`;
}

function sideFileText(id: string, number: number, lines: string[]): string {
  return `# ${id} 流程紀錄（旁檔 ${String(number).padStart(4, "0")}）\n\n${lines.join("\n")}\n`;
}

export type RecordProjectResult =
  | {
      ok: true;
      card: Card;
      hash: string;
      name: string;
      omitted: string[];
    }
  | StoreFailure;

export type RecordFindingsResult =
  | { ok: true; card: Card; hash: string; ids: string[]; omitted: number }
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

  recordAutopickWorkspace(
    id: string,
    workspaceId: string,
    label: string,
  ): UpdateResult {
    return this.mutate(id, (card) => ({
      ...card,
      autopick_workspace_id: workspaceId,
      autopick_workspace_label: label,
    }));
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
   * bridge 專用：把 Team 任務 id 記進 frontmatter 的 `tasks`（ADR-0002 階段 2 決定 Q5）。
   * 冪等：已經在清單內就不重寫檔案；順序保留；一張卡最多 50 個。
   */
  recordTask(id: string, taskId: string, today: string): UpdateResult {
    if (!isCardDate(today))
      return failure("invalid", "today must be a valid YYYY-MM-DD date");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskId))
      return failure("invalid", "taskId must be letters, digits, . _ -");
    return this.mutate(id, (card) => {
      const tasks = card.tasks ?? [];
      if (tasks.includes(taskId)) return card;
      if (tasks.length >= MAX_TASKS)
        return failure("invalid", `a card can hold at most ${MAX_TASKS} tasks`);
      return {
        ...card,
        tasks: [...tasks, taskId],
        updated: today > card.updated ? today : card.updated,
      };
    });
  }

  /**
   * bridge 專用：把紀錄追加到內文的「## 流程紀錄」。事件 id 去重（冪等）；
   * 沒有新紀錄時不重寫檔案；只在有新增時把 updated 推進到最後一筆的日期。
   */
  appendLog(id: string, entries: LogEntry[]): AppendLogResult {
    if (entries.length > MAX_ENTRIES_PER_APPEND)
      return failure(
        "invalid",
        `at most ${MAX_ENTRIES_PER_APPEND} entries can be appended at once`,
      );
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = this.read(id);
      if (!current.ok) return current;
      const card = current.card;

      // 輪替過的卡片，舊事件的紀錄行已不在卡片裡：去重也要看旁檔，重送才仍是冪等。
      let alsoSeen: Set<string> | undefined;
      if (
        card.body.split("\n").some((line) => line.startsWith(POINTER_PREFIX))
      ) {
        const ids = this.sideFileEventIds(id);
        if (!ids.ok) return ids;
        alsoSeen = ids.ids;
      }
      const appended = appendLogEntries(card.body, entries, alsoSeen);
      if (!appended.ok) return failure("invalid", appended.error);
      if (appended.added === 0)
        return { ok: true, card, hash: current.hash, added: 0 };

      const lastDate = entries[entries.length - 1].time.slice(0, 10);
      let next: Card = {
        ...card,
        body: appended.body,
        updated: lastDate > card.updated ? lastDate : card.updated,
      };

      const plan = this.planRotation(id, next);
      if (!plan.ok) return plan;
      if (plan.rotation) next = { ...next, body: plan.rotation.body };

      // 任何寫入之前先確認結果放得進上限；放不進（例如人寫的內容太大）就整個拒絕。
      const serialized = serializeCard(next, this.options);
      if (!serialized.ok) return failure(serialized.code, serialized.error);
      if (plan.rotation && !plan.rotation.reuse) {
        const wrote = this.writeSideFile(
          id,
          plan.rotation.number,
          plan.rotation.text,
        );
        if (!wrote.ok) return wrote;
      }

      const updated = this.update(id, current.hash, () => next);
      if (updated.ok) return { ...updated, added: appended.added };
      if (updated.code !== "conflict") return updated;
    }
    return failure("conflict", `card ${id} kept changing`);
  }

  /** 卡片與所有旁檔裡的全部紀錄，依序，事件 id 重複的只留第一筆（輪替崩潰後可能同時存在兩邊）。 */
  readLog(id: string): ReadLogResult {
    const current = this.read(id);
    if (!current.ok) return current;
    const side = this.sideNumbers(id);
    if (!side.ok) return side;
    const entries: LogEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: LogEntry): void => {
      if (seen.has(entry.eventId)) return;
      seen.add(entry.eventId);
      entries.push(entry);
    };
    for (const number of side.numbers) {
      const text = this.readSideFile(id, number);
      if (!text.ok) return text;
      for (const line of text.text.split("\n")) {
        const entry = parseLogLine(line);
        if (entry) add(entry);
      }
    }
    for (const entry of logEntriesOf(current.card.body)) add(entry);
    return { ok: true, entries };
  }

  private sideFilePath(id: string, number: number): string {
    return path.join(this.rootDir, "logs", id, sideFileName(number));
  }

  // 旁檔只由 bridge 寫，且依上面的批次上限一定小於 1 MiB，所以用絕對上限讀取，
  // 而不是這張卡（可能更小）的上限；否則旁檔讀不回來會讓之後所有追加都失敗。
  private readSideFile(id: string, number: number): FileRead {
    return readRegularFile(
      this.sideFilePath(id, number),
      LEDGER_MAX_FILE_BYTES,
    );
  }

  /** 旁檔編號（升冪）。`logs` 或 `logs/<id>` 是符號連結回 unsafe，不是目錄回 io，不存在視為沒有旁檔。 */
  private sideNumbers(
    id: string,
  ): { ok: true; numbers: number[] } | StoreFailure {
    const logs = path.join(this.rootDir, "logs");
    const dir = path.join(logs, id);
    for (const candidate of [logs, dir]) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { ok: true, numbers: [] };
        throw error;
      }
      if (stat.isSymbolicLink())
        return failure(
          "unsafe",
          "symbolic link is not allowed in the log path",
        );
      if (!stat.isDirectory())
        return failure("io", "the log path is not a directory");
    }
    const numbers: number[] = [];
    for (const name of fs.readdirSync(dir)) {
      const match = SIDE_FILE.exec(name);
      if (match) numbers.push(Number(match[1]));
    }
    return { ok: true, numbers: numbers.sort((a, b) => a - b) };
  }

  private sideFileEventIds(
    id: string,
  ): { ok: true; ids: Set<string> } | StoreFailure {
    const side = this.sideNumbers(id);
    if (!side.ok) return side;
    const ids = new Set<string>();
    for (const number of side.numbers) {
      const text = this.readSideFile(id, number);
      if (!text.ok) return text;
      for (const line of text.text.split("\n")) {
        const entry = parseLogLine(line);
        if (entry) ids.add(entry.eventId);
      }
    }
    return { ok: true, ids };
  }

  private sizeOf(card: Card): number {
    const serialized = serializeCard(card, {
      maxFileBytes: LEDGER_MAX_FILE_BYTES,
    });
    return serialized.ok
      ? Buffer.byteLength(serialized.text, "utf8")
      : Number.POSITIVE_INFINITY;
  }

  /**
   * 追加後超過輪替門檻時，決定要移走哪些紀錄、寫到哪個旁檔。沒有副作用。
   * 若最新的旁檔內容剛好等於這次要寫的（上一次崩潰時留下的），直接沿用，不再建新檔。
   */
  private planRotation(
    id: string,
    next: Card,
  ):
    | {
        ok: true;
        rotation?: {
          body: string;
          number: number;
          text: string;
          reuse: boolean;
        };
      }
    | StoreFailure {
    if (this.sizeOf(next) <= Math.floor(this.maxFileBytes * ROTATE_RATIO))
      return { ok: true };
    const draft = rotateLog(next.body, KEEP_RECENT, "");
    if (!draft) return { ok: true };
    const side = this.sideNumbers(id);
    if (!side.ok) return side;

    const latest = side.numbers.at(-1);
    let number = (latest ?? 0) + 1;
    let reuse = false;
    if (latest !== undefined) {
      const existing = this.readSideFile(id, latest);
      if (
        existing.ok &&
        existing.text === sideFileText(id, latest, draft.moved)
      ) {
        number = latest;
        reuse = true;
      }
    }
    if (number > MAX_SIDE_FILES)
      return failure("io", "too many log side files");
    if (
      Buffer.byteLength(sideFileText(id, number, draft.moved), "utf8") >
      LEDGER_MAX_FILE_BYTES
    )
      return failure(
        "too_large",
        "a log side file would exceed the absolute limit",
      );
    const rotated = rotateLog(
      next.body,
      KEEP_RECENT,
      logPointerLine(id, side.numbers[0] ?? number, number),
    );
    if (!rotated) return { ok: true };
    return {
      ok: true,
      rotation: {
        body: rotated.body,
        number,
        text: sideFileText(id, number, rotated.moved),
        reuse,
      },
    };
  }

  /** 先寫暫存檔再 link 到正式名稱，不覆蓋既有旁檔；目錄 0700、檔案 0600。 */
  private writeSideFile(
    id: string,
    number: number,
    text: string,
  ): { ok: true } | StoreFailure {
    const dir = path.join(this.rootDir, "logs", id);
    const file = this.sideFilePath(id, number);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = path.join(
        dir,
        `.${sideFileName(number)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
      );
      fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
      try {
        fs.linkSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return failure(
        "io",
        `cannot write the log side file (${code ?? "error"})`,
      );
    }
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

  /**
   * bridge 專用：在內文的「## 異動專案」更新或新增該專案的小節，並把專案名稱
   * （`<機器 id>:<repo 目錄名>`）加進 frontmatter 的 `projects`（ADR-0002 決定 4）。
   * 冪等：內容沒有變就不重寫檔案、不推進 updated。一張卡最多 20 個專案。
   */
  recordProject(
    id: string,
    info: ProjectInfo,
    today: string,
  ): RecordProjectResult {
    if (!isCardDate(today))
      return failure("invalid", "today must be a valid YYYY-MM-DD date");
    let name = "";
    let omitted: string[] = [];
    const result = this.mutate(id, (card) => {
      const upserted = upsertProjectSection(card.body, info);
      if (!upserted.ok) return failure("invalid", upserted.error);
      name = upserted.name;
      omitted = upserted.omitted;
      const projects = card.projects ?? [];
      const known = projects.includes(upserted.name);
      if (!upserted.changed && known) return card;
      if (!known && projects.length >= MAX_PROJECTS)
        return failure(
          "invalid",
          `a card can hold at most ${MAX_PROJECTS} projects`,
        );
      return {
        ...card,
        body: upserted.body,
        projects: known ? projects : [...projects, upserted.name],
        updated: today > card.updated ? today : card.updated,
      };
    });
    return result.ok ? { ...result, name, omitted } : result;
  }

  /**
   * bridge 專用：把一批 review findings 記進內文的 `## Review 發現`（F8，ADR-0002 決定 12）。
   * 冪等：同一輪同一範圍的批次已經記過就不重寫檔案。輸入不合格整批拒絕、卡片不動。
   */
  recordFindings(
    id: string,
    input: FindingBatch,
    today: string,
  ): RecordFindingsResult {
    if (!isCardDate(today))
      return failure("invalid", "today must be a valid YYYY-MM-DD date");
    let ids: string[] = [];
    let omitted = 0;
    const result = this.mutate(id, (card) => {
      const recorded = recordFindingBatch(card.body, input);
      if (!recorded.ok) return failure("invalid", recorded.error);
      ids = recorded.ids;
      omitted = recorded.omitted;
      if (!recorded.changed) return card;
      return {
        ...card,
        body: recorded.body,
        updated: today > card.updated ? today : card.updated,
      };
    });
    return result.ok ? { ...result, ids, omitted } : result;
  }

  /** bridge 專用：改一筆 finding 的狀態（只能往前：open → fixed → resolved，或 dismissed）。 */
  setFindingStatus(
    id: string,
    findingId: string,
    status: FindingStatus,
    today: string,
  ): UpdateResult {
    if (!isCardDate(today))
      return failure("invalid", "today must be a valid YYYY-MM-DD date");
    return this.mutate(id, (card) => {
      const changed = setFindingStatusInBody(card.body, findingId, status);
      if (!changed.ok) return failure("invalid", changed.error);
      if (!changed.changed) return card;
      return {
        ...card,
        body: changed.body,
        updated: today > card.updated ? today : card.updated,
      };
    });
  }
}
