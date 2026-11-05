import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "./types.js";

/**
 * ISSUE-088／090：codex 的 hook 由長駐 app-server daemon 執行，`HERDR_PANE_ID` 是 daemon 啟動時
 * 的值，所以 Herdr 為 codex pane 記錄的 `agent_session` 與 hook 事件的 pane 都可能屬於別的
 * codex。hook 的最終訊息沒有 nonce 可驗證，因此對 codex 只在「session 的 rollout 工作目錄
 * 等於這個 pane 的工作目錄」時才採用；其餘一律改走畫面 parser（較慢但不會貼錯內容）。
 */
export function isCodexAgent(agent: AgentRecord): boolean {
  return Boolean(agent.agent?.toLowerCase().includes("codex"));
}

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIRST_LINE_BYTES = 256 * 1024;
const cwdBySession = new Map<string, string | null>();

export async function codexSessionCwd(
  sessionId: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const key = `${codexHome}\n${sessionId}`;
  const cached = cwdBySession.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let found: string | undefined;
  async function scan(dir: string, depth: number): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (found !== undefined) return;
      const path = join(dir, item.name);
      if (item.isDirectory() && depth < 3) await scan(path, depth + 1);
      else if (item.isFile() && item.name.endsWith(`-${sessionId}.jsonl`))
        found = await firstLineCwd(path);
    }
  }
  await scan(join(codexHome, "sessions"), 0);
  // 找不到時不快取，之後 rollout 出現還能再查；找到才快取（session 的 cwd 不會變）。
  if (found !== undefined) {
    if (cwdBySession.size > 256) cwdBySession.clear();
    cwdBySession.set(key, found);
  }
  return found;
}

async function firstLineCwd(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_FIRST_LINE_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      const line = buffer
        .subarray(0, end < 0 ? bytesRead : end)
        .toString("utf8");
      const row = JSON.parse(line) as {
        type?: string;
        payload?: { cwd?: unknown };
      };
      return row.type === "session_meta" && typeof row.payload?.cwd === "string"
        ? row.payload.cwd
        : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * 這個 Agent 的 hook 訊息是否可以當成它自己的回覆。非 codex 一律 true（行為不變）。
 * codex：必須有 id 型 session，且該 session 的 rollout 工作目錄等於 pane 的工作目錄。
 */
export async function hookReplyTrusted(
  agent: AgentRecord,
  codexHome?: string,
): Promise<boolean> {
  if (!isCodexAgent(agent)) return true;
  const session = agent.agent_session as
    { kind?: string; value?: string } | undefined;
  if (session?.kind !== "id" || !session.value) return false;
  const paneCwds = [agent.foreground_cwd, agent.cwd].filter(
    (cwd): cwd is string => typeof cwd === "string" && cwd.length > 0,
  );
  if (!paneCwds.length) return false;
  const sessionCwd = await codexSessionCwd(session.value, codexHome);
  return sessionCwd !== undefined && paneCwds.includes(sessionCwd);
}
