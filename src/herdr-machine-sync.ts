import { execFile } from "node:child_process";
import type { MachineConfig } from "./machines.js";

/** Herdr 自己存的 SSH machine（`herdr machine list --json` 的一筆）。 */
export interface HerdrProfile {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
}

export type HerdrMachineRunner = (args: string[]) => Promise<string>;

const HERDR_TIMEOUT_MS = 2000;

const runHerdr: HerdrMachineRunner = (args) =>
  new Promise((resolve, reject) =>
    execFile(
      "herdr",
      args,
      { encoding: "utf8", timeout: HERDR_TIMEOUT_MS },
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
