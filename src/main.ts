import { loadConfig, statePath } from "./config.js";
import { DiscordAdapter, type CommandContext } from "./discord.js";
import { codeBlock, splitDiscordText, statusEmoji } from "./format.js";
import { HerdrClient } from "./herdr.js";
import {
  AgentWatcher,
  type AgentRemoved,
  type AgentTransition,
} from "./watcher.js";
import {
  agentMatches,
  findAgent,
  RoutingStore,
  validateAgentTarget,
} from "./routing.js";
import type {
  AgentRecord,
  ApprovalRecord,
  TargetMapping,
  WorkspaceRecord,
} from "./types.js";
import { agentLabel, workspacePath } from "./types.js";

export async function run(): Promise<void> {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  const herdr = new HerdrClient(
    undefined,
    config.requestTimeoutMs,
    config.reconnectBaseMs,
  );
  const routing = new RoutingStore(
    statePath(config),
    config.maxTrackedApprovals,
  );
  const discord = new DiscordAdapter(
    config.discord,
    routing,
    config.approvalTimeoutMs,
  );
  const activeStreams = new Set<string>();

  if (!(await herdr.ping())) {
    throw new Error(
      "Herdr socket is not reachable; the bridge cannot control agents. Herdr itself is left untouched.",
    );
  }
  if (dryRun) {
    const watcher = new AgentWatcher(herdr, config.pollIntervalMs);
    watcher.on("transition", (transition: AgentTransition) => {
      if (config.notifyOn.includes(transition.to)) {
        console.log(
          `${transition.from} -> ${transition.to} ${transition.agent.pane_id}`,
        );
      }
    });
    watcher.on("error", (error) =>
      console.error(`Herdr watch unavailable: ${safeError(error)}`),
    );
    watcher.start();
    installShutdown(() => watcher.stop(), routing);
    console.log(
      "herdr-discord-bridge: dry-run; no Discord messages will be sent",
    );
    return;
  }
  if (!config.discord.enabled)
    throw new Error(
      "Discord is disabled or its bot token is missing in plugin config/env",
    );
  if (!config.discord.messageContent) {
    throw new Error(
      "Discord messageContent must be enabled because /herdr commands and thread replies use Gateway message content",
    );
  }

  discord.onCommand(async (context, command, args) => {
    try {
      await handleCommand(command, args, context, {
        config,
        herdr,
        routing,
        discord,
        activeStreams,
      });
    } catch (error) {
      await discord.reply(context.message, `❌ ${safeError(error)}`);
    }
  });
  discord.onApproval(async (approval, text, userId) => {
    if (
      !config.discord.allowedUserIds.length ||
      config.discord.allowedUserIds.includes(userId)
    ) {
      await deliverApproval(approval, text, herdr, routing);
    } else {
      throw new Error("you are not authorized to control this agent");
    }
  });
  discord.onPrompt(async (context, text) => {
    try {
      await promptMappedAgent(text, context, {
        config,
        herdr,
        routing,
        discord,
        activeStreams,
      });
    } catch (error) {
      await discord.reply(context.message, `❌ ${safeError(error)}`);
    }
  });
  await discord.start();

  const watcher = new AgentWatcher(herdr, config.pollIntervalMs);
  watcher.on("transition", (transition: AgentTransition) => {
    void handleTransition(transition, { config, herdr, routing, discord });
  });
  watcher.on("removed", (removed: AgentRemoved) => {
    void handleRemoved(removed, { routing, discord });
  });
  watcher.on("error", (error) =>
    console.error(`Herdr watch unavailable: ${safeError(error)}`),
  );
  watcher.start();
  installShutdown(() => {
    watcher.stop();
    void discord.stop();
  }, routing);
  console.log(
    "herdr-discord-bridge: Discord Gateway connected and Herdr watcher started",
  );
}

interface Runtime {
  config: ReturnType<typeof loadConfig>;
  herdr: HerdrClient;
  routing: RoutingStore;
  discord: DiscordAdapter;
  activeStreams: Set<string>;
}

async function handleCommand(
  command: string,
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  switch (command) {
    case "help":
      await runtime.discord.reply(
        context.message,
        helpText(runtime.config.discord.commandPrefix),
      );
      return;
    case "workspaces":
      await listWorkspaces(context, runtime);
      return;
    case "use":
      await useWorkspace(args, context, runtime);
      return;
    case "target":
      await targetAgent(args, context, runtime);
      return;
    case "current":
      await currentTarget(context, runtime);
      return;
    case "agents":
      await listAgents(args, context, runtime);
      return;
    case "status":
      await status(context, runtime);
      return;
    case "assign":
      await assignAgent(args, context, runtime);
      return;
    case "read":
      await readAgent(args, context, runtime);
      return;
    case "wait":
      await waitAgent(args, context, runtime);
      return;
    case "cancel":
      await cancelAgent(args, context, runtime);
      return;
    default:
      throw new Error(
        `unknown command '${command}'. Try ${runtime.config.discord.commandPrefix} help`,
      );
  }
}

async function listWorkspaces(
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const workspaces = await allowedWorkspaces(
    runtime.herdr,
    runtime.config.allowedWorkspaceIds,
  );
  if (workspaces.length === 0) {
    await runtime.discord.reply(
      context.message,
      "No authorized Herdr workspaces are visible.",
    );
    return;
  }
  const agents = await runtime.herdr.listAgents();
  const lines = workspaces.map((workspace) => {
    const id = workspace.workspace_id;
    const label = workspace.label || workspace.name || "(unnamed)";
    const pathName = workspacePath(workspace) || "(path unavailable)";
    const members =
      agents
        .filter((agent) => agent.workspace_id === id)
        .map((agent) => `${agentLabel(agent)}:${agent.agent_status}`)
        .join(", ") || "no agents";
    return `${statusEmoji(workspaceState(agents, id))} **${label}** — \`${id}\`\n${pathName}\nAgents: ${members}`;
  });
  await runtime.discord.reply(context.message, lines.join("\n\n"));
}

async function useWorkspace(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const selector = args.join(" ").trim();
  if (!selector || selector.includes("/") || selector.includes("\\"))
    throw new Error(
      "provide a workspace id or label from /herdr workspaces; filesystem paths are not accepted",
    );
  const workspaces = await allowedWorkspaces(
    runtime.herdr,
    runtime.config.allowedWorkspaceIds,
  );
  const matches = workspaces.filter(
    (workspace) =>
      workspace.workspace_id === selector ||
      workspace.label === selector ||
      workspace.name === selector,
  );
  if (matches.length === 0)
    throw new Error(
      `workspace '${selector}' was not found or is not authorized`,
    );
  if (matches.length > 1)
    throw new Error(
      `workspace '${selector}' is ambiguous; use its Herdr workspace id`,
    );
  const workspace = matches[0];
  const mapping = runtime.routing.bind(context.routing, {
    workspaceId: workspace.workspace_id,
  });
  await runtime.discord.reply(
    context.message,
    `✅ Routing for this ${context.routing.threadId ? "thread" : "user"} now targets **${workspace.label || workspace.name || workspace.workspace_id}** (\`${mapping.workspaceId}\`). Existing agents were not moved or restarted.`,
  );
}

async function targetAgent(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const query = args.join(" ").trim();
  if (!query) throw new Error("usage: /herdr target <agent-name-or-pane-id>");
  const agent = findAgent(await runtime.herdr.listAgents(), query);
  validateAgentTarget(agent, undefined, runtime.config.allowedWorkspaceIds);
  runtime.routing.bind(context.routing, {
    workspaceId: agent.workspace_id,
    agentName: agentLabel(agent),
    paneId: agent.pane_id,
  });
  await runtime.discord.reply(
    context.message,
    `🎯 This ${context.routing.threadId ? "thread" : "user"} now talks to **${agentLabel(agent)}** in workspace \`${agent.workspace_id}\` / pane \`${agent.pane_id}\`. Subsequent non-command messages in this thread will be sent only to this agent.`,
  );
}

async function currentTarget(
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const mapping = runtime.routing.resolve(context.routing);
  if (!mapping) {
    await runtime.discord.reply(
      context.message,
      "No routing is selected. Use `/herdr workspaces`, then `/herdr use <workspace>`.",
    );
    return;
  }
  const agents = await runtime.herdr.listAgents();
  const agent = mapping.paneId
    ? agents.find((candidate) => candidate.pane_id === mapping.paneId)
    : undefined;
  const workspace = (
    await allowedWorkspaces(runtime.herdr, runtime.config.allowedWorkspaceIds)
  ).find((item) => item.workspace_id === mapping.workspaceId);
  const target = agent
    ? `${agentLabel(agent)} · ${agent.pane_id} · ${agent.agent_status}`
    : mapping.paneId
      ? "stale agent/pane mapping"
      : "agent not selected";
  await runtime.discord.reply(
    context.message,
    `Workspace: **${workspace?.label || mapping.workspaceId}** (\`${mapping.workspaceId}\`)\nPath: ${workspace ? workspacePath(workspace) || "unavailable" : "unavailable"}\nAgent: ${target}\nMapping: ${context.routing.threadId ? "thread" : "user"} precedence`,
  );
}

async function listAgents(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const mapping = runtime.routing.resolve(context.routing);
  const agents = (await runtime.herdr.listAgents()).filter(
    (agent) =>
      runtime.config.allowedWorkspaceIds.length === 0 ||
      runtime.config.allowedWorkspaceIds.includes(agent.workspace_id),
  );
  const requestedWorkspace = args.join(" ").trim();
  const visible = requestedWorkspace
    ? agents.filter(
        (agent) =>
          agent.workspace_id === requestedWorkspace ||
          agent.workspace_name === requestedWorkspace,
      )
    : mapping
      ? agents.filter((agent) => agent.workspace_id === mapping.workspaceId)
      : agents;
  if (visible.length === 0) {
    await runtime.discord.reply(
      context.message,
      "No authorized agents matched the request.",
    );
    return;
  }
  const output = visible
    .map(
      (agent) =>
        `${statusEmoji(agent.agent_status)} **${agentLabel(agent)}** — pane \`${agent.pane_id}\`, workspace \`${agent.workspace_id}\`, **${agent.agent_status}**`,
    )
    .join("\n");
  await runtime.discord.reply(context.message, output);
}

async function status(
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const reachable = await runtime.herdr.ping();
  const mappings = runtime.routing.allMappings().length;
  const approvals = runtime.routing
    .allApprovals()
    .filter((approval) => approval.active).length;
  await runtime.discord.reply(
    context.message,
    `${reachable ? "🟢" : "🔴"} Herdr socket: ${reachable ? "reachable" : "unreachable"}\nRouting mappings: ${mappings}\nPending approvals: ${approvals}`,
  );
}

async function assignAgent(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const query = args.shift()?.trim();
  const prompt = args.join(" ").trim();
  if (!query || !prompt)
    throw new Error("usage: /herdr assign <agent-name-or-pane-id> <prompt>");
  if (prompt.length > 12000 || prompt.includes("\u0000"))
    throw new Error(
      "prompt is empty, contains an invalid character, or is too long",
    );
  const mapping = runtime.routing.resolve(context.routing);
  const agent = findAgent(await runtime.herdr.listAgents(), query);
  validateAgentTarget(agent, mapping, runtime.config.allowedWorkspaceIds);
  if (
    agent.agent_status === "working" ||
    runtime.activeStreams.has(agent.terminal_id)
  )
    throw new Error(
      `agent is busy (${agent.pane_id}); wait for it to settle before assigning another prompt`,
    );
  const target = runtime.routing.bind(context.routing, {
    workspaceId: agent.workspace_id,
    agentName: agentLabel(agent),
    paneId: agent.pane_id,
  });
  await dispatchPrompt(
    agent,
    prompt,
    context,
    runtime,
    `📨 Assigned to **${target.agentName || query}** in \`${target.workspaceId}\` / \`${agent.pane_id}\`. Herdr is running the prompt.`,
  );
}

async function promptMappedAgent(
  prompt: string,
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  if (prompt.length > 12000 || prompt.includes("\u0000"))
    throw new Error(
      "prompt is empty, contains an invalid character, or is too long",
    );
  const agent = await resolveContextAgent("", context, runtime);
  await dispatchPrompt(
    agent,
    prompt,
    context,
    runtime,
    `📨 Sent to **${agentLabel(agent)}** in \`${agent.workspace_id}\` / \`${agent.pane_id}\`.`,
  );
}

async function dispatchPrompt(
  agent: AgentRecord,
  prompt: string,
  context: CommandContext,
  runtime: Runtime,
  acknowledgement: string,
): Promise<void> {
  if (
    agent.agent_status === "working" ||
    runtime.activeStreams.has(agent.terminal_id)
  )
    throw new Error(
      `agent is busy (${agent.pane_id}); wait for it to settle before assigning another prompt`,
    );
  const progress = await runtime.discord.reply(
    context.message,
    acknowledgement,
  );
  await runtime.herdr.promptAgent(agent.pane_id, prompt);
  runtime.activeStreams.add(agent.terminal_id);
  void streamAgent(agent, progress, runtime).finally(() =>
    runtime.activeStreams.delete(agent.terminal_id),
  );
}

async function readAgent(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const agent = await resolveContextAgent(
    args.join(" ").trim(),
    context,
    runtime,
  );
  const output = await runtime.herdr.readAgent(
    agent.pane_id,
    "recent_unwrapped",
    runtime.config.outputLines,
  );
  await runtime.discord.reply(
    context.message,
    `${statusEmoji(agent.agent_status)} ${agentLabel(agent)} / \`${agent.pane_id}\`\n${codeBlock(output || "(no output)")}`,
  );
}

async function waitAgent(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const query = args.join(" ").trim();
  const agent = await resolveContextAgent(query, context, runtime);
  const result = await runtime.herdr.waitAgent(agent.pane_id);
  await runtime.discord.reply(
    context.message,
    `${statusEmoji(result?.agent_status || "unknown")} ${result ? agentLabel(result) : agentLabel(agent)} is **${result?.agent_status || "unknown"}**`,
  );
}

async function cancelAgent(
  args: string[],
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const agent = await resolveContextAgent(
    args.join(" ").trim(),
    context,
    runtime,
  );
  await runtime.herdr.cancelAgent(agent.pane_id);
  await runtime.discord.reply(
    context.message,
    `🛑 Sent Ctrl-C through Herdr's official agent API to \`${agent.pane_id}\`.`,
  );
}

async function resolveContextAgent(
  query: string,
  context: CommandContext,
  runtime: Runtime,
): Promise<AgentRecord> {
  const mapping = runtime.routing.resolve(context.routing);
  const agents = await runtime.herdr.listAgents();
  const agent = query
    ? findAgent(agents, query)
    : mapping?.paneId
      ? agents.find((item) => item.pane_id === mapping.paneId)
      : undefined;
  if (!agent)
    throw new Error(
      "no live agent target; specify an agent name/pane id or set a routing target with /herdr use",
    );
  validateAgentTarget(agent, mapping, runtime.config.allowedWorkspaceIds);
  return agent;
}

async function streamAgent(
  initial: AgentRecord,
  progress: import("discord.js").Message,
  runtime: Runtime,
): Promise<void> {
  const started = Date.now();
  let lastOutput = "";
  let sawWorking = false;
  let settledPolls = 0;
  while (Date.now() - started < 86400000) {
    await new Promise((resolve) =>
      setTimeout(resolve, runtime.config.streamIntervalMs),
    );
    let agents: AgentRecord[];
    try {
      agents = await runtime.herdr.listAgents();
    } catch {
      continue;
    }
    const current = agents.find(
      (agent) =>
        agent.terminal_id === initial.terminal_id ||
        agent.pane_id === initial.pane_id,
    );
    if (!current) {
      await runtime.discord.editProgress(
        progress,
        "⚫ Agent exited or pane closed while the prompt was running.",
      );
      return;
    }
    if (current.agent_status === "working") sawWorking = true;
    try {
      const output = await runtime.herdr.readAgent(
        current.pane_id,
        "recent_unwrapped",
        runtime.config.outputLines,
      );
      if (output && output !== lastOutput) {
        lastOutput = output;
        const preview = splitDiscordText(output, 1650)[0];
        await runtime.discord.editProgress(
          progress,
          `${statusEmoji(current.agent_status)} **${current.agent_status}**\n${codeBlock(preview)}`,
        );
      }
    } catch {
      // The watcher and next stream tick will retry; this does not stop Herdr.
    }
    if (current.agent_status === "working") settledPolls = 0;
    else settledPolls += 1;
    if (
      settledPolls >= (sawWorking ? 2 : 4) ||
      current.agent_status === "blocked"
    ) {
      await runtime.discord.editProgress(
        progress,
        `${statusEmoji(current.agent_status)} Prompt finished with **${current.agent_status}**.\n${codeBlock(splitDiscordText(lastOutput || "(no output)", 1650)[0])}`,
      );
      if (lastOutput && splitDiscordText(lastOutput).length > 1)
        await runtime.discord.postOutput(
          progress,
          `Final output for \`${current.pane_id}\`:\n${codeBlock(lastOutput)}`,
        );
      return;
    }
  }
  await runtime.discord.editProgress(
    progress,
    "⏱️ Prompt is still running; use `/herdr read <agent>` for the latest output.",
  );
}

async function handleTransition(
  transition: AgentTransition,
  runtime: Pick<Runtime, "config" | "herdr" | "routing" | "discord">,
): Promise<void> {
  const closed = runtime.routing.deactivateForTerminal(
    transition.agent.terminal_id,
  );
  for (const approval of closed) {
    if (transition.to !== "blocked")
      await runtime.discord.postRecovery(approval, transition.to);
  }
  if (!runtime.config.notifyOn.includes(transition.to)) return;
  const target = bestMapping(transition.agent, runtime.routing.allMappings());
  if (!target) return;
  const context =
    transition.to === "blocked"
      ? await runtime.herdr
          .readAgent(
            transition.agent.pane_id,
            "detection",
            runtime.config.outputLines,
          )
          .catch(() => "")
      : "";
  await runtime.discord
    .postAgentTransition(transition.agent, context, target)
    .catch((error) =>
      console.error(`Discord notification failed: ${safeError(error)}`),
    );
}

async function handleRemoved(
  removed: AgentRemoved,
  runtime: Pick<Runtime, "routing" | "discord">,
): Promise<void> {
  for (const approval of runtime.routing.deactivateForTerminal(
    removed.terminalId,
  ))
    await runtime.discord.postRecovery(approval, "exited");
}

async function deliverApproval(
  approval: ApprovalRecord,
  text: string,
  herdr: HerdrClient,
  routing: RoutingStore,
): Promise<void> {
  const agents = await herdr.listAgents();
  const current = agents.find(
    (agent) =>
      agent.terminal_id === approval.terminalId &&
      agent.pane_id === approval.paneId &&
      agent.workspace_id === approval.workspaceId,
  );
  if (!current) {
    routing.deactivateApproval(approval.token);
    throw new Error(
      "agent exited or the pane mapping is stale; approval was rejected",
    );
  }
  if (current.agent_status !== "blocked") {
    routing.deactivateApproval(approval.token);
    throw new Error(
      `agent is no longer blocked (${current.agent_status}); approval was rejected`,
    );
  }
  await herdr.sendAgent(current.pane_id, text.slice(0, 12000));
  routing.deactivateApproval(approval.token);
}

async function allowedWorkspaces(
  herdr: HerdrClient,
  allowedIds: string[],
): Promise<WorkspaceRecord[]> {
  const all = await herdr.listWorkspaces();
  return allowedIds.length === 0
    ? all
    : all.filter((workspace) => allowedIds.includes(workspace.workspace_id));
}

function bestMapping(
  agent: AgentRecord,
  mappings: TargetMapping[],
): TargetMapping | undefined {
  return mappings
    .filter(
      (mapping) =>
        mapping.workspaceId === agent.workspace_id &&
        (!mapping.paneId || mapping.paneId === agent.pane_id) &&
        (!mapping.agentName || agentMatches(agent, mapping.agentName)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function workspaceState(agents: AgentRecord[], workspaceId: string): string {
  const states = agents
    .filter((agent) => agent.workspace_id === workspaceId)
    .map((agent) => agent.agent_status);
  if (states.includes("blocked")) return "blocked";
  if (states.includes("working")) return "working";
  if (states.includes("done")) return "done";
  return states.length ? "idle" : "unknown";
}

function helpText(prefix: string): string {
  return [
    `**Herdr Discord Bridge**`,
    `${prefix} workspaces`,
    `${prefix} use <workspace-id-or-label>`,
    `${prefix} target <agent-or-pane>`,
    `${prefix} current`,
    `${prefix} agents [workspace-id]`,
    `${prefix} assign <agent-or-pane> <prompt>`,
    `${prefix} read [agent-or-pane]`,
    `${prefix} status`,
    `${prefix} wait [agent-or-pane]`,
    `${prefix} cancel [agent-or-pane]`,
  ].join("\n");
}

function installShutdown(stop: () => void, routing: RoutingStore): void {
  const shutdown = () => {
    stop();
    routing.flush();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}
