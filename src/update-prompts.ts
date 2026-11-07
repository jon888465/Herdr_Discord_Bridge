/** Only observed update menus belong here; other CLIs remain unsupported. */
export interface UpdatePrompt {
  readonly kind: string;
  readonly match: readonly string[];
  readonly skipKey: string;
}

export const UPDATE_PROMPTS: readonly UpdatePrompt[] = [
  {
    kind: "codex",
    match: ["Update available", "Skip until next version"],
    skipKey: "3",
  },
];

// A mixed screen must remain with the human, even if it has an update menu.
// 涵蓋信任、權限／核准、登入，以及 Codex 的 `Yes, proceed (y)`／`No (esc)` 核准提示（known-issues 有實機紀錄）。
// 更新選單本身的 `enter continue · esc skip` 不含括號，不會命中 `(esc)`。
export const SENSITIVE_SCREEN =
  /trust|permission|approv|allow|log\s*in|sign\s*in|login|proceed|\(y\)|\(esc\)/i;

export function matchUpdatePrompt(
  kind: string | undefined,
  screen: string,
): UpdatePrompt | undefined {
  if (SENSITIVE_SCREEN.test(screen)) return undefined;
  return UPDATE_PROMPTS.find(
    (entry) =>
      entry.kind === kind && entry.match.every((text) => screen.includes(text)),
  );
}
