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
  threadRoutes: {},
  userMappings: {},
  channelDefaults: {},
  approvals: {},
};

type TargetInput = Omit<
  TargetMapping,
  | "discordGuildId"
  | "discordChannelId"
  | "discordThreadId"
  | "discordUserId"
  | "createdAt"
  | "updatedAt"
>;

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
    const route = context.threadId
      ? this.state.threadRoutes[
          threadKey(context.guildId, context.channelId, context.threadId)
        ]
      : undefined;
    const thread = route?.activeAgentKey
      ? route.agents[route.activeAgentKey]
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
    target: TargetInput,
    options: { activate?: boolean } = {},
  ): TargetMapping {
    const timestamp = this.now().toISOString();
    const mapping: TargetMapping = {
      ...target,
      discordGuildId: context.guildId,
      discordChannelId: context.channelId,
      ...(context.threadId ? { discordThreadId: context.threadId } : {}),
      ...(context.userId ? { discordUserId: context.userId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (context.threadId) {
      const key = threadKey(
        context.guildId,
        context.channelId,
        context.threadId,
      );
      const route = this.state.threadRoutes[key] || { agents: {} };
      const targetKey = mappingKey(target);
      const previous = route.agents[targetKey];
      route.agents[targetKey] = {
        ...mapping,
        createdAt: previous?.createdAt ?? timestamp,
      };
      if (options.activate !== false || !route.activeAgentKey)
        route.activeAgentKey = targetKey;
      this.state.threadRoutes[key] = route;
      this.scheduleSave();
      return route.agents[targetKey];
    } else {
      this.state.userMappings[userKey(context.guildId, context.userId)] =
        mapping;
    }
    this.scheduleSave();
    return mapping;
  }

  bindThread(
    context: RoutingContext,
    threadId: string,
    target: TargetInput,
    options: { activate?: boolean } = {},
  ): TargetMapping {
    const threadContext = { ...context, threadId };
    return this.bind(threadContext, target, options);
  }

  setChannelDefault(
    context: RoutingContext,
    target: TargetInput,
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

  threadTargets(context: RoutingContext): TargetMapping[] {
    if (!context.threadId) return [];
    const route =
      this.state.threadRoutes[
        threadKey(context.guildId, context.channelId, context.threadId)
      ];
    return route ? Object.values(route.agents) : [];
  }

  removeThreadTarget(context: RoutingContext, target: TargetMapping): boolean {
    if (!context.threadId) return false;
    const key = threadKey(context.guildId, context.channelId, context.threadId);
    const route = this.state.threadRoutes[key];
    if (!route) return false;
    const targetKey = mappingKey(target);
    if (!route.agents[targetKey]) return false;
    delete route.agents[targetKey];
    if (route.activeAgentKey === targetKey) {
      route.activeAgentKey = Object.keys(route.agents)[0];
    }
    if (Object.keys(route.agents).length === 0)
      delete this.state.threadRoutes[key];
    this.scheduleSave();
    return true;
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
      ...Object.values(this.state.threadRoutes).flatMap((route) =>
        Object.values(route.agents),
      ),
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
    const threadRoutes = parsed.threadRoutes ?? {};
    const legacyMappings =
      (
        parsed as Partial<PersistedRoutingState> & {
          threadMappings?: Record<string, TargetMapping>;
        }
      ).threadMappings ?? {};
    for (const [key, mapping] of Object.entries(legacyMappings)) {
      if (threadRoutes[key]) continue;
      const targetKey = mappingKey(mapping);
      threadRoutes[key] = {
        activeAgentKey: targetKey,
        agents: { [targetKey]: mapping },
      };
    }
    return {
      threadRoutes,
      userMappings: parsed.userMappings ?? {},
      channelDefaults: parsed.channelDefaults ?? {},
      approvals: parsed.approvals ?? {},
    };
  } catch {
    return cloneEmptyState();
  }
}

export function mappingKey(
  target: Pick<TargetMapping, "workspaceId" | "agentName" | "paneId">,
): string {
  return (
    target.paneId || `${target.workspaceId}:${target.agentName || "unknown"}`
  );
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
