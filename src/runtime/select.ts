import { RuntimeError } from "./errors.js";
import type { RuntimeKind } from "./types.js";

export function resolveRuntimeKind({
  env,
  config,
}: {
  env: { HERDR_BRIDGE_RUNTIME?: string };
  config: { runtime?: unknown };
}): RuntimeKind {
  const value =
    env.HERDR_BRIDGE_RUNTIME !== undefined
      ? env.HERDR_BRIDGE_RUNTIME
      : config.runtime === undefined
        ? "herdr"
        : config.runtime;
  if (value === "herdr" || value === "core") return value;
  throw new RuntimeError("RUNTIME_INCOMPATIBLE");
}
