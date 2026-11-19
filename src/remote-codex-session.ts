// 遠端 codex 的 session 身分（ISSUE-175）：codex 的 `agent_session` 不可信（ISSUE-088），bridge 只認
// 「本回合 prompt 的 nonce 出現在哪個 rollout 檔」。遠端 codex 的 rollout 在遠端機器上，這裡用固定腳本去找。
// 規則與本機 `findCodexRolloutByNonce` 相同：排除子 agent，恰好一個 session 才採用，其餘一律「不明」（呼叫端 fail closed）。
// 遠端 exec 只保留最後 64 KiB 輸出，所以子 agent 的判斷在遠端做完，只回傳「旗標 檔名」。

import type { RemoteExec } from "./remote-checkout.js";

const SHORT_MS = 30_000;
const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** 與本機搜尋相同：本回合開始前 5 秒內有寫入的檔案才可能含 nonce。 */
const SLACK_MS = 5000;

// $1 nonce、$2 回合開始到現在的秒數。只看 $CODEX_HOME（預設 ~/.codex）/sessions 底下最近寫入、小於 64 MiB 的 rollout，
// 含 nonce 的才輸出；第一行含 `"subagent"` 的標 S（子 agent），其餘標 R。sessions 是符號連結就當作沒有。
export const CODEX_SESSION_SCRIPT =
  'd="${CODEX_HOME:-$HOME/.codex}/sessions"; [ -d "$d" ] && [ ! -L "$d" ] || exit 0; m=$(( ($2 + 59) / 60 + 1 )); ' +
  `find "$d" -maxdepth 4 -type f -name 'rollout-*.jsonl' -mmin "-$m" -size -65536k 2>/dev/null | head -n 200 | ` +
  'while IFS= read -r f; do grep -q -F -- "$1" "$f" 2>/dev/null || continue; ' +
  `if head -n 1 -- "$f" 2>/dev/null | head -c 65536 | grep -q -F '"subagent"'; then s=S; else s=R; fi; ` +
  'printf \'%s %s\\n\' "$s" "${f##*/}"; done | head -n 20';

/**
 * 在遠端找出含 nonce 的 rollout 對應的 session。找不到、不唯一、遠端失敗都回傳 undefined（呼叫端 fail closed），
 * 失敗原因只進 console，不洩漏遠端內容。
 */
export async function findRemoteCodexSession(
  exec: RemoteExec,
  nonce: string,
  sinceMs: number,
  now: () => number = Date.now,
): Promise<{ kind: "id"; value: string } | undefined> {
  if (!/^[a-f0-9]{16,}$/i.test(nonce)) return undefined;
  const seconds = Math.max(0, Math.ceil((now() - sinceMs + SLACK_MS) / 1000));
  let stdout: string;
  try {
    const result = await exec(["sh", "-c", CODEX_SESSION_SCRIPT, "sh", nonce, String(seconds)], SHORT_MS);
    if (result.code !== 0) return undefined;
    stdout = result.stdout;
  } catch (error) {
    console.error(`遠端 codex session 查詢失敗：${(error as { label?: string })?.label ?? "未知錯誤"}`);
    return undefined;
  }
  const real = new Set<string>();
  for (const line of stdout.split("\n")) {
    const flag = line[0];
    if (!line || line[1] !== " " || (flag !== "R" && flag !== "S")) continue;
    const id = ROLLOUT_NAME.exec(line.slice(2))?.[1];
    if (id && flag === "R") real.add(id.toLowerCase());
  }
  if (real.size !== 1) return undefined;
  return { kind: "id", value: [...real][0]! };
}
