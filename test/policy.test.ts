import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  autopickFor,
  levelFor,
  loadPolicy,
  parsePolicy,
} from "../src/policy.js";

const valid = [
  "# 每個專案的自動化等級（使用者手寫，bridge 只讀）",
  "version: 1",
  "default: L0",
  "projects:",
  "  # 這個專案只開 PR",
  "  local:Herdr_Discord_Bridge: L1",
  "  agy-pod:other.repo: L0",
  "",
].join("\n");

test("a valid policy gives the default level and one level per project", () => {
  const result = parsePolicy(valid);
  assert.deepEqual(result, {
    ok: true,
    policy: {
      default: "L0",
      projects: {
        "local:Herdr_Discord_Bridge": "L1",
        "agy-pod:other.repo": "L0",
      },
    },
  });
});

test("only version is required; default falls back to L0 and projects to none", () => {
  assert.deepEqual(parsePolicy("version: 1\n"), {
    ok: true,
    policy: { default: "L0", projects: {} },
  });
  assert.deepEqual(parsePolicy("version: 1\ndefault: L1\nprojects:\n"), {
    ok: true,
    policy: { default: "L1", projects: {} },
  });
});

test("Windows line endings and blank lines are accepted", () => {
  const result = parsePolicy(
    "version: 1\r\n\r\nprojects:\r\n  local:Foo: L2\r\n",
  );
  assert.equal(result.ok && result.policy.projects["local:Foo"], "L2");
});

const rejected: Array<[string, string, RegExp]> = [
  ["a missing version", "default: L0\n", /version/],
  ["an unsupported version", "version: 2\n", /version/],
  ["a version that is not a number", "version: one\n", /version/],
  [
    "an unknown top-level key",
    "version: 1\nlevel: L2\n",
    /unknown key "level"/,
  ],
  [
    "a duplicate top-level key",
    "version: 1\ndefault: L0\ndefault: L1\n",
    /duplicate/,
  ],
  ["an unknown level", "version: 1\ndefault: L3\n", /level/],
  ["a lowercase level", "version: 1\ndefault: l1\n", /level/],
  ["a trailing comment on a value", "version: 1\ndefault: L1 # ok\n", /level/],
  ["an empty default", "version: 1\ndefault:\n", /level/],
  [
    "a project without the machine prefix",
    "version: 1\nprojects:\n  Foo: L1\n",
    /project name/,
  ],
  [
    "a project name with a space",
    "version: 1\nprojects:\n  local:My Project: L1\n",
    /project name|indent|key/,
  ],
  [
    "a duplicate project",
    "version: 1\nprojects:\n  local:Foo: L1\n  local:Foo: L0\n",
    /duplicate project/,
  ],
  [
    "a project outside the projects block",
    "version: 1\n  local:Foo: L1\n",
    /indent/,
  ],
  [
    "a project line indented by four spaces",
    "version: 1\nprojects:\n    local:Foo: L1\n",
    /indent/,
  ],
  ["a tab", "version: 1\nprojects:\n\tlocal:Foo: L1\n", /tab/],
  ["projects with an inline value", "version: 1\nprojects: L1\n", /projects/],
  [
    "an unknown level for a project",
    "version: 1\nprojects:\n  local:Foo: L9\n",
    /level/,
  ],
  ["a line that is not key: value", "version: 1\nnonsense\n", /line 2/],
  ["a YAML list", "version: 1\nprojects:\n  - local:Foo\n", /project|line/],
  ["a YAML anchor", "version: 1\ndefault: &a L1\n", /level/],
];
for (const [name, text, message] of rejected)
  test(`${name} is rejected`, () => {
    const result = parsePolicy(text);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.match(result.error, message, text);
  });

test("more than 200 projects or a line over 200 characters is rejected", () => {
  const many = Array.from({ length: 201 }, (_, i) => `  local:p${i}: L0`).join(
    "\n",
  );
  assert.equal(parsePolicy(`version: 1\nprojects:\n${many}\n`).ok, false);
  assert.equal(parsePolicy(`version: 1\n# ${"x".repeat(250)}\n`).ok, false);
});

test("levelFor gives the project's own level, or the default for an unlisted project", () => {
  const parsed = parsePolicy(valid);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(levelFor(parsed.policy, "local:Herdr_Discord_Bridge"), "L1");
  assert.equal(levelFor(parsed.policy, "agy-pod:other.repo"), "L0");
  assert.equal(levelFor(parsed.policy, "local:Unlisted"), "L0");
  assert.equal(levelFor(DEFAULT_POLICY, "local:Anything"), "L0");
});

function tempFile(content?: string, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  const file = path.join(dir, "policy.yml");
  if (content !== undefined) {
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
  }
  return { dir, file };
}

test("a missing file means the safe default, and is not an error", () => {
  const { file } = tempFile();
  const result = loadPolicy(file);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.policy, DEFAULT_POLICY);
});

test("a readable, valid file is loaded", () => {
  const { file } = tempFile(valid);
  const result = loadPolicy(file);
  assert.equal(result.status, "loaded");
  assert.equal(levelFor(result.policy, "local:Herdr_Discord_Bridge"), "L1");
});

test("an invalid file falls back to the safe default and reports why", () => {
  const { file } = tempFile("version: 1\ndefault: L9\n");
  const result = loadPolicy(file);
  assert.equal(result.status, "invalid");
  assert.match(result.error ?? "", /level/);
  assert.deepEqual(result.policy, DEFAULT_POLICY);
  assert.equal(levelFor(result.policy, "local:Foo"), "L0");
});

test(
  "a file that group or others can write is refused and the default is used",
  { skip: process.platform === "win32" },
  () => {
    for (const mode of [0o664, 0o666, 0o620, 0o602]) {
      const { file } = tempFile(
        "version: 1\nprojects:\n  local:Foo: L2\n",
        mode,
      );
      const result = loadPolicy(file);
      assert.equal(result.status, "unsafe", mode.toString(8));
      assert.match(result.error ?? "", /chmod 600|writable/);
      assert.equal(levelFor(result.policy, "local:Foo"), "L0");
    }
    // 只有讀取權限（0644）不會讓別人改內容，可以載入。
    const { file } = tempFile("version: 1\n", 0o644);
    assert.equal(loadPolicy(file).status, "loaded");
  },
);

test(
  "a symbolic link, a directory and an oversized file are refused",
  { skip: process.platform === "win32" },
  () => {
    const real = tempFile("version: 1\n");
    const link = path.join(real.dir, "link.yml");
    fs.symlinkSync(real.file, link);
    assert.equal(loadPolicy(link).status, "unsafe");

    const dir = path.join(real.dir, "dir.yml");
    fs.mkdirSync(dir);
    assert.equal(loadPolicy(dir).status, "unsafe");

    const big = tempFile(`version: 1\n# ${"x".repeat(20_000)}\n`);
    const result = loadPolicy(big.file);
    assert.equal(result.status, "unsafe");
    assert.match(result.error ?? "", /16 KiB/);
  },
);

test("a file that is not valid UTF-8 is refused", () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, Buffer.from([0x76, 0xff, 0xfe]), { mode: 0o600 });
  void dir;
  assert.equal(loadPolicy(file).status, "invalid");
});

// H2 自動撿卡（使用者 2026-11-05 決定）：政策檔明確選用，每個專案指定 repo 路徑；Lead 種類全域一個。
const withAutopick = [
  "version: 1",
  "default: L0",
  "autopick_lead: codex",
  "projects:",
  "  local:Herdr_Discord_Bridge: L2",
  "  local:Other: L1",
  "autopick:",
  "  local:Herdr_Discord_Bridge: /Users/example/git_wk/Herdr_Discord_Bridge",
  "",
].join("\n");

test("autopick lists the projects to pick cards for, with each repo path and one Lead kind", () => {
  const result = parsePolicy(withAutopick);
  assert.ok(result.ok);
  assert.deepEqual(result.policy.autopick, {
    "local:Herdr_Discord_Bridge": "/Users/example/git_wk/Herdr_Discord_Bridge",
  });
  assert.equal(result.policy.autopickLead, "codex");
  assert.equal(autopickFor(result.policy, "local:Herdr_Discord_Bridge")?.level, "L2");
  assert.equal(autopickFor(result.policy, "local:Other"), undefined);
});

test("without an autopick block nothing is picked, and the parsed policy keeps its old shape", () => {
  const result = parsePolicy(valid);
  assert.ok(result.ok);
  assert.equal("autopick" in result.policy, false);
  assert.equal(autopickFor(result.policy, "local:Herdr_Discord_Bridge"), undefined);
});

test("the Lead kind defaults to claude and only claude or codex are accepted", () => {
  const result = parsePolicy(
    "version: 1\nprojects:\n  local:A: L1\nautopick:\n  local:A: /repo/a\n",
  );
  assert.ok(result.ok);
  assert.equal(autopickFor(result.policy, "local:A")?.lead, "claude");
  assert.equal(
    parsePolicy("version: 1\nautopick_lead: agy\n").ok,
    false,
  );
});

test("autopick is refused for a project that has no explicit level, so a permissive default can never start work by itself", () => {
  const result = parsePolicy(
    "version: 1\ndefault: L2\nautopick:\n  local:A: /repo/a\n",
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /projects/);
});

test("autopick paths must be absolute, free of .. and control characters, and projects unique", () => {
  const base = "version: 1\nprojects:\n  local:A: L1\nautopick:\n";
  for (const bad of [
    "  local:A: relative/path",
    "  local:A: /repo/../etc",
    "  local:A: /repo/a b\u0001",
    "  local:A: ",
    "  local:A: /repo/a\n  local:A: /repo/b",
  ])
    assert.equal(parsePolicy(base + bad + "\n").ok, false, bad);
});
