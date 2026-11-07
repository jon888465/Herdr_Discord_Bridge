import { agentDisplayName } from "./cli-adapter.js";
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

/**
 * 版面規則（ISSUE-108、使用者 2026-11-07 決定）：一個 tab 最多 2 個 pane。
 * 基底 pane 所在 tab（`pane.layout` 回傳的就是這個 tab）已經有 2 個以上 pane 時，不論尺寸是否夠大都不分割，
 * 改在同 workspace 開新 tab；數的是 tab 內所有 pane（含 Lead、使用者自己的、其他 Agent 的）。
 * 只剩基底 pane 時才依尺寸規則決定能不能分割。每個溢出的新 tab 只放這一個新 pane。
 * 回傳的 `tabId` 只在這次呼叫「自己建立」了新 tab 時才有值，讓呼叫端只命名自己開的 tab。
 */
const MAX_PANES_PER_TAB = 2;

/** 不足以安全分割時，在同 workspace 開 tab。任何建立請求都不重試。 */
export async function createAgentPane(
  port: PaneCreationPort,
  input: { basePaneId: string; workspaceId: string; cwd: string },
  onStarting?: () => void,
): Promise<{
  pane?: { pane_id?: unknown; workspace_id?: unknown; terminal_id?: unknown };
  tabId?: string;
}> {
  const layout = (await port.request("pane.layout", {
    pane_id: input.basePaneId,
  })) as {
    layout?: { panes?: PaneRect[] };
  };
  const panes = layout.layout?.panes ?? [];
  if (!panes.some((pane) => pane.pane_id === input.basePaneId))
    throw new Error("基底 pane 的版面資訊不可用（geometry unavailable）");
  const target =
    panes.length < MAX_PANES_PER_TAB
      ? chooseSplitTarget(panes, input.basePaneId)
      : undefined;
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
    tab?: { tab_id?: unknown };
    root_pane?: {
      pane_id?: unknown;
      workspace_id?: unknown;
      terminal_id?: unknown;
    };
  };
  // tab.create 的官方回傳是 root_pane，pane.split 則是 pane。
  const pane = target ? result.pane : result.root_pane;
  const tabId = result.tab?.tab_id;
  // 只有這次自己建立、且回傳的新 pane 在預期 workspace 時，才把 tab id 交給呼叫端。
  if (
    !target &&
    typeof tabId === "string" &&
    tabId &&
    pane?.workspace_id === input.workspaceId
  )
    return { pane, tabId };
  return { pane };
}

/** Labels are cosmetic: an older server/remote must not change launch or cleanup behavior. */
export async function nameAgentPane(
  port: PaneCreationPort,
  paneId: string,
  input: Parameters<typeof agentDisplayName>[0],
  /** 只傳這次 `createAgentPane` 自己建立的 tab；分割出的 pane 不傳，不會動任何 tab。 */
  tabId?: string,
): Promise<void> {
  const label = agentDisplayName(input);
  if (tabId) {
    try {
      await port.request(
        "tab.rename",
        { tab_id: tabId, label },
        { retries: 0 },
      );
    } catch (error) {
      console.warn(
        `Agent tab label unavailable (${tabId}): ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  try {
    await port.request(
      "pane.rename",
      {
        pane_id: paneId,
        label,
      },
      { retries: 0 },
    );
  } catch (error) {
    console.warn(
      `Agent pane label unavailable (${paneId}): ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
