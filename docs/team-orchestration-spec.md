# Team Orchestration 規格

狀態（2026-09-20）：Phase 1 Durable Task Engine 已實作、待 live 驗收。完整持久化／取消／restart 契約見 [Durable Task Engine](durable-task-engine.md)。blocked continuation 已由 [Phase 2 問題佇列](team-question-queue.md) 接續，live 待驗收。

2026-09-11：ISSUE-013／014 原始碼修正已套用，planning／Worker／synthesis
使用共用 turn 接收器與 Herdr prompt wait；targeted fixture 已更新，完整
repository 檢查與 live 驗收仍待完成。實際修正、CLI／A2A 方法及待辦見
[修正交接](team-orchestration-issues-013-014-handoff.md)，不得把本稿當成
新版端到端流程已通過的證據。

# 1:1:N Multi-Agent Task

## 定義

1 個人類使用者（1）
→ 1 個 Discord thread／任務上下文（1）
→ N 個 Herdr Agent／CLI Agent（N）

Discord thread 是人類與 Lead Agent 的主要協作上下文。Lead Agent 是使用者
唯一的回報窗口，負責理解總任務、拆分子任務、分配給 Worker、監控進度、處理
阻塞、收集結果，最後統整後回報使用者。

目前實作邊界：`team ask` 已建立 Lead planning、Assignment 驗證與排程、Herdr
Worker dispatch、bounded Worker report 與 Lead synthesis，並將同一 lifecycle 保存為 versioned atomic journal。
已提供 task status/cancel 與 restart reconciliation；不自動 resume／重送 prompt。
Blocked Worker 的後續問答使用 team questions/reply，保持原 turn 等待；詳見 Phase 2。

## 2026-09-18 已實作擴充

Profile pool、lazy acquire/session continuity、Lead 多輪 replanning 與本機 console 分離見 [架構與操作](agent-pool-console.md)。固定 phase 是協定步驟，並不固定業務角色。零 Worker 可直接由 Lead 執行；最多 8 輪，partial synthesis 不代表完成。

## 角色

### Human

- 提出總任務與接受最終結果。
- 可指定限制、驗收條件與是否允許修改、commit、push。

### Lead Agent

- 由目前 Discord thread 的 active Agent 擔任。
- 分析總任務並拆分成可獨立執行的子任務。
- 依任務動態決定角色，分配給已選取的 live members 或 Agent profiles；可直接處理而不委派。
- 維護 task、owner、status、dependency 與 blocker。
- 監控 Worker 的 `working`／`done`／`blocked` 狀態。
- 收集 Worker 回報，驗證結果後統整回報 Human。
- 不應讓多個 Worker 同時修改同一批檔案。

### Worker Agent

- 只執行 Lead 分配的子任務。
- 向 Lead 回報，不直接對 Human 做平行結案回報。
- 回報必須包含修改檔案、測試結果、commit／push 狀態與 blocker。
- 不應自行變更任務範圍。

## 任務流程

1. Human 在 Discord thread 提出總任務。
2. Active Agent 成為 Lead。
3. Lead 盤點 workspace 與 Team members。
4. Lead 將總任務拆成子任務。
5. Lead 依能力、檔案範圍與相依性分配給 Workers。
6. 可平行的子任務平行執行；有依賴的任務依序執行。
7. Lead 監控每個 Worker 的狀態與 timeout。
8. Worker 完成後向 Lead 回報實際證據。
9. Lead 進行整合、測試與 review。
10. Lead 將單一統整結果回報 Human。
11. 任務結束後清除 heartbeat／timer，避免重複通知。

## Herdr 分派與等待契約

所有 Lead／Worker dispatch 必須經由 Herdr Agent API；正常任務不可直接對 pane
寫入 shell bytes，也不可使用 `pane.send_input` 取代 Agent prompt。

### Lead planning

1. Bridge 以 Discord thread 的 active Agent 作為 Lead。
2. Lead 必須處於 `idle` 或 `done`；`working`、`blocked`、`unknown` 或 stale
   target 不得接收新的 planning prompt。
3. Bridge 使用 `agent.prompt(target, planningPrompt)` 發送一次規劃請求。請求
   必須要求 bounded JSON Assignment plan，不允許 Lead 在 planning 階段修改檔案。
4. Bridge 使用 `agent.wait(target, until=[idle, done, blocked, unknown])` 等待
   Lead 狀態；等待 timeout 不得無限延長，也不得自動重送 planning prompt。
5. Prompt 前先讀取 Lead 的 baseline，並嘗試連接本機 Codex transcript；優先
   使用相符 prompt／turn 且 task_complete 的 final，保留原始字串內容。
   無可用 final 時，Lead 回到 `idle`／`done` 後，Bridge 使用
   `agent.read(target, source=recent_unwrapped, lines=N)` 取得 transcript，並依
   Lead CLI adapter 擷取本次回覆，再解析 bounded plan。若 adapter 無法辨識邊界，
   僅接受本次隨機 marker 內的完整回覆，不解析任意 transcript JSON；最後驗證 Assignment ID、Worker
   roster、dependency 與 cycle。
   Codex 終端 fallback 的 strict JSON parse 失敗時，可消除字串內換行與
   兩欄 continuation 縮排；不變更既有空白／跳脫，也不對結構化 final 或
   非 Codex 套用。終端已丟失的空白無法保證還原。見 ISSUE-013 的折行回歸。

### Worker dispatch

2026-09-11 驗收失敗：使用者回報未等待 Worker 結束便進入 synthesis，且
report 混入舊對話（ISSUE-014）；另有採用 prompt 範例 plan（ISSUE-013）。
以下為應滿足的契約，不能以既有自動化測試視為已完成這些 live 驗收。
完成證據須對應本次 dispatch；只有舊 idle/done 或歷史 report 不得觸發
完成統整。需等待所有必要 Assignment 的有效回報，blocked／failed 的
partial synthesis 必須明確標示未完成工作。

每個已通過驗證且 dependency 已完成的 Assignment 依下列順序執行：

1. Bridge 以 `agent.prompt(workerPaneId, assignmentPrompt)` 原子送出 bounded
   Assignment instruction；prompt 必須包含 Task ID、Assignment ID、owner 與
   Worker 回報格式。若 Herdr 回傳 `agent.prompt(wait=...)` 的 settled Agent，
   該結果屬於本次 dispatch，Bridge 必須優先使用它，不得再消耗第二個完整 wait timeout。
2. 同一個 Worker 在前一個 Assignment 尚未進入 terminal state 前，不得再次
   dispatch。可互相獨立的 Assignment 才能在同一 wave 平行執行；有 dependency
   的 Assignment 必須等待 prerequisite `done`。
3. Bridge 使用
   `agent.wait(workerPaneId, until=[idle, done, blocked, unknown])` 等待，不以
   `sleep` 或讀取一次畫面推論完成。
4. Worker 進入 `idle`／`done` 後，Bridge 使用
   `agent.read(workerPaneId, source=recent_unwrapped, lines=N)` 取得 bounded
   report；沒有 report 證據不得宣稱 Assignment 完成。
5. Worker 進入 `blocked` 時標記 Assignment `blocked`，保留 pane／task／
   assignment identity 與 observed blocker；Phase 2 保存 question ID 與有界畫面，
   接受明確 reply，沿用原 turn 接收完成報告後繼續排程。
6. Worker 進入 `unknown`、pane 不存在或 bounded wait timeout 時標記 `failed`，
   不靜默改派另一個 Worker；相依 Assignment 標記 failed／skipped。Herdr
   `agent_prompt_stalled` 不代表送達失敗；不得重送 prompt，須使用本次 marker
   繼續觀察至 timeout，再依是否取得有效 report 決定 done 或 failed。

### Timeout、重試與送達

- 目前實作使用設定的 `approvalTimeoutMs` 作為 Lead planning、Worker execution
  與 Lead synthesis 的 wait timeout，預設為 900000 ms；後續應拆成 planning、
  assignment、synthesis 與 task timeout。
- `agent.wait` 使用 bounded request，不因 timeout 自動重送 prompt。未確認送達
  的 prompt 不得盲目 replay，避免 Worker 重複執行。
- `agent.read` 只提供 bounded observed output，不代表完整 terminal history；
  report 必須標示來源 Agent、workspace、pane、Task ID、phase、Assignment ID、
  session 與 begin/end marker。
- 每一個 dispatch、wait、read 的結果都必須能對應到 task lifecycle event，避免
  bridge restart 或 Discord delivery retry 造成重複通知。

完整執行流程見 [1:1:N orchestration Draw.io](./team-orchestration-flow.drawio)。

## 狀態

Assignment 使用既有同一套狀態：

`pending`、`assigned`、`working`、`blocked`、`done`、`failed`、`cancelled`。

Task 使用 planning、running、blocked、synthesizing（包含直接工作／驗證）、cancelling、completed、failed、cancelled；轉移限制見 Phase 1 契約。

`done` 表示 Worker 已交付可驗證的結果；單純收到 prompt、回覆「收到」或
只有 progress 不得轉為 `done`。

## 回報格式

每個 Worker 回報至少包含：

- Task ID
- Owner
- Status
- Changed files
- Commands executed
- Test result
- Commit／push result
- Blocker
- Handoff information

## 安全與協作規則

- Lead 是唯一對 Human 的正式回報窗口。
- Worker 之間避免水平互相 mention，避免 ping-pong 與重複執行。
- 不可把「收到」或單純 progress 當成完成。
- 沒有實際測試結果，不得宣稱驗證完成。
- 不可讓兩個 Agent 同時修改相同檔案。
- Agent 若被 approval、登入或互動式 prompt 卡住，必須標記 `blocked`。
- 長期決策、handoff、blocker 與驗證結果可寫入文件或共享記憶；token、私鑰
  與未驗證推論不可寫入。

## 持久化、取消與安全邊界

`team status [task-id]` 與 `team cancel <task-id>` 受目前 workspace 與既有 allowlists 約束。
Task 保存 Lead、原 prompt、frozen roster、plans、實際 acquire session、Assignment state/report、active turns、timestamps 與 journal。
重啟不自動派送，舊 active 狀態轉 blocked 並保留 unknown/recoverable 核對結果；matching idle/done 不構成 completion evidence。
取消先持久保存 cancelling 並停止排程，僅對可確認 ownership 的 active session 送官方 Ctrl-C，確認停止後才 cancelled／release。
已完成 Worker、不相關 session、替換後的新 session 不送訊號；不關閉 pane／CLI。重啟後仍 active 的舊 turn 需人工檢查。

保留 Lead 自由分工、零 Worker、lazy start 與 existing-session reuse。取消途中 in-flight acquisition／dispatch 未結束時不得提前 release。
Phase 2 question queue 已實作；auto resume、retention、跨 bot writer lock 與 durable Discord delivery 仍未實作。

## 驗收

測試需涵蓋 state transitions、round trip、restart、stale running、whole-team cancellation、動態多輪、零 Worker及 ISSUE-014 回歸。
詳見 [Phase 1 live acceptance](durable-task-engine.md#live-acceptance-still-required)及 [known issues](known-issues.md)。
先前 Draw.io 為初版排程圖，未呈現新增 durable journal／restart quarantine／Phase 2 question queue；不得據此推論自動 resume 已完成。
