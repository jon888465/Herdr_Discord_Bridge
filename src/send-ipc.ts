import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Agent → bridge request: post text and/or files to the Discord thread mapped to `paneId`. */
export interface SendRequest {
  paneId: string;
  text?: string;
  files?: string[];
}
export interface SendResponse {
  ok: boolean;
  message: string;
}

const MAX_REQUEST_BYTES = 256 * 1024;

/** Fixed per-user path so the CLI needs no bridge config; override for tests. */
export function sendSocketPath(): string {
  if (process.env.HERDR_DISCORD_SEND_SOCKET)
    return process.env.HERDR_DISCORD_SEND_SOCKET;
  if (process.platform === "win32")
    return "\\\\.\\pipe\\herdr-discord-bridge-send";
  return join(homedir(), ".config", "herdr-discord-bridge", "send.sock");
}

function isSendRequest(value: unknown): value is SendRequest {
  const v = value as SendRequest;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.paneId === "string" &&
    (v.text === undefined || typeof v.text === "string") &&
    (v.files === undefined ||
      (Array.isArray(v.files) && v.files.every((f) => typeof f === "string")))
  );
}

/**
 * Command socket limited to "send to Discord". It is separate from the instance
 * lock (which never accepts commands). Unix: directory 0700 and socket 0600, so
 * only the same OS user can connect.
 */
export async function startSendServer(
  handler: (request: SendRequest) => Promise<SendResponse>,
  path = sendSocketPath(),
): Promise<() => void> {
  const unix = process.platform !== "win32";
  if (unix) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await removeIfStale(path);
  }
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(JSON.stringify({ ok: false, message: "request too large" }));
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      void (async () => {
        let response: SendResponse;
        try {
          const parsed: unknown = JSON.parse(line);
          response = isSendRequest(parsed)
            ? await handler(parsed)
            : { ok: false, message: "invalid request" };
        } catch (error) {
          response = {
            ok: false,
            message: error instanceof Error ? error.message : "send failed",
          };
        }
        socket.end(JSON.stringify(response) + "\n");
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  if (unix) chmodSync(path, 0o600);
  server.unref();
  return () => {
    server.close();
    if (unix)
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
  };
}

function removeIfStale(path: string): Promise<void> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve();
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
      resolve();
    });
  });
}

export function sendRequest(
  request: SendRequest,
  path = sendSocketPath(),
  timeoutMs = 30000,
): Promise<SendResponse> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let data = "";
    const fail = (message: string) => resolve({ ok: false, message });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      fail("bridge did not respond in time");
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? "bridge is not running (no send socket)"
          : `cannot reach bridge: ${error.code || error.message}`,
      ),
    );
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data) as SendResponse);
      } catch {
        fail("invalid response from bridge");
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  });
}
