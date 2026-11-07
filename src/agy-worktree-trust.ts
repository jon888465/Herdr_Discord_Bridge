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
  private edit(target: string, add: boolean): boolean {
    // rename 會把 symlink 換成一般檔案；使用者的設定若是 symlink 就不動它。
    if (fs.lstatSync(this.settings).isSymbolicLink())
      throw new Error("settings.json is a symlink; leaving it unchanged");
    for (let attempt = 0; attempt < 8; attempt++) {
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
        this.options.beforeRecheck?.();
        const current = fs.statSync(this.settings);
        if (
          current.mtimeMs !== stat.mtimeMs ||
          current.ino !== stat.ino ||
          current.mode !== stat.mode ||
          fs.readFileSync(this.settings, "utf8") !== original
        )
          continue;
        fs.renameSync(tmp, this.settings);
        return true;
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    }
    throw new Error("settings.json kept changing; leaving it unchanged");
  }
  beforeLaunch(kind: string, paneId: string, cwd?: string): void {
    if (kind !== "agy" || !cwd) return;
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
}

export function defaultAgyWorktreeTrust(): AgyWorktreeTrust {
  return new AgyWorktreeTrust({ stateDirectory: stateDirectory() });
}
