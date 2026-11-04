// `card loop --merge` 在 review 通過後等 PR 的 CI（使用者 2026-11-04 決定：等，有逾時；紅燈就停）。
// 只有狀態機：怎麼讀 checks、怎麼睡、現在幾點、有沒有人要求停止都由呼叫端注入，所以可以單獨測試。
//
// - `success`：全部通過，才會繼續往 merge；
// - `failure`：失敗、取消或全部略過（`card merge` 也只認 `success`），退回人工；
// - `pending`／`none`（剛 push、檢查還沒登記）：繼續等；
// - 超過 `timeoutMs` 還沒結論：`timeout`；
// - 讀取出錯：容忍偶發的一兩次，連續三次就丟出去（不無止境地等）。

import type { ChecksConclusion } from "./github.js";

export interface CiWait {
  state: "success" | "failure" | "timeout" | "cancelled";
  text: string;
}

const MAX_CONSECUTIVE_ERRORS = 3;

export async function waitForChecks(options: {
  read(): Promise<{ conclusion: ChecksConclusion }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  intervalMs: number;
  timeoutMs: number;
  stopRequested(): boolean;
}): Promise<CiWait> {
  const started = options.now();
  let errors = 0;
  for (;;) {
    try {
      const { conclusion } = await options.read();
      errors = 0;
      if (conclusion === "success")
        return { state: "success", text: "CI 全部通過。" };
      if (
        conclusion === "failure" ||
        conclusion === "cancelled" ||
        conclusion === "skipped"
      )
        return {
          state: "failure",
          text: `CI 結果是 ${conclusion}（不是全部通過）。`,
        };
    } catch (error) {
      errors++;
      if (errors >= MAX_CONSECUTIVE_ERRORS) throw error;
    }
    if (options.stopRequested())
      return { state: "cancelled", text: "等 CI 時收到停止要求。" };
    if (options.now() - started + options.intervalMs > options.timeoutMs)
      return {
        state: "timeout",
        text: `等了 ${Math.round((options.now() - started) / 1000)} 秒 CI 還沒結束。`,
      };
    await options.sleep(options.intervalMs);
  }
}
