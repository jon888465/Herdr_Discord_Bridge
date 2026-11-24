import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ISSUE-206：卡片指派的 Lead 剛就緒時可能還在短暫 working。`startTeamTask` 用 `settleWorkingAgent` 等它穩定，
 * 但原本只拿結果做斷言，之後交給 `TeamTaskEngine.run` 的仍是最初讀到、狀態還是 working 的 `lead`，
 * 引擎丟出 `Agent is working`，任務沒有啟動（worktree 建好後約 3 秒失敗，事後 Lead 是 idle、輸入框是空的）。
 * `startTeamTask` 沒有匯出，無法在這裡直接執行，所以只能檢查接線：settle 的結果必須同時用在斷言、引擎與回傳值。
 */
const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("async function startTeamTask(");
const body = source.slice(start, source.indexOf("\nasync function ", start + 10));

test("startTeamTask keeps the settled Lead record and uses it for the availability check", () => {
  assert.match(body, /const readyLead = cardId\s*\?\s*await settleWorkingAgent\(/);
  assert.match(body, /assertAgentAvailable\(readyLead, runtime\)/);
});

test("startTeamTask hands the settled Lead record, not the initially read one, to the task engine", () => {
  const run = body.slice(body.indexOf("runtime.tasks.run("), body.indexOf("runtime.tasks.run(") + 600);
  assert.match(run, /\blead: readyLead,/);
  assert.doesNotMatch(run, /^\s*lead,\s*$/m, "不能再用簡寫的 lead（過期的記錄）");
});

test("startTeamTask returns the settled Lead record to its callers", () => {
  assert.match(body, /return \{ taskId, lead: readyLead, workers, staleWorkers, running \};/);
});
