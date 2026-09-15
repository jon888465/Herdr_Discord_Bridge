# Team Orchestration 規格

狀態：第一階段已實作，持久化／recovery／取消與 blocked continuation 尚未實作。

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
Worker dispatch、bounded Worker report 與 Lead synthesis。尚未有 task persistence、
restart recovery、cancel command、heartbeat cleanup 或 blocked Worker 的後續
問答路由；因此本文件的完整 contract 仍不是全部可用功能。

## 角色

### Human

- 提出總任務與接受最終結果。
- 可指定限制、驗收條件與是否允許修改、commit、push。

### Lead Agent

- 由目前 Discord thread 的 active Agent 擔任。
- 分析總任務並拆分成可獨立執行的子任務。
- 將子任務分配給現有 Team members。
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
   才 fallback 到 transcript 中的 JSON object；最後驗證 Assignment ID、Worker
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
   assignment identity 與 observed blocker；目前第一階段會將 blocker 納入
   Lead synthesis，但尚未實作 question ID、使用者回覆與繼續 dispatch。
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

Multi-Agent Task／Assignment 使用下列狀態：

`pending`、`assigned`、`working`、`blocked`、`done`、`failed`、`cancelled`。

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

## 1. 目的

當 Discord thread 有 Team 且收到 Team Task 時，active Agent 成為 Lead。Lead
會拆解請求為子任務（Assignment）。Bridge 驗證並將這些 Assignment 分派給不同
的 Team Participant，監控其 Herdr 狀態，收集有界限的回報，最後要求 Lead
統整結果並回報使用者。

預期關係如下：

```text
1 位 Discord 使用者／thread
        -> 1 個 Team Task
        -> 1 個 Lead + N 個 Participant
        -> N 個 Assignment
        -> 1 個 Synthesis 回應
```

## 2. 入口與使用者體驗

現有指令仍是入口：

查看目前 Team 成員使用：`@bridge team list` 或 `/herdr team list`。

```text
@bridge team ask <task>
```

只有目前 thread 有 Team 時，這個指令才會從直接 fan-out 改為 orchestration。
沒有 Team 的 thread 維持目前錯誤行為，要求使用者先加入 participants。

開始前，Bridge 會解析並驗證：

1. active Agent 作為 Lead；
2. 所有 Team Participant；
3. workspace 授權與 live pane identity；
4. 沒有 target 存在衝突中的 active stream。

Bridge 會發布包含 Lead、凍結後 Roster 與 task ID 的 task receipt。每個
Assignment 都有自己的標示與 progress message。Final message 包含 Lead 的
Synthesis 與精簡的 Assignment 摘要。

## 3. 規劃契約

Lead 會收到使用者任務與嚴格的規劃指示。除非規劃明確標示某 Assignment 必須
循序執行，否則每個可用 Participant 最多只能分配一個 Assignment。

```json
{
  "assignments": [
    {
      "id": "backend",
      "participantPaneId": "w2:p3",
      "instruction": "Implement the backend change and run its tests.",
      "dependsOn": []
    }
  ]
}
```

契約由 Bridge 而非 Lead 強制執行：

- Assignment ID 必須唯一；
- 每個 target 必須在凍結後的 Roster 中，且不能是 Lead；
- dependency 必須引用既有 Assignment，且不可形成循環；
- instruction 必須有界限，且不得包含控制字元；
- 每個 Participant 同一時間最多有一個 active Assignment；
- 不明 target 或格式錯誤的 plan 一律 fail closed。

第一版中 Lead 只能擔任 planner、monitor 與 synthesizer，不能為自己保留
Assignment；未來版本才可擴充此能力。

## 4. 排程與監控

沒有未完成 dependency 的 Assignment 會在設定的 concurrency limit 內平行
dispatch。Dependency 完成後，scheduler 會 dispatch 新解除阻塞的 Assignment。

Herdr 狀態處理如下：

| Herdr 狀態              | Assignment 行為                                 |
| ----------------------- | ----------------------------------------------- |
| `idle`                  | 可供 dispatch                                   |
| `working`               | 執行中；不可再 dispatch 其他 Assignment         |
| `blocked`               | 暫停 Assignment，使用既有 Discord approval 流程 |
| `done`／工作後的 `idle` | 收集 report 並標記 completed                    |
| `unknown`               | 不推論成功；標記可觀察到的 failure 或要求檢查   |
| pane／Agent 不存在      | 標記 failed，並停止相依的 Assignment            |

Team Roster 在 task 期間保持凍結。Discord Team 新增或移除成員只影響下一個
Team Task。

## 5. 統整

所有 Assignment 進入 terminal state 後，Bridge 會送給 Lead 一個有界限的
synthesis prompt，包含：

- 原始使用者任務；
- Assignment plan；
- 每個 Assignment 的狀態與有界限 report；
- failure、blocked 工作與被跳過的 dependency；
- 要求區分已完成事實與推測。

Lead 的 response 會作為最終使用者可見結果發布。Bridge 不得宣稱 failed 或
Team 成員只允許來自同一 workspace；thread routing state 會持久化，重啟後保留成員 mapping。若 pane 或 CLI 未啟動，該成員顯示為 stale 且不可派送。
skipped Assignment 已完成。若 Lead 無法使用，Bridge 會發布已收集的 reports，
並將 synthesis 標記為 failed，不得默默選擇另一個 Lead。

## 6. 狀態模型

```text
planning -> dispatching -> running -> synthesizing -> completed
     |           |            |             |
   failed      failed       failed        failed
     \___________ 使用者要求取消 cancelled __________/
```

Assignment 狀態獨立追蹤為 `pending`、`running`、`blocked`、`completed`、
`failed` 或 `cancelled`。

取消會停止後續 dispatch，並對執行中的 Assignment 發送官方 Herdr cancel
operation；不會關閉 pane 或停止 Herdr。

## 7. 持久化與可觀測性

每個 Team Task 至少記錄：

```json
{
  "taskId": "...",
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordThreadId": "...",
  "lead": { "workspaceId": "...", "paneId": "...", "agentName": "..." },
  "roster": [],
  "assignments": [],
  "state": "running",
  "createdAt": "...",
  "updatedAt": "..."
}
```

持久化紀錄用於 recovery、狀態回報與 audit。它只儲存有界限的 reports 與
statuses，不儲存不受限制的 terminal history。

## 8. 安全性與非目標

- Task 期間不自動建立 workspace、pane、worktree 或 Agent。
- 不執行由 Lead 產生的任意 shell command。
- Agent busy、stale、未授權或有歧義時，不靜默重新分派。
- 除非未來明確政策允許，不同 Assignment 不得同時寫入相同檔案。
- 不轉發 hidden chain-of-thought，只轉發有界限的 observed reports。
- 第一版不自動 merge 或處理 conflict。

## 9. 驗收條件

- Team Task 使用開始時的 active Agent 作為 Lead。
- Lead 的 plan 在任何 child Assignment dispatch 前先完成驗證。
- 獨立 Assignment 在不同 Team Participant 上執行。
- 相依 Assignment 等待 prerequisite 完成。
- Discord 顯示 task、assignment、blocked、failed 與 final synthesis 狀態。
- 完成的 task 包含每個 Assignment 的 terminal status。
- 過期或格式錯誤的 target 不得收到 prompt。
- Restart/recovery 不會重複 dispatch Assignment 或重複 final synthesis。
