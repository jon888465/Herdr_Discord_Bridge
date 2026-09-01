export type AgentStatus =
  "idle" | "working" | "blocked" | "done" | "unknown" | (string & {});

export type ReadSource =
  "visible" | "recent" | "recent_unwrapped" | "detection";

export interface AgentRecord {
  terminal_id: string;
  agent?: string;
  agent_name?: string;
  name?: string;
  display_agent?: string;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_status: AgentStatus;
  workspace_id: string;
  workspace_name?: string;
  tab_id: string;
  pane_id: string;
  focused?: boolean;
  cwd?: string;
  foreground_cwd?: string;
  revision?: number;
  [key: string]: unknown;
}

export interface WorkspaceRecord {
  workspace_id: string;
  label?: string;
  name?: string;
  path?: string;
  cwd?: string;
  worktree?: { checkout_path?: string };
  agents?: AgentRecord[];
  [key: string]: unknown;
}

export interface HerdrErrorShape {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface HerdrResponse<T = unknown> {
  id?: string;
  result?: T;
  error?: HerdrErrorShape;
  [key: string]: unknown;
}

export interface RoutingContext {
  guildId: string;
  channelId: string;
  threadId?: string;
  userId: string;
}

export interface TargetMapping {
  discordGuildId: string;
  discordChannelId: string;
  discordThreadId?: string;
  discordUserId?: string;
  workspaceId: string;
  agentName?: string;
  paneId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  token: string;
  discordGuildId: string;
  discordChannelId: string;
  discordThreadId: string;
  discordMessageId: string;
  terminalId: string;
  workspaceId: string;
  paneId: string;
  agentName: string;
  createdAt: string;
  expiresAt: string;
  active: boolean;
}

export interface PersistedRoutingState {
  threadMappings: Record<string, TargetMapping>;
  userMappings: Record<string, TargetMapping>;
  channelDefaults: Record<string, TargetMapping>;
  approvals: Record<string, ApprovalRecord>;
}

export interface HerdrSnapshot {
  workspaces?: WorkspaceRecord[];
  agents?: AgentRecord[];
  [key: string]: unknown;
}

export const KNOWN_AGENT_STATES: readonly AgentStatus[] = [
  "working",
  "blocked",
  "done",
  "idle",
  "unknown",
];

export function normalizeAgentStatus(value: unknown): AgentStatus {
  if (typeof value !== "string") return "unknown";
  return KNOWN_AGENT_STATES.includes(value as AgentStatus)
    ? (value as AgentStatus)
    : "unknown";
}

export function agentLabel(agent: AgentRecord): string {
  return (
    agent.display_agent ||
    agent.name ||
    agent.agent_name ||
    agent.agent ||
    agent.terminal_title_stripped ||
    agent.title ||
    agent.terminal_id
  );
}

export function workspacePath(workspace: WorkspaceRecord): string | undefined {
  return workspace.path || workspace.cwd || workspace.worktree?.checkout_path;
}
