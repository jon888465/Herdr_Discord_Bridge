import test from "node:test";
import assert from "node:assert/strict";
import { boundedHandoffSummary } from "../src/handoff-summary.js";

const OMISSION_MARKER = "… [older handoff output omitted] …\n";

test("empty, whitespace-only, and ANSI-escape-only inputs return empty string", () => {
  assert.equal(boundedHandoffSummary("", 100), "");
  assert.equal(boundedHandoffSummary("   \n\t  \r\n  ", 100), "");
  assert.equal(boundedHandoffSummary("\u001b[31m\u001b[0m", 100), "");
  assert.equal(boundedHandoffSummary("\u001b[32m   \n  \u001b[0m", 100), "");
});

test("blank lines are removed and remaining lines are joined with LF", () => {
  const input = "first line\r\n\r\n   \nsecond line\n\t\nthird line";
  assert.equal(
    boundedHandoffSummary(input, 200),
    "first line\nsecond line\nthird line",
  );
});

test("output not exceeding maxChars is preserved as-is", () => {
  const input = "alpha\nbeta\ngamma";
  assert.equal(boundedHandoffSummary(input, input.length), input);
  assert.equal(boundedHandoffSummary(input, input.length + 50), input);
});

test("output exceeding maxChars keeps the last part with omission marker and stays within maxChars", () => {
  const input =
    "line-1-old-history-entry\nline-2-middle-history-entry\nline-3-recent-tail";
  const maxChars = OMISSION_MARKER.length + 18;
  const result = boundedHandoffSummary(input, maxChars);

  assert.equal(result.startsWith("… [older handoff output omitted] …"), true);
  assert.equal(result.startsWith(OMISSION_MARKER), true);
  assert.equal(result.endsWith("line-3-recent-tail"), true);
  assert.equal(result, `${OMISSION_MARKER}line-3-recent-tail`);
  assert.equal(result.length <= maxChars, true);
  assert.equal(result.length, maxChars);
});

test("when maxChars is less than or equal to the omission marker length, only the last maxChars characters are returned", () => {
  const input =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const exactMarkerLen = OMISSION_MARKER.length;
  assert.equal(
    boundedHandoffSummary(input, exactMarkerLen),
    input.slice(-exactMarkerLen),
  );

  const shorterLen = 10;
  assert.equal(
    boundedHandoffSummary(input, shorterLen),
    input.slice(-shorterLen),
  );
});

test("secrets are redacted before truncation so raw fake secret never appears in output", () => {
  const fakeSecretSuffix = "FAKE0123456789abcdef";
  const fakeToken = `sk-${fakeSecretSuffix}`;
  const input = `${"x".repeat(80)}\n${fakeToken}\nfooter ok`;

  const fullResult = boundedHandoffSummary(input, 500);
  assert.equal(fullResult.includes(fakeToken), false);
  assert.equal(fullResult.includes(fakeSecretSuffix), false);
  assert.match(fullResult, /\[redacted token\]/);

  // Keep 30 tail chars after the marker: if truncation ran before redaction,
  // "sk-" would be sliced off and fakeSecretSuffix would leak unredacted.
  const tightMaxChars = OMISSION_MARKER.length + 30;
  const truncatedResult = boundedHandoffSummary(input, tightMaxChars);
  assert.equal(truncatedResult.startsWith(OMISSION_MARKER), true);
  assert.equal(truncatedResult.includes(fakeToken), false);
  assert.equal(truncatedResult.includes(fakeSecretSuffix), false);
  assert.equal(truncatedResult.length <= tightMaxChars, true);
});
