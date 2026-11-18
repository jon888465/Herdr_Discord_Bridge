import { execFile } from "node:child_process";
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
/** `machine status` 會實際探測遠端，實測約 4 秒，超過預設 2 秒（ISSUE-170 實機失敗的原因）。 */
const HERDR_STATUS_TIMEOUT_MS = 20_000;
/** remove／rename／disable 只改本機設定，但給寬鬆一點。 */
const HERDR_CHANGE_TIMEOUT_MS = 10_000;

const runHerdr: HerdrMachineRunner = (args, timeoutMs = HERDR_TIMEOUT_MS) =>
  new Promise((resolve, reject) =>
    execFile(
      "herdr",
      args,
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
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

/**
 * 啟動時，bridge 設定是 `ssh` 別名加 `port`（不寫 host）時，Herdr 側邊欄若還存著同一別名、不同埠的 `ssh://別名:埠`，
 * 就換成新埠（ISSUE-170）：Herdr 無法修改既有 machine 的 target，所以做法是新增 → 確認 reachable → 移除舊的 → 改回原 label，
 * 原本停用的維持停用。任何一步失敗都復原（移除剛新增的），舊的保持不動；只認唯一一筆不同埠的舊 profile，多筆不猜。
 * 已有 target 完全相同的 profile、或沒有舊 profile，什麼都不做（回傳 undefined）。
 */
export async function reconcileHerdrPort(
  machine: MachineConfig | undefined,
  run: HerdrMachineRunner = runHerdr,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<string | undefined> {
  if (!machine?.ssh || machine.port === undefined || machine.host) return undefined;
  const expected = `ssh://${machine.ssh}:${machine.port}`;
  let created: HerdrProfile | undefined;
  try {
    const profiles = parseHerdrProfiles(await run(["machine", "list", "--json"]));
    if (profiles.some((profile) => profile.target === expected)) return undefined;
    const stale = profiles.filter(
      (profile) =>
        profile.target.startsWith("ssh://") &&
        herdrTargetHost(profile.target) === machine.ssh,
    );
    if (stale.length === 0) return undefined;
    if (stale.length > 1) return "Herdr 有多個同別名不同埠的 machine，沒有更新埠";
    const [old] = stale;
    const temporary = `${old.label}-new`;
    await run(["machine", "add", expected, "--label", temporary], HERDR_ADD_TIMEOUT_MS);
    created = parseHerdrProfiles(await run(["machine", "list", "--json"])).find(
      (profile) => profile.label === temporary && profile.target === expected,
    );
    if (!created) throw new Error("new profile not found");
    let reachable = false;
    for (let attempt = 0; attempt < REACHABLE_ATTEMPTS && !reachable; attempt++) {
      if (attempt > 0) await wait(REACHABLE_INTERVAL_MS);
      reachable = parseReachable(
        await run(["machine", "status", "--json"], HERDR_STATUS_TIMEOUT_MS),
        created.id,
      );
    }
    if (!reachable) throw new Error("new profile not reachable");
    await run(["machine", "remove", old.id], HERDR_CHANGE_TIMEOUT_MS);
    const added = created;
    created = undefined; // 舊的已移除，之後失敗不能再移除新的
    try {
      await run(["machine", "rename", added.id, "--label", old.label], HERDR_CHANGE_TIMEOUT_MS);
      if (!old.enabled) await run(["machine", "disable", added.id], HERDR_CHANGE_TIMEOUT_MS);
    } catch {
      return `Herdr 側邊欄已換到新埠，但改名或停用沒成功（目前標籤 ${temporary}）`;
    }
    return `Herdr 側邊欄已更新到埠 ${machine.port}`;
  } catch {
    if (created) {
      try {
        await run(["machine", "remove", created.id], HERDR_CHANGE_TIMEOUT_MS);
      } catch {
        /* 復原失敗只留下多的一筆，呼叫者看到說明會知道 */
      }
    }
    return "Herdr 側邊欄的埠沒有更新成功，保留原設定";
  }
}
