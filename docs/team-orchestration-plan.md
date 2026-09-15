# Team Orchestration 實作計畫

狀態：第一階段 vertical slice 已實作；持久化、recovery、取消與完整 blocked
互動仍待實作。

2026-09-11 交接後已完成 ISSUE-013／014 原始碼修正與 targeted tests；完整
repository 檢查及 live Discord／Herdr 驗收仍待完成。Herdr CLI／A2A 方法、
版本差異與驗收清單見 [修正交接](team-orchestration-issues-013-014-handoff.md)。

目前已完成：`team ask` 會由 thread active Agent 擔任 Lead，要求 JSON
Assignment plan，驗證 Worker roster／dependency，透過 Herdr `agent.prompt`、
`agent.wait`、`agent.read` 執行 Worker，收集 bounded report，再由 Lead 產生
synthesis。此流程目前以記憶體中的單次 task lifecycle 運作，尚未持久化 task
或提供 restart recovery。

2026-09-11：ISSUE-013 重啟後再次失敗，已重現 Codex JSON 字串終端折行。
planning 加入相符 Codex transcript final 優先與終端折行 fallback；驗證
紀錄以 `known-issues.md` 為準，仍需新 build 的 live dispatch／synthesis 驗收。

分派與等待的行為契約已寫入規格的「Herdr 分派與等待契約」；流程圖位於
[`docs/team-orchestration-flow.drawio`](./team-orchestration-flow.drawio)。

本計畫實作 [Team Orchestration 規格](./team-orchestration-spec.md)，且不改變
現有 single-Agent routing 語意。

## 階段 1：Domain type 與持久化

新增 `TeamTask`、`Assignment`、`TeamRoster`、`TaskReport` 及其狀態的
明確 type。將 task record 以穩定 task ID 為 key，擴充持久化 routing state。
加入有界限的保留與清理規則。

交付項目：

- type 與 state migration；
- task ID 產生；
- serialization tests；
- stale task recovery policy。

## 階段 2：Planning module

建立介面精簡的深層 `TeamPlanner` module：

```text
plan(task, lead, roster) -> validated AssignmentPlan
```

其實作將 planning prompt 傳給 Lead，解析嚴格的 JSON envelope，驗證 Assignment
target/dependency，並回傳安全 plan 或 typed failure。Prompt 建構與解析應封裝
在 module seam 後，使測試不需要 Discord 或 Herdr。

## 階段 3：Scheduler module

建立介面精簡的深層 `TeamScheduler` module：

```text
start(task, plan) -> task lifecycle events
cancel(taskId) -> result
```

注入 Herdr Adapter、clock、persistence store 與 event sink。此實作負責 dependency
排序、concurrency、避免重複 dispatch、狀態轉換、timeout 處理與 restart recovery。

## 階段 4：Discord 整合

當 thread 有 Team 時，變更 `team ask` 以建立 orchestration task。保持
`team add`、`team remove`、`ask` 與一般 active-Agent prompt 向後相容。

新增精簡的 Discord 訊息，用於顯示：

- task 已接受，以及 Lead/Roster；
- plan 已接受或拒絕；
- assignment 已開始／完成／blocked／failed；
- synthesis 已開始；
- final synthesis。

所有訊息都必須使用現有 Agent/workspace/pane identity header，並支援
Discord-safe splitting。

## 階段 5：Approval、取消與 recovery

重用現有 approval record，並在 approval context 加入 task 與 Assignment identity。
只有在內部 lifecycle 穩定後，才加入 task-level cancel command：

```text
/herdr team cancel <task-id>
/herdr team status [task-id]
```

Bridge restart 時，重新載入非 terminal task、查詢 Herdr state，並只恢復
dispatch identity 仍有效的 Assignment。不得只因 bridge restart 就重播已完成的
prompt。

## 階段 6：測試

在 module seam 建立測試：

- planner 接受有效 JSON，拒絕格式錯誤或不安全 plan；
- planner 拒絕重複、非 Roster、Lead 本身與循環 Assignment；
- scheduler 平行 dispatch 獨立工作；
- scheduler 等待 dependency；
- busy、blocked、stale 與 unknown Agent 產生規格指定的狀態；
- cancellation 阻止後續 dispatch，並使用 Herdr 官方 cancel；
- restart recovery 具備冪等性；
- synthesis 包含成功、失敗與被跳過 dependency；
- Discord output 在分段訊息中保留所有 task report。

使用 fake Herdr 與 Discord Adapter。除非另行加入 end-to-end smoke test，否則
不要以真實 terminal 驅動 orchestration 測試。

## 階段 7：發布

第一階段以 configuration flag 保護功能，預設關閉。先對 allowlisted guild/user
啟用，觀察 task state 與 failure rate；smoke test 穩定後再改為預設開啟。

建議設定：

```json
{
  "teamOrchestration": {
    "enabled": false,
    "maxConcurrentAssignments": 2,
    "planningTimeoutMs": 120000,
    "synthesisTimeoutMs": 120000,
    "taskTimeoutMs": 3600000,
    "maxAssignments": 8
  }
}
```

## 實作前待決事項

1. 第一版是否維持 `team ask` 為唯一入口，或新增明確的 `team plan` 指令？
2. Lead 是否永遠只擔任 planner/synthesizer，或也能收到 child Assignment？
3. 同一 workspace 中的兩個 Assignment 若可能修改重疊檔案，是否預設拒絕？
4. Blocked Assignment 應暫停整個 task，還是允許獨立 Assignment 繼續？
5. Final synthesis 是否只能在所有 Assignment 結束後發布，或允許使用者要求
   partial report？
