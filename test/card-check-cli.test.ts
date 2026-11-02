import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("dist/src/card-check-cli.js");
const wrapper = path.resolve("scripts/herdr-card-check");
const examples = fs
  .readdirSync("docs/card-examples")
  .filter((name) => /^(REQ|TKT)-.*\.md$/.test(name))
  .map((name) => path.join("docs/card-examples", name));

function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8" });
}

test("the built CLI accepts every shipped example card", () => {
  assert.ok(examples.length >= 3);
  const result = run("node", [cli, ...examples]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.split("\n").filter((l) => l.startsWith("OK")).length,
    examples.length,
  );
});

test("the scripts/herdr-card-check wrapper runs the same CLI", () => {
  const result = run(wrapper, examples);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TKT-20261030-example-mantis-bug/);
});

test("the CLI exits 1 on an invalid file, a directory and an oversized file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "card-check-"));
  const invalid = path.join(directory, "REQ-20261030-broken.md");
  fs.writeFileSync(invalid, "not a card\n");
  const big = path.join(directory, "REQ-20261030-huge.md");
  fs.writeFileSync(big, "a".repeat(600 * 1024));

  const bad = run("node", [cli, invalid]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL/);

  const dir = run("node", [cli, directory]);
  assert.equal(dir.status, 1);
  assert.match(dir.stderr, /cannot read/);

  const huge = run("node", [cli, big]);
  assert.equal(huge.status, 1);
  assert.match(huge.stderr, /512 KiB/);
});

test("the CLI exits 2 without arguments", () => {
  const result = run("node", [cli]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: herdr-card-check/);
});

test("the CLI checks ledger cards up to 1 MiB with --ledger and refuses anything larger", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "card-check-ledger-"),
  );
  const card = `---
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
  const file = path.join(directory, "REQ-20261030-example.md");
  fs.writeFileSync(file, card + "a".repeat(600 * 1024));

  const standard = run("node", [cli, file]);
  assert.equal(standard.status, 1);
  assert.match(standard.stderr, /512 KiB/);

  const ledger = run("node", [cli, "--ledger", file]);
  assert.equal(ledger.status, 0, ledger.stderr);

  fs.writeFileSync(file, card + "a".repeat(1100 * 1024));
  const tooBig = run("node", [cli, "--ledger", file]);
  assert.equal(tooBig.status, 1);
  assert.match(tooBig.stderr, /1 MiB/);
});
