import type { RuntimeKind } from "./runtime/types.js";
import { resolveRuntimeKind } from "./runtime/select.js";
import fs from "node:fs";
import { validateProfiles, type AgentProfile } from "./agent-pool.js";
import os from "node:os";
import path from "node:path";
import type { AgentStatus } from "./types.js";
import { nonStringAllowlistKeys } from "./allowlist.js";
import { validateMachines, type MachineConfig } from "./machines.js";
import {
  DEFAULT_HOOK_TRANSPORT,
  validateHookTransport,
  type HookAgent,
  type HookTransportMode,
} from "./hook-status.js";

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  allowedUserIds: string[];
  messageContent: boolean;
  commandPrefix: string;
  requireMention: boolean;
  /** thread 只有本 bot 時免 mention；需 Server Members 與 Presence Intent。 */
  soloThreadNoMention?: boolean;
}

export interface Config {
  /** HERDR_BRIDGE_RUNTIME 優先；未指定維持 Herdr。 */
  runtime?: RuntimeKind;
  /** Core 輸入操作的 terminal address 白名單；空清單僅允許讀取。 */
  coreAllowedTerminals: string[];
  agentProfiles?: AgentProfile[];
  /** 使用者明列的本機目錄（絕對路徑）：agy 在這些目錄啟動時，bridge 確保它在 agy 的信任清單內（ISSUE-113）。 */
  agyTrustedDirectories: string[];
  /** 遠端 Herdr 機器；未列出的 ID 一律是本機。 */
  machines: MachineConfig[];
  /** 各 CLI 的完成／權限通道：auto＝hook 優先、缺事件退回 parser；parser＝只用畫面 parser。 */
  hookTransport: Record<HookAgent, HookTransportMode>;
  notifyOn: AgentStatus[];
  pollIntervalMs: number;
  requestTimeoutMs: number;
  reconnectBaseMs: number;
  approvalTimeoutMs: number;
  /** Team 任務 Lead 規劃、每個 Worker、Lead 彙整單一回合的等待上限（ISSUE-124）；與批准提示有效期分開。 */
  teamTurnTimeoutMs: number;
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
  coreAllowedTerminals: [],
  agyTrustedDirectories: [],
  machines: [],
  hookTransport: { ...DEFAULT_HOOK_TRANSPORT },
  notifyOn: ["blocked"],
  pollIntervalMs: 2000,
  requestTimeoutMs: 5000,
  reconnectBaseMs: 250,
  // 批准提示的有效期：15 分鐘（ISSUE-124 之前也被 Team 回合共用，現已改用 teamTurnTimeoutMs）。
  approvalTimeoutMs: 900000,
  teamTurnTimeoutMs: 3600000, // 1 小時（ISSUE-145：原 30 分鐘會讓稍晚完成的 Worker 被判逾時）
  outputLines: 500,
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
    soloThreadNoMention: false,
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

/** Team 任務 Lead 規劃、每個 Worker、Lead 彙整的單一回合等待上限（不是批准提示的有效期）。 */
export function teamTaskTimeoutMs(
  config: Pick<Config, "teamTurnTimeoutMs">,
): number {
  return config.teamTurnTimeoutMs;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  let parsed: number;
  try {
    parsed = typeof value === "number" ? value : Number(value);
  } catch {
    // JSON 物件的 toString 不是函式時 Number() 會拋 TypeError；設定值不可讓 bridge 無法啟動。
    return fallback;
  }
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

export function configDirectory(): string {
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
  const nonString = nonStringAllowlistKeys(
    fileDiscord as Record<string, unknown>,
  );
  if (nonString.length)
    console.error(
      `Discord 白名單 ${nonString.join("、")} 含有非字串項目，已被忽略（ID 要寫成加引號的字串，數字寫法會失真，ISSUE-159）。`,
    );
  const env = process.env;
  const cfg: Config = {
    ...DEFAULTS,
    ...source,
    runtime: resolveRuntimeKind({ env, config: source }),
    coreAllowedTerminals: stringArray(source.coreAllowedTerminals, []),
    agentProfiles: validateProfiles(source.agentProfiles),
    agyTrustedDirectories: stringArray(source.agyTrustedDirectories, []),
    machines: validateMachines(source.machines),
    hookTransport: validateHookTransport(source.hookTransport),
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
    teamTurnTimeoutMs: positiveInt(
      source.teamTurnTimeoutMs,
      DEFAULTS.teamTurnTimeoutMs,
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
  const soloNoMention = parseBoolean(env.HERDR_DISCORD_SOLO_THREAD_NO_MENTION);
  if (soloNoMention !== undefined)
    cfg.discord.soloThreadNoMention = soloNoMention;

  cfg.discord.enabled = cfg.discord.enabled && cfg.discord.botToken.length > 0;
  return cfg;
}

export function configFilePath(): string {
  return path.join(configDirectory(), "config.json");
}
