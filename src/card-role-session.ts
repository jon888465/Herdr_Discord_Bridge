import type { AgentProfile } from "./agent-pool.js";
import { doneAsReady, waitUntilReady } from "./agent-ready.js";
import type { AgentStartPort } from "./agent-start.js";
import { closeReviewerPane } from "./review-pane.js";
import { assertFreshProfile, machineOfActor } from "./card-role-assignment.js";
import { hasAgentSession, sameAgentSession } from "./response-stream.js";
import type { AgentRecord } from "./types.js";

export function assertReadyIdentity(
  started: AgentRecord,
  ready: AgentRecord,
  kind: string,
  workspace: string,
): void {
  if (
    ready.pane_id !== started.pane_id ||
    ready.terminal_id !== started.terminal_id ||
    ready.workspace_id !== workspace ||
    ready.agent !== kind ||
    machineOfActor(ready) !== "local" ||
    (hasAgentSession(started.agent_session) &&
      !sameAgentSession(started.agent_session, ready.agent_session))
  )
    throw new Error(
      "卡片角色派工前身分已改變（machine／agent／pane／terminal／session）",
    );
}
export type RoleCleanupReason =
  "before_dispatch_failure" | "completed" | "blocked" | "timeout" | "uncertain";
/** A fresh launch per assignment: no persistent binding, no reused model/session. */
const launchQueues = new WeakMap<object, Promise<void>>();
export async function startCardRoleSession(
  port: AgentStartPort & {
    startProfile(
      lead: AgentRecord,
      profile: AgentProfile,
      name: string,
      onPane: (id: string, terminalId?: string) => void,
    ): Promise<AgentRecord>;
  },
  lead: AgentRecord,
  profile: AgentProfile,
  name: string,
) {
  assertFreshProfile(profile);
  let created: string | undefined;
  let owned: { paneId: string; terminalId: string } | undefined;
  let keepPane = false;
  const cleanup = async (reason: RoleCleanupReason = "completed") => {
    if (!owned) return;
    if (
      reason === "blocked" ||
      reason === "timeout" ||
      reason === "uncertain"
    ) {
      console.error(
        `Card role pane ${owned.paneId} retained (${reason}); task stop/cleanup rules apply`,
      );
      return;
    }
    const result = await closeReviewerPane(port, owned);
    if (!result.closed)
      console.error(`卡片角色 pane 保留 ${owned.paneId}：${result.note}`);
  };
  try {
    const launch = (launchQueues.get(port) ?? Promise.resolve()).then(() =>
      port.startProfile(lead, profile, name, (id, terminalId) => {
        created = id;
        if (terminalId) owned = { paneId: id, terminalId };
      }),
    );
    launchQueues.set(
      port,
      launch.then(
        () => {},
        () => {},
      ),
    );
    const started = await launch;
    if (!owned || owned.terminalId !== started.terminal_id)
      throw new Error("卡片角色啟動 terminal 與建立時不符");
    if (!created || created !== started.pane_id)
      throw new Error("卡片角色啟動 pane 不符");
    const ready = await waitUntilReady(
      { panePort: doneAsReady(port) },
      owned,
      started,
    );
    if (!ready.ok) {
      keepPane = true; // No verified stop: preserve blocked/initializing/unobservable sessions.
      throw new Error(ready.reason);
    }
    const live = (await port.listAgentsWithWorkspaceNames()).find(
      (a) => a.pane_id === started.pane_id,
    );
    if (!live) throw new Error("卡片角色就緒後 pane 已不存在");
    assertReadyIdentity(started, live, profile.kind, lead.workspace_id);
    ready.agent = live;
    if (
      profile.model &&
      ready.agent.model &&
      ready.agent.model !== profile.model
    )
      throw new Error("卡片角色實際 model 與啟動指定不符");
    const agent: AgentRecord = {
      ...ready.agent,
      profileId: profile.id,
      ...(profile.model
        ? { model: profile.model, modelEvidence: "launch" }
        : ready.agent.model
          ? { modelEvidence: "observed" }
          : {}),
    };
    return { agent, continuity: "new-session", cleanup };
  } catch (error) {
    // Without the creation-time terminal identity closing could destroy a replacement.
    if (owned && !keepPane) await cleanup();
    else if (owned)
      console.error(
        `Card role pane ${owned.paneId} readiness not confirmed; retained for manual inspection`,
      );
    else if (created)
      console.error(
        `卡片角色啟動失敗；pane ${created} 身分不明，保留供人工檢查`,
      );
    throw error;
  }
}
