// 2026-11-13：白名單留空一律拒絕（fail-closed）。要放行就明確列出 ID（ISSUE-159）。
export function inAllowlist(list: readonly string[], id: string): boolean {
  return list.length > 0 && list.includes(id);
}

// 啟動時回報哪些 Discord 白名單是空的（空的就代表該維度全部拒絕）。
export function emptyDiscordAllowlists(discord: {
  allowedGuildIds: readonly string[];
  allowedChannelIds: readonly string[];
  allowedUserIds: readonly string[];
}): string[] {
  return (
    ["allowedGuildIds", "allowedChannelIds", "allowedUserIds"] as const
  ).filter((key) => discord[key].length === 0);
}
