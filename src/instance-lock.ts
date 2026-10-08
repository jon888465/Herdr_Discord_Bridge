import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An OS-owned local IPC endpoint is used only as a lock, never as a command API.
export async function acquireInstanceLock(
  token: string,
): Promise<() => Promise<void>> {
  const botId = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
  const key = createHash("sha256")
    .update(/^\d{15,25}$/.test(botId) ? botId : token)
    .digest("hex")
    .slice(0, 40);
  const name = `herdr-discord-bridge-${key}`;
  const socketDir =
    process.platform === "darwin" ||
    join(tmpdir(), `${name}.sock`).length >= 104
      ? "/tmp"
      : tmpdir();
  const address =
    process.platform === "linux"
      ? `\0${name}`
      : process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : join(socketDir, `${name}.sock`);
  // A crashed bridge leaves its socket file behind; with nobody listening it
  // is stale and safe to remove (a live instance still accepts connections).
  const removeIfStale = () =>
    new Promise<boolean>((resolve) => {
      if (process.platform === "linux" || process.platform === "win32")
        return resolve(false);
      const probe = connect(address);
      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNREFUSED") return resolve(false);
        try {
          unlinkSync(address);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
  const listen = (): Promise<ReturnType<typeof createServer>> =>
    new Promise((resolve, reject) => {
      const candidate = createServer((socket) => socket.destroy());
      candidate.once("error", reject);
      candidate.listen(address, () => resolve(candidate));
    });
  let server: ReturnType<typeof createServer>;
  try {
    try {
      server = await listen();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
        !(await removeIfStale())
      )
        throw error;
      server = await listen();
    }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    throw new Error(
      error.code === "EADDRINUSE"
        ? "Another bridge instance for this Discord bot is already running (or a local IPC lock remains). Stop the existing instance before starting another."
        : `Cannot acquire bridge instance lock (${error.code || "unknown error"}).`,
    );
  }
  server.unref();
  const cleanup = () => {
    server.close();
  };
  process.once("exit", cleanup);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    process.removeListener("exit", cleanup);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}
