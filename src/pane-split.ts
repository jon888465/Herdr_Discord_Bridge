// 從哪個 pane 分割出新 pane（ISSUE-094）。
//
// profile Worker 與 reviewer 的新 pane 原本一律從「基底 pane」（Lead 或作者）分割。coding 任務會連續啟動
// 好幾個 profile Worker，每個都從 Lead 的 pane 分割出去，Lead 的 pane 因此越切越小；之後 `card review`
// 要再開 reviewer 時基底太小就被拒絕（H4 端到端案例：Lead pane 只剩 6 列）。
// 基底夠大就照舊；太小就改從同一個版面裡夠大的 pane 分割（取面積最大的）；都不夠大才拒絕。
// 新 pane 是獨立的 terminal，關掉它只會關它自己，不受從哪個 pane 分割影響。

export interface PaneRect {
  pane_id: string;
  rect: { width: number; height: number };
}

export type SplitDirection = "right" | "down";

/** 與原本相同的門檻：寬的往右切（至少 80 欄），否則往下切（至少 16 列）。 */
export function directionFor(rect: {
  width: number;
  height: number;
}): SplitDirection | undefined {
  const direction: SplitDirection =
    rect.width >= 120 && rect.width >= rect.height * 2 ? "right" : "down";
  if (direction === "right" && rect.width < 80) return undefined;
  if (direction === "down" && rect.height < 16) return undefined;
  return direction;
}

export function chooseSplitTarget(
  panes: PaneRect[],
  basePaneId: string,
): { paneId: string; direction: SplitDirection; fellBack: boolean } | undefined {
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
