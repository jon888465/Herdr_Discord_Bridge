import fs from "node:fs";
import path from "node:path";
import { connect, createServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { configDirectory, stateDirectory } from "./config.js";
import type { HerdrHub, MachineControlResult } from "./machines.js";

export function machineControlSocketPath(): string {
  return (
    process.env.HERDR_DISCORD_MACHINE_CONTROL_SOCKET ||
    (process.platform === "win32"
      ? "\\\\.\\pipe\\herdr-discord-machine-control"
      : path.join(configDirectory(), "machine-control.sock"))
  );
}
export function machineControlTokenFile(): string {
  return path.join(stateDirectory(), "machine-control.token");
}
export interface MachineControlRequest {
  version: 1;
  token: string;
  action: "connect" | "disconnect";
  machineId: string;
  force?: boolean;
}
const rejected: MachineControlResult = {
  ok: false,
  reason: "request rejected",
};
const unavailable: MachineControlResult = {
  ok: false,
  reason: "bridge 未連線",
};

export async function startMachineControlServer(
  hub: Pick<HerdrHub, "connectMachine" | "disconnectMachine">,
  socketPath = machineControlSocketPath(),
  tokenFile = machineControlTokenFile(),
): Promise<() => void> {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const unix = process.platform !== "win32";
  if (unix) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("machine control already running"));
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED")
          fs.rmSync(socketPath, { force: true });
        resolve();
      });
    });
  }
  const tempToken = `${tokenFile}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempToken, token, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempToken, tokenFile);
  } finally {
    fs.rmSync(tempToken, { force: true });
  }
  const clients = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length <= 8192 && !buffer.includes("\n")) return;
      handled = true;
      let result = rejected;
      try {
        const value: unknown =
          buffer.length <= 8192
            ? JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
            : null;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const v = value as Record<string, unknown>;
          if (
            v.version === 1 &&
            typeof v.token === "string" &&
            Buffer.byteLength(v.token) === Buffer.byteLength(token) &&
            timingSafeEqual(Buffer.from(v.token), Buffer.from(token)) &&
            (v.action === "connect" || v.action === "disconnect") &&
            typeof v.machineId === "string" &&
            (v.force === undefined || typeof v.force === "boolean")
          ) {
            result =
              v.action === "connect"
                ? hub.connectMachine(v.machineId)
                : hub.disconnectMachine(v.machineId, {
                    force: v.force as boolean | undefined,
                  });
          }
        }
      } catch {
        /* Never expose transport or configuration errors. */
      }
      socket.end(JSON.stringify(result) + "\n");
    });
  });
  const previousUmask = unix ? process.umask(0o077) : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    if (unix) fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    for (const client of clients) client.destroy();
    const listening = server.listening;
    server.close();
    if (unix && listening) fs.rmSync(socketPath, { force: true });
    fs.rmSync(tokenFile, { force: true });
    throw error;
  } finally {
    if (previousUmask !== undefined) process.umask(previousUmask);
  }
  server.unref();
  return () => {
    for (const client of clients) client.destroy();
    server.close();
    if (unix) fs.rmSync(socketPath, { force: true });
  };
}

export function machineControlRequest(
  request: Omit<MachineControlRequest, "version" | "token"> &
    Partial<Pick<MachineControlRequest, "version" | "token">>,
  socketPath = machineControlSocketPath(),
  timeoutMs = 5000,
): Promise<MachineControlResult> {
  let token: string;
  try {
    token =
      request.token ??
      fs.readFileSync(machineControlTokenFile(), "utf8").trim();
  } catch {
    return Promise.resolve(unavailable);
  }
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    const finish = (result: MachineControlResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(unavailable));
    socket.on("error", () => finish(unavailable));
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...request, version: 1, token }) + "\n"),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8192) return finish(unavailable);
      if (!buffer.includes("\n")) return;
      try {
        finish(JSON.parse(buffer) as MachineControlResult);
      } catch {
        finish(unavailable);
      }
    });
    socket.on("end", () => finish(unavailable));
  });
}

/** The optional board control channel must never prevent bridge startup. */
export async function startMachineControlServerSafely(
  hub: Pick<HerdrHub, "connectMachine" | "disconnectMachine">,
  socketPath = machineControlSocketPath(),
  tokenFile = machineControlTokenFile(),
  log: (message: string) => void = console.error,
): Promise<() => void> {
  try {
    return await startMachineControlServer(hub, socketPath, tokenFile);
  } catch {
    log("Machine control channel unavailable");
    return () => {};
  }
}
