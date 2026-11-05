import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCommand } from "../src/main.js";
import { createConsoleContext } from "../src/console.js";
import { RoutingStore } from "../src/routing.js";
import { TeamTaskEngine } from "../src/team-task-engine.js";
import { TeamTaskStore } from "../src/team-task-store.js";
import {
  parseAssignmentPlan,
  validateAssignmentPlan,
} from "../src/team-orchestration.js";
import {
  assertIndependentReview,
  codingPlanningAddendum,
  parseCodingResult,
} from "../src/coding-workflow.js";
import {
  captureCodingTree,
  readCodingArtifact,
  versionFromBaseline,
} from "../src/coding-version.js";
import type { AgentRecord } from "../src/types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function repoWithBaseline(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "coding-repo-"));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  writeFileSync(join(repo, "notes.txt"), "keep\n");
  return { repo, head: git(repo, ["rev-parse", "HEAD"]).trim() };
}

function agent(
  pane: string,
  session: string | undefined,
  repo: string,
): AgentRecord {
  return {
    pane_id: pane,
    terminal_id: `term-${pane}`,
    workspace_id: "w1",
    tab_id: "t1",
    agent: "codex",
    agent_status: "idle",
    cwd: repo,
    ...(session ? { agent_session: { kind: "id", value: session } } : {}),
  };
}

function framed(prompt: string, body: string): string {
  const begin = prompt.match(/BRIDGE_BEGIN_[a-f0-9]+/)?.[0];
  const end = prompt.match(/BRIDGE_END_[a-f0-9]+/)?.[0];
  return begin && end ? `${begin}\n${body}\n${end}` : body;
}

test("general plans ignore coding fields and keep the original instruction", () => {
  const parsed = parseAssignmentPlan(
    JSON.stringify({
      assignments: [
        {
          id: "a",
          workerPaneId: "w1:p2",
          instruction: "please --coding later",
          role: "review",
          access: "read",
          dependsOn: [],
        },
      ],
    }),
  );
  assert.equal(parsed.assignments[0].instruction, "please --coding later");
  assert.equal("coding" in parsed.assignments[0], false);
  assert.throws(
    () =>
      parseAssignmentPlan(
        JSON.stringify({
          assignments: [
            {
              id: "a",
              workerPaneId: "w1:p2",
              instruction: "implement",
              role: "implement",
              access: "read",
            },
          ],
        }),
        false,
        true,
      ),
    /single writer/,
  );
});

test("unknown and same-session reviewers are rejected before they count as review", () => {
  const author = agent("w1:p2", "author", "/tmp");
  const same = agent("w1:p3", "author", "/tmp");
  const unknown = agent("w1:p3", undefined, "/tmp");
  assert.throws(
    () =>
      assertIndependentReview(
        [{ paneId: author.pane_id, session: { kind: "id", value: "author" } }],
        same,
      ),
    /same-session/,
  );
  assert.throws(
    () =>
      assertIndependentReview(
        [{ paneId: author.pane_id, session: { kind: "id", value: "author" } }],
        unknown,
      ),
    /unknown reviewer/,
  );
  assert.equal(
    parseCodingResult(
      '{"codingResult":{"kind":"review","verdict":"changes_requested","findings":[{"id":"f1","summary":"fix"}]}}',
    )?.verdict,
    "changes_requested",
  );
});

test("version fingerprint covers untracked bytes, ignores ignored files, and keeps the dirty baseline", () => {
  const { repo, head } = repoWithBaseline();
  try {
    const baseline = captureCodingTree(repo);
    assert.equal(baseline.headSha, head);
    assert.equal(
      versionFromBaseline(
        baseline,
        captureCodingTree(repo),
      ).deliveryPaths.includes("notes.txt"),
      false,
    );
    writeFileSync(join(repo, "added.txt"), "one\n");
    const withUntracked = versionFromBaseline(
      baseline,
      captureCodingTree(repo),
    );
    assert.equal(withUntracked.mode, "uncommitted");
    assert.deepEqual(withUntracked.deliveryPaths, ["added.txt"]);
    assert.equal(withUntracked.untracked[0].sha256, sha("one\n"));
    assert.equal(
      git(repo, ["diff", "--name-only"]).includes("added.txt"),
      false,
    );
    assert.equal(
      git(repo, ["diff", "--cached", "--name-only"]).includes("added.txt"),
      false,
    );
    writeFileSync(join(repo, "added.txt"), "two\n");
    const changed = versionFromBaseline(baseline, captureCodingTree(repo));
    assert.notEqual(changed.fingerprint, withUntracked.fingerprint);
    assert.equal(changed.stagedDiffSha256, withUntracked.stagedDiffSha256);
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    writeFileSync(join(repo, ".gitignore"), "secret.log\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore"]);
    const committedBase = captureCodingTree(repo);
    writeFileSync(join(repo, "secret.log"), "secret\n");
    const ignored = versionFromBaseline(committedBase, captureCodingTree(repo));
    writeFileSync(join(repo, "secret.log"), "changed\n");
    assert.equal(
      versionFromBaseline(committedBase, captureCodingTree(repo)).fingerprint,
      ignored.fingerprint,
    );
    assert.equal(ignored.deliveryPaths.includes("secret.log"), false);
    writeFileSync(join(repo, "tracked.txt"), "tracked\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "tracked"]);
    const committed = versionFromBaseline(
      committedBase,
      captureCodingTree(repo),
    );
    assert.equal(committed.mode, "committed");
    assert.equal(committed.baseSha, committedBase.headSha);
    assert.notEqual(committed.headSha, committed.baseSha);
    assert.ok(committed.deliveryPaths.includes("tracked.txt"));
    const source = readFileSync(
      fileURLToPath(new URL("../../src/coding-version.ts", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /["'](commit|merge|push|reset|checkout|clean)["']/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** ISSUE-088：測試用的 session 標籤 → 固定的 UUID（rollout 檔名帶的 id）。 */
function uuidFor(label: string): string {
  const h = sha(label);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function harness(options: {
  repo: string;
  reviewerSession?: string;
  omitReviewerSession?: boolean;
  /** ISSUE-088：Herdr 對 codex pane 不提供 agent_session，身分只能從 rollout 得知。 */
  hidePaneSessions?: boolean;
  /** ISSUE-089：模擬 codex 在終端依 pane 寬度把 JSON 字串硬換行（換行後縮排兩格）。 */
  wrapCodexReports?: boolean;
  script:
    | "happy"
    | "stale"
    | "synthesis-edit"
    | "same"
    | "unknown"
    | "no-verify"
    | "empty"
    | "general"
    | "review-drift"
    | "verify-drift"
    | "prior-cover"
    | "repeat-finding"
    | "overlap";
  hangWorker?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "coding-task-"));
  // codex 的身分改由 rollout 觀察：每個有 session 的假 Agent 收到 prompt 時寫出對應 rollout。
  const codexHome = join(dir, "codex-home");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let rollouts = 0;
  const store = new TeamTaskStore(join(dir, "tasks"));
  const lead = agent("w1:p1", "lead-session", options.repo);
  const author = agent("w1:p2", "author-session", options.repo);
  const reviewer = agent(
    "w1:p3",
    options.omitReviewerSession
      ? undefined
      : (options.reviewerSession ?? "review-session"),
    options.repo,
  );
  const labels = new Map(
    [lead, author, reviewer].map((item) => [
      item.pane_id,
      (item.agent_session as { value?: string } | undefined)?.value,
    ]),
  );
  const strip = (item: AgentRecord): AgentRecord => {
    if (!options.hidePaneSessions) return item;
    const { agent_session: _hidden, ...rest } = item;
    return rest;
  };
  let live = [lead, author, reviewer].map(strip);
  const prompts: Array<{ target: string; text: string }> = [];
  const cancels: string[] = [];
  let plans = 0;
  let reviews = 0;
  let entered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const port = {
    listAgentsWithWorkspaceNames: async () => live,
    promptAgent: async (target: string, text: string) => {
      prompts.push({ target, text });
      const label = labels.get(target);
      if (label) {
        const day = join(codexHome, "sessions", "2026", "11", "05");
        mkdirSync(day, { recursive: true });
        writeFileSync(
          join(day, `rollout-${rollouts++}-${uuidFor(label)}.jsonl`),
          text,
        );
      }
      if (text.includes("Do not modify files while planning")) plans += 1;
      if (text.includes("Coding role: review")) reviews += 1;
      if (
        (options.script === "review-drift" ||
          options.script === "prior-cover") &&
        text.includes("Coding role: review") &&
        reviews === 2
      )
        writeFileSync(
          join(options.repo, "added.txt"),
          "changed-during-review\n",
        );
      if (
        options.script === "verify-drift" &&
        text.includes("Coding role: verify")
      )
        writeFileSync(
          join(options.repo, "added.txt"),
          "changed-during-verify\n",
        );
      if (
        text.includes("Coding role: implement") &&
        text.includes("Finding refs: f1")
      )
        writeFileSync(join(options.repo, "added.txt"), "two\n");
      else if (text.includes("Coding role: implement"))
        writeFileSync(join(options.repo, "added.txt"), "one\n");
      if (options.hangWorker && target === author.pane_id) {
        live = live.map((item) =>
          item.pane_id === target ? { ...item, agent_status: "working" } : item,
        );
        entered!();
      }
    },
    waitAgent: async (target: string) => {
      if (options.hangWorker && target === author.pane_id)
        return new Promise<AgentRecord>(() => {});
      return {
        ...live.find((item) => item.pane_id === target)!,
        agent_status: "done" as const,
      };
    },
    readAgent: async (target: string) => {
      const prompt =
        prompts.filter((item) => item.target === target).at(-1)?.text ?? "";
      let body = "historical";
      if (options.script === "general") {
        if (prompt.includes("Do not modify files while planning")) {
          body = JSON.stringify(
            plans < 2
              ? {
                  assignments: [
                    {
                      id: "step-1",
                      workerPaneId: author.pane_id,
                      instruction: "Inspect",
                      role: "review",
                      access: "read",
                    },
                  ],
                }
              : { assignments: [] },
          );
        } else if (target === author.pane_id) body = "report";
        else body = "Verified synthesis";
      } else if (prompt.includes("Do not modify files while planning")) {
        body = JSON.stringify(
          planFor(options.script, plans, author.pane_id, reviewer.pane_id),
        );
        if (options.script === "stale" && plans >= 4)
          writeFileSync(join(options.repo, "added.txt"), "stale\n");
      } else if (prompt.includes("Coding role: implement"))
        body = JSON.stringify({
          codingResult: { kind: "implement", files: ["added.txt"] },
        });
      else if (prompt.includes("Coding role: review")) {
        body = JSON.stringify({
          codingResult: {
            kind: "review",
            verdict:
              ((options.script === "happy" ||
                options.script === "review-drift" ||
                options.script === "repeat-finding") &&
                reviews === 1) ||
              (options.script === "repeat-finding" && reviews === 2)
                ? "changes_requested"
                : "pass",
            findings:
              ((options.script === "happy" ||
                options.script === "review-drift" ||
                options.script === "repeat-finding") &&
                reviews === 1) ||
              (options.script === "repeat-finding" && reviews === 2)
                ? [
                    {
                      id: "f1",
                      summary:
                        reviews === 1 ? "rename the value" : "still wrong",
                    },
                  ]
                : [],
          },
        });
      } else if (prompt.includes("Coding role: verify")) {
        body = JSON.stringify({
          codingResult: {
            kind: "verify",
            commands: [{ command: "node --test", exitCode: 0 }],
          },
        });
        if (options.wrapCodexReports)
          body = body.replace("node --test", "node --\n  test");
      } else if (
        prompt.includes("Synthesize") ||
        prompt.includes("acceptance gate")
      ) {
        if (options.script === "synthesis-edit")
          writeFileSync(join(options.repo, "added.txt"), "lead-edit\n");
        body = "Local delivery report";
      }
      return framed(prompt, body);
    },
    cancelAgent: async (target: string) => {
      cancels.push(target);
      live = live.map((item) =>
        item.pane_id === target
          ? { ...item, agent_status: "idle" as const }
          : item,
      );
    },
  };
  const engine = new TeamTaskEngine(store, port, new Set());
  return {
    dir,
    store,
    engine,
    port,
    prompts,
    cancels,
    lead: strip(lead),
    author: strip(author),
    reviewer: strip(reviewer),
    entered: enteredPromise,
    close: () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function planFor(
  script: string,
  round: number,
  author: string,
  reviewer: string,
) {
  const implement = {
    id: "impl",
    workerPaneId: author,
    instruction: "Add the feature",
    role: "implement",
    access: "write",
    writeScope: ["added.txt"],
  };
  const review = (id: string) => ({
    id,
    workerPaneId: reviewer,
    instruction: "Review the current version",
    role: "review",
    access: "read",
  });
  const verify = {
    id: "ver",
    workerPaneId: reviewer,
    instruction: "Run the local check",
    role: "verify",
    access: "read",
  };
  const fix = {
    id: "fix",
    workerPaneId: author,
    instruction: "Address f1",
    role: "implement",
    access: "write",
    writeScope: ["added.txt"],
    findingRefs: ["f1"],
  };
  if (script === "happy" || script === "review-drift") {
    const rounds = [
      [implement],
      [review("rev1")],
      [fix],
      [review("rev2")],
      [verify],
      [],
    ];
    return { assignments: rounds[round - 1] ?? [] };
  }
  if (script === "prior-cover") {
    const rounds = [
      [implement],
      [review("rev1")],
      [review("rev2")],
      [verify],
      [],
    ];
    return { assignments: rounds[round - 1] ?? [] };
  }
  if (script === "repeat-finding") {
    const rounds = [
      [implement],
      [review("rev-a")],
      [fix],
      [review("rev-b")],
      [],
    ];
    return { assignments: rounds[round - 1] ?? [] };
  }
  if (script === "overlap") {
    return {
      assignments: [implement, review("rev1")],
    };
  }
  if (script === "no-verify") {
    const rounds = [[implement], [review("rev1")], []];
    return { assignments: rounds[round - 1] ?? [] };
  }
  if (script === "empty") return { assignments: [] };
  const rounds = [[implement], [review("rev1")], [verify], []];
  return { assignments: rounds[round - 1] ?? [] };
}

test("coding review findings are replanned without failing the review assignment", async () => {
  const { repo, head } = repoWithBaseline();
  const h = harness({ repo, script: "happy" });
  try {
    const task = await h.engine.run({
      taskId: "task-coding",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    assert.equal(task.state, "completed", task.detail);
    assert.equal(task.coding?.stage, "ready-to-integrate");
    assert.equal(
      task.assignments.find((item) => item.plan.id === "rev1")?.state,
      "done",
    );
    assert.equal(
      task.coding?.artifacts.find((item) => item.assignmentId === "rev1")
        ?.verdict,
      "changes_requested",
    );
    assert.equal(task.coding?.findings[0]?.status, "resolved");
    assert.equal(
      task.assignments.find((item) => item.plan.id === "fix")?.plan.coding
        ?.findingRefs[0],
      "f1",
    );
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), head);
    const artifact = task.coding!.artifacts.find(
      (item) => item.assignmentId === "impl",
    )!;
    assert.equal(artifact.untracked[0]?.path, "added.txt");
    assert.equal(artifact.deliveryPaths.includes("notes.txt"), false);
    assert.equal(
      git(repo, ["diff", "--name-only"]).includes("added.txt"),
      false,
    );
    const outside = readCodingArtifact(
      h.store.journalDirectory(),
      task.taskId,
      artifact.id,
    ) as { outsideWorktree: boolean; untracked: Array<{ sha256: string }> };
    assert.equal(outside.outsideWorktree, true);
    assert.equal(outside.untracked[0].sha256, sha("one\n"));
    assert.equal(outside.untracked[0].sha256.startsWith(join(repo, "")), false);
    const saved = JSON.parse(
      readFileSync(join(h.dir, "tasks", `${task.taskId}.json`), "utf8"),
    );
    assert.equal(saved.schemaVersion, 3);
    assert.match(
      h.prompts.map((item) => item.text).join("\n"),
      /finding f1|Finding refs: f1|"id":"f1"/,
    );
    assert.doesNotMatch(h.prompts[0].text, /Human task: --coding/);
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("read-only review drift does not stamp pass evidence or complete", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({ repo, script: "review-drift" });
  try {
    const task = await h.engine.run({
      taskId: "task-review-drift",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    const rev2 = task.coding?.artifacts.find(
      (item) => item.assignmentId === "rev2",
    );
    assert.equal(
      task.assignments.find((item) => item.plan.id === "rev2")?.state,
      "done",
    );
    assert.notEqual(task.state, "completed", task.detail);
    assert.equal(task.state, "failed");
    assert.equal(rev2?.verdict, "inconclusive");
    assert.equal(rev2?.reportedVerdict, "pass");
    assert.notEqual(rev2?.startVersionFingerprint, rev2?.endVersionFingerprint);
    assert.equal(rev2?.versionFingerprint, rev2?.endVersionFingerprint);
    assert.match(rev2?.driftReason ?? "", /changed during/);
    assert.equal(
      task.coding?.artifacts.some(
        (item) =>
          item.verdict === "pass" &&
          item.versionFingerprint === rev2?.endVersionFingerprint,
      ),
      false,
    );
    assert.equal(
      task.coding?.artifacts.some(
        (item) =>
          item.assignmentId === "rev2" &&
          item.verdict === "pass" &&
          item.versionFingerprint === rev2.startVersionFingerprint,
      ),
      false,
    );
    assert.equal(
      task.coding?.findings.find((item) => item.id === "f1")?.status,
      "open",
    );
    assert.match(
      task.detail ?? "",
      /drifted|changed during|unhandled findings/,
    );
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    const saved = readCodingArtifact(
      h.store.journalDirectory(),
      task.taskId,
      rev2!.id,
    ) as { driftReason?: string };
    assert.equal(saved.driftReason, rev2?.driftReason);
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verify drift and an earlier pass do not cover the changed version", async () => {
  for (const script of ["verify-drift", "prior-cover"] as const) {
    const { repo } = repoWithBaseline();
    const h = harness({ repo, script });
    try {
      const task = await h.engine.run({
        taskId: `task-${script}`,
        prompt: "ship the local change",
        lead: h.lead,
        workers: [h.author, h.reviewer],
        replan: true,
        coding: true,
        timeoutMs: 500,
      });
      assert.notEqual(task.state, "completed", task.detail);
      assert.equal(task.state, "failed");
      const drifted = task.coding?.artifacts.find((item) => item.driftReason);
      assert.ok(drifted, script);
      assert.notEqual(
        drifted.startVersionFingerprint,
        drifted.endVersionFingerprint,
      );
      assert.equal(drifted.versionFingerprint, drifted.endVersionFingerprint);
      assert.notEqual(drifted.verdict, "pass");
      assert.notEqual(drifted.verificationPassed, true);
      const current = task.coding?.versionFingerprint;
      assert.equal(
        task.coding?.artifacts.some(
          (item) =>
            item.role === "review" &&
            item.verdict === "pass" &&
            item.versionFingerprint === current &&
            !item.driftReason,
        ),
        false,
        script,
      );
      const earlier = task.coding?.artifacts.find(
        (item) => item.assignmentId === "rev1" && item.verdict === "pass",
      );
      if (script === "prior-cover") {
        assert.equal(drifted.role, "review");
        assert.ok(earlier);
        assert.notEqual(earlier.versionFingerprint, current);
      }
      if (script === "verify-drift") {
        assert.equal(drifted.role, "verify");
        assert.equal(
          task.coding?.artifacts.some(
            (item) =>
              item.role === "verify" &&
              item.verificationPassed === true &&
              (item.versionFingerprint === current ||
                item.versionFingerprint === drifted.startVersionFingerprint),
          ),
          false,
        );
      }
      assert.match(task.detail ?? "", /drifted|changed during|verification/);
      assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    } finally {
      h.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("repeated raw finding ids stay referenceable across two changes_requested rounds", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({ repo, script: "repeat-finding" });
  try {
    const task = await h.engine.run({
      taskId: "task-repeat-finding",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    assert.equal(
      task.assignments.find((item) => item.plan.id === "rev-a")?.state,
      "done",
    );
    assert.equal(
      task.assignments.find((item) => item.plan.id === "rev-b")?.state,
      "done",
    );
    assert.doesNotMatch(task.detail ?? "", /duplicate finding/);
    assert.equal(task.coding?.findings.length, 2);
    assert.equal(task.coding?.findings[0]?.id, "f1");
    assert.equal(task.coding?.findings[0]?.status, "open");
    assert.equal(task.coding?.findings[1]?.id, "rev-b:f1");
    assert.equal(task.coding?.findings[1]?.status, "open");
    assert.equal(task.coding?.findings[1]?.summary, "still wrong");
    assert.equal(
      task.assignments.find((item) => item.plan.id === "fix")?.plan.coding
        ?.findingRefs[0],
      "f1",
    );
    assert.notEqual(task.state, "completed");
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a writer round cannot overlap a read-only assignment", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({ repo, script: "overlap" });
  try {
    const task = await h.engine.run({
      taskId: "task-overlap",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    assert.equal(task.state, "failed");
    assert.match(task.detail ?? "", /depend on that writer/);
    assert.equal(
      task.coding?.artifacts.some((item) => item.verdict === "pass"),
      false,
    );
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a changed version, a missing verify, and a Lead edit cannot complete", async () => {
  for (const script of ["stale", "no-verify", "synthesis-edit"] as const) {
    const { repo } = repoWithBaseline();
    const h = harness({ repo, script });
    try {
      const task = await h.engine.run({
        taskId: `task-${script}`,
        prompt: "ship the local change",
        lead: h.lead,
        workers: [h.author, h.reviewer],
        replan: true,
        coding: true,
        timeoutMs: 500,
      });
      assert.notEqual(task.state, "completed");
      assert.equal(task.state, "failed");
      assert.match(
        task.detail ?? "",
        /current version|verification|version changed/,
      );
      assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    } finally {
      h.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("same-session and unknown reviewers do not pass the coding gate", async () => {
  for (const mode of ["same", "unknown"] as const) {
    const { repo } = repoWithBaseline();
    const h = harness({
      repo,
      script: mode,
      reviewerSession: mode === "same" ? "author-session" : undefined,
      omitReviewerSession: mode === "unknown",
    });
    try {
      const task = await h.engine.run({
        taskId: `task-${mode}`,
        prompt: "ship the local change",
        lead: h.lead,
        workers: [h.author, h.reviewer],
        replan: true,
        coding: true,
        timeoutMs: 500,
      });
      // ISSUE-088：codex 的身分要等回合結束才由 rollout 確認，所以 review 會跑完，
      // 但入帳時判定不獨立，不能算通過的 review。
      assert.equal(task.state, "failed");
      const reviews = (task.coding?.artifacts ?? []).filter(
        (item) => item.role === "review",
      );
      assert.ok(reviews.length > 0);
      assert.equal(
        reviews.some((item) => item.independentReview),
        false,
      );
      assert.equal(
        reviews.some((item) => item.verdict === "pass"),
        false,
      );
      assert.match(
        reviews.map((item) => item.independenceFailure ?? "").join("\n"),
        mode === "same" ? /same-session/ : /unknown reviewer/,
      );
    } finally {
      h.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("ISSUE-088: codex panes without a Herdr agent_session still get an independent review from the rollout identity", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({ repo, script: "happy", hidePaneSessions: true });
  try {
    const task = await h.engine.run({
      taskId: "task-rollout-identity",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    const reviews = (task.coding?.artifacts ?? []).filter(
      (item) => item.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((item) => item.independentReview === true));
    assert.equal(
      reviews.at(-1)?.reviewerSession?.value,
      uuidFor("review-session"),
    );
    const implement = task.coding?.artifacts.find(
      (item) => item.role === "implement",
    );
    assert.equal(implement?.authorSession?.value, uuidFor("author-session"));
    assert.equal(task.state, "completed");
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ISSUE-089: a codex report whose JSON string was hard-wrapped by the terminal still counts as verification", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({ repo, script: "happy", wrapCodexReports: true });
  try {
    const task = await h.engine.run({
      taskId: "task-wrapped-report",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    const verify = task.coding?.artifacts.find(
      (item) => item.role === "verify",
    );
    assert.equal(verify?.evidence, "recorded");
    assert.equal(verify?.verificationPassed, true);
    assert.deepEqual(verify?.commands, [
      { command: "node --test", exitCode: 0 },
    ]);
    assert.equal(task.state, "completed");
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ISSUE-088: a reviewer that shares the author's rollout session is not independent even without a Herdr agent_session", async () => {
  const { repo } = repoWithBaseline();
  const h = harness({
    repo,
    script: "same",
    reviewerSession: "author-session",
    hidePaneSessions: true,
  });
  try {
    const task = await h.engine.run({
      taskId: "task-rollout-same",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    assert.equal(task.state, "failed");
    const reviews = (task.coding?.artifacts ?? []).filter(
      (item) => item.role === "review",
    );
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((item) => item.independentReview === false));
    assert.match(reviews[0]!.independenceFailure ?? "", /same-session/);
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("zero-worker coding ask does not complete, while a general ask stays compatible", async () => {
  const { repo } = repoWithBaseline();
  const coding = harness({ repo, script: "empty" });
  const general = harness({ repo, script: "general" });
  try {
    const blocked = await coding.engine.run({
      taskId: "task-empty",
      prompt: "ship the local change",
      lead: coding.lead,
      workers: [],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    assert.equal(blocked.state, "failed");
    assert.match(blocked.detail ?? "", /review|verification/);
    const ordinary = await general.engine.run({
      taskId: "task-general",
      prompt: "please --coding later",
      lead: general.lead,
      workers: [general.author],
      replan: true,
      timeoutMs: 500,
    });
    assert.equal(ordinary.state, "completed");
    assert.equal(ordinary.codingMode, undefined);
    assert.equal("coding" in ordinary.assignments[0].plan, false);
    assert.equal(ordinary.assignments[0].plan.instruction, "Inspect");
    assert.match(general.prompts[0].text, /please --coding later/);
    assert.doesNotMatch(
      general.prompts[0].text,
      /explicitly selected the local Git coding workflow/,
    );
    const journal = JSON.parse(
      readFileSync(join(general.dir, "tasks", "task-general.json"), "utf8"),
    );
    assert.equal(journal.schemaVersion, 2);
    journal.schemaVersion = 1;
    writeFileSync(
      join(general.dir, "tasks", "task-general.json"),
      JSON.stringify(journal),
    );
    assert.equal(
      new TeamTaskStore(join(general.dir, "tasks")).get("task-general").state,
      "completed",
    );
    journal.schemaVersion = 2;
    journal.events[0].task.codingMode = true;
    writeFileSync(
      join(general.dir, "tasks", "task-general.json"),
      JSON.stringify(journal),
    );
    assert.throws(
      () => new TeamTaskStore(join(general.dir, "tasks")),
      /schema v3/,
    );
  } finally {
    coding.close();
    general.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cancel and restart leave the baseline dirty tree and do not redispatch", async () => {
  const { repo, head } = repoWithBaseline();
  const h = harness({ repo, script: "happy", hangWorker: true });
  try {
    const running = h.engine.run({
      taskId: "task-cancel",
      prompt: "ship the local change",
      lead: h.lead,
      workers: [h.author, h.reviewer],
      replan: true,
      coding: true,
      timeoutMs: 500,
    });
    await h.entered;
    const journal = readFileSync(join(h.dir, "tasks", "task-cancel.json"));
    const copy = mkdtempSync(join(tmpdir(), "coding-restart-"));
    mkdirSync(join(copy, "tasks"));
    writeFileSync(join(copy, "tasks", "task-cancel.json"), journal);
    const restarted = new TeamTaskEngine(
      new TeamTaskStore(join(copy, "tasks")),
      {
        ...h.port,
        promptAgent: async () => {
          h.prompts.push({ target: "restart", text: "nope" });
        },
      },
      new Set(),
    );
    const before = h.prompts.length;
    await restarted.reconcile();
    const recovered = restarted.store.get("task-cancel");
    assert.equal(recovered.state, "blocked");
    assert.equal(
      recovered.coding?.baselineFingerprint,
      h.store.get("task-cancel").coding?.baselineFingerprint,
    );
    assert.equal(h.prompts.length, before);
    assert.equal(
      h.prompts.some((item) => item.target === "restart"),
      false,
    );
    const cancelled = await h.engine.cancel("task-cancel");
    await running;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "keep\n");
    assert.equal(git(repo, ["log", "--oneline"]).trim().split("\n").length, 1);
    rmSync(copy, { recursive: true, force: true });
  } finally {
    h.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("artifact reads stay inside the task directory and reject escapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-artifacts-"));
  try {
    mkdirSync(join(dir, "artifacts", "task-a"), { recursive: true });
    writeFileSync(
      join(dir, "artifacts", "task-a", "a-ok.json"),
      JSON.stringify({ ok: true }),
    );
    assert.deepEqual(readCodingArtifact(dir, "task-a", "a-ok"), { ok: true });
    // 目標必須真實存在：/etc/hostname 在 macOS 不存在，會變成 ENOENT 而不是逃逸（ISSUE-035）。
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(dir, "artifacts", "task-a", "a-link.json"));
    assert.throws(
      () => readCodingArtifact(dir, "task-a", "a-link"),
      /escapes|read limit/,
    );
    writeFileSync(
      join(dir, "artifacts", "task-a", "a-big.json"),
      "x".repeat(300_000),
    );
    assert.throws(
      () => readCodingArtifact(dir, "task-a", "a-big"),
      /read limit/,
    );
    assert.throws(
      () => readCodingArtifact(dir, "task-a", "a-../a-ok"),
      /invalid coding artifact/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("team ask --coding is opt-in and does not reinterpret the original prompt", async () => {
  const { repo } = repoWithBaseline();
  const dir = mkdtempSync(join(tmpdir(), "coding-cli-"));
  const routing = new RoutingStore(join(dir, "routing.json"));
  const output: string[] = [];
  const general = harness({ repo, script: "general" });
  const coding = harness({ repo, script: "empty" });
  try {
    const context = createConsoleContext((text) => output.push(text));
    routing.bind(context.routing, { workspaceId: "w1", paneId: "w1:p1" });
    routing.bindWorkspace(
      "w1",
      { workspaceId: "w1", paneId: "w1:p2" },
      { activate: false },
    );
    routing.bindWorkspace("w1", { workspaceId: "w1", paneId: "w1:p1" });
    const runtimeFor = (h: ReturnType<typeof harness>) => ({
      tasks: h.engine,
      herdr: h.port,
      routing,
      activeStreams: new Set<string>(),
      config: { allowedWorkspaceIds: [], approvalTimeoutMs: 500 },
      discord: {
        reply: async (_message: unknown, text: string) => output.push(text),
      },
    });
    await handleCommand(
      "team",
      ["ask", "please", "--coding", "later"],
      context,
      runtimeFor(general) as never,
    );
    assert.match(output.join("\n"), /completed/);
    assert.match(general.prompts[0].text, /Human task: please --coding later/);
    assert.doesNotMatch(
      general.prompts[0].text,
      /explicitly selected the local Git coding workflow/,
    );
    output.length = 0;
    routing.bind(context.routing, {
      workspaceId: "w1",
      paneId: coding.lead.pane_id,
    });
    await handleCommand(
      "team",
      ["ask", "--coding", "fix the bug"],
      context,
      runtimeFor(coding) as never,
    );
    assert.match(coding.prompts[0].text, /Human task: fix the bug/);
    assert.match(
      coding.prompts[0].text,
      /explicitly selected the local Git coding workflow/,
    );
    assert.match(output.join("\n"), /failed/);
    const listed = coding.store.list("w1")[0];
    output.length = 0;
    await handleCommand(
      "team",
      ["status", listed.taskId],
      context,
      runtimeFor(coding) as never,
    );
    assert.match(output.join("\n"), /Coding stage:/);
  } finally {
    routing.flush();
    general.close();
    coding.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ISSUE-087: the planning prompt states that read-only assignments must list the writer directly, and the validator still enforces it", () => {
  assert.match(
    codingPlanningAddendum(),
    /every other assignment in that round.*list the writer's assignment id directly.*through another assignment.*rejected/s,
  );
  const lead = agent("w1:p1", "lead", "/tmp");
  const author = agent("w1:p2", "author", "/tmp");
  const reviewer = agent("w1:p3", "reviewer", "/tmp");
  const chain = (verifyDeps: string[]) =>
    parseAssignmentPlan(
      JSON.stringify({
        assignments: [
          {
            id: "impl",
            workerPaneId: author.pane_id,
            instruction: "write",
            role: "implement",
            access: "write",
            writeScope: ["a.txt"],
          },
          {
            id: "review",
            workerPaneId: reviewer.pane_id,
            instruction: "review",
            role: "review",
            access: "read",
            dependsOn: ["impl"],
          },
          {
            id: "verify",
            workerPaneId: reviewer.pane_id,
            instruction: "verify",
            role: "verify",
            access: "read",
            dependsOn: verifyDeps,
          },
        ],
      }),
      false,
      true,
    );
  const validate = (plan: ReturnType<typeof chain>) =>
    validateAssignmentPlan(plan, lead, [author, reviewer], {
      prior: [],
      findingIds: [],
      artifactIds: [],
    });
  assert.throws(
    () => validate(chain(["review"])),
    /must depend on that writer/,
  );
  assert.doesNotThrow(() => validate(chain(["impl", "review"])));
});

test("coding plan validator rejects a second writer and an unknown finding reference", () => {
  const lead = agent("w1:p1", "lead", "/tmp");
  const author = agent("w1:p2", "author", "/tmp");
  const other = agent("w1:p3", "other", "/tmp");
  const plan = parseAssignmentPlan(
    JSON.stringify({
      assignments: [
        {
          id: "one",
          workerPaneId: author.pane_id,
          instruction: "write",
          role: "implement",
          access: "write",
          writeScope: ["a.txt"],
        },
        {
          id: "two",
          workerPaneId: other.pane_id,
          instruction: "write more",
          role: "implement",
          access: "write",
          writeScope: ["b.txt"],
          dependsOn: ["one"],
        },
      ],
    }),
    false,
    true,
  );
  assert.throws(
    () =>
      validateAssignmentPlan(plan, lead, [author, other], {
        prior: [],
        findingIds: [],
        artifactIds: [],
      }),
    /one writer/,
  );
  const fix = parseAssignmentPlan(
    JSON.stringify({
      assignments: [
        {
          id: "fix",
          workerPaneId: author.pane_id,
          instruction: "write",
          role: "implement",
          access: "write",
          writeScope: ["a.txt"],
          findingRefs: ["missing"],
        },
      ],
    }),
    false,
    true,
  );
  assert.throws(
    () =>
      validateAssignmentPlan(fix, lead, [author, other], {
        prior: [],
        findingIds: [],
        artifactIds: [],
      }),
    /unknown finding/,
  );
});
