import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookTransportMode = "auto" | "parser";
export const HOOK_AGENTS = ["claude", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export const DEFAULT_HOOK_TRANSPORT: Record<HookAgent, HookTransportMode> = {
  claude: "auto",
  codex: "auto",
};

/** 設定值只接受 auto／parser，且只對支援 hook 的 CLI 生效；其餘一律忽略。 */
export function validateHookTransport(
  value: unknown,
): Record<HookAgent, HookTransportMode> {
  const result = { ...DEFAULT_HOOK_TRANSPORT };
  if (typeof value !== "object" || value === null) return result;
  for (const kind of HOOK_AGENTS) {
    const mode = (value as Record<string, unknown>)[kind];
    if (mode === "auto" || mode === "parser") result[kind] = mode;
    else if (mode !== undefined)
      throw new Error(
        `hookTransport.${kind} must be "auto" or "parser", got ${JSON.stringify(mode)}`,
      );
  }
  return result;
}

/** agent 名稱（如 "claude"、"codex"）→ 是否走 hook；未支援的 CLI 一律 parser。 */
export function hookModeFor(
  transport: Partial<Record<string, HookTransportMode>> | undefined,
  agent: string | undefined,
): HookTransportMode {
  const name = (agent || "").toLowerCase();
  const kind = HOOK_AGENTS.find((k) => name.includes(k));
  if (!kind) return "parser";
  return transport?.[kind] ?? "auto";
}

const HOOK_COMMAND = "herdr-discord-hook";
const EVENTS = ["Stop", "PermissionRequest"] as const;

interface HookFile {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>;
}

/** 讀 CLI 的 hook 設定，回報兩個事件是否已註冊本 bridge 的 hook 指令（不判斷 Codex 信任狀態）。 */
export function registeredEvents(file: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let parsed: HookFile = {};
  try {
    if (existsSync(file)) parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* 無法讀取視為未註冊 */
  }
  for (const event of EVENTS)
    out[event] = (parsed.hooks?.[event] ?? []).some((entry) =>
      (entry.hooks ?? []).some(
        (h) =>
          typeof h.command === "string" && h.command.includes(HOOK_COMMAND),
      ),
    );
  return out;
}

export function hookStatusText(
  transport: Partial<Record<string, HookTransportMode>> | undefined,
  home = homedir(),
): string {
  const files: Record<HookAgent, string> = {
    claude: join(home, ".claude", "settings.json"),
    codex: join(home, ".codex", "hooks.json"),
  };
  const lines = [
    "**Hook 通道狀態**（hook 優先；事件缺失時自動退回畫面 parser）",
  ];
  for (const kind of HOOK_AGENTS) {
    const reg = registeredEvents(files[kind]);
    const mode = transport?.[kind] ?? "auto";
    const mark = (ok: boolean | undefined) => (ok ? "✅" : "❌ 未註冊");
    // Codex 執行 PermissionRequest hook 時不顯示核准提示（ISSUE-045），所以不建議註冊。
    const perm =
      kind === "codex"
        ? reg.PermissionRequest
          ? "⚠️ 已註冊（會擋住 Codex 的核准提示，建議移除）"
          : "未註冊（Codex 不建議開啟）"
        : mark(reg.PermissionRequest);
    lines.push(
      `• **${kind}**：模式 \`${mode}\`｜Stop ${mark(reg.Stop)}｜PermissionRequest ${perm}（${files[kind]}）`,
    );
  }
  lines.push(
    "• 其他 CLI（agy、pi、grok…）目前只用 parser。",
    "• Codex 另需在 Codex 內輸入 `/hooks` 審查並信任 `Stop`；信任前不會執行。",
    '• 設定：`hookTransport: { claude: "auto"|"parser", codex: "auto"|"parser" }`（config.json），改完需重啟 bridge。',
  );
  return lines.join("\n");
}
