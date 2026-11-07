// Agent pane 的版面選擇與建立（ISSUE-094／108）。

export interface PaneRect {
  pane_id: string;
  rect: { width: number; height: number };
}

export type SplitDirection = "right" | "down";

// rect 包含框線；至少保留 60 欄、18 列，並為分隔線預留一格。
// 高度門檻同樣適用於往右分割，避免很寬但只有幾行的 pane 繼續被切。
export const MIN_AGENT_PANE_COLS = 60;
export const MIN_AGENT_PANE_ROWS = 18;

export function directionFor(rect: {
  width: number;
  height: number;
}): SplitDirection | undefined {
  const { width, height } = rect;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (height >= MIN_AGENT_PANE_ROWS && width >= MIN_AGENT_PANE_COLS * 2 + 1)
    return "right";
  if (width >= MIN_AGENT_PANE_COLS && height >= MIN_AGENT_PANE_ROWS * 2 + 1)
    return "down";
  return undefined;
}

export function chooseSplitTarget(
  panes: PaneRect[],
  basePaneId: string,
):
  { paneId: string; direction: SplitDirection; fellBack: boolean } | undefined {
  const base = panes.find((pane) => pane.pane_id === basePaneId);
  if (!base) return undefined;
  const direction = directionFor(base.rect);
  if (direction) return { paneId: base.pane_id, direction, fellBack: false };
  const candidates = panes
    .filter((pane) => pane.pane_id !== basePaneId)
    .map((pane) => ({ pane, direction: directionFor(pane.rect) }))
    .filter(
      (item): item is { pane: PaneRect; direction: SplitDirection } =>
        item.direction !== undefined,
    )
    .sort(
      (a, b) =>
        b.pane.rect.width * b.pane.rect.height -
        a.pane.rect.width * a.pane.rect.height,
    );
  const best = candidates[0];
  return best
    ? { paneId: best.pane.pane_id, direction: best.direction, fellBack: true }
    : undefined;
}

export interface PaneCreationPort {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { retries?: number },
  ): Promise<unknown>;
}

/** 不足以安全分割時，在同 workspace 開 tab。任何建立請求都不重試。 */
export async function createAgentPane(
  port: PaneCreationPort,
  input: { basePaneId: string; workspaceId: string; cwd: string },
  onStarting?: () => void,
): Promise<{
  pane?: { pane_id?: unknown; workspace_id?: unknown; terminal_id?: unknown };
}> {
  const layout = (await port.request("pane.layout", {
    pane_id: input.basePaneId,
  })) as {
    layout?: { panes?: PaneRect[] };
  };
  const panes = layout.layout?.panes ?? [];
  if (!panes.some((pane) => pane.pane_id === input.basePaneId))
    throw new Error("基底 pane 的版面資訊不可用（geometry unavailable）");
  const target = chooseSplitTarget(panes, input.basePaneId);
  onStarting?.();
  const result = (await port.request(
    target ? "pane.split" : "tab.create",
    {
      ...(target
        ? { target_pane_id: target.paneId, direction: target.direction }
        : {}),
      workspace_id: input.workspaceId,
      cwd: input.cwd,
      focus: false,
    },
    { retries: 0 },
  )) as {
    pane?: { pane_id?: unknown; workspace_id?: unknown; terminal_id?: unknown };
    root_pane?: {
      pane_id?: unknown;
      workspace_id?: unknown;
      terminal_id?: unknown;
    };
  };
  // tab.create 的官方回傳是 root_pane，pane.split 則是 pane。
  return { pane: target ? result.pane : result.root_pane };
}
