# Team Orchestration 實作計畫

更新：2026-09-19。此文件以目前增量取代早期 vertical-slice 提案；歷史驗證保留於 known-issues。

## Phase 1：Durable Task Engine

原始碼已接上既有 scheduler，待 live 驗收：

- 獨立 TeamTaskStore：version-1 atomic event journals、after-image replay、schema／identity／state transition 驗證。
- TeamTaskEngine：持久 task、shared Assignment lifecycle、frozen roster、actual session、reports、blocked/unknown recovery。
- `team ask`、`team status [task-id]`、`team cancel <task-id>` 共用 workspace 授權及 reservation。
- 重啟核對，不重送 prompt、不恢復舊 Promise、不把 stale running 視為 active。
- Whole-team cancellation：停止新派送，等待 acquisition／dispatch，核對後官方 Ctrl-C，停止確認後釋放 lease；未知或不確定時保持 cancelling。
- 動態多輪 Lead、零 Worker、Agent Pool lazy start／reuse、ISSUE-014、console 分離保留。

完整架構及 live 驗收步驟見 [Durable Task Engine](durable-task-engine.md)。
自動化完整與 targeted 結果記錄於 [ISSUE-020](known-issues.md)；unit tests 不等於 live acceptance。

## Phase 2：多 Agent blocked continuation（未實作）

- task／assignment／question identity、問題佇列與選擇 UI。
- 精確 reply routing、過期／重複回答防護、blocked 後繼續排程。
- 是否凍結其他工作、人工接手／恢復的政策。

Phase 1 只保留 blocker 與狀態，不重用單 Agent thread-level approval 來假裝 Team 問答已完成。

## 後续提案（未實作）

- 有證據的 turn resume／重新規劃，不盲目重送有副作用的 prompt。
- Journal retention／compaction、schema migrations、跨 bot／程序 state-directory 排他。
- Durable Discord delivery retry、opt-in pane mirror、完整事件匯流排。
- 各 phase 獨立 timeout 設定；目前沿用 approvalTimeoutMs。

沒有固定 Planner → Coder → Reviewer → Tester，也不由 Bridge 默默新增 business roles、自動 merge 或接管未知 session。
