# Phase 1: Durable Task Engine

2026-09-19。原始碼與 fixture 驗證，不代表 live Herdr／Discord 已驗收；結果見 ISSUE-020。

## 使用

```text
team ask <prompt>
team status [task-id]
team cancel <task-id>
```

Discord 加上 `/herdr` 前綴。status/cancel 只操作目前選取且授權的 workspace。
status 無 ID 列出該 workspace 保存的任務；指定 ID 也顯示 synthesis、blocker、recovery。
任務受既有 Discord guild/channel/user allowlist 保護；同 workspace 授權操作者可查看／取消。

## 責任與資料

- `team-orchestration.ts` 仍是唯一 scheduler：Lead 動態決定 Worker、依賴與下一輪，不固定角色；零 Worker 由 Lead 在 synthesis 階段直接執行與驗證。
- `team-turn.ts` 保留 ISSUE-014 的 matching transcript、nonce marker、settled completion 與 prompt-stalled 不重送行為，增加取消檢查及派送前持久化 hook。
- `team-task-engine.ts` 擁有執行、reservation、取消與 restart reconciliation，將同一 scheduler 的事件同步持久化後才通知 UI。
- `team-task-store.ts` 保存 task ID、workspace ID、Lead/session identity、original prompt、frozen roster（含 profile 定義）、Assignment plan/state/actual session/report/blocker、active turn、timestamps、synthesis 與 recovery。
- `AgentPool` 繼續 lazy acquire／existing-session reuse；release 不停止 CLI。Profile acquire 途中取消須先等 acquire 結束，不能提前釋放 lease 或讓取得的 Worker 接收新 prompt。

Task lifecycle：

| 狀態                           | 意義／可轉移方向                                                          |
| ------------------------------ | ------------------------------------------------------------------------- |
| planning                       | Lead 規劃；可 running、synthesizing、blocked、failed、cancelling          |
| running                        | Worker 執行；可再次 planning、synthesizing、blocked、failed、cancelling   |
| synthesizing                   | 包含 Lead 直接執行、驗證、統整；可 completed、blocked、failed、cancelling |
| blocked                        | 保存追問或執行不確定狀態；可 partial synthesis、failed、cancelling        |
| cancelling                     | 禁止新派送，等待停止核對；只可 cancelled                                  |
| completed / failed / cancelled | terminal；不能重新派送或回到 planning                                     |

Assignment 沿用 `pending → assigned → working → done`，並可 blocked／failed／cancelled；沒有另一套 running/completed 別名。
已驗證的 plan 必須先保存，才開始 acquire／dispatch；每個重要 state transition、report、cancel intent 與 reconciliation 都進 journal。
Phase 2 正常執行會等待 blocked 問題回答後的原 turn 報告；觀察失敗可產生 partial synthesis，仍保留未確認 turn；相依工作 failed 不代表該 Worker 已停止。
派送後 timeout／capture failure 若留下未確認的 turn，task 保持 blocked/unknown，不把「觀察失敗」當作「程序停止」。

## 持久化與故障

路徑：既有 state directory 下的 `team-tasks/<task-id>.json`，與 routing／Agent Pool 檔案分開。
Phase 2 新寫入 schema version 為 2，可讀舊 v1 並於 mutation 升級；每個 event 有連續 sequence、timestamp、type 與完整 after-image。
整份 journal 透過同目錄唯一 temporary file、0600、file fsync、atomic rename 寫入；POSIX 再 fsync directory。
Windows 保留 file fsync／rename，沒有 POSIX directory fsync 保證。
單一檔案同時是 journal 與可重建狀態，避免 snapshot 與 journal 雙檔提交不一致。

啟動時驗證 schema、event sequence、immutable identity、狀態轉移與 Assignment 結構；未知版本／損毀拒絕啟動，不丟棄任務。
未完成 rename 的 `.tmp` 不當成已提交紀錄。寫入失敗停止該 engine 派送，保留 reservation，需處理磁碟後重啟核對；不以記憶體狀態冒充保存成功。
每個 task 的每個 event 都保存 after-image，適合目前最多 64 Assignments 的規模，但儲存量隨事件／報告成長。
Phase 1 沒有自動 retention、compaction、schema migration 或跨 Bridge writer lock；同 bot 的既有 instance lock 保留，獨立 bot 不可共用 state directory。

## 重啟核對

正常啟動在接受命令前載入 non-terminal tasks 並查詢 Herdr。
旧 planning/running/synthesizing/blocked 統一轉為 blocked；cancelling 保持 cancelling。
原 assigned/working Assignment 轉 blocked，turn 標成 uncertain；pending 不派送。
核對 workspace、pane、terminal、agent kind、session kind/value，逐一記錄 missing、replaced、unknown 或 same-session/live status。
全部 identity 可確認時為 recoverable，否則 unknown；**same-session 不證明目前 work/turn 屬於舊任務**。
不以 idle/done 推論完成，不恢復舊 Promise、不重播 prompt、不重新產生 synthesis。
保留原 terminal reservations，防止新任務搶用未處理的 session。

Phase 1 的 recovery 是持久保存、核對與人工處理，不是自動 resume。
先 `team status <id>`，再用 read/attach 檢查。舊 turn 在重啟後仍 working/blocked 時，Engine 不自動 Ctrl-C，因為不能證明目前工作仍屬於它；操作者需在 Herdr 確認並停止原工作，再 `team cancel <id>` 核對與釋放。

## Whole-Team cancellation

1. 持久化 cancelling，再中止 scheduler；禁止新 plan／dispatch／synthesis。
2. 等 in-flight lazy acquire 與 prompt request 結束；觀察性 wait 可中止。取消等待可能受既有 Herdr request timeout 影響。
3. 僅對當前 Bridge 所持有、session identity 明確且仍 working/blocked 的 turn，使用既有 `cancelAgent`（官方 Ctrl-C）；不關 pane、不殺 CLI、不碰已完成或未啟動 Worker。
4. cancel intent 在送訊號前持久化。不確定送達不自動重送，避免打斷後來的工作。
5. 所有 turn 已 idle/done、原 session 消失或明確被替換後，標記剩餘 Assignment cancelled、task cancelled，釋放 terminal reservations 與 profile leases。
6. session 不明、API 失敗、仍 active 時保持 cancelling 並顯示原因。停止稍晚生效時再次 `team cancel <id>` 只核對，不重送已嘗試的 Ctrl-C。

這是邏輯任務取消及可觀察停止確認；Herdr 沒有 compare-session-and-cancel 原子 API，核對與送訊號之間仍有外部 pane 操作的競態。
一般 `cancel <pane>` 與單 Agent blocked reply 拒絕操作 Engine 保留的 session，避免繞過 task lifecycle。
Phase 2 已接入 assignment/question reply queue 與原 turn 續接，見 [問題佇列](team-question-queue.md)；點選 UI 仍未實作。
Console conversation／attach／watch 不改變；Discord 通知失敗不回滾 task，也没有持久化 delivery retry。

## Live acceptance still required

記錄實際 bridge commit、Herdr／各 CLI 版本、task ID、Assignment ID 與時間戳：

1. Discord 與 console 各做多輪動態任務、零 Worker、profile lazy start 與 existing-session reuse。
2. 在 planning、平行 Worker、synthesis 中重啟 Bridge；舊任務可查、無重複 prompt、無假 running/completed。
3. 同 session、缺 session metadata、pane 消失／被替換、Herdr 離線分別核對；不誤中止其他工作。
4. 取消兩個 active Workers、blocked Lead、lazy acquire 中任務；確認 Ctrl-C、延迟停止、reservation 釋放、CLI session 仍保留。
5. ISSUE-014 本次回覆關聯／等待所有必要報告，及安靜 conversation、獨立 attach/watch 回歸。
6. 實際檔案系統 crash／斷電耐久性與 Windows rename 行為；fixture 不代表 power-loss 驗證。

本輪沒有連線真實 Discord／Herdr、沒有部署或重啟使用者 Bridge，舊訊息不補送。
