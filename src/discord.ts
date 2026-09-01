import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  ThreadChannel,
  TextChannel,
} from "discord.js";
import type { DiscordConfig } from "./config.js";
import {
  agentHeader,
  codeBlock,
  splitDiscordText,
  statusEmoji,
  stripAnsi,
} from "./format.js";
import type {
  AgentRecord,
  ApprovalRecord,
  RoutingContext,
  TargetMapping,
} from "./types.js";
import { agentLabel } from "./types.js";
import { RoutingStore } from "./routing.js";

const BUTTON_PREFIX = "hdb.approve.";

export interface CommandContext {
  message: Message;
  routing: RoutingContext;
}

export type CommandHandler = (
  context: CommandContext,
  command: string,
  args: string[],
) => Promise<void>;
export type ApprovalHandler = (
  approval: ApprovalRecord,
  text: string,
  userId: string,
) => Promise<void>;
export type PromptHandler = (
  context: CommandContext,
  text: string,
) => Promise<void>;

export class DiscordAdapter {
  readonly name = "discord";
  private readonly client: Client;
  private readonly ready: Promise<void>;
  private commandHandler: CommandHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private promptHandler: PromptHandler | null = null;

  constructor(
    private readonly config: DiscordConfig,
    private readonly routing: RoutingStore,
    private readonly approvalTimeoutMs = 900000,
  ) {
    const intents = [GatewayIntentBits.Guilds];
    if (config.messageContent)
      intents.push(
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      );
    this.client = new Client({ intents });
    this.ready = new Promise((resolve) =>
      this.client.once(Events.ClientReady, () => resolve()),
    );

    this.client.on(
      Events.MessageCreate,
      (message) => void this.handleMessage(message),
    );
    this.client.on(
      Events.InteractionCreate,
      (interaction) => void this.handleInteraction(interaction),
    );
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  onPrompt(handler: PromptHandler): void {
    this.promptHandler = handler;
  }

  async start(): Promise<void> {
    await this.client.login(this.config.botToken);
    await this.ready;
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  async reply(message: Message, content: string): Promise<Message> {
    const chunks = splitDiscordText(content);
    const first = await message.reply({ content: chunks[0] });
    const channel = message.channel as TextChannel | ThreadChannel;
    for (const chunk of chunks.slice(1)) await channel.send(chunk);
    return first;
  }

  async editProgress(message: Message, content: string): Promise<void> {
    await message.edit({ content: splitDiscordText(content)[0] });
  }

  async postOutput(message: Message, content: string): Promise<void> {
    const channel = message.channel as TextChannel | ThreadChannel;
    for (const chunk of splitDiscordText(content)) await channel.send(chunk);
  }

  async postAgentTransition(
    agent: AgentRecord,
    context: string,
    target: TargetMapping,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(
      target.discordThreadId || target.discordChannelId,
    );
    if (
      !channel ||
      (!(channel instanceof TextChannel) && !(channel instanceof ThreadChannel))
    )
      throw new Error(
        "configured Discord destination is not a text channel or thread",
      );
    const state = agent.agent_status;
    const title = agentLabel(agent) || target.paneId || "unknown agent";
    const identity = agentHeader(
      title,
      agent.workspace_name || agent.workspace_id,
      agent.pane_id,
      agent.agent,
    );
    const header = `${identity}\n${statusEmoji(state)} **${title}** is **${state}**`;
    const body = context ? `\n${codeBlock(stripAnsi(context))}` : "";
    const chunks = splitDiscordText(`${header}${body}`);
    const message = await channel.send(chunks[0]);
    for (const chunk of chunks.slice(1)) await channel.send(chunk);

    if (state !== "blocked") return;
    const thread =
      channel instanceof ThreadChannel
        ? channel
        : await message.startThread({
            name: `↩ ${title}`.slice(0, 90),
            autoArchiveDuration: 1440,
          });
    const approval = this.routing.createApproval({
      discordGuildId: target.discordGuildId,
      discordChannelId: target.discordChannelId,
      discordThreadId: thread.id,
      discordMessageId: message.id,
      terminalId: agent.terminal_id,
      workspaceId: agent.workspace_id,
      paneId: agent.pane_id,
      agentName: agentLabel(agent),
      timeoutMs: this.approvalTimeoutMs,
    });
    this.routing.bindThread(
      {
        guildId: target.discordGuildId,
        channelId: target.discordChannelId,
        threadId: thread.id,
        userId: target.discordUserId || "system",
      },
      thread.id,
      {
        workspaceId: agent.workspace_id,
        agentName: approval.agentName,
        paneId: agent.pane_id,
      },
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}${approval.token}`)
        .setLabel("Approve / continue")
        .setStyle(ButtonStyle.Primary),
    );
    await message.edit({ components: [row] });
    await thread.send(
      "Reply in this thread to answer the agent. The approval button sends `continue`.\n" +
        `This approval expires <t:${Math.floor(Date.parse(approval.expiresAt) / 1000)}:R>.`,
    );
  }

  async postRecovery(approval: ApprovalRecord, status: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(
        approval.discordThreadId,
      );
      if (channel instanceof ThreadChannel) {
        await channel.send(
          `${agentHeader(approval.agentName, approval.workspaceId, approval.paneId)}\n${statusEmoji(status)} Agent is now **${status}**. This approval is closed.`,
        );
      }
    } catch {
      // A deleted or archived Discord thread is safe to ignore.
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const channelId = this.parentChannelId(message);
    if (
      message.author.bot ||
      !message.guildId ||
      !this.isAllowed(message.guildId, channelId, message.author.id)
    )
      return;
    const command = this.parseCommand(message);
    if (command) {
      if (!this.commandHandler) return;
      await this.commandHandler(command.context, command.name, command.args);
      return;
    }
    if (
      !this.config.messageContent ||
      !message.content ||
      !message.channel.isThread()
    )
      return;
    const context = this.contextFor(message, message.channel.id);
    const approval = this.routing.getApprovalForThread(context);
    if (approval && this.approvalHandler) {
      try {
        await this.approvalHandler(
          approval,
          message.content.trim(),
          message.author.id,
        );
      } catch (error) {
        await message.reply(`❌ Approval rejected: ${safeError(error)}`);
      }
      return;
    }
    const prompt = this.parsePrompt(message);
    if (!prompt || !this.promptHandler) return;
    try {
      await this.promptHandler({ message, routing: context }, prompt);
    } catch (error) {
      await message.reply(`❌ Prompt rejected: ${safeError(error)}`);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (
      !interaction.isButton() ||
      !interaction.customId.startsWith(BUTTON_PREFIX)
    )
      return;
    const button = interaction as ButtonInteraction;
    const guildId = button.guildId;
    const buttonChannel = button.channel;
    const parentChannelId = buttonChannel?.isThread()
      ? buttonChannel.parentId || button.channelId
      : button.channelId;
    if (!guildId || !this.isAllowed(guildId, parentChannelId, button.user.id)) {
      await button.reply({
        content: "⛔ You are not authorized to control this agent.",
        ephemeral: true,
      });
      return;
    }
    const token = button.customId.slice(BUTTON_PREFIX.length);
    const approval = this.routing.getApproval(token, {
      guildId,
      channelId: parentChannelId,
      ...(buttonChannel?.isThread() ? { threadId: buttonChannel.id } : {}),
      userId: button.user.id,
    });
    if (
      !approval ||
      approval.discordMessageId !== button.message.id ||
      !this.approvalHandler
    ) {
      await button.reply({
        content: "⌛ This approval is stale, expired, or no longer available.",
        ephemeral: true,
      });
      return;
    }
    try {
      await this.approvalHandler(approval, "continue", button.user.id);
      this.routing.deactivateApproval(approval.token);
      await button.update({
        content: "✅ Approval delivered to the agent.",
        components: [],
      });
    } catch (error) {
      await button.reply({
        content: `❌ Could not deliver approval: ${safeError(error)}`,
        ephemeral: true,
      });
    }
  }

  private parseCommand(
    message: Message,
  ): { context: CommandContext; name: string; args: string[] } | null {
    let content = message.content.trim();
    const mention = this.client.user
      ? new RegExp(`<@!?${this.client.user.id}>`, "g")
      : null;
    const mentioned = mention ? mention.test(content) : false;
    if (mention) content = content.replace(mention, "").trim();
    if (this.config.requireMention && !mentioned) return null;
    if (!content.startsWith(this.config.commandPrefix)) return null;
    const rest = content.slice(this.config.commandPrefix.length).trim();
    if (!rest)
      return {
        context: { message, routing: this.contextFor(message) },
        name: "help",
        args: [],
      };
    const parts = rest.split(/\s+/);
    return {
      context: { message, routing: this.contextFor(message) },
      name: parts[0].toLowerCase(),
      args: parts.slice(1),
    };
  }

  private parsePrompt(message: Message): string | null {
    if (!message.channel.isThread() || !message.content.trim()) return null;
    let content = message.content.trim();
    const mention = this.client.user
      ? new RegExp(`<@!?${this.client.user.id}>`, "g")
      : null;
    const mentioned = mention ? mention.test(content) : false;
    if (mention) content = content.replace(mention, "").trim();
    if (this.config.requireMention && !mentioned) return null;
    if (!content || content.startsWith(this.config.commandPrefix)) return null;
    return content;
  }

  private contextFor(
    message: Message,
    threadId?: string,
  ): CommandContext["routing"] {
    const isThread = message.channel.isThread();
    return {
      guildId: message.guildId || "",
      channelId: isThread
        ? message.channel.parentId || message.channelId
        : message.channelId,
      threadId: threadId || (isThread ? message.channel.id : undefined),
      userId: message.author.id,
    };
  }

  private parentChannelId(message: Message): string {
    return message.channel.isThread()
      ? message.channel.parentId || message.channelId
      : message.channelId;
  }

  private isAllowed(
    guildId: string,
    channelId: string,
    userId: string,
  ): boolean {
    return (
      (this.config.allowedGuildIds.length === 0 ||
        this.config.allowedGuildIds.includes(guildId)) &&
      (this.config.allowedChannelIds.length === 0 ||
        this.config.allowedChannelIds.includes(channelId)) &&
      (this.config.allowedUserIds.length === 0 ||
        this.config.allowedUserIds.includes(userId))
    );
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "unknown error";
}
