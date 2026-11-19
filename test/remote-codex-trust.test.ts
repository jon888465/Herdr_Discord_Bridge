// 遠端 codex 預先信任（ISSUE-174）：TOML 編輯是純函式；寫入走與 agy 相同的遠端腳本，這裡用真的 sh 驗證。
import test, { type TestContext } from "node:test";
import { ok, equal, throws, rejects } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editCodexProjectTrust } from "../src/codex-project-trust.js";
import { editRemoteCodexTrust, remoteTrustEditor, editRemoteAgyTrust } from "../src/remote-agy-trust.js";
import { RemoteFailure, cardHash, type RemoteExec } from "../src/remote-checkout.js";

const DIR = "/home/u/herdr-card-review/task-abc";
const HEADER = `[projects."${DIR}"]`;
const BASE = '[projects."/home/u/work"]\ntrust_level = "trusted"\n\n[tui]\ntheme = "dark"\n';

test("add appends one table at the end and leaves the rest untouched", () => {
  equal(editCodexProjectTrust(BASE, DIR, true), `${BASE}\n${HEADER}\ntrust_level = "trusted"\n`);
  equal(editCodexProjectTrust("", DIR, true), `${HEADER}\ntrust_level = "trusted"\n`);
  // 結尾沒有換行：先補換行再追加，不黏在最後一行後面
  equal(editCodexProjectTrust('model = "x"', DIR, true), `model = "x"\n\n${HEADER}\ntrust_level = "trusted"\n`);
});

test("add is a no-op when the header already exists, even with a trailing comment", () => {
  const present = `${BASE}\n${HEADER}\ntrust_level = "trusted"\n`;
  equal(editCodexProjectTrust(present, DIR, true), null);
  equal(editCodexProjectTrust(`${BASE}\n${HEADER} # mine\ntrust_level = "untrusted"\n`, DIR, true), null);
});

test("remove undoes add exactly (round trip)", () => {
  for (const original of [BASE, "", 'model = "x"\n', "a = 1\n\n[b]\nc = 2\n"]) {
    const added = editCodexProjectTrust(original, DIR, true)!;
    equal(editCodexProjectTrust(added, DIR, false), original === "" || original.endsWith("\n") ? original : `${original}\n`);
  }
  // 中間的區塊（後面還有別的資料表）也只拿掉我們的
  const middle = `[a]\nx = 1\n\n${HEADER}\ntrust_level = "trusted"\n\n[z]\ny = 2\n`;
  equal(editCodexProjectTrust(middle, DIR, false), "[a]\nx = 1\n\n[z]\ny = 2\n");
});

test("remove leaves entries it did not write, or that carry more than trust_level", () => {
  equal(editCodexProjectTrust(BASE, DIR, false), null);
  equal(editCodexProjectTrust(`${HEADER}\ntrust_level = "untrusted"\n`, DIR, false), null);
  equal(editCodexProjectTrust(`${HEADER}\ntrust_level = "trusted"\nnote = "x"\n`, DIR, false), null);
});

test("refuses forms it cannot edit and directories that would need escaping", () => {
  throws(() => editCodexProjectTrust('[projects]\n"/x" = { trust_level = "trusted" }\n', DIR, true), /does not edit/);
  throws(() => editCodexProjectTrust('projects = { "/x" = { trust_level = "trusted" } }\n', DIR, true), /does not edit/);
  throws(() => editCodexProjectTrust("", '/a"b', true), /escaped/);
  throws(() => editCodexProjectTrust("", "/a\\b", true), /escaped/);
  throws(() => editCodexProjectTrust("", "/a\nb", true), /escaped/);
});

test("only agy and codex have a remote trust editor", () => {
  equal(remoteTrustEditor("agy"), editRemoteAgyTrust);
  equal(remoteTrustEditor("codex"), editRemoteCodexTrust);
  for (const kind of ["claude", "pi", "", "Codex"]) equal(remoteTrustEditor(kind), undefined);
});

const HASH = cardHash("REQ-1");
const NAME = `acme__repo__${HASH}`;
const MARKER = `hdb-card-review-checkout:v1:${HASH}`;
const CONFIG = '[projects."/home/u/work"]\ntrust_level = "trusted"\n\n[tui]\ntheme = "dark"\n';

async function shPod(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codex-trust-sh-")));
  const [home, root] = [join(base, "home"), join(base, "root")];
  const dir = join(root, NAME);
  const file = join(home, ".codex/config.toml");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git/hdb-card-review"), MARKER);
  await writeFile(file, CONFIG, { mode: 0o640 });
  const exec: RemoteExec = (argv) => new Promise((resolve) => execFile(argv[0]!, argv.slice(1), { env: { ...process.env, HOME: home } }, (e, stdout) => resolve({ code: e ? Number(e.code) : 0, stdout })));
  const usable = !(await exec(["sh", "-c", "command -v sha256sum && command -v base64"], 5000)).code;
  if (!usable) t.skip("no sha256sum/base64");
  return { base, home, root, dir, file, exec, usable };
}

test("real sh: add and remove restore config.toml byte for byte, keep its mode, back up with mode 600", async (t) => {
  const { home, root, dir, file, exec, usable } = await shPod(t);
  if (!usable) return;
  const input = { root, dir, cardHash: HASH };
  for (let i = 0; i < 3; i++) {
    equal(await editRemoteCodexTrust(exec, input, true), true);
    equal(await readFile(file, "utf8"), `${CONFIG}\n[projects."${dir}"]\ntrust_level = "trusted"\n`);
    equal((await stat(file)).mode & 0o777, 0o640);
    equal(await editRemoteCodexTrust(exec, input, true), false);
    equal(await editRemoteCodexTrust(exec, input, false), true);
    equal(await readFile(file, "utf8"), CONFIG);
    equal(await editRemoteCodexTrust(exec, input, false), false);
  }
  const backups = await readdir(join(root, ".hdb-codex-config-backups"));
  ok(backups.length > 0 && backups.length <= 5);
  for (const b of backups) {
    ok(b.startsWith("config-") && b.endsWith(".toml"));
    equal((await stat(join(root, ".hdb-codex-config-backups", b))).mode & 0o777, 0o600);
  }
  // 不碰 agy 的備份目錄，也不在 ~/.codex 留下額外檔案
  ok(!(await readdir(root)).includes(".hdb-agy-settings-backups"));
  equal((await readdir(join(home, ".codex"))).join(","), "config.toml");
});

test("real sh: refuses a missing config, a symlinked config and a checkout without the right marker", async (t) => {
  const { base, root, dir, file, exec, usable } = await shPod(t);
  if (!usable) return;
  const input = { root, dir, cardHash: HASH };
  await rejects(editRemoteCodexTrust(exec, { ...input, cardHash: cardHash("REQ-2") }, true), (e: unknown) => e instanceof RemoteFailure && /marker/.test(e.label));
  await writeFile(join(base, "real.toml"), CONFIG);
  const { rm } = await import("node:fs/promises");
  await rm(file);
  await symlink(join(base, "real.toml"), file);
  await rejects(editRemoteCodexTrust(exec, input, true), (e: unknown) => e instanceof RemoteFailure && e.label === "codex 設定檔是符號連結");
  equal(await readFile(join(base, "real.toml"), "utf8"), CONFIG);
  await rm(file);
  await rejects(editRemoteCodexTrust(exec, input, true), (e: unknown) => e instanceof RemoteFailure && e.label === "codex 設定檔不存在");
});

test("real sh: an unparsable projects layout is refused and the file stays as it was", async (t) => {
  const { root, dir, file, exec, usable } = await shPod(t);
  if (!usable) return;
  const odd = '[projects]\n"/x" = { trust_level = "trusted" }\n';
  await writeFile(file, odd);
  await rejects(editRemoteCodexTrust(exec, { root, dir, cardHash: HASH }, true), (e: unknown) => e instanceof RemoteFailure && e.label === "codex 設定檔格式不符");
  equal(await readFile(file, "utf8"), odd);
});
