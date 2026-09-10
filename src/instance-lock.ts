import { createHash } from "node:crypto";
import { createServer } from "node:net";
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
  const address =
    process.platform === "linux"
      ? `\0${name}`
      : process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : join(tmpdir(), `${name}.sock`);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? "Another bridge instance for this Discord bot is already running (or a local IPC lock remains). Stop the existing instance before starting another."
            : `Cannot acquire bridge instance lock (${error.code || "unknown error"}).`,
        ),
      );
    });
    server.listen(address, resolve);
  });
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
