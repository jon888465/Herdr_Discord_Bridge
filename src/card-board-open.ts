import { execFile } from "node:child_process";

const PLUGIN_ID = "herdr-discord-bridge";
const ENTRYPOINT = "card-board";
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
 * 確認 bridge 所在 workspace 已有 Card 看板 pane；沒有就在同 workspace 另開一個 tab（不搶焦點）。
 * 不在 Herdr pane 內執行（沒有 workspace）時略過。回傳一行結果說明；失敗由呼叫端記錄，不影響啟動。
 */
export async function ensureCardBoardPane(
  run: HerdrCli,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const workspace = await bridgeWorkspace(run, env);
  if (!workspace) return "略過：bridge 不在 Herdr pane 內，找不到 workspace";
  const panes = parsePanes(await run(["pane", "list"]));
  if (
    panes.some(
      (pane) =>
        pane.workspace_id === workspace && pane.label === CARD_BOARD_LABEL,
    )
  )
    return `已開啟（workspace ${workspace}），不重複開`;
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
  return `已在 workspace ${workspace} 另開 tab`;
}
