import fs from "node:fs";
import path from "node:path";
import {
  DiscordAdapter,
  type CommandContext,
  type CommandHandler,
  type PromptHandler,
} from "../discord.js";
import { RoutingStore } from "../routing.js";
import { stateDirectory, type Config } from "../config.js";
import { CoreAdapter } from "./core-adapter.js";
import { RuntimeError } from "./errors.js";
import { RuntimeCapability } from "./types.js";

export interface CoreDiscordPort {
  onCommand(handler: CommandHandler): void;
  onPrompt(handler: PromptHandler): void;
  reply(message: CommandContext["message"], text: string): Promise<unknown>;
  start(): Promise<void>;
  stop?(): Promise<void>;
}
export function assertCoreConfig(config: Config): void {
  for (const [field, capability] of [
    ["allowedWorkspaceIds", RuntimeCapability.Workspace],
    ["machines", RuntimeCapability.Targets],
  ] as const) {
    if (config[field].length)
      throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
        operation: field,
        capability,
        message: `Core 不支援操作 ${field}（缺少 ${capability}）；未執行操作。請移除 ${field} 設定後再啟動。`,
      });
  }
}
interface CoreRoutes {
  runtime: "core";
  coreId: string;
  bindings: Record<string, string>;
}
export async function startCoreBridge(
  config: Config,
  adapter: CoreAdapter,
  options: {
    discord?: CoreDiscordPort;
    directory?: string;
    log?: (text: string) => void;
  } = {},
): Promise<CoreDiscordPort> {
  assertCoreConfig(config);
  await adapter.health();
  await adapter.listTargets();
  if (!adapter.coreId) throw new RuntimeError("RUNTIME_IDENTITY_UNVERIFIED");
  const coreId = adapter.coreId;
  const directory = options.directory ?? stateDirectory();
  const file = path.join(directory, "core-routing.json");
  let routes: CoreRoutes = { runtime: "core", coreId, bindings: {} };
  if (fs.existsSync(file)) {
    const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && typeof saved === "object") {
      const value = saved as Partial<CoreRoutes>;
      if (
        value.runtime === "core" &&
        value.coreId === coreId &&
        value.bindings &&
        typeof value.bindings === "object" &&
        !Array.isArray(value.bindings)
      )
        routes = {
          runtime: "core",
          coreId,
          bindings: Object.fromEntries(
            Object.entries(value.bindings).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        };
    }
  }
  // DiscordAdapter 的核准查詢使用獨立空間；Core 不建立 Herdr target mapping。
  const discord =
    options.discord ??
    new DiscordAdapter(
      config.discord,
      new RoutingStore(path.join(directory, "core-discord.json")),
      config.approvalTimeoutMs,
    );
  const key = (context: CommandContext) =>
    context.routing.threadId
      ? JSON.stringify([
          context.routing.guildId,
          context.routing.channelId,
          context.routing.threadId,
        ])
      : undefined;
  const bound = (context: CommandContext) => {
    const id = key(context);
    return id ? routes.bindings[id] : undefined;
  };
  const denyIdentity = () => new RuntimeError("RUNTIME_IDENTITY_UNVERIFIED");
  const authorize = async (id: string | undefined) => {
    if (!id || !(config.coreAllowedTerminals ?? []).includes(id))
      throw denyIdentity();
    let target;
    try {
      await adapter.health();
      if (adapter.coreId !== coreId) throw denyIdentity();
      target = await adapter.getTarget(id);
    } catch {
      throw denyIdentity();
    }
    if (
      !target ||
      target.id !== id ||
      target.coreId !== coreId ||
      target.state !== "live"
    )
      throw denyIdentity();
    return target;
  };
  const respond = (context: CommandContext, text: string) =>
    discord.reply(context.message, text);
  const guard = async (
    context: CommandContext,
    action: () => Promise<void>,
  ) => {
    try {
      await action();
    } catch (error) {
      if (error instanceof RuntimeError)
        await respond(
          context,
          `${error.message} [${error.code}]${error.code === "RUNTIME_IDENTITY_UNVERIFIED" && !(config.coreAllowedTerminals ?? []).length ? " 請設定 coreAllowedTerminals。" : ""}`,
        );
      else {
        (options.log ?? console.error)(
          "Core command failed (unexpected error)",
        );
        await respond(context, "處理失敗，已記錄");
      }
    }
  };
  const unsupported = (command: string) => {
    const capability = /^(workspaces|wk|workspace)$/.test(command)
      ? RuntimeCapability.Workspace
      : /^(card|worktree)$/.test(command)
        ? RuntimeCapability.Worktree
        : /^(agent(?: |$)|pool$)/.test(command)
          ? RuntimeCapability.AgentStart
          : RuntimeCapability.Snapshot;
    throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
      operation: command,
      capability,
    });
  };
  discord.onCommand((context, command, args) =>
    guard(context, async () => {
      if (command === "agents" || (command === "agent" && !args.length)) {
        const targets = await adapter.listTargets();
        await respond(
          context,
          targets
            .map(
              (target) =>
                `${target.id} | ${target.title || target.name || "—"} | ${target.status}`,
            )
            .join("\n") || "沒有 Core terminal",
        );
        return;
      }
      if (command === "status" && !args.length) {
        await respond(
          context,
          `runtime=core socket=${adapter.socketPath} version=${adapter.version} generation=${adapter.generation}`,
        );
        return;
      }
      if (
        command === "target" ||
        command === "use" ||
        (command === "agent" && args[0] === "use")
      ) {
        const ids = command === "agent" ? args.slice(1) : args;
        const routeKey = key(context);
        if (ids.length !== 1 || !routeKey) throw denyIdentity();
        const target = await authorize(ids[0]);
        const next = {
          ...routes,
          bindings: { ...routes.bindings, [routeKey]: target.id },
        };
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(temporary, file);
        routes = next;
        await respond(context, `Core thread 目標：${target.id}`);
        return;
      }
      if (command === "read" && args.length <= 1) {
        const id = args[0] ?? bound(context);
        if (!id) throw denyIdentity();
        const result = await adapter.read(id, "visible", 0);
        await respond(
          context,
          result.text +
            (result.complete
              ? ""
              : `\n（畫面不完整：${result.why ?? "unknown"}）`),
        );
        return;
      }
      if (command === "ask" && args.length >= 2) {
        const target = await authorize(args[0]);
        const result = await adapter.send(target.id, args.slice(1).join(" "));
        await respond(
          context,
          `已送出至 ${target.id}（turn=${result.turn ?? "unknown"}，started=${result.started ?? "unknown"}）`,
        );
        return;
      }
      if (
        (command === "cancel" && args.length <= 1) ||
        (command === "agent" && args[0] === "keys" && args.length >= 3)
      ) {
        const target = await authorize(
          command === "cancel" ? (args[0] ?? bound(context)) : args[1],
        );
        await adapter.keys(
          target.id,
          command === "cancel" ? ["ctrl+c"] : args.slice(2),
        );
        await respond(context, `已送按鍵至 ${target.id}`);
        return;
      }
      if (command === "help" && !args.length) {
        await respond(
          context,
          "Core：agents、status、read [terminal]、ask <terminal> <text>、target/use <terminal>（thread）、agent keys <terminal> <keys...>、cancel [terminal]。輸入需 coreAllowedTerminals 授權。",
        );
        return;
      }
      unsupported(
        command === "agent" && ["start", "pool", "detach"].includes(args[0])
          ? `agent ${args[0]}`
          : command,
      );
    }),
  );
  discord.onPrompt((context, text) =>
    guard(context, async () => {
      const target = await authorize(bound(context));
      await adapter.send(target.id, text);
      await respond(context, `已送出至 ${target.id}`);
    }),
  );
  try {
    await discord.start();
  } catch (error) {
    await discord.stop?.();
    throw error;
  }
  return discord;
}
