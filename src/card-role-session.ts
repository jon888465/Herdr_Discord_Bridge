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
  /** 只有卡片 remote reviewer 會傳遠端 machine；其餘一律 local。 */
  machine = "local",
): void {
  // 列出是哪些欄位對不上（ISSUE-171 遠端 fixer 實機驗收遇到這個錯誤卻看不出原因）；只含 id／種類，不含內容。
  const changed: string[] = [];
  if (ready.pane_id !== started.pane_id)
    changed.push(`pane ${started.pane_id} → ${ready.pane_id}`);
  if (ready.terminal_id !== started.terminal_id)
    changed.push(`terminal ${started.terminal_id} → ${ready.terminal_id}`);
  if (ready.workspace_id !== workspace)
    changed.push(`workspace ${workspace} → ${ready.workspace_id}`);
  if (ready.agent !== kind) changed.push(`agent ${kind} → ${ready.agent}`);
  if (machineOfActor(ready) !== machine)
    changed.push(`machine ${machine} → ${machineOfActor(ready)}`);
  if (
    hasAgentSession(started.agent_session) &&
    !sameAgentSession(started.agent_session, ready.agent_session)
  )
    changed.push(
      `session ${hasAgentSession(ready.agent_session) ? "已換" : "消失"}`,
    );
  if (changed.length)
    throw new Error(
      `卡片角色派工前身分已改變（machine／agent／pane／terminal／session）：${changed.join("；")}`,
    );
}
export type RoleCleanupReason =
  "before_dispatch_failure" | "completed" | "blocked" | "timeout" | "uncertain";
/** A fresh launch per assignment: no persistent binding, no reused model/session. */
const launchQueues = new WeakMap<object, Promise<void>>();
export async function startFreshProfileSession(
  port: AgentStartPort & {
    startProfile(
      lead: AgentRecord,
      profile: AgentProfile,
      name: string,
      onPane: (id: string, terminalId?: string) => void,
      onStarting?: () => void,
      beforeLaunch?: () => void,
    ): Promise<AgentRecord>;
  },
  lead: AgentRecord,
  profile: AgentProfile,
  name: string,
  options?: {
    beforeCreate: () => void;
    claimPane: (paneId: string, terminalId: string) => void;
    afterCreate: () => void;
    modelMatches: (model: string) => boolean;
    note: (message: string) => void;
    retainLaunchError: (error: unknown) => boolean;
  },
) {
  assertFreshProfile(profile);
  let created: string | undefined;
  let owned: { paneId: string; terminalId: string } | undefined;
  let keepPane = false;
  const note = options?.note ?? console.error;
  const cleanup = async (reason: RoleCleanupReason = "completed") => {
    if (!owned) return;
    if (
      reason === "blocked" ||
      reason === "timeout" ||
      reason === "uncertain"
    ) {
      note(
        `Fresh pane ${owned.paneId} retained (${reason}); task stop/cleanup rules apply`,
      );
      return;
    }
    const result = await closeReviewerPane(port, owned);
    if (!result.closed)
      note(`Fresh pane ${owned.paneId} retained: ${result.note}`);
  };
  try {
    const launch = (launchQueues.get(port) ?? Promise.resolve()).then(() =>
      port.startProfile(
        lead,
        profile,
        name,
        (id, terminalId) => {
          created = id;
          if (terminalId) {
            options?.claimPane(id, terminalId);
            owned = { paneId: id, terminalId };
            options?.afterCreate();
          }
        },
        options?.beforeCreate,
        options?.afterCreate,
      ),
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
      {
        panePort: doneAsReady(port),
        role: "Worker",
        expectedKind: profile.kind,
      },
      owned,
      started.agent_status === "done"
        ? { ...started, agent_status: "idle" }
        : started,
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
      !(
        options?.modelMatches(String(ready.agent.model)) ??
        ready.agent.model === profile.model
      )
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
    if (owned && !keepPane && !options?.retainLaunchError(error))
      await cleanup();
    else if (owned)
      note(`Fresh pane ${owned.paneId} retained for manual inspection`);
    else if (created)
      note(`Fresh pane ${created} ownership unconfirmed; inspect manually`);
    throw error;
  }
}

export const startCardRoleSession = startFreshProfileSession;
