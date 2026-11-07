import test from "node:test";
import assert from "node:assert/strict";
import { UPDATE_PROMPTS, matchUpdatePrompt } from "../src/update-prompts.js";

// 2026-11-07 在實機 codex 0.166.0 看到的更新選單（原樣）。
const REAL_CODEX_UPDATE = [
  "  Update available · 0.166.0 → 0.167.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Update now (runs `brew upgrade --cask codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  enter continue · esc skip",
].join("\n");

test("the real observed codex update menu matches and is not vetoed", () => {
  assert.equal(matchUpdatePrompt("codex", REAL_CODEX_UPDATE)?.skipKey, "3");
});

test("a codex approval prompt mixed with the update menu is never matched", () => {
  for (const approval of [
    "Yes, proceed (y)\nNo (esc)",
    "Would you like to run this command?\n1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)",
    "No (esc)",
    "Yes (y)",
  ])
    assert.equal(
      matchUpdatePrompt("codex", `${REAL_CODEX_UPDATE}\n${approval}`),
      undefined,
      approval,
    );
});

test("observed update list contains only the confirmed codex menu and no sensitive wording", () => {
  assert.deepEqual(UPDATE_PROMPTS, [
    {
      kind: "codex",
      match: ["Update available", "Skip until next version"],
      skipKey: "3",
    },
  ]);
  for (const entry of UPDATE_PROMPTS) {
    assert.doesNotMatch(
      JSON.stringify(entry),
      /trust|permission|approv|allow|login|log\s*in|sign\s*in/i,
    );
  }
});
