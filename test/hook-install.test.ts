import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_INSTALL_PY, formatHookReports, installLocalHooks, installRemoteHooks, machinesWithoutHook, type RemoteExec } from "../src/hook-install.js";
import { validateMachines } from "../src/machines.js";

const projectDir = process.cwd();
const fixedNow = () => new Date(2026, 10, 27, 10, 0, 0);

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hook-install-"));
}
const write = (file: string, text: string) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text));
type HookEntry = { hooks: Array<{ command: string; timeout: number }> };
type Settings = {
  theme?: string;
  other?: unknown;
  hooks: Record<string, HookEntry[]>;
  "herdr-discord-bridge": { Stop: Array<{ command: string }> };
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
type RemoteItem = { agent: string; outcome: string; detail: string; backup?: string };
const by = (reports: ReturnType<typeof installLocalHooks>, agent: string) => reports.find((r) => r.agent === agent)!;
const hookCommand = path.join(projectDir, "scripts", "herdr-discord-hook");

test("本機：沒有偵測到設定目錄的 CLI 一律略過，不建立任何檔案", () => {
  const home = tmpHome();
  const reports = installLocalHooks({ home, projectDir, now: fixedNow });
  assert.deepEqual(reports.map((r) => [r.agent, r.outcome]), [["claude", "skipped"], ["codex", "skipped"], ["agy", "skipped"], ["pi", "skipped"]]);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("本機 Claude：補上 Stop 與 PermissionRequest、保留其他設定、先備份；再跑一次什麼都不動；dry-run 不寫檔", () => {
  const home = tmpHome();
  const file = path.join(home, ".claude", "settings.json");
  write(file, JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } }, null, 2));
  const before = fs.readFileSync(file, "utf8");

  const dry = installLocalHooks({ home, projectDir, dryRun: true, now: fixedNow });
  assert.equal(by(dry, "claude").outcome, "installed");
  assert.match(by(dry, "claude").detail, /^會新增/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "dry-run 不改檔");

  const first = by(installLocalHooks({ home, projectDir, now: fixedNow }), "claude");
  assert.equal(first.outcome, "installed");
  assert.ok(first.backup && fs.readFileSync(first.backup, "utf8") === before, "備份是改之前的原樣");
  const after = read(file);
  assert.equal(after.theme, "dark");
  assert.ok(after.hooks.SessionStart);
  assert.equal(after.hooks.Stop[0].hooks[0].command, hookCommand);
  assert.equal(after.hooks.Stop[0].hooks[0].timeout, 10);
  assert.equal(after.hooks.PermissionRequest[0].hooks[0].timeout, 300);

  const second = by(installLocalHooks({ home, projectDir, now: fixedNow }), "claude");
  assert.equal(second.outcome, "present");
  assert.equal(second.backup, undefined);
  assert.equal(read(file).hooks.Stop.length, 1, "沒有重複項目");
});

test("本機 Codex：只加 Stop 並提示要在 /hooks 信任；已註冊 PermissionRequest 只提醒、不刪", () => {
  const home = tmpHome();
  const file = path.join(home, ".codex", "hooks.json");
  write(file, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: `${hookCommand}` }] }] } }));
  const reports = installLocalHooks({ home, projectDir, now: fixedNow });
  const codex = reports.filter((r) => r.agent === "codex");
  assert.equal(codex[0]!.outcome, "manual");
  assert.match(codex[0]!.detail, /\/hooks/);
  assert.match(codex[1]!.detail, /PermissionRequest/);
  assert.equal(read(file).hooks.Stop[0].hooks[0].command, hookCommand);
  assert.ok(read(file).hooks.PermissionRequest, "PermissionRequest 沒被刪");
});

test("本機 agy：建立群組；既有其他群組保留；已有有效項目就不動", () => {
  const home = tmpHome();
  const file = path.join(home, ".gemini", "config", "hooks.json");
  write(file, JSON.stringify({ other: { Stop: [{ command: "/bin/true", type: "command" }] } }));
  assert.equal(by(installLocalHooks({ home, projectDir, now: fixedNow }), "agy").outcome, "installed");
  const value = read(file);
  assert.ok(value.other);
  assert.equal(value["herdr-discord-bridge"].Stop[0].command, hookCommand);
  assert.equal(by(installLocalHooks({ home, projectDir, now: fixedNow }), "agy").outcome, "present");
});

test("本機 pi：沒有就安裝、相同就不動、內容不同就更新並備份", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  const target = path.join(home, ".pi", "agent", "extensions", "herdr-discord-bridge.ts");
  assert.equal(by(installLocalHooks({ home, projectDir, now: fixedNow }), "pi").outcome, "installed");
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(projectDir, "scripts", "pi", "herdr-discord-bridge.ts"), "utf8"));
  assert.equal(by(installLocalHooks({ home, projectDir, now: fixedNow }), "pi").outcome, "present");
  fs.writeFileSync(target, "// old version\n");
  const updated = by(installLocalHooks({ home, projectDir, now: fixedNow }), "pi");
  assert.equal(updated.outcome, "updated");
  assert.equal(fs.readFileSync(updated.backup!, "utf8"), "// old version\n");
});

test("本機：JSON 壞掉只回報、檔案原樣；原有項目指向不存在的檔案時另外加一筆有效的、舊的不動", () => {
  const home = tmpHome();
  const bad = path.join(home, ".claude", "settings.json");
  write(bad, "{ not json");
  const reports = installLocalHooks({ home, projectDir, now: fixedNow });
  assert.equal(by(reports, "claude").outcome, "error");
  assert.equal(fs.readFileSync(bad, "utf8"), "{ not json");

  const stale = tmpHome();
  const file = path.join(stale, ".codex", "hooks.json");
  write(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/nonexistent/scripts/herdr-discord-hook" }] }] } }));
  const codex = by(installLocalHooks({ home: stale, projectDir, now: fixedNow }), "codex");
  assert.equal(codex.outcome, "manual");
  assert.match(codex.detail, /指向的檔案不存在/);
  const stops = read(file).hooks.Stop;
  assert.equal(stops.length, 2);
  assert.equal(stops[0].hooks[0].command, "/nonexistent/scripts/herdr-discord-hook");
});

// ---- 遠端：把 REMOTE_INSTALL_PY 真的在本機用暫時 HOME 跑（遠端只需要 python3） ----
function runRemote(home: string, over: Record<string, unknown> = {}): RemoteItem[] {
  const payload = Buffer.from(
    JSON.stringify({
      dry: false,
      machine: "m1",
      hookSocket: "/tmp/hooks-remote.sock",
      kinds: ["codex", "pi", "agy", "claude"],
      hookPy: fs.readFileSync(path.join(projectDir, "scripts", "remote", "herdr-discord-hook.py"), "utf8"),
      piExt: fs.readFileSync(path.join(projectDir, "scripts", "pi", "herdr-discord-bridge.ts"), "utf8"),
      ...over,
    }),
  ).toString("base64");
  const out = execFileSync("python3", ["-"], { input: REMOTE_INSTALL_PY.replace("%PAYLOAD%", payload), env: { ...process.env, HOME: home }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}
const rby = (items: RemoteItem[], agent: string) => items.find((i) => i.agent === agent)!;

test("遠端腳本：安裝 hook 腳本與各 CLI 的 hook、冪等、不重複、先備份；Codex 回報尚未信任", () => {
  const home = tmpHome();
  for (const dir of [".codex", ".claude", ".gemini", path.join(".pi", "agent")]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  write(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/herdr-discord-hook", timeout: 10 }] }] } }));
  const first = runRemote(home);
  assert.equal(rby(first, "script").outcome, "installed");
  assert.ok(fs.statSync(path.join(home, ".local", "bin", "herdr-discord-hook.py")).mode & 0o111, "腳本可執行");
  const codex = rby(first, "codex");
  assert.equal(codex.outcome, "manual");
  assert.match(codex.detail, /\/hooks/);
  assert.ok(codex.backup, "改之前備份");
  const stops = read(path.join(home, ".codex", "hooks.json")).hooks.Stop;
  assert.equal(stops.length, 2, "既有項目保留、另外新增第二個");
  assert.match(stops[1].hooks[0].command, /^env HERDR_DISCORD_HOOK_SOCKET=\/tmp\/hooks-remote\.sock .*\/\.local\/bin\/herdr-discord-hook\.py --machine m1$/);
  assert.equal(rby(first, "pi").outcome, "installed");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".config", "herdr-discord-bridge", "extra-hook-targets.json"), "utf8")), [{ socket: "/tmp/hooks-remote.sock", machine: "m1" }]);
  assert.equal(rby(first, "agy").outcome, "installed");
  assert.equal(rby(first, "claude").outcome, "installed");

  // Codex 信任紀錄（config.toml 的 hooks.state）：有 trusted_hash 才算已信任。
  const second = runRemote(home);
  assert.match(rby(second, "codex").detail, /尚未在 Codex 的 \/hooks 信任/);
  write(path.join(home, ".codex", "config.toml"), `[hooks.state."${path.join(home, ".codex", "hooks.json")}:stop:1:0"]\ntrusted_hash = "sha256:abc"\n`);
  const third = runRemote(home);
  assert.deepEqual(third.map((i) => i.outcome).filter((o) => o !== "present"), [], "全部都已安裝");
  assert.match(rby(third, "codex").detail, /已信任/);
  assert.equal(read(path.join(home, ".codex", "hooks.json")).hooks.Stop.length, 2, "沒有重複");
});

test("遠端腳本：dry-run 不寫任何檔案；hookSocket 等於預設路徑時不加 env 也不寫額外目標；壞掉的 JSON 只回報", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const dry = runRemote(home, { dry: true });
  assert.equal(rby(dry, "script").outcome, "installed");
  assert.ok(rby(dry, "script").detail.startsWith("會"));
  assert.equal(fs.existsSync(path.join(home, ".local")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);

  const def = path.join(home, ".config", "herdr-discord-bridge", "hooks.sock");
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  const items = runRemote(home, { hookSocket: def, kinds: ["codex", "pi"] });
  assert.doesNotMatch(read(path.join(home, ".codex", "hooks.json")).hooks.Stop[0].hooks[0].command, /^env /);
  assert.equal(fs.existsSync(path.join(home, ".config", "herdr-discord-bridge", "extra-hook-targets.json")), false);
  assert.equal(rby(items, "pi").outcome, "installed");

  write(path.join(home, ".codex", "hooks.json"), "{ bad");
  assert.equal(rby(runRemote(home, { kinds: ["codex"] }), "codex").outcome, "error");
  assert.equal(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"), "{ bad");
});

test("installRemoteHooks：沒設 hookSocket 只提示；ssh 參數固定；失敗與無法解析的回傳都只回報", async () => {
  const [plain, withHook] = validateMachines([
    { id: "no-hook", ssh: "no-hook", socket: "/s.sock", cardReview: { root: "/root/review", kinds: ["codex"] } },
    { id: "m1", ssh: "m1", socket: "/s.sock", hookSocket: "/h.sock", cardReview: { root: "/root/review", kinds: ["codex"] } },
  ]);
  const never: RemoteExec = async () => assert.fail("不該執行 ssh");
  const hint = await installRemoteHooks(plain!, { projectDir, exec: never });
  assert.equal(hint[0]!.outcome, "manual");
  assert.match(hint[0]!.detail, /沒有設定 hookSocket/);

  const calls: string[][] = [];
  const ok: RemoteExec = async (argv, stdin) => {
    calls.push(argv);
    assert.ok(stdin.includes("json.loads(base64.b64decode(") && !stdin.includes("%PAYLOAD%"), "payload 已代入");
    return { code: 0, stdout: `noise\n${JSON.stringify([{ agent: "codex", outcome: "present", detail: "已安裝" }])}\n`, stderr: "" };
  };
  const done = await installRemoteHooks(withHook!, { projectDir, exec: ok });
  assert.deepEqual(calls[0], ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "m1", "python3", "-"]);
  assert.deepEqual(done, [{ agent: "codex", outcome: "present", detail: "已安裝", scope: "machine:m1" }]);

  const failed = await installRemoteHooks(withHook!, { projectDir, exec: async () => ({ code: 255, stdout: "", stderr: "ssh: connect failed\n" }) });
  assert.equal(failed[0]!.outcome, "error");
  assert.match(failed[0]!.detail, /255/);
  const garbled = await installRemoteHooks(withHook!, { projectDir, exec: async () => ({ code: 0, stdout: "not json", stderr: "" }) });
  assert.equal(garbled[0]!.outcome, "error");
});

test("machinesWithoutHook 與報告格式", () => {
  const machines = validateMachines([
    { id: "mach-a", ssh: "mach-a", socket: "/s.sock", hookSocket: "/h.sock" },
    { id: "mach-b", ssh: "mach-b", socket: "/s.sock" },
  ]);
  assert.deepEqual(machinesWithoutHook(machines), ["mach-b"]);
  const text = formatHookReports([{ scope: "local", agent: "pi", outcome: "installed", detail: "x", file: "/f", backup: "/f.bak" }]);
  assert.match(text, /^＋ \[local\] pi：x（\/f）；備份 \/f\.bak$/);
});
