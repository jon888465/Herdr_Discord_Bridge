import { execFile } from "node:child_process";
import { HERDR_RESTART_APPROVAL, runWithPtyApproval } from "./herdr-pty.js";
import type { MachineConfig } from "./machines.js";

/** Herdr 自己存的 SSH machine（`herdr machine list --json` 的一筆）。 */
export interface HerdrProfile {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
}

export type HerdrMachineRunner = (args: string[], timeoutMs?: number) => Promise<string>;

const HERDR_TIMEOUT_MS = 2000;
/** `machine add` 會準備遠端伺服器，比一般指令久。 */
const HERDR_ADD_TIMEOUT_MS = 60_000;
/** 確認重啟遠端 server 後的 `machine add`：要先重啟遠端再準備，比一般 add 久。 */
const HERDR_APPROVED_ADD_TIMEOUT_MS = 120_000;
/** `machine status` 會實際探測遠端，實測約 4 秒，超過預設 2 秒（ISSUE-170 實機失敗的原因）。 */
const HERDR_STATUS_TIMEOUT_MS = 20_000;
/** remove／rename／disable 只改本機設定，但給寬鬆一點。 */
const HERDR_CHANGE_TIMEOUT_MS = 10_000;

/**
 * `herdr machine status` 只要有任何一台不通就以非零 exit code 結束，但 stdout 仍有完整 JSON（ISSUE-170 實機：
 * 舊埠那筆不通，status 回 exit 1，被當成失敗而整個復原）。status 有輸出就照常使用；逾時等其他失敗仍然丟錯。
 */
export function settleHerdrOutput(
  args: string[],
  error: (Error & { code?: unknown; killed?: boolean }) | null,
  stdout: string,
): string {
  if (!error) return stdout;
  if (
    args[1] === "status" &&
    !error.killed &&
    typeof error.code === "number" &&
    stdout.trim()
  )
    return stdout;
  throw error;
}

const DETAIL_LIMIT = 400;

/** 給日誌看的單行說明：壓成一行、限制長度；Herdr 拒絕時的原因（例如 `machine add` 的 not ready）在 stderr／stdout，不在 Error.message。 */
export function describeHerdrFailure(error: unknown): string {
  const detail = (error as { herdrOutput?: unknown } | undefined)?.herdrOutput;
  const text = typeof detail === "string" && detail.trim() ? detail : error instanceof Error ? error.message : String(error);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > DETAIL_LIMIT ? `${oneLine.slice(0, DETAIL_LIMIT)}…` : oneLine;
}

/**
 * Herdr 的 `machine add` 在遠端 server 不是 Herdr 準備流程啟動的時候，要求互動式同意重啟它（會中斷遠端所有 pane 的行程）；
 * 沒有 TTY 時被當成取消，輸出含「remote server is not ready for saved machines」或重啟提示（ISSUE-170、ISSUE-177）。
 */
export function isRemoteRestartRequired(error: unknown): boolean {
  return /not ready for saved machines|restart the remote server/i.test(describeHerdrFailure(error));
}

function withHerdrOutput(error: unknown, stdout: string, stderr: string): unknown {
  const output = [stderr, stdout].filter((part) => part?.trim()).join(" ");
  if (error && typeof error === "object" && output) (error as { herdrOutput?: string }).herdrOutput = output;
  return error;
}

export const runHerdr: HerdrMachineRunner = (args, timeoutMs = HERDR_TIMEOUT_MS) =>
  new Promise((resolve, reject) =>
    execFile(
      "herdr",
      args,
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout, stderr) => {
        try {
          resolve(settleHerdrOutput(args, error, stdout));
        } catch (thrown) {
          reject(withHerdrOutput(thrown, stdout, stderr));
        }
      },
    ),
  );

export function parseHerdrProfiles(output: string): HerdrProfile[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("unexpected output");
  return value.flatMap((item): HerdrProfile[] =>
    item &&
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.target === "string" &&
    typeof item.enabled === "boolean"
      ? [{ id: item.id, label: item.label, target: item.target, enabled: item.enabled }]
      : [],
  );
}

/**
 * Herdr 的 target 可能是 `ssh://[帳號@]主機[:埠]`（埠會變動的 machine 用 `ssh://別名:埠` 加入，ISSUE-168）：
 * 取出主機（別名）部分；不是 ssh:// 開頭就原樣回傳。
 */
export function herdrTargetHost(target: string): string {
  const match = /^ssh:\/\/(?:[^@/]*@)?([^:/]+)(?::\d+)?\/?$/.exec(target);
  return match ? match[1]! : target;
}

/**
 * bridge 的 machine 對應到 Herdr 的 profile：設了 `ssh` 就比 `target`（原樣相等，或 `ssh://` 形式的主機部分相等，
 * 所以埠變了也對得上），否則比 `label` 與 machine id。只認唯一符合的一筆；多筆符合不猜，交給呼叫者回報。
 */
export function matchHerdrProfiles(
  machine: MachineConfig,
  profiles: HerdrProfile[],
): HerdrProfile[] {
  return profiles.filter((profile) =>
    machine.ssh
      ? profile.target === machine.ssh || herdrTargetHost(profile.target) === machine.ssh
      : profile.label === machine.id,
  );
}

/**
 * 手動連線／斷線時把 Herdr 側邊欄的 machine 一起啟用／停用。`disable` 只中斷 Herdr 客戶端對這台的連線，
 * 遠端 session 與 agent 照舊執行（Herdr 文件）。回傳要給使用者看的說明；沒有對應的 profile 不算問題，回傳 undefined。
 * 任何失敗都只回說明、不丟錯：bridge 自己的連線狀態不受影響。
 */
export async function syncHerdrMachine(
  machine: MachineConfig | undefined,
  enable: boolean,
  run: HerdrMachineRunner = runHerdr,
): Promise<string | undefined> {
  if (!machine) return undefined;
  try {
    const matches = matchHerdrProfiles(
      machine,
      parseHerdrProfiles(await run(["machine", "list", "--json"])),
    );
    if (matches.length === 0) return undefined;
    if (matches.length > 1) return "Herdr 有多個符合的 machine，沒有同步";
    const [profile] = matches;
    if (profile.enabled === enable) return undefined;
    await run(["machine", enable ? "enable" : "disable", profile.id]);
    return enable ? "Herdr 側邊欄已啟用" : "Herdr 側邊欄已停用";
  } catch {
    return "Herdr 側邊欄沒有同步成功";
  }
}

const REACHABLE_ATTEMPTS = 5;
const REACHABLE_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseReachable(output: string, id: string): boolean {
  const value: unknown = JSON.parse(output);
  return (
    Array.isArray(value) &&
    value.some((item) => item && item.id === id && item.status === "reachable")
  );
}

/** `machine status` 裡該 profile 的狀態與錯誤文字，給日誌用；解析不了就回固定短句。 */
function statusDetail(output: string, id: string): string {
  try {
    const value: unknown = JSON.parse(output);
    const item = Array.isArray(value) ? value.find((entry) => entry && entry.id === id) : undefined;
    if (!item) return "status 沒有這筆";
    return describeHerdrFailure(`${item.status}：${item.error ?? "沒有錯誤文字"}`);
  } catch {
    return "status 輸出無法解析";
  }
}

/**
 * 啟動時，bridge 設定是 `ssh` 別名加 `port`（不寫 host）時，Herdr 側邊欄若還存著同一別名、不同埠的 `ssh://別名:埠`，
 * 就換成新埠（ISSUE-170）：Herdr 無法修改既有 machine 的 target，所以做法是新增 → 確認 reachable → 移除舊的 → 改回原 label，
 * 原本停用的維持停用。任何一步失敗都復原（移除剛新增的），舊的保持不動；只認唯一一筆不同埠的舊 profile，多筆不猜。
 * 已有 target 完全相同的 profile、或沒有舊 profile，什麼都不做（回傳 undefined）。
 */
export interface HerdrPortOutcome {
  /** 給使用者看的一行說明；沒有要做的事是 undefined。 */
  note?: string;
  /** 換埠失敗在 `add` 那一步，而且 Herdr 要求先重啟遠端 server（需要使用者確認，ISSUE-177）。 */
  needsRemoteRestart?: boolean;
}

export interface HerdrPortOptions {
  /** 使用者已確認可以重啟遠端 server：`add` 改走 pty，只在 Herdr 的重啟提示出現時回答 y。 */
  approveRestart?: boolean;
  /** 測試用：取代真的 pty 執行。 */
  runApproved?: HerdrMachineRunner;
}

const approvedAdd: HerdrMachineRunner = (args, timeoutMs = HERDR_APPROVED_ADD_TIMEOUT_MS) =>
  runWithPtyApproval("herdr", args, HERDR_RESTART_APPROVAL, timeoutMs);

/** 同 `reconcileHerdrPortOutcome`，只回說明（給既有呼叫者與測試）。 */
export async function reconcileHerdrPort(
  machine: MachineConfig | undefined,
  run: HerdrMachineRunner = runHerdr,
  wait: (ms: number) => Promise<void> = sleep,
  log: (message: string) => void = console.error,
): Promise<string | undefined> {
  return (await reconcileHerdrPortOutcome(machine, run, wait, log)).note;
}

export async function reconcileHerdrPortOutcome(
  machine: MachineConfig | undefined,
  run: HerdrMachineRunner = runHerdr,
  wait: (ms: number) => Promise<void> = sleep,
  log: (message: string) => void = console.error,
  options: HerdrPortOptions = {},
): Promise<HerdrPortOutcome> {
  if (!machine?.ssh || machine.port === undefined || machine.host) return {};
  const expected = `ssh://${machine.ssh}:${machine.port}`;
  const trace = (message: string): void => log(`Herdr machine ${machine.id} 換埠：${message}`);
  let created: HerdrProfile | undefined;
  let step = "list";
  try {
    const profiles = parseHerdrProfiles(await run(["machine", "list", "--json"]));
    if (profiles.some((profile) => profile.target === expected)) return {};
    const stale = profiles.filter(
      (profile) =>
        profile.target.startsWith("ssh://") &&
        herdrTargetHost(profile.target) === machine.ssh,
    );
    if (stale.length === 0) return {};
    trace(`目標 ${expected}；Herdr 現有同別名 profile：${stale.map((p) => `${p.target}（${p.enabled ? "啟用" : "停用"}）`).join("、")}`);
    if (stale.length > 1) return { note: "Herdr 有多個同別名不同埠的 machine，沒有更新埠" };
    const [old] = stale;
    const temporary = `${old.label}-new`;
    step = "add";
    if (options.approveRestart) {
      trace("使用者已確認重啟遠端 server：add 改走互動式（只回答 Herdr 的重啟提示）");
      await (options.runApproved ?? approvedAdd)(["machine", "add", expected, "--label", temporary], HERDR_APPROVED_ADD_TIMEOUT_MS);
    } else {
      await run(["machine", "add", expected, "--label", temporary], HERDR_ADD_TIMEOUT_MS);
    }
    trace("add 成功");
    step = "list（確認新項目）";
    created = parseHerdrProfiles(await run(["machine", "list", "--json"])).find(
      (profile) => profile.label === temporary && profile.target === expected,
    );
    if (!created) throw new Error("new profile not found");
    let reachable = false;
    step = "status";
    for (let attempt = 0; attempt < REACHABLE_ATTEMPTS && !reachable; attempt++) {
      if (attempt > 0) await wait(REACHABLE_INTERVAL_MS);
      const output = await run(["machine", "status", "--json"], HERDR_STATUS_TIMEOUT_MS);
      reachable = parseReachable(output, created.id);
      trace(`status 第 ${attempt + 1} 次：${reachable ? "reachable" : `未 reachable（${statusDetail(output, created.id)}）`}`);
    }
    if (!reachable) throw new Error(`new profile not reachable after ${REACHABLE_ATTEMPTS} attempts`);
    step = "remove";
    await run(["machine", "remove", old.id], HERDR_CHANGE_TIMEOUT_MS);
    const added = created;
    created = undefined; // 舊的已移除，之後失敗不能再移除新的
    try {
      step = "rename";
      await run(["machine", "rename", added.id, "--label", old.label], HERDR_CHANGE_TIMEOUT_MS);
      step = "disable";
      if (!old.enabled) await run(["machine", "disable", added.id], HERDR_CHANGE_TIMEOUT_MS);
    } catch (error) {
      trace(`步驟 ${step} 失敗：${describeHerdrFailure(error)}`);
      return { note: `Herdr 側邊欄已換到新埠，但改名或停用沒成功（目前標籤 ${temporary}）` };
    }
    return { note: `Herdr 側邊欄已更新到埠 ${machine.port}` };
  } catch (error) {
    trace(`步驟 ${step} 失敗：${describeHerdrFailure(error)}`);
    const needsRemoteRestart = step === "add" && !options.approveRestart && isRemoteRestartRequired(error);
    if (created) {
      try {
        await run(["machine", "remove", created.id], HERDR_CHANGE_TIMEOUT_MS);
        trace("已移除剛新增的項目");
      } catch (removeError) {
        /* 復原失敗只留下多的一筆，呼叫者看到說明會知道 */
        trace(`移除剛新增的項目也失敗：${describeHerdrFailure(removeError)}`);
      }
    }
    return {
      note: "Herdr 側邊欄的埠沒有更新成功，保留原設定",
      ...(needsRemoteRestart ? { needsRemoteRestart: true } : {}),
    };
  }
}
