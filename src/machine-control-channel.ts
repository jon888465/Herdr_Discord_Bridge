import fs from "node:fs";
import path from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { configDirectory, stateDirectory } from "./config.js";
import type { MachineControlResult } from "./machines.js";

/**
 * 看板（另一個程序）→ bridge 的 machine 連線／斷線控制通道（ISSUE-166 第三階段 B）。
 * Unix socket 放在 config 目錄下的短路徑；每次啟動產生新 token，只有讀得到 0600 token 檔的同一個 OS 使用者能操作。
 * 所有失敗只回固定短句，不帶 ssh、socket 路徑、token 或設定內容。
 */
export const MACHINE_CONTROL_MAX_REQUEST_BYTES = 4096;
export const MACHINE_CONTROL_TIMEOUT_MS = 5000;

export function machineControlSocketPath(): string {
  return path.join(configDirectory(), "run", "mc.sock");
}

export function machineControlTokenFile(): string {
  return path.join(stateDirectory(), "machine-control.token");
}

export type MachineControlAction = "connect" | "disconnect";

export interface MachineControlCommand {
  action: MachineControlAction;
  machineId: string;
  force?: boolean;
}

export interface MachineControlHub {
  connectMachine(id: string): MachineControlResult;
  disconnectMachine(
    id: string,
    options?: { force?: boolean },
  ): MachineControlResult;
}

export const CONTROL_REJECTED = "請求被拒絕";
export const CONTROL_TOO_LARGE = "請求過大";
export const CONTROL_TIMEOUT = "請求逾時";
export const CONTROL_FAILED = "操作失敗";
export const CONTROL_UNAVAILABLE = "bridge 未連線";
export const CONTROL_NO_RESPONSE = "bridge 沒有回應";
export const CONTROL_BAD_RESPONSE = "bridge 回應格式不對";
export const CONTROL_START_FAILED_LOG = "Machine control channel unavailable";

function fail(reason: string): MachineControlResult {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 常數時間比較；長度不同先拒絕（timingSafeEqual 本身要求等長）。 */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 驗證一行請求；格式、版本、token、action、machineId、force 任何一項不對就回 undefined，不會呼叫 hub。 */
export function parseControlRequest(
  line: string,
  token: string,
): MachineControlCommand | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !tokenMatches(value.token, token) ||
    (value.action !== "connect" && value.action !== "disconnect") ||
    typeof value.machineId !== "string" ||
    !value.machineId ||
    (value.force !== undefined && typeof value.force !== "boolean")
  )
    return undefined;
  return {
    action: value.action,
    machineId: value.machineId,
    ...(value.force === true ? { force: true } : {}),
  };
}

/** 只送出結果的已知欄位，保留結構化的 needsForce:true。 */
export function normalizeControlResult(value: unknown): MachineControlResult {
  if (!isObject(value)) return fail(CONTROL_BAD_RESPONSE);
  if (value.ok === true) {
    if (value.status !== "connected" && value.status !== "disconnected")
      return fail(CONTROL_BAD_RESPONSE);
    if (value.note !== undefined && typeof value.note !== "string")
      return fail(CONTROL_BAD_RESPONSE);
    return {
      ok: true,
      status: value.status,
      ...(typeof value.note === "string" ? { note: value.note } : {}),
    };
  }
  if (value.ok !== false || typeof value.reason !== "string")
    return fail(CONTROL_BAD_RESPONSE);
  return {
    ok: false,
    reason: value.reason,
    ...(value.needsForce === true ? { needsForce: true } : {}),
  };
}

function runCommand(
  hub: MachineControlHub,
  command: MachineControlCommand,
): MachineControlResult {
  try {
    return normalizeControlResult(
      command.action === "connect"
        ? hub.connectMachine(command.machineId)
        : hub.disconnectMachine(
            command.machineId,
            command.force ? { force: true } : {},
          ),
    );
  } catch {
    return fail(CONTROL_FAILED);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isSocketPath(file: string): boolean {
  try {
    return fs.lstatSync(file).isSocket();
  } catch {
    return false;
  }
}

/** 對既有路徑做一次連線探測：有程序在聽是 live；ECONNREFUSED 是 refused；其他錯誤是 other。 */
export type SocketProbe = (
  file: string,
) => Promise<"live" | "refused" | "other">;

const probeSocket: SocketProbe = (file) =>
  new Promise((resolve) => {
    const probe = connect(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", (error) => {
      probe.destroy();
      resolve(isErrno(error, "ECONNREFUSED") ? "refused" : "other");
    });
  });

/**
 * 既有路徑：有程序在聽就拒絕啟動；ECONNREFUSED 且 lstat 確認是 socket 才刪除，其他情況保留原樣、讓 listen 失敗。
 * 目錄或普通檔案在 Linux 也會回 ECONNREFUSED；PR #275 對它無條件刪除，目錄在 Linux 丟 ERR_FS_EISDIR，普通檔案被誤刪。
 * macOS 對這兩種路徑回的不是 ECONNREFUSED，所以測試注入 probe 才能在兩個平台都走到這條路。
 */
export async function clearStaleSocket(
  file: string,
  probe: SocketProbe = probeSocket,
): Promise<void> {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const result = await probe(file);
  if (result === "live") throw new Error("machine control already running");
  if (result === "refused" && isSocketPath(file)) fs.unlinkSync(file);
}

/** 建立（或收緊）socket 目錄為 0700；不接受 symlink 或非目錄。 */
function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error("not a directory");
  fs.chmodSync(dir, 0o700);
}

function writeTokenFile(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, token, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** 在 umask 077 下 listen，完成或失敗後都還原 umask。 */
async function listenPrivately(
  server: ReturnType<typeof createServer>,
  socketPath: string,
): Promise<void> {
  const previous = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  fs.chmodSync(socketPath, 0o600);
}

export interface MachineControlServerOptions {
  socketPath?: string;
  tokenFile?: string;
  maxRequestBytes?: number;
  timeoutMs?: number;
}

export async function startMachineControlServer(
  hub: MachineControlHub,
  options: MachineControlServerOptions = {},
): Promise<() => void> {
  if (process.platform === "win32") throw new Error("unsupported platform");
  const socketPath = options.socketPath ?? machineControlSocketPath();
  const tokenFile = options.tokenFile ?? machineControlTokenFile();
  const maxBytes = options.maxRequestBytes ?? MACHINE_CONTROL_MAX_REQUEST_BYTES;
  const timeoutMs = options.timeoutMs ?? MACHINE_CONTROL_TIMEOUT_MS;
  ensurePrivateDirectory(path.dirname(socketPath));
  await clearStaleSocket(socketPath);
  const token = randomBytes(32).toString("hex");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    // 總期限：從連線建立起算，收到資料不重設；socket.setTimeout 是閒置逾時，持續慢速送資料就能拖過上限（review f1）。
    const deadline = setTimeout(() => reply(fail(CONTROL_TIMEOUT)), timeoutMs);
    deadline.unref();
    const reply = (result: MachineControlResult): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (socket.destroyed) return;
      socket.end(JSON.stringify(result) + "\n");
      // 回覆後的銷毀期限不會被對方繼續寫入重設：半開的 client 持續送資料也不能永久占用 socket（review f1）。
      destroyTimer = setTimeout(() => socket.destroy(), timeoutMs);
      destroyTimer.unref();
    };
    let destroyTimer: NodeJS.Timeout | undefined;
    socket.once("close", () => {
      done = true;
      clearTimeout(deadline);
      clearTimeout(destroyTimer);
    });
    // 閒置逾時是額外保護：回覆後對方不關也不讀時直接切斷。
    socket.setTimeout(timeoutMs, () =>
      done ? socket.destroy() : reply(fail(CONTROL_TIMEOUT)),
    );
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      const newline = chunk.indexOf(0x0a);
      const take = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += take.length;
      if (size > maxBytes) return reply(fail(CONTROL_TOO_LARGE));
      chunks.push(take);
      if (newline < 0) return;
      const command = parseControlRequest(
        Buffer.concat(chunks).toString("utf8"),
        token,
      );
      reply(command ? runCommand(hub, command) : fail(CONTROL_REJECTED));
    });
  });
  try {
    await listenPrivately(server, socketPath);
    writeTokenFile(tokenFile, token);
  } catch (error) {
    const listening = server.listening;
    server.close();
    if (listening && isSocketPath(socketPath)) fs.rmSync(socketPath);
    throw error;
  }
  server.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const client of clients) client.destroy();
    server.close();
    try {
      if (isSocketPath(socketPath)) fs.unlinkSync(socketPath);
      fs.rmSync(tokenFile, { force: true });
    } catch {
      // 關閉時清不掉只留下過期檔案，下次啟動會處理。
    }
  };
}

/** 通道是選用的：啟動失敗只記一行固定訊息，回傳空的停止函式，不擋 bridge 啟動。 */
export async function startMachineControlServerSafely(
  hub: MachineControlHub,
  options: MachineControlServerOptions = {},
  log: (message: string) => void = console.error,
): Promise<() => void> {
  try {
    return await startMachineControlServer(hub, options);
  } catch {
    log(CONTROL_START_FAILED_LOG);
    return () => undefined;
  }
}

function readToken(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256) return undefined;
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 看板端：送出一個請求並等待一行回應；任何傳輸錯誤都轉成固定短句，不會丟出例外。 */
export function sendMachineControl(
  command: MachineControlCommand,
  options: { socketPath?: string; tokenFile?: string; timeoutMs?: number } = {},
): Promise<MachineControlResult> {
  const token = readToken(options.tokenFile ?? machineControlTokenFile());
  if (!token) return Promise.resolve(fail(CONTROL_UNAVAILABLE));
  const socketPath = options.socketPath ?? machineControlSocketPath();
  const timeoutMs = options.timeoutMs ?? MACHINE_CONTROL_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(socketPath);
    // 總期限：server 慢慢送資料也不會延長等待（review f1）；閒置逾時保留為額外保護。
    const deadline = setTimeout(
      () => finish(fail(CONTROL_NO_RESPONSE)),
      timeoutMs,
    );
    const finish = (result: MachineControlResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(fail(CONTROL_NO_RESPONSE)));
    socket.on("error", () => finish(fail(CONTROL_UNAVAILABLE)));
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          version: 1,
          token,
          action: command.action,
          machineId: command.machineId,
          ...(command.force ? { force: true } : {}),
        }) + "\n",
      ),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MACHINE_CONTROL_MAX_REQUEST_BYTES)
        return finish(fail(CONTROL_BAD_RESPONSE));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(normalizeControlResult(JSON.parse(buffer.slice(0, end))));
      } catch {
        finish(fail(CONTROL_BAD_RESPONSE));
      }
    });
    socket.on("end", () => finish(fail(CONTROL_BAD_RESPONSE)));
  });
}
