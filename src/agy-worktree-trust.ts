// ISSUE-113: pre-authorize only indexed card worktrees. No terminal interaction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CardWorktreeStore } from "./card-worktrees.js";
import { CardStore } from "./card-store.js";
import { stateDirectory } from "./config.js";
import type { CardEvent } from "./card-events.js";

type Ownership = {
  cardId: string;
  path: string;
  settingsPath: string;
  sourcePath?: string;
};
export interface AgyTrustOptions {
  stateDirectory: string;
  /** 使用者在 config.json 明列的目錄；與卡片 worktree 不同，bridge 只補進信任清單、不會自動移除。 */
  trustedDirectories?: string[];
  settingsPath?: string;
  home?: string;
  log?: (message: string) => void;
  event?: (cardId: string, event: CardEvent) => void;
  /** Filesystem boundary hook for deterministic concurrent-editor tests. */
  beforeRecheck?: () => void;
}

/** Find the top-level array span without reserializing unrelated JSON fields. */
function arraySpan(source: string): [number, number] {
  const tokens = [
    ...source.matchAll(
      /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ),
  ];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i][0];
    if (
      depth === 1 &&
      t.startsWith('"') &&
      JSON.parse(t) === "trustedWorkspaces" &&
      tokens[i + 1]?.[0] === ":"
    ) {
      start = tokens[i + 2].index!;
    }
    if (t === "{" || t === "[") depth++;
    if (t === "}" || t === "]") {
      depth--;
      if (start >= 0 && t === "]" && depth === 1)
        return [start, tokens[i].index!];
    }
  }
  throw new Error("trustedWorkspaces array not found");
}

export class AgyWorktreeTrust {
  private readonly home: string;
  private readonly settings: string;
  private readonly ownership: string;
  constructor(private readonly options: AgyTrustOptions) {
    this.home = options.home ?? os.homedir();
    this.settings =
      options.settingsPath ??
      path.join(this.home, ".gemini/antigravity-cli/settings.json");
    this.ownership = path.join(
      options.stateDirectory,
      "agy-worktree-trust.json",
    );
  }
  private report(
    cardId: string,
    target: string,
    action: "add" | "remove",
    result: "added" | "removed" | "unchanged" | "error" | "remote",
    detail = "",
  ) {
    const message = `agy worktree trust ${action} ${result}: ${target}${detail ? ` (${detail})` : ""}`;
    (this.options.log ?? console.warn)(message);
    const event: CardEvent = {
      event: "agy_worktree_trust",
      path: target,
      action,
      result,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      eventId: `agy-trust-${createHash("sha256").update(`${cardId}:${target}:${action}:${result}`).digest("hex").slice(0, 40)}`,
    };
    try {
      if (this.options.event) this.options.event(cardId, event);
      else {
        const recorded = new CardStore(
          path.join(this.options.stateDirectory, "cards"),
        ).recordEvent(cardId, event);
        if (!recorded.ok) throw new Error(recorded.error);
      }
    } catch (e) {
      (this.options.log ?? console.warn)(
        `agy trust event warning: ${String(e)}`,
      );
    }
  }
  private owners(): Ownership[] {
    if (!fs.existsSync(this.ownership)) return [];
    const value: unknown = JSON.parse(fs.readFileSync(this.ownership, "utf8"));
    if (
      !Array.isArray(value) ||
      value.some(
        (v) =>
          !v ||
          typeof v.cardId !== "string" ||
          typeof v.path !== "string" ||
          typeof v.settingsPath !== "string",
      )
    )
      throw new Error("invalid agy trust ownership state");
    return value;
  }
  private save(owners: Ownership[]) {
    const tmp = `${this.ownership}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(owners), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.ownership);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  private assertNotSymlink(): void {
    if (fs.lstatSync(this.settings).isSymbolicLink())
      throw new Error("settings.json is a symlink; leaving it unchanged");
  }
  /** 每次修改前把驗證過的原內容備份到 state 目錄（只留最新 5 份、權限 600）。 */
  private backup(content: string): void {
    const dir = path.join(this.options.stateDirectory, "agy-settings-backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 8);
    const name = `settings-${Date.now()}-${digest}-${randomUUID().slice(0, 4)}.json`;
    fs.writeFileSync(path.join(dir, name), content, {
      flag: "wx",
      mode: 0o600,
    });
    const kept = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("settings-"))
      .sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - 5)))
      fs.rmSync(path.join(dir, old), { force: true });
  }
  private edit(target: string, add: boolean): boolean {
    for (let attempt = 0; attempt < 8; attempt++) {
      // rename 會把 symlink 換成一般檔案：每次重試與最後 rename 之前都要檢查，不能只檢查一次。
      this.assertNotSymlink();
      const stat = fs.statSync(this.settings);
      const original = fs.readFileSync(this.settings, "utf8");
      const parsed = JSON.parse(original);
      if (
        !parsed ||
        !Array.isArray(parsed.trustedWorkspaces) ||
        !parsed.trustedWorkspaces.every((v: unknown) => typeof v === "string")
      )
        throw new Error("trustedWorkspaces must be a string array");
      const entries: string[] = parsed.trustedWorkspaces;
      const index = entries.indexOf(target);
      if (add ? index >= 0 : index < 0) return false;
      const [start, end] = arraySpan(original);
      let replacement: string;
      if (add) {
        // 插在最後一筆後面，沿用第一筆前的縮排；這樣只多一行，移除後逐位元組還原。
        const body = original.slice(start + 1, end);
        const strings = [...body.matchAll(/"(?:\\.|[^"\\])*"/g)];
        if (!strings.length)
          replacement = "[" + body + JSON.stringify(target) + "]";
        else {
          const last = strings[strings.length - 1];
          const lastEnd = last.index! + last[0].length;
          const separator = body.slice(0, strings[0].index!);
          replacement =
            "[" +
            body.slice(0, lastEnd) +
            "," +
            separator +
            JSON.stringify(target) +
            body.slice(lastEnd) +
            "]";
        }
      } else {
        const body = original.slice(start + 1, end);
        const strings = [...body.matchAll(/"(?:\\.|[^"\\])*"/g)];
        const match = strings[index];
        const from =
          index > 0
            ? strings[index - 1].index! + strings[index - 1][0].length
            : match.index!;
        const to =
          index > 0 || strings.length === 1
            ? match.index! + match[0].length
            : strings[1].index!;
        replacement = "[" + body.slice(0, from) + body.slice(to) + "]";
      }
      const next =
        original.slice(0, start) + replacement + original.slice(end + 1);
      const tmp = `${this.settings}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, next, { flag: "wx", mode: stat.mode & 0o777 });
        fs.chmodSync(tmp, stat.mode & 0o777);
        // 備份在最後核對「之前」完成：核對通過後立刻 rename，中間不再有任何額外的檔案操作。
        // agy 可能同時寫設定檔，rename 與核對之間無法互斥；備份供使用者還原。
        this.backup(original);
        this.options.beforeRecheck?.();
        const current = fs.statSync(this.settings);
        if (
          current.mtimeMs !== stat.mtimeMs ||
          current.ino !== stat.ino ||
          current.mode !== stat.mode ||
          fs.readFileSync(this.settings, "utf8") !== original
        )
          continue;
        this.assertNotSymlink();
        fs.renameSync(tmp, this.settings);
        return true;
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    }
    throw new Error("settings.json kept changing; leaving it unchanged");
  }
  /**
   * 使用者明列的目錄（config.json `agyTrustedDirectories`）：cwd 必須「正好」是其中一個正規路徑
   * （不信任上層或子目錄、不跟 symlink、不信任 `/` 與家目錄本身）。確保它在信任清單內，沒有所有權紀錄、不會被移除。
   * 回傳 true 表示 cwd 屬於這類目錄（已處理，不再走卡片 worktree 流程）。
   */
  private trustConfiguredDirectory(cwd: string): boolean {
    const configured = this.options.trustedDirectories ?? [];
    if (!configured.includes(cwd)) return false;
    try {
      if (
        !path.isAbsolute(cwd) ||
        path.resolve(cwd) !== cwd ||
        cwd === path.parse(cwd).root ||
        cwd === this.home ||
        fs.realpathSync(cwd) !== cwd ||
        !fs.statSync(cwd).isDirectory()
      ) {
        (this.options.log ?? console.warn)(
          `agy trusted directory skipped (not a canonical directory): ${cwd}`,
        );
        return true;
      }
      const added = this.edit(cwd, true);
      (this.options.log ?? console.warn)(
        `agy trusted directory ${added ? "added" : "unchanged"}: ${cwd}`,
      );
    } catch (e) {
      (this.options.log ?? console.warn)(
        `agy trusted directory error: ${cwd} (${String(e)})`,
      );
    }
    return true;
  }
  /** `agent start` 用：只處理使用者明列的目錄，絕不信任卡片 worktree 或其他 `--cwd`。 */
  beforeLaunchConfigured(kind: string, paneId: string, cwd?: string): void {
    if (kind !== "agy" || !cwd || paneId.split(":").length > 2) return;
    this.trustConfiguredDirectory(cwd);
  }
  beforeLaunch(kind: string, paneId: string, cwd?: string): void {
    if (kind !== "agy" || !cwd) return;
    if (paneId.split(":").length <= 2 && this.trustConfiguredDirectory(cwd))
      return;
    let cardId = "";
    let target = cwd;
    try {
      const entry = new CardWorktreeStore(
        path.join(this.options.stateDirectory, "card-worktrees.json"),
      )
        .list()
        .find((e) => !e.removedAt && e.path === cwd);
      cardId = entry?.cardId ?? "";
      if (paneId.split(":").length > 2) {
        if (cardId)
          this.report(
            cardId,
            target,
            "add",
            "remote",
            "remote agy trust needs manual handling／遠端 agy 的信任需人工處理",
          );
        else
          (this.options.log ?? console.warn)(
            "remote agy trust needs manual handling／遠端 agy 的信任需人工處理",
          );
        return;
      }
      if (!entry) return;
      target = fs.realpathSync(cwd);
      // 已登記的路徑本身必須是正規路徑：登記的是 symlink（目標即使也在 worktree 根目錄底下）也不信任，
      // 否則已登記的 card-req-A 被換成指向未登記 card-req-B 的 symlink，就會信任到不是 bridge 建立的目錄。
      if (target !== path.resolve(cwd))
        throw new Error(
          "registered worktree path is a symlink; not trusting it",
        );
      const root = path.join(this.home, ".herdr/worktrees");
      const relative = path.relative(root, target).split(path.sep);
      if (
        relative.length !== 2 ||
        relative[0] === ".." ||
        !relative[0] ||
        !/^card-req-.+/.test(relative[1]) ||
        !fs.statSync(target).isDirectory()
      )
        return;
      // Canonical root must not itself redirect outside the authorized home tree.
      if (fs.realpathSync(root) !== root) return;
      const owners = this.owners();
      const added = this.edit(target, true);
      if (added) {
        try {
          this.save([
            ...owners,
            {
              cardId,
              path: target,
              sourcePath: cwd,
              settingsPath: this.settings,
            },
          ]);
        } catch (e) {
          this.edit(target, false);
          throw e;
        }
      }
      this.report(cardId, target, "add", added ? "added" : "unchanged");
    } catch (e) {
      if (cardId)
        this.report(
          cardId,
          target,
          "add",
          "error",
          `settings.json: ${String(e)}`,
        );
      else
        (this.options.log ?? console.warn)(
          `agy trust index error: ${String(e)}`,
        );
    }
  }
  cleanup(cardId: string, cwd: string): void {
    let target = cwd;
    try {
      const owners = this.owners();
      const owner = owners.find(
        (e) =>
          e.cardId === cardId &&
          e.settingsPath === this.settings &&
          (e.path === cwd ||
            e.sourcePath === cwd ||
            (() => {
              try {
                return e.path === fs.realpathSync(cwd);
              } catch {
                return false;
              }
            })()),
      );
      if (!owner) return;
      target = owner.path;
      const removed = this.edit(target, false);
      this.save(owners.filter((e) => e !== owner));
      this.report(cardId, target, "remove", removed ? "removed" : "unchanged");
    } catch (e) {
      this.report(cardId, target, "remove", "error", String(e));
    }
  }
  /**
   * 清理信任失敗（例如 cleanup 當下設定檔暫時壞掉）後，worktree 已被標成移除，沒有別的重試入口：
   * bridge 啟動時對「所有權還在、但 worktree 目錄已不存在」的項目重試移除；worktree 還在的不動（review）。
   */
  sweep(): void {
    let owners: Ownership[];
    try {
      owners = this.owners();
    } catch (e) {
      (this.options.log ?? console.warn)(`agy trust sweep error: ${String(e)}`);
      return;
    }
    for (const owner of owners)
      if (owner.settingsPath === this.settings && !fs.existsSync(owner.path))
        this.cleanup(owner.cardId, owner.path);
  }
}

export function defaultAgyWorktreeTrust(
  trustedDirectories: string[] = [],
): AgyWorktreeTrust {
  return new AgyWorktreeTrust({
    stateDirectory: stateDirectory(),
    trustedDirectories,
  });
}
