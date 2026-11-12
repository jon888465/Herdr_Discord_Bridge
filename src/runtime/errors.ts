import type { RuntimeAdapter, RuntimeCapability } from "./types.js";

export type RuntimeErrorCode =
  | "RUNTIME_UNSUPPORTED_OPERATION"
  | "RUNTIME_IDENTITY_UNVERIFIED"
  | "RUNTIME_UNREACHABLE"
  | "RUNTIME_INCOMPATIBLE"
  | "RUNTIME_DELIVERY_UNKNOWN";

const MESSAGES = {
  RUNTIME_IDENTITY_UNVERIFIED: "Core 目標身分或授權無法確認；未送出輸入。",
  RUNTIME_UNREACHABLE: "無法連線所選 Core runtime；未切換至 Herdr。",
  RUNTIME_INCOMPATIBLE: "Core 協定或必要 API 不相容；未切換 runtime。",
  RUNTIME_DELIVERY_UNKNOWN: "Core 指令送達狀態不明；未自動重送。",
} as const;

export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    public readonly details: {
      operation?: string;
      capability?: RuntimeCapability;
      runtime?: string;
      rpcCode?: number;
      rpcKind?: string;
      reason?: string;
      deliveryAttempted?: boolean;
      missingMethods?: string[];
      message?: string;
    } = {},
  ) {
    super(
      details.message ??
        (code === "RUNTIME_UNSUPPORTED_OPERATION"
          ? `${details.runtime === "herdr" ? "Herdr" : "Core"} 不支援操作 ${details.operation ?? "unknown"}（缺少 ${details.capability ?? "unknown"}）；未執行操作。`
          : MESSAGES[code] +
            (details.missingMethods?.length
              ? ` 缺少 method：${details.missingMethods.join("、")}`
              : "")),
    );
    this.name = "RuntimeError";
  }
}

export function assertCapability(
  adapter: Pick<RuntimeAdapter, "kind" | "capabilities">,
  capability: RuntimeCapability,
  operation: string,
): void {
  if (!adapter.capabilities.has(capability))
    throw new RuntimeError("RUNTIME_UNSUPPORTED_OPERATION", {
      operation,
      capability,
      runtime: adapter.kind,
    });
}
