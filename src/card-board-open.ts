import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID = "herdr-discord-bridge";
const ENTRYPOINT = "card-board";

/**
 * 看板在 `$EDITOR` 編輯卡片時留下的標記（內容只有看板程序的 pid）。bridge 啟動時要把舊看板換成新程式，
 * 但編輯中直接關掉 pane 會丟掉還沒存的內容，所以看到標記就不動。
 */
export function boardEditingMarker(stateDir: string): string {
  return path.join(stateDir, "card-board-editing.json");
}

/** 標記存在而且寫入標記的看板程序還活著；缺檔、壞檔、程序已死（看板被殺掉留下的殘留標記）都算沒有在編輯。 */
export function isBoardEditing(markerFile: string): boolean {
  try {
    const pid = (
      JSON.parse(fs.readFileSync(markerFile, "utf8")) as { pid?: unknown }
    ).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** 看板 pane 的 title（herdr-plugin.toml 的 panes.title），也是 herdr 回報的 label。 */
export const CARD_BOARD_LABEL = "Card board";

/** 執行 `herdr <args>` 並回傳 stdout；注入點讓測試不必真的呼叫 herdr。 */
export type HerdrCli = (args: string[]) => Promise<string>;

export const runHerdrCli: HerdrCli = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "herdr",
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

interface PaneInfo {
  pane_id?: string;
  workspace_id?: string;
  label?: string;
}

function parsePanes(text: string): PaneInfo[] {
  const parsed = JSON.parse(text) as {
    result?: { panes?: PaneInfo[]; pane?: PaneInfo };
  };
  return (
    parsed.result?.panes ?? (parsed.result?.pane ? [parsed.result.pane] : [])
  );
}

async function bridgeWorkspace(
  run: HerdrCli,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  if (!env.HERDR_PANE_ID) return undefined;
  const [pane] = parsePanes(await run(["pane", "get", env.HERDR_PANE_ID]));
  return pane?.workspace_id || undefined;
}

/**
 * 確保 bridge 所在 workspace 有一個**跑最新程式**的 Card 看板 pane。已有舊看板時關掉它再開新的：
 * 舊看板是重啟前的程序，不會載入新版（例如沒有 Machine 檢視），留著等於沒有啟動新看板。
 * 但看板正在編輯卡片（`isEditing`）時不動它，避免丟掉沒存的內容。
 * 不在 Herdr pane 內執行（沒有 workspace）時略過。回傳一行結果說明；失敗由呼叫端記錄，不影響啟動。
 */
export async function ensureCardBoardPane(
  run: HerdrCli,
  env: NodeJS.ProcessEnv,
  options: { isEditing?: () => boolean } = {},
): Promise<string> {
  const workspace = await bridgeWorkspace(run, env);
  if (!workspace) return "略過：bridge 不在 Herdr pane 內，找不到 workspace";
  const panes = parsePanes(await run(["pane", "list"]));
  const existing = panes.filter(
    (pane) =>
      pane.workspace_id === workspace && pane.label === CARD_BOARD_LABEL,
  );
  if (existing.length && options.isEditing?.())
    return `看板正在編輯卡片（workspace ${workspace}），這次不重開；它仍是舊程式，編輯完請自行關掉讓下次啟動換新`;
  for (const pane of existing)
    if (pane.pane_id) await run(["pane", "close", pane.pane_id]);
  await run([
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    ENTRYPOINT,
    "--placement",
    "tab",
    "--workspace",
    workspace,
    "--no-focus",
  ]);
  return existing.length
    ? `已把舊看板換成新的（workspace ${workspace}，關掉 ${existing.length} 個舊的再另開 tab）`
    : `已在 workspace ${workspace} 另開 tab`;
}
