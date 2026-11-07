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

export function matchUpdatePrompt(
  kind: string | undefined,
  screen: string,
): UpdatePrompt | undefined {
  // A mixed screen must remain with the human, even if it has an update menu.
  if (/trust|permission|approv|allow|log\s*in|sign\s*in|login/i.test(screen))
    return undefined;
  return UPDATE_PROMPTS.find(
    (entry) =>
      entry.kind === kind && entry.match.every((text) => screen.includes(text)),
  );
}
