// 遠端 fixer（ISSUE-171 第 3 階段）：PR 階段的一圈修正在遠端機器上進行。
// 與本機的 `runCardFix` 同樣的前後契約（FixFlowInput → FixFlowResult、不寫卡片、不 push），差別只在作者改的是遠端的快照目錄：
// 先送出乾淨工作樹的快照 → 遠端 agent 修改 → 作者回覆宣告修好了哪些 finding → bridge 取回改動、本機重新驗證後 commit（`startRemoteRole` 寫入模式）。
// 作者沒有宣告修好任何 finding、回覆不合格、卡住或逾時，都不取回任何遠端改動，本機不動。

import { randomUUID } from "node:crypto";
import {
  assertFreshProfile,
  assertRoleMatches,
  roleMetadata,
} from "./card-role-assignment.js";
import { roleIdentity } from "./card-events.js";
import { buildFixPrompt, parseFixReply } from "./card-fix.js";
import {
  fixerAgentName,
  type FixFlowDeps,
  type FixFlowInput,
  type FixFlowResult,
  type FixOutcome,
} from "./card-fix-flow.js";
import type { RoleCleanupReason } from "./card-role-session.js";
import type { startRemoteRole } from "./remote-snapshot.js";
import { sensitivePathsIn } from "./sensitive-paths.js";

export type StartRemoteRole = (
  input: Parameters<typeof startRemoteRole>[1],
) => ReturnType<typeof startRemoteRole>;

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

const failed = (
  reason: string,
  skipped: Array<{ id: string; reason: string }> = [],
): FixOutcome => ({ kind: "failed", reason, skipped });

export async function runRemoteCardFix(
  deps: { flow: FixFlowDeps; start: StartRemoteRole },
  machineId: string,
  input: FixFlowInput,
): Promise<FixFlowResult> {
  const launch = input.launch;
  if (!launch)
    return {
      ok: false,
      stage: "kind",
      error: "遠端 fixer 需要已配置的 profile，不知道要啟動哪個 agent",
    };
  assertFreshProfile(launch);
  const built = buildFixPrompt({
    card: input.card,
    findings: input.findings,
    round: input.round,
  });
  if (!built.ok) return { ok: false, stage: "prompt", error: built.error };

  let before: { head: string; dirty: boolean };
  try {
    before = await deps.flow.state(input.worktreePath);
  } catch (error) {
    return {
      ok: false,
      stage: "state",
      error: `無法讀取工作樹狀態，不開始修正：${message(error)}`,
    };
  }
  if (before.dirty)
    return {
      ok: false,
      stage: "state",
      error:
        "worktree 有未提交的修改，不開始修正（修正要在乾淨的工作樹上進行）；請先 commit 或處理",
    };

  let role: Awaited<ReturnType<StartRemoteRole>>;
  try {
    role = await deps.start({
      machineId,
      role: "fixer",
      // 每次執行唯一：上一次被保留（blocked／逾時）的遠端目錄不會擋住重試。
      key: `card-fix:${input.card.id}:r${input.round}:${randomUUID().slice(0, 8)}`,
      cwd: input.worktreePath,
      profile: launch,
      name: fixerAgentName(input.card.id, input.round),
    });
  } catch (error) {
    return { ok: false, stage: "start", error: message(error) };
  }

  let reason: RoleCleanupReason = "completed";
  try {
    const actual = { ...role.agent };
    const constraint = input.card.roles?.fixer;
    if (constraint) assertRoleMatches("fixer", constraint, actual);
    if (!deps.flow.recordRoleStrict)
      throw new Error("卡片角色紀錄介面不存在，未派工");
    await deps.flow.recordRoleStrict({
      ...roleIdentity("fixer", actual, { round: input.round }),
      ...roleMetadata(
        "fixer",
        constraint,
        actual,
        input.requestedKind ? "CLI" : "default",
        launch.model ? "launch" : actual.model ? "observed" : "unknown",
      ),
    });

    let text: string;
    try {
      const turn = await deps.flow.runTurn(
        role.agent,
        built.prompt,
        deps.flow.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (turn.state === "blocked") {
        reason = "blocked";
        return done(
          failed("作者卡住了（blocked，可能在等人確認）；遠端 workspace 已保留"),
        );
      }
      text = turn.text;
    } catch (error) {
      reason = "timeout";
      return done(failed(`作者沒有回覆：${message(error)}`));
    }
    const parsed = parseFixReply(
      text,
      input.findings.map((item) => item.id),
    );
    if (!parsed.ok) return done(failed(parsed.reason));
    if (parsed.fixed.length === 0)
      return done(
        failed(
          `作者把所有 finding 都略過了（${parsed.skipped.map((item) => `${item.id}：${item.reason}`).join("；")}），沒有修正；遠端改動不取回`,
          parsed.skipped,
        ),
      );

    // 取回、驗證、套用並 commit；任何一步失敗本機已還原，這一圈不採用。
    try {
      await role.afterTurn();
    } catch (error) {
      return done(failed(message(error), parsed.skipped));
    }
    let after: { head: string; dirty: boolean };
    let files: string[];
    try {
      after = await deps.flow.state(input.worktreePath);
      files = await deps.flow.changedFiles(
        input.worktreePath,
        before.head,
        after.head,
      );
    } catch (error) {
      return done(
        failed(`修正之後無法讀取工作樹狀態：${message(error)}`, parsed.skipped),
      );
    }
    if (after.dirty || after.head === before.head)
      return done(
        failed(
          "遠端改動套用後本機工作樹狀態不符（沒有新 commit 或不乾淨），這一圈不採用；請到 worktree 檢查",
          parsed.skipped,
        ),
      );
    return done({
      kind: "fixed",
      fixed: parsed.fixed,
      skipped: parsed.skipped,
      headBefore: before.head,
      headAfter: after.head,
      files,
      sensitivePaths: sensitivePathsIn(files),
    });
  } catch (error) {
    // 派工前的例外（身分不符、紀錄失敗…）與本機流程一樣往外丟，但遠端資源要清掉。
    reason = "before_dispatch_failure";
    throw error;
  } finally {
    await role.cleanup(reason).catch((error: unknown) => {
      console.error(`remote fixer ${machineId}: 清理失敗：${message(error)}`);
    });
  }

  function done(outcome: FixOutcome): FixFlowResult {
    return {
      ok: true,
      fixerKind: launch!.kind,
      outcome,
      closed: reason === "completed",
      ...(reason === "blocked" || reason === "timeout"
        ? { closeNote: "遠端 workspace 與目錄已保留，請人檢查（cleanup_pending）" }
        : {}),
    };
  }
}
