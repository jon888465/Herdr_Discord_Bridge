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
          "❌ " +
            (error instanceof Error ? error.message : "unknown error"),
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
