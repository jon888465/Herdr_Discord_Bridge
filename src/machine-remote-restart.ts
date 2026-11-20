// 遠端 Herdr server 需要重啟時的狀態與背景工作（ISSUE-177）。
// 狀態檔 `machine-remote-restart.json`：`pending` 是 bridge 自己換埠時發現「Herdr 要求先重啟遠端 server」的 machine；
// `status` 是最近一次背景重啟的進度，給看板顯示。控制通道的總期限只有 5 秒，重啟要數十秒，所以確認後立刻回應、工作在背景跑。

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDirectory } from "./config.js";
import type { HerdrPortOutcome } from "./herdr-machine-sync.js";
import type { MachineConfig } from "./machines.js";
import type { ReopenResult } from "./remote-bridge-restart.js";

export function remoteRestartFile(): string {
  return path.join(stateDirectory(), "machine-remote-restart.json");
}

export interface RemoteRestartStatus {
  machineId: string;
  state: "running" | "done" | "failed";
  /** 給使用者看的一行說明。 */
  note: string;
  updatedAt: number;
}

export interface RemoteRestartState {
  pending: string[];
  status?: RemoteRestartStatus;
}

const STATES = new Set(["running", "done", "failed"]);

/** 檔案不存在、格式不對、版本不認得都當成沒有；`pending` 只留下 knownIds 裡還有的 machine。 */
export function loadRemoteRestart(file: string, knownIds?: string[]): RemoteRestartState {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) return { pending: [] };
    const raw = value as { pending?: unknown; status?: unknown };
    const known = knownIds ? new Set(knownIds) : undefined;
    const pending = Array.isArray(raw.pending)
      ? [...new Set(raw.pending.filter((id): id is string => typeof id === "string" && (!known || known.has(id))))]
      : [];
    const s = raw.status as Partial<RemoteRestartStatus> | undefined;
    const status =
      s && typeof s.machineId === "string" && typeof s.state === "string" && STATES.has(s.state) && typeof s.note === "string" && typeof s.updatedAt === "number"
        ? ({ machineId: s.machineId, state: s.state, note: s.note, updatedAt: s.updatedAt } as RemoteRestartStatus)
        : undefined;
    return { pending, ...(status ? { status } : {}) };
  } catch {
    return { pending: [] };
  }
}

/** 原子寫入（暫存檔加 rename），權限 0600；失敗回傳 false，不丟錯。 */
export function saveRemoteRestart(file: string, state: RemoteRestartState): boolean {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, pending: [...new Set(state.pending)].sort(), ...(state.status ? { status: state.status } : {}) }) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 暫存檔清不掉就留著，不影響結果 */
    }
    return false;
  }
}

export function setRemoteRestartPending(file: string, id: string, pending: boolean): void {
  const state = loadRemoteRestart(file);
  const has = state.pending.includes(id);
  if (has === pending) return;
  saveRemoteRestart(file, { ...state, pending: pending ? [...state.pending, id] : state.pending.filter((p) => p !== id) });
}

export function setRemoteRestartStatus(file: string, status: RemoteRestartStatus): void {
  saveRemoteRestart(file, { ...loadRemoteRestart(file), status });
}

/** 換埠結果是否算成功（Herdr 側邊欄已經換到新埠）。 */
export function portReconcileSucceeded(outcome: HerdrPortOutcome): boolean {
  return outcome.note?.startsWith("Herdr 側邊欄已更新到埠") === true || outcome.note?.startsWith("Herdr 側邊欄已換到新埠") === true;
}

export interface RemoteRestartDeps {
  file: string;
  /** 使用者已確認：執行換埠（add 走有核准的互動路徑）。 */
  reconcile: (machine: MachineConfig) => Promise<HerdrPortOutcome>;
  /** 重啟前偵測遠端有沒有 bridge（階段 2）；沒提供就不偵測、不重開。查不到要回 false，不要丟錯。 */
  detectBridge?: (machine: MachineConfig) => Promise<boolean>;
  /** 換埠成功後重開遠端 bridge（階段 2）；只有偵測到遠端原本有 bridge 才會呼叫。 */
  reopenBridge?: (machine: MachineConfig) => Promise<ReopenResult>;
  now?: () => number;
  log?: (message: string) => void;
}

const running = new Set<string>();

export type RemoteRestartStart = { started: true } | { started: false; reason: string };

/**
 * 使用者在看板確認後呼叫。只有 bridge 自己換埠時發現需要重啟（`pending`）的 machine 才會執行，
 * 其他一律拒絕，所以不能用這個入口去重啟任意遠端；同一台同時只跑一個。工作在背景跑，不等它。
 */
export function startRemoteRestart(machine: MachineConfig | undefined, deps: RemoteRestartDeps): RemoteRestartStart {
  if (!machine) return { started: false, reason: "沒有這台 machine" };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.error;
  const { file } = deps;
  if (!loadRemoteRestart(file).pending.includes(machine.id)) return { started: false, reason: "這台目前沒有需要重啟遠端 server" };
  if (running.has(machine.id)) return { started: false, reason: "已在重啟中" };
  running.add(machine.id);
  setRemoteRestartStatus(file, { machineId: machine.id, state: "running", note: "重啟遠端 Herdr server 中，請稍候", updatedAt: now() });
  log(`Herdr machine ${machine.id}：使用者已確認，開始重啟遠端 Herdr server 並更新埠`);
  const status = (state: RemoteRestartStatus["state"], note: string): void =>
    setRemoteRestartStatus(file, { machineId: machine.id, state, note, updatedAt: now() });
  void (async () => {
    // 重啟遠端 server 會停掉遠端的 bridge，所以要在重啟前先偵測（階段 2）。
    let hadBridge = false;
    try {
      hadBridge = (await deps.detectBridge?.(machine)) === true;
    } catch {
      hadBridge = false;
    }
    if (hadBridge) log(`Herdr machine ${machine.id}：偵測到遠端有 bridge，換埠成功後會重開`);
    const outcome = await deps.reconcile(machine);
    if (!portReconcileSucceeded(outcome)) {
      status("failed", `重啟遠端 server 沒有成功，側邊欄保留原設定（詳見 bridge 日誌）${hadBridge ? "；若遠端 bridge 停了請自行重開" : ""}`);
      return;
    }
    setRemoteRestartPending(file, machine.id, false);
    if (!hadBridge || !deps.reopenBridge) {
      status("done", `遠端 Herdr server 已重啟，側邊欄已更新${deps.detectBridge ? "（沒有偵測到遠端 bridge）" : ""}`);
      return;
    }
    status("running", "遠端 Herdr server 已重啟，重開遠端 bridge 中");
    const reopened = await deps.reopenBridge(machine).catch((): ReopenResult => ({ ok: false, note: "重開遠端 bridge 失敗，請自行重開" }));
    status(reopened.ok ? "done" : "failed", `遠端 Herdr server 已重啟，側邊欄已更新；${reopened.note}`);
  })()
    .catch(() => status("failed", "重啟遠端 server 失敗（詳見 bridge 日誌）"))
    .finally(() => running.delete(machine.id));
  return { started: true };
}
