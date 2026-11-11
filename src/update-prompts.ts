import { stripAnsi } from "./format.js";

/** Only observed update menus belong here; other CLIs remain unsupported. */
export interface UpdatePrompt {
  readonly kind: string;
  readonly match: readonly string[];
  readonly skipKey: string;
}

export const UPDATE_PROMPTS: readonly UpdatePrompt[] = [
  {
    kind: "codex",
    match: [
      "Update available",
      "1. Update now",
      "2. Skip",
      "3. Skip until next version",
    ],
    skipKey: "2",
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
  const lines = stripAnsi(screen)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (SENSITIVE_SCREEN.test(screen)) return undefined;
  // Match the entire observed menu, not text quoted inside another question.
  // Only whitespace, ANSI styling and the selection marker may vary.
  if (
    !/^Update available · \d+\.\d+\.\d+ → \d+\.\d+\.\d+$/.test(
      lines.shift() ?? "",
    )
  )
    return undefined;
  if (
    lines[0] ===
    "Release notes: https://github.com/openai/codex/releases/latest"
  )
    lines.shift();
  const options = lines.splice(0, 3).map((line) => line.replace(/^›\s*/, ""));
  if (
    !/^1\. Update now(?: \(runs `brew upgrade --cask codex`\))?$/.test(
      options[0] ?? "",
    ) ||
    options[1] !== "2. Skip" ||
    options[2] !== "3. Skip until next version"
  )
    return undefined;
  if (lines[0] === "enter continue · esc skip") lines.shift();
  if (lines.length) return undefined;
  return UPDATE_PROMPTS.find(
    (entry) =>
      entry.kind === kind && entry.match.every((text) => screen.includes(text)),
  );
}
