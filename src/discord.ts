import {
  ActionRowBuilder,
  AttachmentBuilder,
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
  StringSelectMenuBuilder,
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
const MODEL_SELECT_PREFIX = "hdb.model.";
export const SHORT_COMMANDS = new Set([
  "help",
  "workspaces",
  "wk",
  "agents",
  "agent",
  "status",
  "hooks",
  "current",
  "use",
  "ask",
  "target",
  "assign",
  "model",
  "discord",
  "read",
  "wait",
  "cancel",
  "handoff",
  "quota",
  "failover",
  "team",
]);

export interface CommandContext {
  source?: "console";
  selectProfiles?: (
    profiles: string[],
    selected: string[],
  ) => Promise<string[] | undefined>;
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
export type ModelSelectHandler = (
  context: RoutingContext,
  targetPaneId: string,
  model: string,
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
  private readonly soloThreads = new Map<
    string,
    { solo: boolean; at: number }
  >();
  private modelSelectHandler: ModelSelectHandler | null = null;
  private paused = false;

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
    // 特權 intent；未在 Developer Portal 開啟就加入會導致登入失敗，故需明確設定。
    if (config.messageContent && config.soloThreadNoMention)
      intents.push(
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
      );
    this.client = new Client({ intents });
    this.ready = new Promise((resolve) =>
      this.client.once(Events.ClientReady, () => resolve()),
    );

    this.client.on(
      Events.MessageCreate,
      (message) =>
        void this.handleMessage(message).catch((error) =>
          console.error(`Discord inbound failed: ${safeError(error)}`),
        ),
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

  onModelSelect(handler: ModelSelectHandler): void {
    this.modelSelectHandler = handler;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(value: boolean): void {
    this.paused = value;
  }

  async showModelPicker(
    message: Message,
    agent: AgentRecord,
    models: string[],
  ): Promise<Message> {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(MODEL_SELECT_PREFIX + agent.pane_id)
      .setPlaceholder("Choose a model")
      .addOptions(
        models.slice(0, 25).map((model) => ({
          label: model.slice(0, 100),
          value: model.slice(0, 100),
        })),
      );
    return message.reply({
      content:
        agentHeader(
          agentLabel(agent),
          agent.workspace_name || agent.workspace_id,
          agent.pane_id,
          agent.agent,
        ) + "\nSelect a model for this Agent:",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      ],
    });
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
    for (const chunk of splitDiscordText(content))
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }

  async postFiles(
    message: Message,
    files: { path: string; name: string }[],
  ): Promise<void> {
    if (!files.length) return;
    const channel = message.channel as TextChannel | ThreadChannel;
    await channel.send({
      files: files.map((f) => new AttachmentBuilder(f.path, { name: f.name })),
      allowedMentions: { parse: [] },
    });
  }

  /** 把 Herdr 端 Agent 要求的文字與檔案送到已對應的 Discord 目的地。 */
  async postDirect(
    target: TargetMapping,
    content: string[],
    files: { path: string; name: string }[],
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
    for (const text of content)
      for (const chunk of splitDiscordText(text))
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    if (files.length)
      await channel.send({
        files: files.map(
          (f) => new AttachmentBuilder(f.path, { name: f.name }),
        ),
        allowedMentions: { parse: [] },
      });
  }

  /** 把文字與檔案送回某個已知的來源對話（例如私訊）；用於沒有 thread 對應的 Agent。 */
  async postToChannel(
    channel: { send(payload: unknown): Promise<unknown> },
    content: string[],
    files: { path: string; name: string }[],
  ): Promise<void> {
    for (const text of content)
      for (const chunk of splitDiscordText(text))
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    if (files.length)
      await channel.send({
        files: files.map(
          (f) => new AttachmentBuilder(f.path, { name: f.name }),
        ),
        allowedMentions: { parse: [] },
      });
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
    // 只有本 bot 在線的 thread 視同已 mention（指令與一般文字皆免 mention）。
    const solo =
      this.config.soloThreadNoMention &&
      message.channel.isThread() &&
      (await this.threadHasNoOtherBots(message.channel));
    const command = this.parseCommand(message, solo);
    if (command) {
      if (this.paused && command.name !== "discord") return;
      if (!this.commandHandler) return;
      await this.commandHandler(command.context, command.name, command.args);
      return;
    }
    if (this.paused || !this.config.messageContent) return;
    let replyToBot = false;
    if (message.reference?.messageId) {
      try {
        const referenced = await message.fetchReference();
        replyToBot =
          referenced.author.id === this.client.user?.id &&
          referenced.channelId === message.channelId;
      } catch {
        await message.reply(
          "❌ 無法讀取被回覆的訊息；請直接 mention bot 並重新發問。",
        );
        return;
      }
    }
    if (!message.channel.isThread()) {
      const channelContext = this.contextFor(message);
      const hasRoute = Boolean(this.routing.resolve(channelContext));
      const mentioned = this.client.user
        ? new RegExp(`<@!?${this.client.user.id}>`).test(message.content)
        : false;
      // 頻道內不是專屬 thread，只有明確 mention 的訊息才視為 prompt。
      const prompt = mentioned ? this.parsePrompt(message, replyToBot) : null;
      if (prompt && hasRoute && this.promptHandler) {
        try {
          await this.promptHandler(
            { message, routing: channelContext },
            prompt,
          );
        } catch (error) {
          await message.reply(`❌ Prompt rejected: ${safeError(error)}`);
        }
        return;
      }
      if (prompt || replyToBot || message.attachments.size)
        await message.reply(
          "❌ 尚未選取 Agent；請先 `@bot agent use <pane>`，或在已綁定 Agent 的 Discord thread 內發問或傳送圖片。",
        );
      return;
    }
    if (!message.content.trim() && !message.attachments.size) return;
    const context = this.contextFor(message, message.channel.id);
    const approval = this.routing.getApprovalForThread(context);
    if (approval && message.attachments.size) {
      await message.reply(
        "❌ Agent 正等待核准；請先回答核准問題，再傳送圖片。",
      );
      return;
    }
    if (approval && this.approvalHandler) {
      try {
        await this.approvalHandler(
          approval,
          message.content.trim(),
          message.author.id,
        );
        // 文字回答成功後原本完全沒有回饋，使用者無法分辨「已送出」與「沒收到」。
        await message.react("📨").catch(() => undefined);
      } catch (error) {
        await message.reply(`❌ Approval rejected: ${safeError(error)}`);
      }
      return;
    }
    const prompt = this.parsePrompt(message, replyToBot || solo);
    if (!prompt || !this.promptHandler) return;
    try {
      await this.promptHandler({ message, routing: context }, prompt);
    } catch (error) {
      await message.reply(`❌ Prompt rejected: ${safeError(error)}`);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (this.paused) {
      if (interaction.isButton() || interaction.isStringSelectMenu())
        await interaction.reply({
          content: "⏸️ Discord command handling is paused.",
          ephemeral: true,
        });
      return;
    }
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith(MODEL_SELECT_PREFIX)
    ) {
      const select = interaction;
      const guildId = select.guildId;
      const channel = select.channel;
      const parentChannelId = channel?.isThread()
        ? channel.parentId || select.channelId
        : select.channelId;
      if (
        !guildId ||
        !this.isAllowed(guildId, parentChannelId, select.user.id)
      ) {
        await select.reply({
          content: "⛔ You are not authorized to control this agent.",
          ephemeral: true,
        });
        return;
      }
      if (!this.modelSelectHandler) {
        await select.reply({
          content: "Model switching is unavailable.",
          ephemeral: true,
        });
        return;
      }
      try {
        await this.modelSelectHandler(
          this.contextFor(select.message as Message),
          select.customId.slice(MODEL_SELECT_PREFIX.length),
          select.values[0],
        );
        await select.update({
          content:
            select.message.content +
            "\n✅ Model switch requested: **" +
            select.values[0] +
            "**",
          components: [],
        });
      } catch (error) {
        await select.reply({
          content: "❌ Could not switch model: " + safeError(error),
          ephemeral: true,
        });
      }
      return;
    }
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
    solo = false,
  ): { context: CommandContext; name: string; args: string[] } | null {
    let content = message.content.trim();
    const mention = this.client.user
      ? new RegExp(`<@!?${this.client.user.id}>`, "g")
      : null;
    const mentioned = (mention ? mention.test(content) : false) || solo;
    if (mention) content = content.replace(mention, "").trim();
    const parsed = parseCommandText(
      content,
      this.config.commandPrefix,
      mentioned,
      this.config.requireMention,
    );
    if (!parsed) return null;
    if (!parsed.rest)
      return {
        context: { message, routing: this.contextFor(message) },
        name: "help",
        args: [],
      };
    const reply = parsed.rest.match(
      /^team\s+reply\s+(\S+)\s+(\S+)\s+([\s\S]+)$/i,
    );
    if (reply)
      return {
        context: { message, routing: this.contextFor(message) },
        name: "team",
        args: ["reply", reply[1], reply[2], reply[3]],
      };
    const parts = parsed.rest.split(/\s+/);
    return {
      context: { message, routing: this.contextFor(message) },
      name: parts[0].toLowerCase(),
      args: parts.slice(1),
    };
  }

  /** thread 成員中除本 bot 外沒有「在線」的 bot；無法確認時回傳 false（仍須 mention）。 */
  private async threadHasNoOtherBots(thread: ThreadChannel): Promise<boolean> {
    const selfId = this.client.user?.id;
    if (!selfId) return false;
    const cached = this.soloThreads.get(thread.id);
    if (cached && Date.now() - cached.at < 30000) return cached.solo;
    let solo = false;
    try {
      const members = await thread.members.fetch({ withMember: true });
      solo = members.every((m) => {
        if (m.id === selfId || !m.guildMember?.user.bot) return true;
        const status = thread.guild.presences.cache.get(m.id)?.status;
        return !status || status === "offline";
      });
    } catch {
      solo = false;
    }
    this.soloThreads.set(thread.id, { solo, at: Date.now() });
    return solo;
  }

  private parsePrompt(message: Message, replyToBot = false): string | null {
    let content = message.content.trim();
    const mention = this.client.user
      ? new RegExp(`<@!?${this.client.user.id}>`, "g")
      : null;
    const mentioned = mention ? mention.test(content) : false;
    if (mention) content = content.replace(mention, "").trim();
    if (this.config.requireMention && !mentioned && !replyToBot) return null;
    if (!content && message.attachments.size)
      content = [...message.attachments.values()].every((a) =>
        (a.contentType || "").toLowerCase().startsWith("image/"),
      )
        ? "請檢視附上的圖片並回覆。"
        : "請讀取附上的檔案並回覆。";
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

export function parseCommandText(
  content: string,
  commandPrefix: string,
  mentioned: boolean,
  requireMention: boolean,
): { rest: string } | null {
  if (requireMention && !mentioned) return null;
  const hasPrefix = content.startsWith(commandPrefix);
  const shortCommand = content.split(/\s+/, 1)[0]?.toLowerCase();
  if (!hasPrefix && (!mentioned || !SHORT_COMMANDS.has(shortCommand)))
    return null;
  return {
    rest: hasPrefix ? content.slice(commandPrefix.length).trim() : content,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "unknown error";
}
