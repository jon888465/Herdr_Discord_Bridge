import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_NAME } from "../src/card.js";
import {
  FIELD_OMITTED,
  projectName,
  upsertProjectSection,
  type ProjectInfo,
} from "../src/card-projects.js";

const cat = (...parts: string[]): string => parts.join("");

test("projectName is <machine>:<directory> and keeps valid directory names as they are", () => {
  assert.equal(
    projectName("local", "Herdr_Discord_Bridge"),
    "local:Herdr_Discord_Bridge",
  );
  assert.equal(projectName("agy-pod", "repo.v2"), "agy-pod:repo.v2");
  assert.equal(projectName("local", ".hidden-repo"), "local:.hidden-repo");
});

test("a directory name that needs changing gets a deterministic hash suffix so it cannot collide", () => {
  const spaced = projectName("local", "My Project");
  assert.match(spaced ?? "", /^local:My-Project-[0-9a-f]{4}$/);
  assert.equal(projectName("local", "My Project"), spaced);
  assert.equal(projectName("local", "My-Project"), "local:My-Project");
  assert.notEqual(spaced, projectName("local", "My-Project"));
  assert.notEqual(spaced, projectName("local", "My  Project"));

  const chinese = projectName("local", "專案");
  assert.match(chinese ?? "", /^local:p-[0-9a-f]{4}$/);
  assert.notEqual(chinese, projectName("local", "另一個專案"));

  assert.match(projectName("local", "..") ?? "", /^local:p-[0-9a-f]{4}$/);

  const long = projectName("local", "a".repeat(70));
  assert.match(long ?? "", /^local:a{59}-[0-9a-f]{4}$/);
});

test("projectName returns null for an invalid machine id and always produces a valid name", () => {
  assert.equal(projectName("bad machine", "repo"), null);
  assert.equal(projectName("", "repo"), null);
  for (const directory of [
    "repo",
    "My Project",
    "專案",
    "..",
    "a".repeat(80),
    "x/y",
    "-",
  ]) {
    const name = projectName("local", directory);
    assert.ok(name !== null && PROJECT_NAME.test(name), directory);
  }
});

const full: ProjectInfo = {
  machine: "local",
  repoPath: "/Users/jon/git_wk/Herdr_Discord_Bridge",
  branch: "card/REQ-20261102-example",
  worktreePath: "/Users/jon/.herdr/worktrees/Herdr_Discord_Bridge/card-req",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  prUrl: "https://github.com/o/r/pull/9",
  remote: "https://github.com/o/r.git",
};

test("a body without the section gets it at the end, with the fields in a fixed order", () => {
  assert.deepEqual(upsertProjectSection("# T\n\n## 描述\n內容\n", full), {
    ok: true,
    changed: true,
    name: "local:Herdr_Discord_Bridge",
    omitted: [],
    body: [
      "# T",
      "",
      "## 描述",
      "內容",
      "",
      "## 異動專案",
      "",
      "### local:Herdr_Discord_Bridge",
      "",
      "- 機器：local",
      "- repo：/Users/jon/git_wk/Herdr_Discord_Bridge",
      "- 分支：card/REQ-20261102-example",
      "- worktree：/Users/jon/.herdr/worktrees/Herdr_Discord_Bridge/card-req",
      "- base：0123456789ab",
      "- head：abcdef123456",
      "- PR：https://github.com/o/r/pull/9",
      "- remote：https://github.com/o/r.git",
      "",
    ].join("\n"),
  });
});

test("writing the same project again updates its fields in place and is idempotent", () => {
  const first = upsertProjectSection("# T\n", {
    machine: "local",
    repoPath: "/a/Foo",
    branch: "card/x",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = upsertProjectSection(first.body, {
    machine: "local",
    repoPath: "/a/Foo",
    headSha: "abcdef1234567890",
    prUrl: "https://github.com/o/r/pull/9",
  });
  assert.equal(second.ok && second.changed, true);
  assert.equal(
    second.ok && second.body,
    [
      "# T",
      "",
      "## 異動專案",
      "",
      "### local:Foo",
      "",
      "- 機器：local",
      "- repo：/a/Foo",
      "- 分支：card/x",
      "- head：abcdef123456",
      "- PR：https://github.com/o/r/pull/9",
      "",
    ].join("\n"),
  );
  if (!second.ok) return;
  const third = upsertProjectSection(second.body, {
    machine: "local",
    repoPath: "/a/Foo",
    headSha: "abcdef1234567890",
  });
  assert.deepEqual(third, {
    ok: true,
    changed: false,
    name: "local:Foo",
    omitted: [],
    body: second.body,
  });
  const newHead = upsertProjectSection(second.body, {
    machine: "local",
    repoPath: "/a/Foo",
    headSha: "1111111222222233",
  });
  assert.ok(newHead.ok && newHead.body.includes("- head：111111122222\n"));
  assert.ok(newHead.ok && !newHead.body.includes("abcdef123456"));
});

test("another project is added after the first, inside the section and before the next heading", () => {
  const body =
    "# T\n\n## 異動專案\n\n### local:Foo\n\n- 機器：local\n- repo：/a/Foo\n\n## 待確認\n- a\n";
  const result = upsertProjectSection(body, {
    machine: "agy-pod",
    repoPath: "/srv/Bar",
  });
  assert.equal(
    result.ok && result.body,
    "# T\n\n## 異動專案\n\n### local:Foo\n\n- 機器：local\n- repo：/a/Foo\n\n### agy-pod:Bar\n\n- 機器：agy-pod\n- repo：/srv/Bar\n\n## 待確認\n- a\n",
  );
});

test("lines and prose written by a person inside the section are kept", () => {
  const body =
    "# T\n\n## 異動專案\n\n人寫的說明\n\n### local:Foo\n\n- 機器：local\n- repo：/a/Foo\n- 備註：人寫的\n";
  const result = upsertProjectSection(body, {
    machine: "local",
    repoPath: "/a/Foo",
    branch: "x",
  });
  assert.equal(
    result.ok && result.body,
    "# T\n\n## 異動專案\n\n人寫的說明\n\n### local:Foo\n\n- 機器：local\n- repo：/a/Foo\n- 分支：x\n- 備註：人寫的\n",
  );
});

test("a field that does not match its format is rejected, naming the field", () => {
  const ok = { machine: "local", repoPath: "/a/Foo" };
  const bad: Array<[string, Partial<ProjectInfo>]> = [
    ["machine", { machine: "bad machine" }],
    ["repoPath", { repoPath: "relative/path" }],
    ["repoPath", { repoPath: "/a\nb" }],
    ["repoPath", { repoPath: "/" + "a".repeat(120) }],
    ["worktreePath", { worktreePath: "relative" }],
    ["branch", { branch: "has space" }],
    ["baseSha", { baseSha: "zz" }],
    ["headSha", { headSha: "abc" }],
    ["prUrl", { prUrl: "ftp://example.invalid/x" }],
    ["remote", { remote: "not a url" }],
  ];
  for (const [field, patch] of bad) {
    const result = upsertProjectSection("# T\n", { ...ok, ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok)
      assert.match(result.error, new RegExp(field), JSON.stringify(patch));
  }
});

test("a suspected secret omits only that field; credentials in a remote URL are scrubbed and kept", () => {
  const token = cat("gh", "p_", "FAKEFAKEFAKE0123456789ABCD");
  const result = upsertProjectSection("# T\n", {
    machine: "local",
    repoPath: "/a/Foo",
    branch: token,
    remote: "https://user:pw@github.com/o/r.git",
  });
  assert.equal(result.ok && result.omitted.join(","), "branch");
  assert.ok(result.ok && result.body.includes(`- 分支：${FIELD_OMITTED}\n`));
  assert.ok(
    result.ok &&
      result.body.includes("- remote：https://[redacted]@github.com/o/r.git\n"),
  );
  assert.equal(result.ok && result.body.includes(token), false);
  assert.equal(result.ok && result.body.includes("pw"), false);
  assert.equal(FIELD_OMITTED, "（已省略：疑似含機敏資料）");
});

test("a repository directory that looks like a secret cannot be named and is rejected", () => {
  const result = upsertProjectSection("# T\n", {
    machine: "local",
    repoPath: "/a/" + cat("gh", "p_", "FAKEFAKEFAKE0123456789ABCD"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /repoPath/);
});
