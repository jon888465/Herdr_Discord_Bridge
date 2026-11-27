// REQ-20261127-hook-install（ISSUE-227）：安裝並檢查 CLI hook（本機與遠端 machine）。
//
// 原則：
// - 已經安裝就不動（偵測：hook 設定裡有指向 `herdr-discord-hook` 的指令，且指向的檔案存在）；
// - 改任何檔案前一律備份（`<檔>.bak-<時間>`）；JSON 壞掉時只回報、絕不覆寫；
// - 只對「偵測到有在用」的 CLI 動手（設定目錄存在）；
// - 失敗只回報，不丟例外、不擋 bridge 啟動；
// - 需要人確認的事不代勞（Codex 的 `/hooks` 信任）：只提示。

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sshTargetArgs, type MachineConfig } from "./machines.js";

export type HookOutcome = "installed" | "updated" | "present" | "skipped" | "stale-added" | "manual" | "error";

export interface HookReport {
  scope: string;
  agent: string;
  outcome: HookOutcome;
  detail: string;
  file?: string;
  backup?: string;
}

const HOOK_NAME = "herdr-discord-hook";
const PI_EXTENSION = "herdr-discord-bridge.ts";

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

type JsonRead = { kind: "missing" } | { kind: "bad"; error: string } | { kind: "ok"; value: Record<string, unknown>; indent: number };

function readJson(file: string): JsonRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "bad", error: String(error) };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "bad", error: "不是 JSON 物件" };
    return { kind: "ok", value: value as Record<string, unknown>, indent: raw.startsWith("{\n    ") ? 4 : 2 };
  } catch {
    return { kind: "bad", error: "不是合法 JSON" };
  }
}

/** 寫檔：先備份既有檔，再以暫存檔加 rename 寫入（保留原權限）。 */
function writeJson(file: string, value: unknown, indent: number, now: Date): string | undefined {
  let backup: string | undefined;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${stamp(now)}`;
    fs.copyFileSync(file, backup);
    mode = fs.statSync(file).mode & 0o777;
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-hook-install`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`, { mode });
  fs.renameSync(tmp, file);
  return backup;
}

/** 設定裡所有指向本專案 hook 腳本的指令（Claude／Codex 結構）。 */
function claudeStyleCommands(parsed: Record<string, unknown>, event: string): string[] {
  const hooks = parsed.hooks as Record<string, unknown> | undefined;
  const entries = hooks?.[event];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) =>
    Array.isArray((entry as { hooks?: unknown })?.hooks)
      ? ((entry as { hooks: Array<{ command?: unknown }> }).hooks.flatMap((h) => (typeof h?.command === "string" && h.command.includes(HOOK_NAME) ? [h.command] : [])))
      : [],
  );
}

/** 指令裡第一個指向 hook 腳本的絕對路徑；那個檔案存在才算「有效」。 */
function commandTargetExists(command: string): boolean {
  const match = /(\/[^\s'"]*herdr-discord-hook[^\s'"]*)/.exec(command);
  return !!match && fs.existsSync(match[1]!);
}

type EnsureResult = { outcome: "present" | "added" | "stale-added" };

function ensureClaudeStyle(parsed: Record<string, unknown>, event: string, command: string, timeout: number): EnsureResult {
  const existing = claudeStyleCommands(parsed, event);
  if (existing.some(commandTargetExists)) return { outcome: "present" };
  const hooks = ((parsed.hooks as Record<string, unknown[]> | undefined) ?? ((parsed.hooks = {}) as Record<string, unknown[]>));
  const list = (hooks[event] as unknown[] | undefined) ?? (hooks[event] = []);
  list.push({ hooks: [{ type: "command", command, timeout }] });
  return { outcome: existing.length ? "stale-added" : "added" };
}

function reportFor(agent: string, file: string, results: EnsureResult[], backup: string | undefined, dry: boolean, events: string[], extra = ""): HookReport {
  const changed = results.some((r) => r.outcome !== "present");
  if (!changed) return { scope: "local", agent, outcome: "present", detail: `已安裝（${events.join("、")}）`, file };
  const stale = results.some((r) => r.outcome === "stale-added");
  const verb = dry ? "會新增" : "已新增";
  return {
    scope: "local",
    agent,
    outcome: agent === "codex" ? "manual" : stale ? "stale-added" : "installed",
    detail: `${verb}：${results.flatMap((r, i) => (r.outcome === "present" ? [] : [events[i]!])).join("、")}${stale ? "（原有項目指向的檔案不存在，已另外加一筆有效的，舊的沒動）" : ""}${extra}`,
    file,
    ...(backup ? { backup } : {}),
  };
}

export interface LocalHookOptions {
  home: string;
  /** 本專案的絕對路徑（hook 腳本與 pi extension 的來源）。 */
  projectDir: string;
  dryRun?: boolean;
  now?: () => Date;
}

/** 本機：Claude、Codex、agy、pi。只處理設定目錄存在的 CLI。 */
export function installLocalHooks(options: LocalHookOptions): HookReport[] {
  const { home, projectDir } = options;
  const dry = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  const command = path.join(projectDir, "scripts", HOOK_NAME);
  const reports: HookReport[] = [];
  const skip = (agent: string, dir: string): HookReport => ({ scope: "local", agent, outcome: "skipped", detail: `沒有偵測到 ${agent} 的設定目錄（${dir}），略過` });
  const bad = (agent: string, file: string, error: string): HookReport => ({ scope: "local", agent, outcome: "error", detail: `${file} ${error}，不動它，請先修好再重跑`, file });

  // Claude：Stop 與 PermissionRequest。
  const claudeFile = path.join(home, ".claude", "settings.json");
  if (!fs.existsSync(path.join(home, ".claude"))) reports.push(skip("claude", "~/.claude"));
  else {
    const read = readJson(claudeFile);
    if (read.kind === "bad") reports.push(bad("claude", claudeFile, read.error));
    else {
      const value = read.kind === "ok" ? read.value : {};
      const results = [ensureClaudeStyle(value, "Stop", command, 10), ensureClaudeStyle(value, "PermissionRequest", command, 300)];
      const changed = results.some((r) => r.outcome !== "present");
      const backup = changed && !dry ? writeJson(claudeFile, value, read.kind === "ok" ? read.indent : 2, now()) : undefined;
      reports.push(reportFor("claude", claudeFile, results, backup, dry, ["Stop", "PermissionRequest"]));
    }
  }

  // Codex：只有 Stop（PermissionRequest 會擋住 Codex 的核准提示）；新增後要使用者在 /hooks 信任。
  const codexFile = path.join(home, ".codex", "hooks.json");
  if (!fs.existsSync(path.join(home, ".codex"))) reports.push(skip("codex", "~/.codex"));
  else {
    const read = readJson(codexFile);
    if (read.kind === "bad") reports.push(bad("codex", codexFile, read.error));
    else {
      const value = read.kind === "ok" ? read.value : {};
      const result = ensureClaudeStyle(value, "Stop", command, 10);
      const backup = result.outcome !== "present" && !dry ? writeJson(codexFile, value, read.kind === "ok" ? read.indent : 2, now()) : undefined;
      const report = reportFor("codex", codexFile, [result], backup, dry, ["Stop"], "；**Codex 需要你在 Codex 裡輸入 `/hooks` 審查並信任它，信任前不會執行**");
      reports.push(report);
      if (claudeStyleCommands(value, "PermissionRequest").length)
        reports.push({ scope: "local", agent: "codex", outcome: "manual", detail: "Codex 已註冊 PermissionRequest hook，會擋住 Codex 的核准提示（ISSUE-045），建議自行移除；這裡不替你刪", file: codexFile });
    }
  }

  // agy：{ 群組: { 事件: [{ command, timeout, type }] } }。
  const agyFile = path.join(home, ".gemini", "config", "hooks.json");
  if (!fs.existsSync(path.join(home, ".gemini"))) reports.push(skip("agy", "~/.gemini"));
  else {
    const read = readJson(agyFile);
    if (read.kind === "bad") reports.push(bad("agy", agyFile, read.error));
    else {
      const value = read.kind === "ok" ? read.value : {};
      const groups = Object.values(value) as Array<{ Stop?: Array<{ command?: unknown }> }>;
      const existing = groups.flatMap((g) => (Array.isArray(g?.Stop) ? g.Stop.flatMap((h) => (typeof h?.command === "string" && h.command.includes(HOOK_NAME) ? [h.command] : [])) : []));
      if (existing.some(commandTargetExists)) reports.push({ scope: "local", agent: "agy", outcome: "present", detail: "已安裝（Stop）", file: agyFile });
      else {
        const group = ((value["herdr-discord-bridge"] as Record<string, unknown[]> | undefined) ?? (value["herdr-discord-bridge"] = {} as Record<string, unknown[]>)) as Record<string, unknown[]>;
        (group.Stop ??= []).push({ command, timeout: 10, type: "command" });
        const backup = !dry ? writeJson(agyFile, value, read.kind === "ok" ? read.indent : 2, now()) : undefined;
        reports.push({ scope: "local", agent: "agy", outcome: existing.length ? "stale-added" : "installed", detail: `${dry ? "會新增" : "已新增"}：Stop${existing.length ? "（原有項目指向的檔案不存在，已另外加一筆有效的）" : ""}`, file: agyFile, ...(backup ? { backup } : {}) });
      }
    }
  }

  // pi：extension 檔（內容與本專案版本不同就更新；不動 extra-hook-targets.json）。
  const piDir = path.join(home, ".pi", "agent");
  if (!fs.existsSync(piDir)) reports.push(skip("pi", "~/.pi/agent"));
  else {
    const source = path.join(projectDir, "scripts", "pi", PI_EXTENSION);
    const target = path.join(piDir, "extensions", PI_EXTENSION);
    try {
      const want = fs.readFileSync(source);
      const have = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
      if (have && sha(have) === sha(want)) reports.push({ scope: "local", agent: "pi", outcome: "present", detail: "已安裝，內容與本專案版本相同", file: target });
      else {
        let backup: string | undefined;
        if (!dry) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (have) {
            backup = `${target}.bak-${stamp(now())}`;
            fs.copyFileSync(target, backup);
          }
          fs.writeFileSync(target, want);
        }
        reports.push({ scope: "local", agent: "pi", outcome: have ? "updated" : "installed", detail: `${dry ? "會" : "已"}${have ? "更新（內容與本專案版本不同）" : "安裝"}extension；已在執行的 pi 要重開才會載入`, file: target, ...(backup ? { backup } : {}) });
      }
    } catch (error) {
      reports.push({ scope: "local", agent: "pi", outcome: "error", detail: `讀寫 extension 失敗：${error instanceof Error ? error.message : String(error)}`, file: target });
    }
  }
  return reports;
}

function sha(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------- 遠端 ----------------

/**
 * 在遠端以 `python3 -` 執行（只需要 Python 3，與 `scripts/remote/herdr-discord-hook.py` 同樣的前提）。
 * 冪等：腳本內容雜湊相同就不動；hook 設定已有指向本腳本且 `--machine <id>` 相同的項目就不動；改檔前備份；JSON 壞掉不覆寫。
 * `%PAYLOAD%` 在執行前換成 base64 的 JSON（內含腳本內容、hookSocket、kinds、dry-run 旗標）。
 */
export const REMOTE_INSTALL_PY = `
import base64, hashlib, json, os, re, shutil, time

P = json.loads(base64.b64decode("%PAYLOAD%").decode("utf-8"))
HOME = os.path.expanduser("~")
DRY = bool(P["dry"])
MID = P["machine"]
SOCK = P["hookSocket"]
DEFAULT_SOCK = os.path.join(HOME, ".config", "herdr-discord-bridge", "hooks.sock")
STAMP = time.strftime("%Y%m%d-%H%M%S")
OUT = []


def report(agent, outcome, detail, **extra):
    item = {"agent": agent, "outcome": outcome, "detail": detail}
    item.update(extra)
    OUT.append(item)


def backup(path):
    if os.path.exists(path):
        target = "%s.bak-%s" % (path, STAMP)
        shutil.copy2(path, target)
        return target
    return None


def write_text(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp-hook-install"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def read_json(path):
    if not os.path.exists(path):
        return ("missing", {})
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        if not isinstance(value, dict):
            return ("bad", None)
        return ("ok", value)
    except Exception:
        return ("bad", None)


def write_json(path, value):
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    bak = None if DRY else backup(path)
    if not DRY:
        write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\\n", mode)
    return bak


HOOK_PATH = os.path.join(HOME, ".local", "bin", "herdr-discord-hook.py")
env_prefix = "" if SOCK == DEFAULT_SOCK else "env HERDR_DISCORD_HOOK_SOCKET=%s " % SOCK
COMMAND = "%s%s --machine %s" % (env_prefix, HOOK_PATH, MID)


def is_ours(command):
    return isinstance(command, str) and "herdr-discord-hook.py" in command and ("--machine %s" % MID) in command


def some_true(values):
    for value in values:
        if value:
            return True
    return False


# 1. hook 腳本本身
want = P["hookPy"].encode("utf-8")
have = open(HOOK_PATH, "rb").read() if os.path.exists(HOOK_PATH) else None
if have is not None and hashlib.sha256(have).hexdigest() == hashlib.sha256(want).hexdigest() and (os.stat(HOOK_PATH).st_mode & 0o111):
    report("script", "present", "herdr-discord-hook.py 已安裝且內容相同", file=HOOK_PATH)
else:
    bak = None
    if not DRY:
        bak = backup(HOOK_PATH) if have is not None else None
        write_text(HOOK_PATH, want.decode("utf-8"), 0o755)
    report("script", "updated" if have is not None else "installed", ("會" if DRY else "已") + ("更新" if have is not None else "安裝") + " herdr-discord-hook.py", file=HOOK_PATH, **({"backup": bak} if bak else {}))


def trusted(hooks_file, group, index):
    config = os.path.join(HOME, ".codex", "config.toml")
    if not os.path.exists(config):
        return False
    text = open(config, encoding="utf-8").read()
    header = '[hooks.state."%s:stop:%d:%d"]' % (hooks_file, group, index)
    at = text.find(header)
    if at < 0:
        return False
    rest = text[at + len(header):]
    nxt = rest.find("\\n[")
    section = rest if nxt < 0 else rest[:nxt]
    return "trusted_hash" in section


def claude_style(agent, file, events):
    kind, value = read_json(file)
    if kind == "bad":
        report(agent, "error", "%s 不是合法 JSON，不動它" % file, file=file)
        return
    hooks = value.setdefault("hooks", {})
    changed = []
    position = None
    for event, timeout in events:
        groups = hooks.setdefault(event, [])
        found = False
        for gi, group in enumerate(groups):
            for hi, hook in enumerate(group.get("hooks", [])):
                if is_ours(hook.get("command")):
                    found = True
                    if event == "Stop":
                        position = (gi, hi)
        if not found:
            groups.append({"hooks": [{"type": "command", "command": COMMAND, "timeout": timeout}]})
            changed.append(event)
            if event == "Stop":
                position = (len(groups) - 1, 0)
    if not changed:
        extra = ""
        if agent == "codex" and position is not None:
            extra = "，已信任" if trusted(file, position[0], position[1]) else "，**但尚未在 Codex 的 /hooks 信任，信任前不會執行**"
        report(agent, "present", "已安裝%s" % extra, file=file)
        return
    bak = write_json(file, value)
    detail = ("會新增：" if DRY else "已新增：") + "、".join(changed)
    if agent == "codex":
        detail += "；**需要在這台 machine 的 Codex 輸入 /hooks 審查並信任，信任前不會執行**"
    report(agent, "manual" if agent == "codex" else "installed", detail, file=file, **({"backup": bak} if bak else {}))


kinds = P["kinds"]
if "codex" in kinds:
    if os.path.isdir(os.path.join(HOME, ".codex")):
        claude_style("codex", os.path.join(HOME, ".codex", "hooks.json"), [("Stop", 10)])
    else:
        report("codex", "skipped", "沒有偵測到 ~/.codex，略過")
if "claude" in kinds:
    if os.path.isdir(os.path.join(HOME, ".claude")):
        claude_style("claude", os.path.join(HOME, ".claude", "settings.json"), [("Stop", 10)])
    else:
        report("claude", "skipped", "沒有偵測到 ~/.claude，略過")
if "agy" in kinds:
    agy_file = os.path.join(HOME, ".gemini", "config", "hooks.json")
    if os.path.isdir(os.path.join(HOME, ".gemini")):
        kind, value = read_json(agy_file)
        if kind == "bad":
            report("agy", "error", "%s 不是合法 JSON，不動它" % agy_file, file=agy_file)
        else:
            groups = [g for g in value.values() if isinstance(g, dict)]
            found = some_true(is_ours(h.get("command")) for g in groups for h in g.get("Stop", []) if isinstance(h, dict))
            if found:
                report("agy", "present", "已安裝", file=agy_file)
            else:
                group = value.setdefault("herdr-discord-bridge", {})
                group.setdefault("Stop", []).append({"command": COMMAND, "timeout": 10, "type": "command"})
                bak = write_json(agy_file, value)
                report("agy", "installed", ("會新增" if DRY else "已新增") + "：Stop", file=agy_file, **({"backup": bak} if bak else {}))
    else:
        report("agy", "skipped", "沒有偵測到 ~/.gemini，略過")
if "pi" in kinds:
    pi_dir = os.path.join(HOME, ".pi", "agent")
    if os.path.isdir(pi_dir):
        target = os.path.join(pi_dir, "extensions", "herdr-discord-bridge.ts")
        want_ext = P["piExt"].encode("utf-8")
        have_ext = open(target, "rb").read() if os.path.exists(target) else None
        if have_ext is not None and hashlib.sha256(have_ext).hexdigest() == hashlib.sha256(want_ext).hexdigest():
            report("pi", "present", "extension 已安裝且內容相同", file=target)
        else:
            bak = None
            if not DRY:
                bak = backup(target) if have_ext is not None else None
                write_text(target, want_ext.decode("utf-8"))
            report("pi", "updated" if have_ext is not None else "installed", ("會" if DRY else "已") + ("更新" if have_ext is not None else "安裝") + " extension；已在執行的 pi 要重開才會載入", file=target, **({"backup": bak} if bak else {}))
        # 額外目標：SOCK 與 extension 的預設 socket 相同就不需要。
        if SOCK != DEFAULT_SOCK:
            targets_file = os.path.join(HOME, ".config", "herdr-discord-bridge", "extra-hook-targets.json")
            try:
                targets = json.load(open(targets_file, encoding="utf-8")) if os.path.exists(targets_file) else []
                if not isinstance(targets, list):
                    raise ValueError("not a list")
            except Exception:
                report("pi", "error", "%s 不是合法的 JSON 陣列，不動它" % targets_file, file=targets_file)
                targets = None
            if targets is not None:
                if some_true(isinstance(t, dict) and t.get("socket") == SOCK and t.get("machine") == MID for t in targets):
                    report("pi-targets", "present", "extra-hook-targets.json 已有這個目標", file=targets_file)
                else:
                    targets.append({"socket": SOCK, "machine": MID})
                    bak = None if DRY else backup(targets_file)
                    if not DRY:
                        write_text(targets_file, json.dumps(targets, ensure_ascii=False) + "\\n", 0o600)
                    report("pi-targets", "installed", ("會新增" if DRY else "已新增") + "目標到 extra-hook-targets.json", file=targets_file, **({"backup": bak} if bak else {}))
    else:
        report("pi", "skipped", "沒有偵測到 ~/.pi/agent，略過")

print(json.dumps(OUT, ensure_ascii=False))
`;

export type RemoteExec = (argv: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRemoteExec: RemoteExec = (argv, stdin) =>
  new Promise((resolve) => {
    const child = execFile(argv[0]!, argv.slice(1), { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code as number | undefined) ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end(stdin);
  });

export interface RemoteHookOptions {
  projectDir: string;
  dryRun?: boolean;
  exec?: RemoteExec;
}

/** 對一台設了 `hookSocket` 的 machine 安裝／檢查 hook；沒設 `hookSocket` 回報提示、不動任何東西。 */
export async function installRemoteHooks(machine: MachineConfig, options: RemoteHookOptions): Promise<HookReport[]> {
  const scope = `machine:${machine.id}`;
  if (!machine.hookSocket)
    return [{ scope, agent: "-", outcome: "manual", detail: "沒有設定 hookSocket：這台的 agent 回覆只能用畫面解析（hook 通道未啟用）。要啟用請在 config.json 的這台 machine 加 hookSocket（遠端的絕對路徑；若這台自己也跑 bridge，要用不同於預設 hooks.sock 的路徑），再重跑" }];
  if (!machine.cardReview?.kinds.length)
    return [{ scope, agent: "-", outcome: "skipped", detail: "沒有設定 cardReview.kinds，不知道要裝哪些 CLI 的 hook，略過" }];
  let payload: string;
  try {
    payload = Buffer.from(
      JSON.stringify({
        dry: options.dryRun === true,
        machine: machine.id,
        hookSocket: machine.hookSocket,
        kinds: machine.cardReview.kinds,
        hookPy: fs.readFileSync(path.join(options.projectDir, "scripts", "remote", "herdr-discord-hook.py"), "utf8"),
        piExt: fs.readFileSync(path.join(options.projectDir, "scripts", "pi", PI_EXTENSION), "utf8"),
      }),
      "utf8",
    ).toString("base64");
  } catch (error) {
    return [{ scope, agent: "-", outcome: "error", detail: `讀本專案的 hook 腳本失敗：${error instanceof Error ? error.message : String(error)}` }];
  }
  let args: string[];
  try {
    args = sshTargetArgs(machine);
  } catch (error) {
    return [{ scope, agent: "-", outcome: "error", detail: error instanceof Error ? error.message : String(error) }];
  }
  const exec = options.exec ?? defaultRemoteExec;
  const result = await exec(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...args, "python3", "-"], REMOTE_INSTALL_PY.replace("%PAYLOAD%", payload));
  if (result.code !== 0)
    return [{ scope, agent: "-", outcome: "error", detail: `ssh 或遠端 Python 失敗（結束碼 ${result.code}）：${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`.slice(0, 200) }];
  try {
    const items = JSON.parse(result.stdout.trim().split("\n").slice(-1)[0] ?? "[]") as Array<Omit<HookReport, "scope">>;
    return items.map((item) => ({ ...item, scope }));
  } catch {
    return [{ scope, agent: "-", outcome: "error", detail: "遠端回傳的結果無法解析" }];
  }
}

export function formatHookReports(reports: HookReport[]): string {
  const mark: Record<HookOutcome, string> = { installed: "＋", updated: "↻", present: "✓", skipped: "－", "stale-added": "＋", manual: "!", error: "✗" };
  return reports
    .map((r) => `${mark[r.outcome]} [${r.scope}] ${r.agent}：${r.detail}${r.file ? `（${r.file}）` : ""}${r.backup ? `；備份 ${r.backup}` : ""}`)
    .join("\n");
}

/** 啟動時用：設了 cardReview 卻沒設 hookSocket 的 machine（hook 通道沒有啟用）。 */
export function machinesWithoutHook(machines: readonly MachineConfig[]): string[] {
  return machines.filter((m) => !m.hookSocket).map((m) => m.id);
}
