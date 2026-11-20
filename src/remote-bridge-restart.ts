// 遠端機器上的 bridge：重啟遠端 Herdr server 前偵測、換埠成功後重開（ISSUE-177 階段 2）。
// 重啟遠端 server 會停掉它上面所有 pane 的行程，遠端若跑著獨立的 bridge 也會一起停，不會自己回來。
// 不用 `scripts/run.sh` 重開：它可能就是把遠端 server 起成「不可存活」狀態的原因（ISSUE-170），重開後會再落入同一個狀態。

import { matchHerdrProfiles, parseHerdrProfiles, type HerdrMachineRunner } from "./herdr-machine-sync.js";
import type { MachineConfig } from "./machines.js";

/** plugin manifest（herdr-plugin.toml）裡 bridge pane 的標題；本機的 bridge pane 也是這個標籤。 */
export const BRIDGE_PANE_LABEL = "Discord bridge";
export const BRIDGE_PLUGIN_ID = "herdr-discord-bridge";
export const BRIDGE_ENTRYPOINT = "bridge";

const OPEN_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 20_000;
const READY_ATTEMPTS = 12;
const READY_INTERVAL_MS = 5_000;
const VERIFY_ATTEMPTS = 6;
const VERIFY_INTERVAL_MS = 2_000;

/** `pane.list` 的結果（或 `herdr pane list` 的 JSON 的 `result`）裡有沒有標題是 bridge 的 pane。 */
export function hasBridgePane(listResult: unknown): boolean {
  const panes = (listResult as { panes?: unknown } | undefined)?.panes;
  return Array.isArray(panes) && panes.some((pane) => (pane as { label?: unknown } | null)?.label === BRIDGE_PANE_LABEL);
}

/**
 * 重啟前：用 bridge 自己對遠端的連線列出 pane，看遠端有沒有跑著 bridge。查不到（連線失敗、格式不對）一律回 false，
 * 不影響重啟本身；呼叫端會在說明裡讓使用者知道沒有偵測到。
 */
export async function detectRemoteBridge(listPanes: () => Promise<unknown>): Promise<boolean> {
  try {
    return hasBridgePane(await listPanes());
  } catch {
    return false;
  }
}

export interface ReopenResult {
  ok: boolean;
  /** 給使用者看的一行說明。 */
  note: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePaneList(output: string): unknown {
  const value = JSON.parse(output) as { result?: unknown };
  return value && typeof value === "object" && "result" in value ? value.result : value;
}

/**
 * 換埠成功之後：用已經換到新埠的 Herdr machine 在遠端重開 bridge pane。
 * 先等遠端 server 回來；遠端已經有 bridge 就不再開（避免兩個）；開了之後確認 pane 真的出現。
 */
export async function reopenRemoteBridge(
  machine: MachineConfig,
  run: HerdrMachineRunner,
  wait: (ms: number) => Promise<void> = sleep,
  log: (message: string) => void = console.error,
): Promise<ReopenResult> {
  const trace = (message: string): void => log(`Herdr machine ${machine.id} 重開遠端 bridge：${message}`);
  const expected = machine.ssh && machine.port !== undefined ? `ssh://${machine.ssh}:${machine.port}` : undefined;
  let profileId: string | undefined;
  try {
    const profiles = matchHerdrProfiles(machine, parseHerdrProfiles(await run(["machine", "list", "--json"], LIST_TIMEOUT_MS)));
    const exact = expected ? profiles.filter((profile) => profile.target === expected) : profiles;
    if (exact.length !== 1) {
      trace("Herdr 找不到唯一對應的 machine，沒有重開");
      return { ok: false, note: "找不到對應的 Herdr machine，沒有重開遠端 bridge，請自行重開" };
    }
    profileId = exact[0]!.id;
  } catch (error) {
    trace(`列出 Herdr machine 失敗：${String((error as Error)?.message ?? error)}`);
    return { ok: false, note: "列出 Herdr machine 失敗，沒有重開遠端 bridge，請自行重開" };
  }
  const list = async (): Promise<unknown> => parsePaneList(await run(["--machine", profileId!, "pane", "list"], LIST_TIMEOUT_MS));
  let panes: unknown;
  let ready = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS && !ready; attempt++) {
    if (attempt > 0) await wait(READY_INTERVAL_MS);
    try {
      panes = await list();
      ready = true;
    } catch {
      trace(`遠端 server 還沒回來（第 ${attempt + 1} 次）`);
    }
  }
  if (!ready) return { ok: false, note: "遠端 server 一直沒有回來，沒有重開遠端 bridge，請自行重開" };
  if (hasBridgePane(panes)) {
    trace("遠端已經有 bridge 在執行，不再開");
    return { ok: true, note: "遠端 bridge 已在執行" };
  }
  try {
    await run(["--machine", profileId, "plugin", "pane", "open", "--plugin", BRIDGE_PLUGIN_ID, "--entrypoint", BRIDGE_ENTRYPOINT], OPEN_TIMEOUT_MS);
    trace("已送出 plugin pane open");
  } catch (error) {
    trace(`plugin pane open 失敗：${String((error as Error)?.message ?? error)}`);
    return { ok: false, note: "重開遠端 bridge 失敗，請自行重開" };
  }
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(VERIFY_INTERVAL_MS);
    try {
      if (hasBridgePane(await list())) {
        trace("確認遠端 bridge pane 已出現");
        return { ok: true, note: "已重開遠端 bridge" };
      }
    } catch {
      /* 下一輪再看 */
    }
  }
  return { ok: false, note: "已送出重開遠端 bridge，但沒有看到 pane，請確認" };
}
