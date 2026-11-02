import test from "node:test";
import assert from "node:assert/strict";
import { publicText } from "../src/handoff-evidence.js";
import { boundedHandoffSummary } from "../src/handoff-summary.js";

const cat = (...parts: string[]): string => parts.join("");
const FAKE = "FAKEFAKEFAKE";

test("publicText now covers the patterns the old rules missed", () => {
  const out = publicText(
    cat(
      "token github_",
      "pat_",
      FAKE,
      "0123456789_",
      FAKE,
      " and https://user:",
      FAKE,
      "PASS@example.invalid/x",
    ),
  );
  assert.equal(out.includes(cat("github_", "pat_", FAKE)), false);
  assert.equal(out.includes(cat(FAKE, "PASS")), false);
});

test("publicText still strips ANSI escapes and bounds long text with the history marker", () => {
  assert.equal(publicText("\u001B[31mred\u001B[0m text"), "red text");
  const long = "x".repeat(200);
  const bounded = publicText(long, 100);
  assert.ok(bounded.includes("\n[history omitted]\n"));
  assert.ok(bounded.length <= 100 + 30);
});

test("boundedHandoffSummary redacts secrets, drops blank lines and keeps short text as is", () => {
  const out = boundedHandoffSummary(
    cat("\u001B[1mdone\u001B[0m\n\n  \nBearer ", FAKE, FAKE, "\nlast line\n"),
    1000,
  );
  assert.equal(out, "done\nBearer [redacted]\nlast line");
});

test("boundedHandoffSummary keeps the omission marker when the text is too long", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const out = boundedHandoffSummary(lines, 120);
  assert.ok(out.startsWith("… [older handoff output omitted] …\n"));
  assert.ok(out.endsWith("line 49"));
  assert.ok(out.length <= 120);
});

test("a private key that truncation would cut in half is redacted before truncating, not leaked", () => {
  const key = cat(
    "-----BEGIN PRIV",
    "ATE KEY-----\n",
    "BODYLINEONE\nBODYLINETWO\nBODYLINETHREE\n",
    "-----END PRIV",
    "ATE KEY-----",
  );
  const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`).join("\n");
  // 上限刻意讓截斷點落在金鑰內容中間：若先截斷再遮蔽，BEGIN 行會被切掉。
  const out = boundedHandoffSummary(`${filler}\n${key}\nafter`, 100);
  assert.equal(out.includes("BODYLINE"), false);
  assert.ok(out.endsWith("after"));
});
