import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentRecord,
  ApprovalRecord,
  PersistedRoutingState,
  RoutingContext,
  TargetMapping,
} from "./types.js";

const EMPTY_STATE: PersistedRoutingState = {
  threadMappings: {},
  userMappings: {},
  channelDefaults: {},
  approvals: {},
};

export class RoutingStore {
  private state: PersistedRoutingState;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly maxApprovals = 256,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = loadState(filePath);
    this.pruneExpired();
  }

  resolve(context: RoutingContext): TargetMapping | undefined {
    const thread = context.threadId
      ? this.state.threadMappings[
          threadKey(context.guildId, context.channelId, context.threadId)
        ]
      : undefined;
    if (thread) return thread;
    const user =
      this.state.userMappings[userKey(context.guildId, context.userId)];
    if (user) return user;
    return this.state.channelDefaults[
      channelKey(context.guildId, context.channelId)
    ];
  }

  bind(
    context: RoutingContext,
    target: Omit<
      TargetMapping,
      | "discordGuildId"
      | "discordChannelId"
      | "discordThreadId"
      | "discordUserId"
      | "createdAt"
      | "updatedAt"
    >,
  ): TargetMapping {
    const current = this.resolve(context);
    const timestamp = this.now().toISOString();
    const mapping: TargetMapping = {
      ...target,
      discordGuildId: context.guildId,
      discordChannelId: context.channelId,
      ...(context.threadId ? { discordThreadId: context.threadId } : {}),
      ...(context.userId ? { discordUserId: context.userId } : {}),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (context.threadId)
      this.state.threadMappings[
        threadKey(context.guildId, context.channelId, context.threadId)
      ] = mapping;
    else
      this.state.userMappings[userKey(context.guildId, context.userId)] =
        mapping;
    this.scheduleSave();
    return mapping;
  }

  bindThread(
    context: RoutingContext,
    threadId: string,
    target: Omit<
      TargetMapping,
      | "discordGuildId"
      | "discordChannelId"
      | "discordThreadId"
      | "discordUserId"
      | "createdAt"
      | "updatedAt"
    >,
  ): TargetMapping {
    const threadContext = { ...context, threadId };
    return this.bind(threadContext, target);
  }

  setChannelDefault(
    context: RoutingContext,
    target: Omit<
      TargetMapping,
      | "discordGuildId"
      | "discordChannelId"
      | "discordThreadId"
      | "discordUserId"
      | "createdAt"
      | "updatedAt"
    >,
  ): TargetMapping {
    const timestamp = this.now().toISOString();
    const key = channelKey(context.guildId, context.channelId);
    const old = this.state.channelDefaults[key];
    const mapping: TargetMapping = {
      ...target,
      discordGuildId: context.guildId,
      discordChannelId: context.channelId,
      createdAt: old?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.state.channelDefaults[key] = mapping;
    this.scheduleSave();
    return mapping;
  }

  createApproval(
    input: Omit<
      ApprovalRecord,
      "token" | "createdAt" | "active" | "expiresAt"
    > & { timeoutMs: number },
  ): ApprovalRecord {
    this.pruneExpired();
    const createdAt = this.now();
    const approval: ApprovalRecord = {
      ...input,
      token: crypto.randomBytes(18).toString("base64url"),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.timeoutMs).toISOString(),
      active: true,
    };
    delete (approval as ApprovalRecord & { timeoutMs?: number }).timeoutMs;
    const approvals = Object.values(this.state.approvals).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    while (approvals.length >= this.maxApprovals) {
      const oldest = approvals.shift();
      if (oldest) delete this.state.approvals[oldest.token];
    }
    this.state.approvals[approval.token] = approval;
    this.scheduleSave();
    return approval;
  }

  getApproval(
    token: string,
    context: RoutingContext,
  ): ApprovalRecord | undefined {
    this.pruneExpired();
    const approval = this.state.approvals[token];
    if (!approval || !approval.active) return undefined;
    if (
      approval.discordGuildId !== context.guildId ||
      approval.discordChannelId !== context.channelId
    )
      return undefined;
    if (context.threadId && approval.discordThreadId !== context.threadId)
      return undefined;
    return approval;
  }

  getApprovalForThread(context: RoutingContext): ApprovalRecord | undefined {
    this.pruneExpired();
    return Object.values(this.state.approvals).find(
      (approval) =>
        approval.active &&
        approval.discordGuildId === context.guildId &&
        approval.discordChannelId === context.channelId &&
        approval.discordThreadId === context.threadId,
    );
  }

  deactivateApproval(token: string): void {
    const approval = this.state.approvals[token];
    if (!approval) return;
    approval.active = false;
    this.scheduleSave();
  }

  deactivateForTerminal(terminalId: string): ApprovalRecord[] {
    const changed: ApprovalRecord[] = [];
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.active && approval.terminalId === terminalId) {
        approval.active = false;
        changed.push(approval);
      }
    }
    if (changed.length) this.scheduleSave();
    return changed;
  }

  allMappings(): TargetMapping[] {
    return [
      ...Object.values(this.state.threadMappings),
      ...Object.values(this.state.userMappings),
      ...Object.values(this.state.channelDefaults),
    ];
  }

  allApprovals(): ApprovalRecord[] {
    this.pruneExpired();
    return Object.values(this.state.approvals);
  }

  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    saveState(this.filePath, this.state);
  }

  private pruneExpired(): void {
    const now = this.now().getTime();
    let changed = false;
    for (const [token, approval] of Object.entries(this.state.approvals)) {
      if (Date.parse(approval.expiresAt) <= now) {
        delete this.state.approvals[token];
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        saveState(this.filePath, this.state);
      } catch (error) {
        console.error(
          "routing state could not be saved:",
          error instanceof Error ? error.message : "unknown error",
        );
      }
    }, 25);
    this.writeTimer.unref();
  }
}

export function threadKey(
  guildId: string,
  channelId: string,
  threadId: string,
): string {
  return `${guildId}:${channelId}:${threadId}`;
}

export function userKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function channelKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function loadState(filePath: string): PersistedRoutingState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<PersistedRoutingState>;
    return {
      threadMappings: parsed.threadMappings ?? {},
      userMappings: parsed.userMappings ?? {},
      channelDefaults: parsed.channelDefaults ?? {},
      approvals: parsed.approvals ?? {},
    };
  } catch {
    return cloneEmptyState();
  }
}

function saveState(filePath: string, state: PersistedRoutingState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function cloneEmptyState(): PersistedRoutingState {
  return JSON.parse(JSON.stringify(EMPTY_STATE)) as PersistedRoutingState;
}

export function agentMatches(agent: AgentRecord, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    agent.name,
    agent.agent_name,
    agent.agent,
    agent.display_agent,
    agent.pane_id,
    agent.terminal_id,
    agent.terminal_title_stripped,
    agent.title,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase() === normalized);
}

export function findAgent(agents: AgentRecord[], query: string): AgentRecord {
  const matches = agents.filter((agent) => agentMatches(agent, query));
  if (matches.length === 0)
    throw new Error(`agent '${query}' was not found or its pane is closed`);
  if (matches.length > 1)
    throw new Error(`agent '${query}' is ambiguous; use its pane id`);
  return matches[0];
}

export function validateAgentTarget(
  agent: AgentRecord,
  mapping: TargetMapping | undefined,
  allowedWorkspaceIds: string[],
): void {
  if (
    allowedWorkspaceIds.length > 0 &&
    !allowedWorkspaceIds.includes(agent.workspace_id)
  ) {
    throw new Error("that workspace is not authorized for this bridge");
  }
  if (mapping && mapping.workspaceId !== agent.workspace_id) {
    throw new Error(
      "the mapped workspace no longer contains this agent (stale mapping)",
    );
  }
}
