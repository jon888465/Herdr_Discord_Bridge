import type { RoutingStore } from "./routing.js";
import type { Config } from "./config.js";
import readline from "node:readline";
import type { Message } from "discord.js";
import type { CommandContext } from "./discord.js";

type ConsoleCommand = {
  command: string;
  args: string[];
};

export function parseConsoleCommand(
  line: string,
  commandPrefix: string,
): ConsoleCommand | null {
  const text = line.trim();
  if (!text) return null;
  const rest = text.startsWith(commandPrefix)
    ? text.slice(commandPrefix.length).trim()
    : text;
  if (!rest) return null;
  const parts = rest.split(/\s+/);
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1),
  };
}

export function createConsoleContext(
  print: (text: string) => void,
): CommandContext {
  const channel = {
    isThread: () => false,
    send: async (payload: unknown) => {
      print(consolePayload(payload));
      return message;
    },
  };
  const message = {
    author: { id: "local-console", bot: false },
    attachments: new Map(),
    guildId: null,
    channelId: "local-console",
    channel,
    reply: async (payload: unknown) => {
      print(consolePayload(payload));
      return message;
    },
    edit: async (payload: unknown) => {
      print(consolePayload(payload));
      return message;
    },
  } as unknown as Message;
  return {
    message,
    routing: {
      guildId: "local-console",
      channelId: "local-console",
      userId: "local-console",
    },
  };
}

export function startConsole(
  commandPrefix: string,
  onCommand: (
    command: string,
    args: string[],
    context: CommandContext,
  ) => Promise<void>,
  print: (text: string) => void = console.log,
): { stop: () => void } {
  if (!process.stdin.isTTY) return { stop: () => undefined };
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: "bridge> ",
  });
  const context = createConsoleContext(print);
  let closed = false;
  input.on("line", (line) => {
    const parsed = parseConsoleCommand(line, commandPrefix);
    if (!parsed) {
      input.prompt();
      return;
    }
    void onCommand(parsed.command, parsed.args, context)
      .catch((error) =>
        print(
          "❌ " + (error instanceof Error ? error.message : "unknown error"),
        ),
      )
      .finally(() => {
        if (!closed) input.prompt();
      });
  });
  input.on("close", () => {
    closed = true;
  });
  input.prompt();
  return {
    stop: () => {
      closed = true;
      input.close();
    },
  };
}

function consolePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    "content" in payload &&
    typeof payload.content === "string"
  )
    return payload.content;
  return "[bridge console: interactive Discord component omitted]";
}

export async function routeConsoleCommand(
  command: string,
  args: string[],
  context: CommandContext,
  store: RoutingStore,
  config: Config,
): Promise<CommandContext | null> {
  const allowed = (guild: string, channel: string, workspace: string) =>
    (!config.discord.allowedGuildIds.length ||
      config.discord.allowedGuildIds.includes(guild)) &&
    (!config.discord.allowedChannelIds.length ||
      config.discord.allowedChannelIds.includes(channel)) &&
    (!config.allowedWorkspaceIds.length ||
      config.allowedWorkspaceIds.includes(workspace));
  const routes = store
    .allMappings()
    .filter(
      (m) =>
        m.discordThreadId &&
        allowed(m.discordGuildId, m.discordChannelId, m.workspaceId),
    );
  if (command === "threads") {
    const lines = [
      ...new Set(
        routes.map(
          (m) =>
            `${m.discordThreadId} · workspace ${m.workspaceId} · channel ${m.discordChannelId}`,
        ),
      ),
    ];
    await context.message.reply(
      lines.join("\n") || "No authorized mapped Discord threads.",
    );
    return null;
  }
  if (command === "thread") {
    if (args.length !== 1)
      throw new Error(
        "usage: thread <thread ID>|off; use threads to list mappings",
      );
    if (args[0] !== "off" && !routes.some((m) => m.discordThreadId === args[0]))
      throw new Error("Unknown or unauthorized mapped thread; use threads.");
    store.selectConsoleThread(args[0] === "off" ? undefined : args[0]);
    await context.message.reply(
      args[0] === "off"
        ? "Local console routing restored."
        : `Shared routing: thread ${args[0]}. Console output stays here.`,
    );
    return null;
  }
  const selected = store.consoleThread();
  if (!selected || command === "help") return context;
  if (
    !routes.some(
      (m) =>
        m.discordThreadId === selected.threadId &&
        m.discordGuildId === selected.guildId &&
        m.discordChannelId === selected.channelId,
    )
  )
    throw new Error(
      "Shared thread is unavailable or unauthorized. Select a thread or use thread off.",
    );
  return { ...context, routing: { ...selected, userId: "local-console" } };
}
