/**
 * ISSUE-157：`team cancel` 只能取消目前 workspace 的 task；但 task 所屬的 workspace 已經關閉時，
 * 沒有任何指令能切過去，task 會永遠留在非終態。此時（且只有此時）允許從其他 workspace 取消。
 * 列不出 workspace 時一律維持拒絕，不把「查不到」當成「已關閉」。
 */
export async function mayCancelFromWorkspace(
  taskWorkspaceId: string,
  currentWorkspaceId: string,
  listWorkspaceIds: () => Promise<string[]>,
): Promise<boolean> {
  if (taskWorkspaceId === currentWorkspaceId) return true;
  try {
    return !(await listWorkspaceIds()).includes(taskWorkspaceId);
  } catch {
    return false;
  }
}
