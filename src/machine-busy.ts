export interface MachineWork {
  key: string;
  workspace?: string;
  paneId?: string;
  terminalId?: string;
  machine?: string;
}
export interface MachinePoolSnapshot {
  leases: readonly MachineWork[];
  pending: readonly MachineWork[];
}

/**
 * 遠端角色（SSH clone／checkout 快照、建 workspace、啟動 agent）不經 AgentPool，準備期間也還沒有 stream，
 * 只靠 stream 與 pool 判定會讓「普通斷線」在準備到一半時被放行，直接中斷它（review 第 1 輪 F2）。
 * 從開始準備一直到 cleanup 結束，都登記在這裡。
 */
export class RemoteRoleWork {
  private readonly work = new Map<string, string>();

  /** 登記一份工作，回傳結束函式；重複呼叫結束函式沒有副作用。 */
  begin(key: string, machineId: string): () => void {
    this.work.set(key, machineId);
    return () => {
      this.work.delete(key);
    };
  }

  entries(): ReadonlyMap<string, string> {
    return this.work;
  }
}

/** 整個 bridge 共用的登記表：`main.ts` 的 hub busy 判定與遠端角色啟動都用它。 */
export const remoteRoleWork = new RemoteRoleWork();

/**
 * 包住遠端角色的啟動：啟動前就登記，啟動失敗立刻釋放；成功後把 `cleanup` 換成「cleanup 結束（成功或失敗）才釋放」，
 * 所以整個角色生命週期都算進該機器的進行中工作。沒人呼叫 cleanup 時會一直算忙碌，那是偏安全的方向（要強制才能斷線）。
 */
export async function trackRemoteRole<
  T extends { cleanup(reason?: never): Promise<unknown> },
>(
  registry: RemoteRoleWork,
  key: string,
  machineId: string,
  start: () => Promise<T>,
): Promise<T> {
  const end = registry.begin(key, machineId);
  let role: T;
  try {
    role = await start();
  } catch (error) {
    end();
    throw error;
  }
  const cleanup = role.cleanup.bind(role);
  return Object.assign(role, {
    cleanup: async (reason?: Parameters<T["cleanup"]>[0]) => {
      try {
        return await cleanup(reason as never);
      } finally {
        end();
      }
    },
  });
}

/** Count active and starting work once, even when a lease also has a stream. */
export function machineBusyReason(
  machineId: string,
  input: {
    activeTerminals: Iterable<string>;
    pool: MachinePoolSnapshot;
    remoteRoles?: RemoteRoleWork;
  },
): string | undefined {
  const prefix = `${machineId}:`;
  const work = new Set(
    [...input.activeTerminals].filter((id) => id.startsWith(prefix)),
  );
  for (const entry of [...input.pool.leases, ...input.pool.pending]) {
    if (
      entry.machine === machineId ||
      entry.paneId?.startsWith(prefix) ||
      entry.terminalId?.startsWith(prefix) ||
      entry.workspace?.startsWith(prefix)
    )
      work.add(entry.terminalId ?? entry.paneId ?? entry.key);
  }
  for (const [key, machine] of input.remoteRoles?.entries() ?? [])
    if (machine === machineId) work.add(`remote-role:${key}`);
  return work.size ? `${work.size} 個進行中的回合` : undefined;
}
