// 卡片開出的 PR 的索引（追蹤清單 F3）。用途：輪詢 CI 結果與 PR 是否已 merge／關閉，並知道要通知哪個
// thread。只是索引，不是權威資料：PR 的真實狀態以 GitHub 為準。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCardId } from "./card.js";

export type PullRequestStateName = "OPEN" | "MERGED" | "CLOSED";

export interface CardPullRequest {
  cardId: string;
  /** `<owner>/<repo>` */
  repo: string;
  number: number;
  url: string;
  /** 目前已知的 head commit（完整 40 位）。 */
  headSha: string;
  /** 開 PR 時任務的來源 thread；通知送到這裡。沒有表示來源是本機 console。 */
  origin?: { guildId: string; channelId: string; threadId?: string };
  openedAt: string;
  state: PullRequestStateName;
  /** 已回報過 CI 結果的 head sha；每個 head sha 只回報一次。 */
  ciReportedSha?: string;
  endedAt?: string;
}

interface FileShape {
  version: 1;
  pullRequests: CardPullRequest[];
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9:_.-]{1,64}$/;

function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function assertEntry(item: unknown, label: string): CardPullRequest {
  const e = item as Partial<CardPullRequest> | null;
  if (!e || typeof e !== "object") throw new Error(`${label}: not an object`);
  if (typeof e.cardId !== "string" || !isCardId(e.cardId))
    throw new Error(`${label}: invalid cardId`);
  if (typeof e.repo !== "string" || !REPO.test(e.repo))
    throw new Error(`${label}: invalid repo`);
  if (
    !Number.isInteger(e.number) ||
    (e.number as number) < 1 ||
    (e.number as number) > 9_999_999
  )
    throw new Error(`${label}: invalid number`);
  if (
    typeof e.url !== "string" ||
    !e.url.startsWith("https://") ||
    e.url.length > 300 ||
    /\s/.test(e.url)
  )
    throw new Error(`${label}: invalid url`);
  if (typeof e.headSha !== "string" || !SHA40.test(e.headSha))
    throw new Error(`${label}: invalid headSha`);
  if (e.state !== "OPEN" && e.state !== "MERGED" && e.state !== "CLOSED")
    throw new Error(`${label}: invalid state`);
  if (!validTime(e.openedAt)) throw new Error(`${label}: invalid time`);
  if (e.endedAt !== undefined && !validTime(e.endedAt))
    throw new Error(`${label}: invalid endedAt`);
  if (e.ciReportedSha !== undefined && !SHA40.test(e.ciReportedSha))
    throw new Error(`${label}: invalid ciReportedSha`);
  let origin: CardPullRequest["origin"];
  if (e.origin !== undefined) {
    const o = e.origin;
    if (
      !o ||
      typeof o.guildId !== "string" ||
      typeof o.channelId !== "string" ||
      !ID.test(o.guildId) ||
      !ID.test(o.channelId) ||
      (o.threadId !== undefined &&
        (typeof o.threadId !== "string" || !ID.test(o.threadId)))
    )
      throw new Error(`${label}: invalid origin`);
    origin = {
      guildId: o.guildId,
      channelId: o.channelId,
      ...(o.threadId ? { threadId: o.threadId } : {}),
    };
  }
  return {
    cardId: e.cardId,
    repo: e.repo,
    number: e.number as number,
    url: e.url,
    headSha: e.headSha,
    ...(origin ? { origin } : {}),
    openedAt: e.openedAt,
    state: e.state,
    ...(e.ciReportedSha ? { ciReportedSha: e.ciReportedSha } : {}),
    ...(e.endedAt ? { endedAt: e.endedAt } : {}),
  };
}

export class CardPullRequestStore {
  private entries: CardPullRequest[] = [];

  constructor(private readonly file: string) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: FileShape;
    try {
      parsed = JSON.parse(text) as FileShape;
    } catch {
      throw new Error(`card-prs file is not valid JSON: ${file}`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.pullRequests))
      throw new Error(`card-prs file has an unsupported format: ${file}`);
    const seen = new Set<string>();
    const openCards = new Set<string>();
    for (const [index, item] of parsed.pullRequests.entries()) {
      const entry = assertEntry(item, `card-prs entry ${index}`);
      const key = `${entry.repo}#${entry.number}`;
      if (seen.has(key))
        throw new Error(`card-prs has a duplicate pull request ${key}`);
      seen.add(key);
      if (entry.state === "OPEN") {
        if (openCards.has(entry.cardId))
          throw new Error(
            `card-prs has two open pull requests for ${entry.cardId}`,
          );
        openCards.add(entry.cardId);
      }
      this.entries.push(entry);
    }
  }

  list(): CardPullRequest[] {
    return structuredClone(this.entries);
  }

  forCard(cardId: string): CardPullRequest[] {
    return this.list().filter((entry) => entry.cardId === cardId);
  }

  /** 還要輪詢的（尚未 merge 或關閉）。 */
  open(): CardPullRequest[] {
    return this.list().filter((entry) => entry.state === "OPEN");
  }

  /** 冪等：同一個 PR 已記錄就不改；同一張卡同時只能有一個開著的 PR。 */
  record(
    input: Omit<
      CardPullRequest,
      "openedAt" | "state" | "ciReportedSha" | "endedAt"
    >,
    at: string,
  ): void {
    const entry = assertEntry(
      { ...input, openedAt: at, state: "OPEN" },
      "pull request",
    );
    if (
      this.entries.some(
        (item) => item.repo === entry.repo && item.number === entry.number,
      )
    )
      return;
    if (
      this.entries.some(
        (item) => item.cardId === entry.cardId && item.state === "OPEN",
      )
    )
      throw new Error(`card ${entry.cardId} already has an open pull request`);
    this.entries.push(entry);
    this.save();
  }

  private find(repo: string, number: number): CardPullRequest {
    const found = this.entries.find(
      (item) => item.repo === repo && item.number === number,
    );
    if (!found) throw new Error(`unknown pull request ${repo}#${number}`);
    return found;
  }

  markEnded(
    repo: string,
    number: number,
    state: "MERGED" | "CLOSED",
    at: string,
  ): void {
    if (state !== "MERGED" && state !== "CLOSED")
      throw new Error("invalid state");
    if (!validTime(at)) throw new Error("invalid time");
    const found = this.find(repo, number);
    found.state = state;
    found.endedAt = at;
    this.save();
  }

  markCiReported(repo: string, number: number, headSha: string): void {
    if (!SHA40.test(headSha)) throw new Error("invalid sha");
    const found = this.find(repo, number);
    found.ciReportedSha = headSha;
    this.save();
  }

  /** push 新的 commit 後 head 會變；CI 要對新的 head 重新回報一次。 */
  updateHead(repo: string, number: number, headSha: string): void {
    if (!SHA40.test(headSha)) throw new Error("invalid sha");
    const found = this.find(repo, number);
    if (found.headSha === headSha) return;
    found.headSha = headSha;
    this.save();
  }

  private save(): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const body: FileShape = { version: 1, pullRequests: this.entries };
    try {
      fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

const shared = new Map<string, CardPullRequestStore>();

/** 同一個檔案在程序內共用一個實例：各自快取再整檔寫回會互相覆蓋對方的更新。 */
export function sharedCardPullRequests(file: string): CardPullRequestStore {
  let store = shared.get(file);
  if (!store) {
    store = new CardPullRequestStore(file);
    shared.set(file, store);
  }
  return store;
}
