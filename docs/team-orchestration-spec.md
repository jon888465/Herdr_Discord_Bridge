# Team Orchestration 規格

狀態：規劃中，尚未實作。

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

| Herdr 狀態 | Assignment 行為 |
| --- | --- |
| `idle` | 可供 dispatch |
| `working` | 執行中；不可再 dispatch 其他 Assignment |
| `blocked` | 暫停 Assignment，使用既有 Discord approval 流程 |
| `done`／工作後的 `idle` | 收集 report 並標記 completed |
| `unknown` | 不推論成功；標記可觀察到的 failure 或要求檢查 |
| pane／Agent 不存在 | 標記 failed，並停止相依的 Assignment |

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
