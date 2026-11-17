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

/** Count active and starting work once, even when a lease also has a stream. */
export function machineBusyReason(
  machineId: string,
  input: { activeTerminals: Iterable<string>; pool: MachinePoolSnapshot },
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
  return work.size ? `${work.size} 個進行中的回合` : undefined;
}
