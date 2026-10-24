import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HerdrClient, HerdrError } from "./herdr.js";

/** 遠端 Herdr 機器：經 SSH 把遠端 herdr.sock 轉成本機短路徑 socket（ISSUE-041）。 */
export interface MachineConfig {
  /** 識別碼；ID 以 `<id>:` 當前綴區分，不帶前綴的一律是本機。 */
  id: string;
  /** `ssh` 的目標（~/.ssh/config 的 Host 或 user@host）。 */
  ssh: string;
  /** 遠端 Herdr API socket 的絕對路徑。 */
  socket: string;
}

const MACHINE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,31}$/;
// 本機 ID 長 w1、w1:p1、w1:t1、term_xxx；機器 ID 不可與其混淆。
const LOCAL_LOOKALIKE = /^(w\d+|p\d+|t\d+|term_.*|local)$/;

export function validateMachines(value: unknown): MachineConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const machines: MachineConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { id, ssh, socket } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof ssh !== "string" ||
      typeof socket !== "string"
    )
      throw new Error("machines[] needs string id, ssh and socket");
    if (!MACHINE_ID.test(id) || LOCAL_LOOKALIKE.test(id))
      throw new Error(`machines[].id "${id}" is not a valid machine id`);
    if (seen.has(id)) throw new Error(`machines[].id "${id}" is duplicated`);
    // ssh 目標不可被當成 ssh 選項，socket 必須是遠端絕對路徑。
    if (!ssh || ssh.startsWith("-") || /\s/.test(ssh))
      throw new Error(`machines[${id}].ssh is not a valid ssh target`);
    if (!socket.startsWith("/") || /[\s:]/.test(socket))
      throw new Error(`machines[${id}].socket must be an absolute path`);
    seen.add(id);
    machines.push({ id, ssh, socket });
  }
  return machines;
}

export function tunnelSocketPath(id: string): string {
  // macOS 的 Unix socket 路徑上限約 104 字元，所以放在短路徑。
  return path.join(
    os.homedir(),
    ".config",
    "herdr-discord-bridge",
    "tunnels",
    `${id}.sock`,
  );
}

/** 維持一條 `ssh -L` 轉發；斷線後以退避重連。 */
export class MachineTunnel {
  readonly socketPath: string;
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly machine: MachineConfig,
    private readonly log: (message: string) => void = console.error,
    socketPath: string = tunnelSocketPath(machine.id),
  ) {
    this.socketPath = socketPath;
  }

  start(): void {
    fs.mkdirSync(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    this.spawnSsh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.child?.kill("SIGTERM");
    fs.rmSync(this.socketPath, { force: true });
  }

  private spawnSsh(): void {
    if (this.stopped) return;
    fs.rmSync(this.socketPath, { force: true });
    const startedAt = Date.now();
    const child = spawn(
      "ssh",
      [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `${this.socketPath}:${this.machine.socket}`,
        this.machine.ssh,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-300);
    });
    child.once("error", (error) =>
      this.log(`machine ${this.machine.id}: ssh failed: ${error.message}`),
    );
    child.once("exit", (code) => {
      this.child = null;
      if (this.stopped) return;
      // 撐過 30 秒才斷的連線視為曾經成功，退避從頭開始。
      if (Date.now() - startedAt > 30000) this.backoffMs = 1000;
      this.log(
        `machine ${this.machine.id}: tunnel closed (exit ${code}) ${stderr.trim()}; retry in ${Math.round(this.backoffMs / 1000)}s`,
      );
      this.timer = setTimeout(() => this.spawnSsh(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    });
  }
}

/** 遠端清理：只刪 root 直接子項中超過 minutes 分鐘的 `message-*` 真目錄。 */
export async function cleanupRemoteAttachments(
  machine: MachineConfig,
  root: string,
  minutes: number,
  sshCommand = "ssh",
  timeoutMs = 60000,
): Promise<void> {
  if (!root.startsWith("/") || root.includes("\0"))
    throw new Error("remote directory must be an absolute path");
  if (!Number.isInteger(minutes) || minutes < 1)
    throw new Error("invalid retention");
  const command = `[ -d ${shellQuote(root)} ] && find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -name 'message-*' -mmin +${minutes} -exec rm -rf {} + ; true`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      sshCommand,
      ["-o", "BatchMode=yes", machine.ssh, command],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cleanup on ${machine.id} timed out`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-300);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `cleanup on ${machine.id} failed (exit ${code}) ${stderr.trim()}`,
          ),
        );
    });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 把本機檔案經 ssh 串流寫到遠端目錄（遠端 0700／0600）；回傳遠端絕對路徑。 */
export async function uploadFiles(
  machine: MachineConfig,
  remoteDir: string,
  files: Array<{ localPath: string; name: string }>,
  sshCommand = "ssh",
  timeoutMs = 60000,
): Promise<string[]> {
  if (!remoteDir.startsWith("/") || remoteDir.includes("\0"))
    throw new Error("remote directory must be an absolute path");
  const out: string[] = [];
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(file.name) || file.name.startsWith("."))
      throw new Error("unsafe attachment file name");
    const remotePath = `${remoteDir.replace(/\/+$/, "")}/${file.name}`;
    const bytes = await readFile(file.localPath);
    const command = `umask 077 && mkdir -p ${shellQuote(remoteDir)} && cat > ${shellQuote(remotePath)}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        sshCommand,
        ["-o", "BatchMode=yes", machine.ssh, command],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`upload to ${machine.id} timed out`));
      }, timeoutMs);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-300);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `upload to ${machine.id} failed (exit ${code}) ${stderr.trim()}`,
            ),
          );
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(bytes);
    });
    out.push(remotePath);
  }
  return out;
}

const ID_KEYS = new Set([
  "terminal_id",
  "pane_id",
  "workspace_id",
  "tab_id",
  "target_pane_id",
  "target",
]);
const AGGREGATE_METHODS = new Set([
  "agent.list",
  "workspace.list",
  "session.snapshot",
]);

type Params = Record<string, unknown>;

interface Remote {
  config: MachineConfig;
  tunnel: MachineTunnel;
  client: HerdrClient;
  up: boolean;
  cache: Map<string, Record<string, unknown>>;
}

/**
 * 本機 + 遠端機器的單一入口。不帶機器前綴的 ID 一律走本機；`<機器>:` 前綴的 ID
 * 轉給對應機器並去掉前綴，回傳的 ID 再補上前綴，因此其餘程式碼只看到唯一的字串 ID。
 */
export class HerdrHub extends HerdrClient {
  private readonly remotes = new Map<string, Remote>();

  constructor(
    machines: MachineConfig[],
    socketPath: string | undefined,
    defaultTimeoutMs: number,
    reconnectBaseMs: number,
    log: (message: string) => void = console.error,
    socketFor: (id: string) => string = tunnelSocketPath,
  ) {
    super(socketPath, defaultTimeoutMs, reconnectBaseMs);
    for (const config of machines) {
      const tunnel = new MachineTunnel(config, log, socketFor(config.id));
      this.remotes.set(config.id, {
        config,
        tunnel,
        client: new HerdrClient(
          tunnel.socketPath,
          Math.min(defaultTimeoutMs, 5000),
          reconnectBaseMs,
        ),
        up: false,
        cache: new Map(),
      });
    }
    this.log = log;
  }

  private log: (message: string) => void;

  startTunnels(): void {
    for (const remote of this.remotes.values()) remote.tunnel.start();
  }

  stopTunnels(): void {
    for (const remote of this.remotes.values()) remote.tunnel.stop();
  }

  /** 把本機檔案上傳到該機器上的目錄；機器不存在時回報錯誤。 */
  async uploadTo(
    machineId: string,
    remoteDir: string,
    files: Array<{ localPath: string; name: string }>,
  ): Promise<string[]> {
    const remote = this.remotes.get(machineId);
    if (!remote) throw new Error(`unknown machine ${machineId}`);
    return uploadFiles(remote.config, remoteDir, files);
  }

  async cleanupAttachments(
    machineId: string,
    root: string,
    minutes: number,
  ): Promise<void> {
    const remote = this.remotes.get(machineId);
    if (!remote) throw new Error(`unknown machine ${machineId}`);
    await cleanupRemoteAttachments(remote.config, root, minutes);
  }

  machineIds(): string[] {
    return [...this.remotes.keys()];
  }

  override request<T = unknown>(
    method: string,
    params: Params = {},
    options: { timeoutMs?: number; retries?: number } = {},
  ): Promise<T> {
    let machine: string | undefined;
    try {
      machine = this.machineOf(params);
    } catch (error) {
      return Promise.reject(error);
    }
    if (machine) {
      const remote = this.remotes.get(machine)!;
      return this.remoteRequest<T>(remote, method, params, options);
    }
    if (this.remotes.size > 0 && AGGREGATE_METHODS.has(method))
      return this.aggregate<T>(method, params, options);
    return super.request<T>(method, params, options);
  }

  /** 參數裡出現哪一台機器的 ID；混用本機與遠端或不同機器會被拒絕。 */
  private machineOf(params: Params): string | undefined {
    let found: string | undefined;
    let sawLocal = false;
    for (const [key, value] of Object.entries(params)) {
      if (!ID_KEYS.has(key) || typeof value !== "string") continue;
      const id = this.prefixOf(value);
      if (!id) {
        sawLocal = true;
        continue;
      }
      if (found && found !== id)
        throw new Error(`request mixes machines ${found} and ${id}`);
      found = id;
    }
    if (found && sawLocal)
      throw new Error(`request mixes machine ${found} with local IDs`);
    return found;
  }

  private prefixOf(value: string): string | undefined {
    const colon = value.indexOf(":");
    if (colon <= 0) return undefined;
    const id = value.slice(0, colon);
    return this.remotes.has(id) ? id : undefined;
  }

  private async remoteRequest<T>(
    remote: Remote,
    method: string,
    params: Params,
    options: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const prefix = `${remote.config.id}:`;
    const stripped: Params = {};
    for (const [key, value] of Object.entries(params)) {
      stripped[key] =
        ID_KEYS.has(key) &&
        typeof value === "string" &&
        value.startsWith(prefix)
          ? value.slice(prefix.length)
          : value;
    }
    try {
      const result = await remote.client.request<T>(method, stripped, options);
      this.markUp(remote, true);
      return this.decorate(result, remote.config.id) as T;
    } catch (error) {
      if (!(error instanceof HerdrError)) this.markUp(remote, false);
      throw error;
    }
  }

  private async aggregate<T>(
    method: string,
    params: Params,
    options: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const local = await super.request<Record<string, unknown>>(
      method,
      params,
      options,
    );
    const merged: Record<string, unknown> = { ...local };
    for (const remote of this.remotes.values()) {
      let part: Record<string, unknown> | undefined;
      try {
        part = (await remote.client.request<Record<string, unknown>>(
          method,
          params,
          { timeoutMs: 3000, retries: 0 },
        )) as Record<string, unknown>;
        part = this.decorate(part, remote.config.id) as Record<string, unknown>;
        remote.cache.set(method, part);
        this.markUp(remote, true);
      } catch {
        // 遠端暫時不通時沿用上次結果：避免 watcher 把遠端 Agent 誤判為已移除。
        this.markUp(remote, false);
        part = remote.cache.get(method);
      }
      if (!part) continue;
      for (const [key, value] of Object.entries(part)) {
        if (Array.isArray(value) && Array.isArray(merged[key]))
          merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
    return merged as T;
  }

  private markUp(remote: Remote, up: boolean): void {
    if (remote.up === up) return;
    remote.up = up;
    this.log(
      `machine ${remote.config.id}: ${up ? "connected" : "unreachable (using last known state)"}`,
    );
  }

  /** 為遠端回傳的 ID 補上機器前綴，並標示來源機器。 */
  private decorate(value: unknown, machine: string): unknown {
    const prefix = `${machine}:`;
    const walk = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(walk);
      if (!node || typeof node !== "object") return node;
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(source)) {
        if (ID_KEYS.has(key) && typeof item === "string" && item)
          out[key] = prefix + item;
        else out[key] = walk(item);
      }
      if (typeof source.workspace_id === "string") {
        out.machine = machine;
        // Agent 的 name 是 Agent 自己的名稱，不是 workspace 名稱，不加前綴。
        const keys =
          typeof source.terminal_id === "string"
            ? ["workspace_name"]
            : ["label", "name", "workspace_name"];
        for (const key of keys) {
          if (typeof source[key] === "string" && source[key])
            out[key] = `${machine}:${source[key] as string}`;
        }
      } else if (typeof source.terminal_id === "string") {
        out.machine = machine;
      }
      return out;
    };
    return walk(value);
  }
}
