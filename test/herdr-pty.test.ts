// 在 pty 裡等特定提示才回答（ISSUE-177）：用真的 `script` 與一個假的互動式指令驗證。
import test, { type TestContext } from "node:test";
import { equal, deepEqual as eq, match, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_RESTART_APPROVAL, PTY_SCRIPT, runWithPtyApproval } from "../src/herdr-pty.js";

function hasScript(): boolean {
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 假的互動式指令：先睡一下再印提示，讀一行輸入；只有收到 y 才成功。 */
async function fake(prompt: string, delayMs = 300): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "pty-fake-")), "fake.js");
  await writeFile(
    file,
    `setTimeout(() => {
  process.stdout.write(${JSON.stringify(prompt)});
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", (line) => {
    if (line.trim() === "y") { console.log("\\nSaved. Remote server is ready."); process.exit(0); }
    console.log("\\nerror: remote setup cancelled; machine was not saved"); process.exit(1);
  });
}, ${delayMs});
`,
  );
  return file;
}

test("等到提示出現才回答 y，成功時回傳整理過的輸出", async (t: TestContext) => {
  if (!hasScript()) return t.skip("no python3 with pty");
  const file = await fake("restart the remote server now? [y/N] ");
  const out = await runWithPtyApproval(process.execPath, [file], HERDR_RESTART_APPROVAL, 10_000);
  match(out, /Saved\. Remote server is ready\./);
});

test("提示延遲很久才出現，也不會提早回答（提早回答會被當成取消）", async (t: TestContext) => {
  if (!hasScript()) return t.skip("no python3 with pty");
  const file = await fake("restart the remote server now? [y/N] ", 1500);
  const out = await runWithPtyApproval(process.execPath, [file], HERDR_RESTART_APPROVAL, 10_000);
  match(out, /Saved\./);
});

test("不是預期的提示就不回答：逾時失敗，且假指令從沒收到回答", async (t: TestContext) => {
  if (!hasScript()) return t.skip("no python3 with pty");
  const file = await fake("delete everything now? [y/N] ");
  await rejects(
    runWithPtyApproval(process.execPath, [file], HERDR_RESTART_APPROVAL, 2_500),
    (error: Error & { herdrOutput?: string }) => /timed out/.test(error.message) && /delete everything now/.test(error.herdrOutput ?? "") && !/Saved/.test(error.herdrOutput ?? ""),
  );
});

test("指令失敗（非零結束碼）時丟錯，錯誤帶輸出", async (t: TestContext) => {
  if (!hasScript()) return t.skip("no python3 with pty");
  const file = await fake("restart the remote server now? [y/N] ");
  // 用只接受 n 的回答模擬被拒絕
  await rejects(
    runWithPtyApproval(process.execPath, [file], { prompt: HERDR_RESTART_APPROVAL.prompt, answer: "n\n" }, 10_000),
    (error: Error & { herdrOutput?: string }) => /code 1/.test(error.message) && /remote setup cancelled/.test(error.herdrOutput ?? ""),
  );
});

test("不支援的平台直接拒絕，不啟動任何程序", async () => {
  await rejects(runWithPtyApproval("herdr", [], HERDR_RESTART_APPROVAL, 1000, "win32"), /不支援/);
});

test("HERDR_RESTART_APPROVAL 只認 Herdr 的重啟提示", () => {
  equal(HERDR_RESTART_APPROVAL.prompt.test("restart the remote server now? [y/N] "), true);
  equal(HERDR_RESTART_APPROVAL.prompt.test("restart the remote server now?\n[y/N]"), true);
  equal(HERDR_RESTART_APPROVAL.prompt.test("delete the remote server now? [y/N]"), false);
  equal(HERDR_RESTART_APPROVAL.prompt.test("restart the remote server now?"), false);
  equal(HERDR_RESTART_APPROVAL.answer, "y\n");
});

test("找不到 python3 時明確回報，不啟動別的程序", async () => {
  await rejects(runWithPtyApproval("herdr", [], HERDR_RESTART_APPROVAL, 2000, "linux", "definitely-not-python3"), /找不到 python3/);
});

test("固定的 Python 程式沒有拼入任何值：提示、回答與指令都只走 argv", () => {
  equal(PTY_SCRIPT.includes("restart the remote server"), false);
  equal(PTY_SCRIPT.includes("sys.argv[1]"), true);
  equal(PTY_SCRIPT.includes("sys.argv[4:]"), true);
});
