import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HerdrClient, HerdrError } from "./herdr.js";
import { hookSocketPath } from "./hook-events.js";
import type { AgentRecord } from "./types.js";

/** 遠端 Herdr 機器：經 SSH 把遠端 herdr.sock 轉成本機短路徑 socket（ISSUE-041）。 */
export interface MachineConfig {
  /** 識別碼；ID 以 `<id>:` 當前綴區分，不帶前綴的一律是本機。 */
  id: string;
  /** `ssh` 的目標（~/.ssh/config 的 Host 或 user@host）。 */
  ssh: string;
  /** 遠端 Herdr API socket 的絕對路徑。 */
  socket: string;
  /**
   * 選填：遠端 hook socket 的絕對路徑。設定後 bridge 以 `ssh -R` 把它轉回本機 hook socket，
   * 遠端 Agent 的 Stop hook 才能把事件送回本機（ISSUE-045）。未設定則遠端只用 parser。
   */
  hookSocket?: string;
  /** 選填：開放卡片 reviewer 與 task 內唯讀角色；toolchain 為 true 才可分配 verify。 */
  cardReview?: { root: string; kinds: string[]; toolchain?: boolean };
}

/** 遠端 shell／git 參數：不可含 `..`、`.` 路徑段、控制字元、空白、shell 字元，路徑段不以 `-` 開頭。 */
export function unsafeRemoteValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 200) return "長度";
  if (value.split("/").some((part) => part.startsWith("-") || part === ".")) return ". 或 - 路徑段";
  if (/[\u0000-\u0020\u007F\s'"\\`$;&|<>*?]/.test(value) || value.includes("..")) return "控制、空白、shell 字元或 ..";
  return undefined;
}

function validateCardReview(id: string, value: unknown): MachineConfig["cardReview"] {
  if (value === undefined) return undefined;
  const { root, kinds, toolchain, ...rest } = (value ?? {}) as Record<string, unknown>;
  const list = Array.isArray(kinds) ? (kinds as string[]) : [];
  if (
    !value || Array.isArray(value) || Object.keys(rest).length || typeof root !== "string" || !root.startsWith("/") ||
    unsafeRemoteValue(root) || root.split("/").filter(Boolean).length < 2 || !list.length || new Set(list).size !== list.length ||
    list.some((kind) => !["claude", "codex", "agy", "pi"].includes(kind)) || (toolchain !== undefined && typeof toolchain !== "boolean")
  )
    throw new Error(`machines[${id}].cardReview needs an absolute root (2+ segments) and kinds from claude, codex, agy, pi; toolchain, if set, must be a boolean`);
  return { root: root.replace(/\/+$/, ""), kinds: [...list], ...(toolchain ? { toolchain: true } : {}) };
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
    const { id, ssh, socket, hookSocket, cardReview } = item as Record<string, unknown>;
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
    if (
      hookSocket !== undefined &&
      (typeof hookSocket !== "string" ||
        !hookSocket.startsWith("/") ||
        /[\s:'"\\]/.test(hookSocket) ||
        hookSocket.split("/").includes(".."))
    )
      throw new Error(
        `machines[${id}].hookSocket must be an absolute path without spaces`,
      );
    const review = validateCardReview(id, cardReview);
    seen.add(id);
    machines.push({
      id,
      ssh,
      socket,
      ...(typeof hookSocket === "string" ? { hookSocket } : {}),
      ...(review ? { cardReview: review } : {}),
    });
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

/** SIGTERM 沒送達（kill 丟錯，或回 false 而程序還活著）就丟錯，呼叫端因此保留參照讓重試找得到（review F8、F10）。 */
function terminate(child: ChildProcess | null): void {
  if (
    child &&
    !child.kill("SIGTERM") &&
    child.exitCode === null &&
    child.signalCode === null
  )
    throw new Error("tunnel process did not receive SIGTERM");
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
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    this.socketPath = socketPath;
  }

  start(): void {
    fs.mkdirSync(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    this.stopped = false;
    this.backoffMs = 1000;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.child) this.spawnSsh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    terminate(child); // 失敗會丟錯，先不清參照（review F8、F10）
    this.child = null;
    fs.rmSync(this.socketPath, { force: true });
  }

  private spawnSsh(): void {
    if (this.stopped) return;
    fs.rmSync(this.socketPath, { force: true });
    const startedAt = Date.now();
    const child = this.spawnProcess(
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
    // spawn 失敗（ENOENT／EACCES）只發 error、不保證有 exit：error 也要走同一個收尾，child 才會清掉、退避重連（review F11）。
    const closed = (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      // 撐過 30 秒才斷的連線視為曾經成功，退避從頭開始。
      if (Date.now() - startedAt > 30000) this.backoffMs = 1000;
      this.log(
        `machine ${this.machine.id}: tunnel closed (exit ${code}) ${stderr.trim()}; retry in ${Math.round(this.backoffMs / 1000)}s`,
      );
      this.timer = setTimeout(() => this.spawnSsh(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    };
    child.once("error", (error) => {
      this.log(`machine ${this.machine.id}: ssh failed: ${error.message}`);
      // 只有 spawn 失敗（沒有 pid）才收尾；kill 送不到信號（EPERM 等）也會發 error，但程序還活著（review F12）。
      if (child.pid === undefined) closed(null);
    });
    child.once("exit", closed);
  }
}

/** `ssh -R` 參數：把遠端 hook socket 轉回本機 hook socket；遠端 socket 檔由啟動前的 `rm -f` 清掉（`StreamLocalBindUnlink` 是 sshd 端選項，client 端設定無效）。 */
export function hookTunnelArgs(
  machine: MachineConfig,
  localHookSocket: string,
): string[] {
  return [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-R",
    `${machine.hookSocket}:${localHookSocket}`,
    machine.ssh,
  ];
}

/**
 * 另開一條 `ssh -R`（不與 -L 共用，轉發失敗不會拖垮遠端控制），讓遠端 hook 把事件送回本機。
 * 啟動前先在遠端建立 0700 目錄；斷線後以退避重連。
 */
export class HookReverseTunnel {
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly machine: MachineConfig,
    private readonly localHookSocket: string,
    private readonly log: (message: string) => void = console.error,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  start(): void {
    if (!this.machine.hookSocket) return;
    this.stopped = false;
    this.backoffMs = 1000;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.child) this.spawnSsh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    terminate(child);
    this.child = null;
  }

  private spawnSsh(): void {
    if (this.stopped || !this.machine.hookSocket) return;
    const startedAt = Date.now();
    const dir = path.posix.dirname(this.machine.hookSocket);
    const prepare = this.spawnProcess(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        this.machine.ssh,
        `mkdir -p -m 700 ${shellQuote(dir)} && rm -f ${shellQuote(this.machine.hookSocket)}`,
      ],
      { stdio: "ignore" },
    );
    let forwarding: ChildProcess | undefined;
    const retry = (reason: string) => {
      if (this.child !== prepare && this.child !== forwarding) return;
      this.child = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > 30000) this.backoffMs = 1000;
      this.log(
        `machine ${this.machine.id}: hook tunnel ${reason}; retry in ${Math.round(this.backoffMs / 1000)}s`,
      );
      this.timer = setTimeout(() => this.spawnSsh(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    };
    this.child = prepare;
    prepare.once("error", (error) => {
      if (prepare.pid === undefined) retry(`mkdir failed: ${error.message}`); // 有 pid 的 error 是信號失敗（review F12）
    });
    prepare.once("exit", (code) => {
      if (this.child !== prepare) return;
      if (this.stopped) {
        this.child = null; // kill 失敗後自己退出：清掉參照，之後重新啟動才會 spawn（review F14）
        return;
      }
      if (code !== 0) return retry(`mkdir exited ${code}`);
      const child = this.spawnProcess(
        "ssh",
        hookTunnelArgs(this.machine, this.localHookSocket),
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      forwarding = child;
      this.child = child;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-300);
      });
      child.once("error", (error) => {
        if (child.pid === undefined) retry(`ssh failed: ${error.message}`);
      });
      child.once("exit", (exit) =>
        retry(`closed (exit ${exit}) ${stderr.trim()}`),
      );
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

export type MachineControlResult =
  | { ok: true; status: "connected" | "disconnected"; note?: string }
  | { ok: false; reason: string; needsForce?: boolean };

interface Remote {
  config: MachineConfig;
  tunnel: MachineTunnel;
  hookTunnel?: HookReverseTunnel;
  client: HerdrClient;
  up: boolean;
  disconnected: boolean;
  /** 已標為斷線，但至少一條 tunnel 沒停成功；重按斷線會重試停止（review 第 2 輪 F6）。 */
  stopPending?: boolean;
  generation: number;
  /** 最後一次實際請求遠端（不論成功失敗）的時間；從沒請求過是 undefined。 */
  observedAt?: number;
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
    private readonly isBusy?: (machineId: string) => string | undefined,
    private readonly scheduleProbe: (callback: () => void, delayMs: number) => void = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
    },
  ) {
    super(socketPath, defaultTimeoutMs, reconnectBaseMs);
    for (const config of machines) {
      const tunnel = new MachineTunnel(config, log, socketFor(config.id));
      this.remotes.set(config.id, {
        config,
        tunnel,
        hookTunnel: config.hookSocket
          ? new HookReverseTunnel(config, hookSocketPath(), log)
          : undefined,
        client: new HerdrClient(
          tunnel.socketPath,
          Math.min(defaultTimeoutMs, 5000),
          reconnectBaseMs,
        ),
        up: false,
        disconnected: false,
        generation: 0,
        cache: new Map(),
      });
    }
    this.log = log;
  }

  private log: (message: string) => void;

  startTunnels(): void {
    for (const remote of this.remotes.values()) {
      if (remote.disconnected) continue;
      remote.tunnel.start();
      remote.hookTunnel?.start();
    }
  }

  isDisconnected(id: string): boolean {
    return this.remotes.get(id)?.disconnected ?? false;
  }

  connectMachine(id: string): MachineControlResult {
    const remote = this.remotes.get(id);
    if (!remote) return { ok: false, reason: "machine 不存在" };
    if (!remote.disconnected)
      return { ok: true, status: "connected", note: "已在連線中" };
    try {
      remote.disconnected = false;
      remote.stopPending = false;
      remote.up = false;
      remote.observedAt = undefined;
      remote.generation++;
      // 兩條 tunnel 各自嘗試啟動；任何一條失敗才整體回復（review F7）。
      let startFailed = false;
      for (const start of [
        () => remote.tunnel.start(),
        () => remote.hookTunnel?.start(),
      ])
        try {
          start();
        } catch {
          startFailed = true;
        }
      if (startFailed) throw new Error("tunnel start failed");
      const generation = remote.generation;
      this.scheduleProbe(() => {
        if (remote.disconnected || remote.generation !== generation) return;
        void this.probeRemote(remote, generation);
      }, 2000);
      return { ok: true, status: "connected" };
    } catch {
      // 回復成可重試的斷線並停掉已啟動的 tunnel，否則重按會回「已在連線中」（review F3）。
      remote.stopPending = !this.stopRemoteTunnels(remote);
      remote.disconnected = true;
      remote.generation++;
      remote.up = false;
      remote.observedAt = Date.now();
      return { ok: false, reason: "連線失敗" };
    }
  }

  private async probeRemote(remote: Remote, generation: number): Promise<void> {
    let up = false;
    try {
      await remote.client.request(
        "agent.list",
        {},
        { timeoutMs: 3000, retries: 0 },
      );
      up = true;
    } catch {
      /* Probe failures are reflected only in the status channel. */
    }
    if (!remote.disconnected && remote.generation === generation)
      this.markUp(remote, up);
  }

  disconnectMachine(
    id: string,
    options: { force?: boolean } = {},
  ): MachineControlResult {
    const remote = this.remotes.get(id);
    if (!remote) return { ok: false, reason: "machine 不存在" };
    if (remote.disconnected) {
      if (!remote.stopPending)
        return { ok: true, status: "disconnected", note: "已是斷線" };
      // 上次停 tunnel 沒停乾淨：已經是斷線狀態，不用再問有沒有進行中的工作，直接重試停止。
      remote.stopPending = !this.stopRemoteTunnels(remote);
      return remote.stopPending
        ? { ok: false, reason: "停止連線時又出錯，請再按一次重試" }
        : { ok: true, status: "disconnected" };
    }
    try {
      const busy = !options.force && this.isBusy?.(id);
      if (busy)
        return {
          ok: false,
          reason: `有進行中的工作：${busy}，再按一次強制斷線`,
          needsForce: true,
        };
      remote.disconnected = true;
      remote.generation++;
      remote.up = false;
      remote.observedAt = Date.now();
      remote.stopPending = !this.stopRemoteTunnels(remote);
      return remote.stopPending
        ? {
            ok: false,
            reason: "已標為斷線，但停止連線時出錯，請再按一次重試",
          }
        : { ok: true, status: "disconnected" };
    } catch {
      return { ok: false, reason: "斷線失敗" };
    }
  }

  /** 兩條 tunnel 各自嘗試停止，一條丟錯不影響另一條；回傳是否都停成功。 */
  private stopRemoteTunnels(remote: Remote): boolean {
    let stopped = true;
    for (const stop of [
      () => remote.tunnel.stop(),
      () => remote.hookTunnel?.stop(),
    ])
      try {
        stop();
      } catch {
        stopped = false;
      }
    return stopped;
  }

  stopTunnels(): void {
    for (const remote of this.remotes.values()) this.stopRemoteTunnels(remote);
  }

  /** 把本機檔案上傳到該機器上的目錄；機器不存在時回報錯誤。 */
  async uploadTo(
    machineId: string,
    remoteDir: string,
    files: Array<{ localPath: string; name: string }>,
  ): Promise<string[]> {
    const remote = this.remotes.get(machineId);
    if (!remote) throw new Error(`unknown machine ${machineId}`);
    if (remote.disconnected) throw new Error("machine 已斷線"); // review F13
    return uploadFiles(remote.config, remoteDir, files);
  }

  async cleanupAttachments(
    machineId: string,
    root: string,
    minutes: number,
  ): Promise<void> {
    const remote = this.remotes.get(machineId);
    if (!remote) throw new Error(`unknown machine ${machineId}`);
    if (remote.disconnected) throw new Error("machine 已斷線");
    await cleanupRemoteAttachments(remote.config, root, minutes);
  }

  usageMachineStatus(): Array<{ id: string; reachable: boolean }> {
    return [...this.remotes.values()].map((r) => ({
      id: r.config.id,
      reachable: r.up,
    }));
  }

  /**
   * 每台遠端的連線旗標與最後一次觀測時間。`up` 只在請求遠端時更新，本機請求先失敗或沒人探測時不會變，
   * 所以讀取者要依 `observedAt` 判斷這個旗標還算不算新（ISSUE-164）。
   */
  machineObservations(): Array<{
    id: string;
    reachable: boolean;
    disconnected: boolean;
    observedAt?: number;
  }> {
    return [...this.remotes.values()].map((r) => ({
      id: r.config.id,
      reachable: r.up,
      disconnected: r.disconnected,
      ...(r.observedAt === undefined ? {} : { observedAt: r.observedAt }),
    }));
  }

  machineIds(): string[] {
    return [...this.remotes.keys()];
  }

  machineConfig(machineId: string): MachineConfig | undefined {
    return this.remotes.get(machineId)?.config;
  }

  /** 只送到指定機器：不經聚合與快取，失敗就丟錯；ID 參數必須帶該機器前綴。 */
  requestOn<T = unknown>(machineId: string, method: string, params: Params = {}, options: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const remote = this.remotes.get(machineId);
    if (!remote) return Promise.reject(new Error(`unknown machine ${machineId}`));
    if (remote.disconnected) return Promise.reject(new Error("machine 已斷線"));
    if (Object.entries(params).some(([k, v]) => ID_KEYS.has(k) && typeof v === "string" && !v.startsWith(`${machineId}:`)))
      return Promise.reject(new Error(`request on ${machineId} has a non-${machineId} ID`));
    return this.remoteRequest<T>(remote, method, params, options);
  }

  /** 指定機器當下的 Agent 清單（不用快取）。 */
  async freshAgentsOn(machineId: string): Promise<AgentRecord[]> {
    const result = await this.requestOn<{ agents?: unknown }>(machineId, "agent.list", {}, { timeoutMs: 5000, retries: 0 });
    if (!Array.isArray(result?.agents)) throw new Error(`agent.list on ${machineId} returned no agents array`);
    return result.agents as AgentRecord[];
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
    if (remote.disconnected) throw new Error("machine 已斷線");
    const generation = remote.generation;
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
      if (remote.disconnected || remote.generation !== generation)
        throw new Error("machine 已斷線");
      this.markUp(remote, true);
      return this.decorate(result, remote.config.id) as T;
    } catch (error) {
      if (
        !remote.disconnected &&
        remote.generation === generation &&
        !(error instanceof HerdrError)
      )
        this.markUp(remote, false);
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
      if (remote.disconnected) continue;
      const generation = remote.generation;
      let part: Record<string, unknown> | undefined;
      try {
        part = (await remote.client.request<Record<string, unknown>>(
          method,
          params,
          { timeoutMs: 3000, retries: 0 },
        )) as Record<string, unknown>;
        if (remote.disconnected || remote.generation !== generation) continue;
        part = this.decorate(part, remote.config.id) as Record<string, unknown>;
        remote.cache.set(method, part);
        this.markUp(remote, true);
      } catch {
        if (remote.disconnected || remote.generation !== generation) continue;
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
    remote.observedAt = Date.now();
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
