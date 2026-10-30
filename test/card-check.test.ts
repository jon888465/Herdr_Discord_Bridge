import test from "node:test";
import assert from "node:assert/strict";
import { runCardCheck } from "../src/card-check.js";

const valid = `---
id: REQ-20261030-example
type: requirement
status: draft
title: 範例卡片
version: 1
created: 2026-10-30
updated: 2026-10-30
---

# 範例卡片
`;

function reader(files: Record<string, string>) {
  return (path: string): string => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
}

test("a valid card prints one OK line with id, type, status and title, exit 0", () => {
  const result = runCardCheck(
    ["cards/REQ-20261030-example.md"],
    reader({ "cards/REQ-20261030-example.md": valid }),
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK +cards\/REQ-20261030-example\.md/m);
  assert.match(result.stdout, /REQ-20261030-example/);
  assert.match(result.stdout, /requirement/);
  assert.match(result.stdout, /draft/);
  assert.match(result.stdout, /範例卡片/);
});

test("an invalid card prints FAIL with the reason on stderr, exit 1", () => {
  const broken = valid.replace(/^title: .*\n/m, "");
  const result = runCardCheck(
    ["a/REQ-20261030-example.md"],
    reader({ "a/REQ-20261030-example.md": broken }),
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^FAIL +a\/REQ-20261030-example\.md/m);
  assert.match(result.stderr, /"title"/);
});

test("the filename must match the id, whatever directory it is in", () => {
  const result = runCardCheck(
    ["somewhere/else.md"],
    reader({ "somewhere/else.md": valid }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /REQ-20261030-example\.md/);
});

test("every file is checked even after a failure, and a single failure gives exit 1", () => {
  const files = {
    "bad/REQ-20261030-example.md": "no frontmatter",
    "good/REQ-20261030-example.md": valid,
  };
  const result = runCardCheck(Object.keys(files), reader(files));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /OK +good\//);
  assert.match(result.stderr, /FAIL +bad\//);
});

test("an unreadable file is reported as a failure with the reason", () => {
  const result = runCardCheck(["missing.md"], reader({}));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FAIL +missing\.md/);
  assert.match(result.stderr, /ENOENT/);
});

test("no arguments prints usage and exits 2; --help prints usage and exits 0", () => {
  const none = runCardCheck([], reader({}));
  assert.equal(none.code, 2);
  assert.match(none.stderr, /Usage: herdr-card-check/);
  const help = runCardCheck(["--help"], reader({}));
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: herdr-card-check/);
});

test("an unknown option is a usage error, not treated as a file", () => {
  const result = runCardCheck(["--frobnicate"], reader({}));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--frobnicate/);
});
