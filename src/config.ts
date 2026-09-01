import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentStatus } from "./types.js";

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  allowedUserIds: string[];
  messageContent: boolean;
  commandPrefix: string;
  requireMention: boolean;
}

export interface Config {
  notifyOn: AgentStatus[];
  pollIntervalMs: number;
  requestTimeoutMs: number;
  reconnectBaseMs: number;
  approvalTimeoutMs: number;
  outputLines: number;
  handoffLines: number;
  handoffMaxChars: number;
  streamIntervalMs: number;
  maxTrackedApprovals: number;
  stateFile: string;
  allowedWorkspaceIds: string[];
  discord: DiscordConfig;
}

const DEFAULTS: Config = {
  notifyOn: ["blocked", "done"],
  pollIntervalMs: 2000,
  requestTimeoutMs: 5000,
  reconnectBaseMs: 250,
  approvalTimeoutMs: 900000,
  outputLines: 80,
  handoffLines: 40,
  handoffMaxChars: 6000,
  streamIntervalMs: 1200,
  maxTrackedApprovals: 256,
  stateFile: "routing.json",
  allowedWorkspaceIds: [],
  discord: {
    enabled: true,
    botToken: "",
    allowedGuildIds: [],
    allowedChannelIds: [],
    allowedUserIds: [],
    messageContent: true,
    commandPrefix: "/herdr",
    requireMention: false,
  },
};

function parseIds(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const ids = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : [];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

/** Remove JSONC comments without corrupting // inside a quoted string. */
function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function configDirectory(): string {
  return (
    process.env.HERDR_PLUGIN_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "herdr-discord-bridge")
  );
}

export function stateDirectory(): string {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR || path.join(configDirectory(), "state")
  );
}

function safeStateFile(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    return DEFAULTS.stateFile;
  const normalized = path.normalize(value);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    return DEFAULTS.stateFile;
  }
  return path.basename(normalized) === normalized
    ? normalized
    : DEFAULTS.stateFile;
}

export function statePath(config: Config): string {
  return path.join(stateDirectory(), config.stateFile);
}

export function loadConfig(): Config {
  const file = path.join(configDirectory(), "config.json");
  let source: Partial<Config> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(
      stripJsonComments(fs.readFileSync(file, "utf8")),
    ) as Partial<Config>;
    source = parsed && typeof parsed === "object" ? parsed : {};
  }
  const fileDiscord =
    source.discord && typeof source.discord === "object" ? source.discord : {};
  const discordSource = fileDiscord as Partial<DiscordConfig>;
  const env = process.env;
  const cfg: Config = {
    ...DEFAULTS,
    ...source,
    notifyOn: stringArray(source.notifyOn, DEFAULTS.notifyOn),
    pollIntervalMs: positiveInt(
      source.pollIntervalMs,
      DEFAULTS.pollIntervalMs,
      300000,
    ),
    requestTimeoutMs: positiveInt(
      source.requestTimeoutMs,
      DEFAULTS.requestTimeoutMs,
      120000,
    ),
    reconnectBaseMs: positiveInt(
      source.reconnectBaseMs,
      DEFAULTS.reconnectBaseMs,
      30000,
    ),
    approvalTimeoutMs: positiveInt(
      source.approvalTimeoutMs,
      DEFAULTS.approvalTimeoutMs,
      86400000,
    ),
    outputLines: positiveInt(source.outputLines, DEFAULTS.outputLines, 500),
    handoffLines: positiveInt(source.handoffLines, DEFAULTS.handoffLines, 200),
    handoffMaxChars: positiveInt(
      source.handoffMaxChars,
      DEFAULTS.handoffMaxChars,
      12000,
    ),
    streamIntervalMs: positiveInt(
      source.streamIntervalMs,
      DEFAULTS.streamIntervalMs,
      30000,
    ),
    maxTrackedApprovals: positiveInt(
      source.maxTrackedApprovals,
      DEFAULTS.maxTrackedApprovals,
      10000,
    ),
    stateFile: safeStateFile(source.stateFile),
    allowedWorkspaceIds: stringArray(
      source.allowedWorkspaceIds,
      DEFAULTS.allowedWorkspaceIds,
    ),
    discord: {
      ...DEFAULTS.discord,
      ...discordSource,
      allowedGuildIds: stringArray(
        discordSource.allowedGuildIds,
        DEFAULTS.discord.allowedGuildIds,
      ),
      allowedChannelIds: stringArray(
        discordSource.allowedChannelIds,
        DEFAULTS.discord.allowedChannelIds,
      ),
      allowedUserIds: stringArray(
        discordSource.allowedUserIds,
        DEFAULTS.discord.allowedUserIds,
      ),
      commandPrefix:
        typeof discordSource.commandPrefix === "string" &&
        discordSource.commandPrefix.length > 0
          ? discordSource.commandPrefix.slice(0, 32)
          : DEFAULTS.discord.commandPrefix,
    },
  };

  if (env.HERDR_DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN) {
    cfg.discord.botToken =
      env.HERDR_DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN || "";
  }
  const guilds = parseIds(
    env.HERDR_DISCORD_ALLOWED_GUILDS || env.DISCORD_ALLOWED_GUILDS,
  );
  if (guilds !== undefined) cfg.discord.allowedGuildIds = guilds;
  const channels = parseIds(
    env.HERDR_DISCORD_ALLOWED_CHANNELS || env.DISCORD_ALLOWED_CHANNELS,
  );
  if (channels !== undefined) cfg.discord.allowedChannelIds = channels;
  const users = parseIds(
    env.HERDR_DISCORD_ALLOWED_USERS || env.DISCORD_ALLOWED_USERS,
  );
  if (users !== undefined) cfg.discord.allowedUserIds = users;
  const workspaces = parseIds(env.HERDR_ALLOWED_WORKSPACES);
  if (workspaces !== undefined) cfg.allowedWorkspaceIds = workspaces;
  const messageContent = parseBoolean(env.HERDR_DISCORD_MESSAGE_CONTENT);
  if (messageContent !== undefined) cfg.discord.messageContent = messageContent;
  const requireMention = parseBoolean(env.HERDR_DISCORD_REQUIRE_MENTION);
  if (requireMention !== undefined) cfg.discord.requireMention = requireMention;

  cfg.discord.enabled = cfg.discord.enabled && cfg.discord.botToken.length > 0;
  return cfg;
}

export function configFilePath(): string {
  return path.join(configDirectory(), "config.json");
}
