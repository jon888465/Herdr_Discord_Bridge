// 在 pty 裡執行一個互動式指令，只在看到「特定提示」時回答一次（ISSUE-177）。
// Herdr 的 `machine add` 要求重啟遠端 server 時要互動式回答 [y/N]；沒有 TTY 就當成取消。
// Node 沒有內建 pty：試過 `script`，但 macOS 的 `script` 不接受 Node 的 pipe（socketpair）、FIFO 當 stdin
// （tcgetattr: Operation not supported on socket），所以改用 Python 內建的 `pty` 模組（macOS 與 Linux 都有 python3）。
// 重要：提示出現前就送出回答會被當成取消（2026-11-20 實測），所以一定要等提示。

import { spawn } from "node:child_process";

export interface PtyApproval {
  /** 必須符合這個提示才回答；其他提示一律不回答（逾時後取消）。 */
  prompt: RegExp;
  /** 送出的回答，含換行。 */
  answer: string;
}

/** Herdr 要求重啟遠端 server 的提示（含 [y/N]）。 */
export const HERDR_RESTART_APPROVAL: PtyApproval = {
  prompt: /restart the remote server now\?\s*\[y\/N\]/i,
  answer: "y\n",
};

const MAX_OUTPUT = 16_384;

// 固定的 Python 程式：argv = [提示 regex, 旗標（i 或空）, 回答, 指令, 引數…]。值只走 argv，不拼進程式碼。
// 在 pty 裡執行指令、轉送輸出到 stdout、看到提示才寫一次回答、結束碼照傳；收到 SIGTERM 就殺掉子程序。
export const PTY_SCRIPT = `
import os, pty, re, select, signal, sys
pattern, flags, answer = sys.argv[1], sys.argv[2], sys.argv[3]
argv = sys.argv[4:]
rx = re.compile(pattern, re.IGNORECASE if "i" in flags else 0)
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        sys.stderr.write("exec failed: %s\\n" % e)
        os._exit(127)
def stop(*_):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    os._exit(143)
signal.signal(signal.SIGTERM, stop)
buf = ""
answered = False
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 0.2)
    except (OSError, ValueError):
        break
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        text = data.decode("utf-8", "replace")
        sys.stdout.write(text)
        sys.stdout.flush()
        buf = (buf + text)[-4096:]
        if not answered and rx.search(re.sub(r"\\x1b\\[[0-9;?]*[a-zA-Z]", "", buf).replace("\\r", "")):
            answered = True
            os.write(fd, answer.encode())
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
`;

function stripTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

export type PtyRunError = Error & { herdrOutput?: string };

/**
 * 在 pty 裡執行 command，等 `approval.prompt` 出現才送一次回答；結束碼 0 回傳整理過的輸出，否則丟錯（錯誤帶 herdrOutput）。
 * 逾時就終止並丟錯；沒有出現提示就不會回答。沒有 python3 或平台不支援（Windows）會直接丟錯。
 */
export function runWithPtyApproval(
  command: string,
  args: string[],
  approval: PtyApproval,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
  python = "python3",
): Promise<string> {
  if (platform === "win32") return Promise.reject(new Error("這個平台不支援互動式確認"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      ["-c", PTY_SCRIPT, approval.prompt.source, approval.prompt.flags.includes("i") ? "i" : "", approval.answer, command, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let settled = false;
    const finish = (error: PtyRunError | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stripTerminal(output).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
      if (!error) return resolve(text);
      error.herdrOutput = text;
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      finish(new Error("timed out waiting for the command"));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => finish(Object.assign(error, { message: (error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到 python3，無法做互動式確認" : error.message }) as PtyRunError));
    child.once("close", (code) => finish(code === 0 ? undefined : (new Error(`exited with code ${String(code)}`) as PtyRunError)));
  });
}
