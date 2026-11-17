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
 * 遠端角色與遠端 review 不經 AgentPool，準備期間也沒有 stream；從開始到結束都登記在這裡，普通斷線才會被擋下（review F2、F5）。
 */
export class RemoteRoleWork {
  private readonly work = new Map<string, string>();
  private sequence = 0;

  /** 登記一份工作，回傳結束函式（可重複呼叫）。每份有自己的單元 id，同 key 重複登記不會互相覆蓋。 */
  begin(key: string, machineId: string): () => void {
    const unit = `${key}#${++this.sequence}`;
    this.work.set(unit, machineId);
    return () => {
      this.work.delete(unit);
    };
  }

  entries(): ReadonlyMap<string, string> {
    return this.work;
  }
}

/** 整個 bridge 共用的登記表：`main.ts` 的 hub busy 判定與遠端角色啟動都用它。 */
export const remoteRoleWork = new RemoteRoleWork();

/** 包住整段都在一次 await 裡的遠端工作（`card review` 的 `reviewOnRemote`）：執行前登記，結束才釋放。 */
export async function trackRemoteWork<T>(
  registry: RemoteRoleWork,
  key: string,
  machineId: string,
  run: () => Promise<T>,
): Promise<T> {
  const end = registry.begin(key, machineId);
  try {
    return await run();
  } finally {
    end();
  }
}

/** 包住遠端角色的啟動：啟動前登記、失敗立刻釋放；成功後 `cleanup` 結束才釋放。沒人呼叫 cleanup 會一直忙碌，偏安全（要強制才能斷線）。 */
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
