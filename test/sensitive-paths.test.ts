import test from "node:test";
import assert from "node:assert/strict";
import { SENSITIVE_PATHS, sensitivePathsIn } from "../src/sensitive-paths.js";

test("ordinary source, test and doc files are not sensitive", () => {
  assert.deepEqual(
    sensitivePathsIn([
      "src/main.ts",
      "src/card-command.ts",
      "test/card-command.test.ts",
      "docs/known-issues.md",
      "README.md",
      "docs/package.json.md",
      "src/policy.test.ts",
    ]),
    [],
  );
});

test("each protected path, directory and the list file itself is reported", () => {
  const protectedFiles = [
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    "AGENTS.md",
    "package.json",
    "scripts/run.sh",
    "scripts/lint.mjs",
    "src/policy.ts",
    "src/github.ts",
    "src/sensitive-paths.ts",
  ];
  assert.deepEqual(sensitivePathsIn(protectedFiles), protectedFiles);
});

test("the list itself is part of the list, so an Agent cannot widen the gate by editing it first", () => {
  assert.ok(SENSITIVE_PATHS.includes("src/sensitive-paths.ts"));
});

test("matching ignores case and a leading ./ because a checkout may be case-insensitive", () => {
  assert.deepEqual(
    sensitivePathsIn(["agents.md", "./package.json", "Scripts/run.sh", ".GITHUB/x"]),
    ["agents.md", "./package.json", "Scripts/run.sh", ".GITHUB/x"],
  );
});

test("only the repository-root package.json and exact files match, not look-alikes", () => {
  assert.deepEqual(
    sensitivePathsIn([
      "docs/SPEC.md",
      "src/policy.ts.bak",
      "scripts-extra/a.sh",
      ".github-notes.md",
      "AGENTS.md.orig",
    ]),
    [],
  );
});

test("paths that climb out of the repository are treated as sensitive", () => {
  assert.deepEqual(sensitivePathsIn(["../outside.txt", "src/../.github/x"]), [
    "../outside.txt",
    "src/../.github/x",
  ]);
});

test("a path is reported once and keeps its input order", () => {
  assert.deepEqual(
    sensitivePathsIn(["package.json", "src/main.ts", "AGENTS.md", "package.json"]),
    ["package.json", "AGENTS.md"],
  );
});

// 使用者 2026-11-06 決定：SPEC.md 是文件，新功能的 PR 幾乎都會改它，列入敏感路徑會讓 L2 對功能類卡片幾乎都退回人工。
test("SPEC.md is plain documentation, not a protected path", () => {
  assert.ok(!SENSITIVE_PATHS.includes("SPEC.md"));
  assert.deepEqual(sensitivePathsIn(["SPEC.md", "docs/known-issues.md"]), []);
});

test("an empty list has nothing sensitive", () => {
  assert.deepEqual(sensitivePathsIn([]), []);
});
