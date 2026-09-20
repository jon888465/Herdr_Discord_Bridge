# Phase 2: Team question queue

2026-09-20：原始碼與 fixture 已實作，live Herdr／Discord／CLI 尚待驗收（ISSUE-012）。

## 使用與路由

```text
team questions <task-id>
team reply <task-id> <question-id> <answer>
team status <task-id>
team cancel <task-id>
```

Discord 使用 `/herdr` 前綴。問題通知包含 task、assignment（Lead 則顯示 planning/synthesis）、Agent、pane、問題 ID 與 40 行／6,000 字元 visible snapshot。`team questions` 可重新查詢，不依賴通知成功。問題可能包含工具核准內容，使用者須閱讀後明確回答；Lead 不代答。

Console 必須選取 task 的 workspace；Discord 除既有 guild/channel/user allowlist 外，還必須符合 task 建立時的 guild/channel/thread。Console 可在該 workspace 以明確 task/question ID 回答 Discord task。更換 active Agent 或 attach/watch 不改變問題目的地。普通 ask、thread approval 與 pane cancel 不得繞過 Team reservation。回覆保留大小寫與內部空白，長度 1–12,000 字元。

## 狀態與續接

- 同一 task 最多保存 128 個歷史問題，可有多個 pending questions，依開啟順序保存；可任意選擇問題回答，不採「最新問題」猜測。
- 每題綁定 frozen task、實際 acquired Worker／Lead identity、phase、assignment、session、state_change_seq 與有界畫面 fingerprint。
- 回答前再讀 live identity、blocked 狀態、visible snapshot，再核對 identity／sequence。缺少明確 session metadata、過期、已回答、取消、重啟與被替換的問題皆拒絕。
- 問題／reply intent／結果寫入同一 atomic task journal。pending → sending 在送字前持久化；只使用既有 sendAgent API 且 retries=0。送達失敗標 unknown，不重試，也不以變動畫面開啟同 pane 的替代問題來重送答案。
- 新問題取代舊 pending ID 時，舊問題標 stale；已答畫面在同 sequence 下不重複開題。無 sequence 且畫面完全相同的下一題无法可靠識別，需人工檢查，不猜測。
- Task 有 pending/sending 問題時呈 blocked，其他同 wave Worker 繼續工作。既有 scheduler 仍以 wave barrier 等待，依賴工作與後續 wave 在必要報告完成後才派送。Assignment blocked → working → done 沿用既有 lifecycle。
- 回答後沿用原 runTeamTurn 的 nonce／transcript receiver，不建立第二個 prompt／Assignment、不重播原任務。Lead planning 與 synthesis 也可提問，所有必要報告完成才作最終統整；動態 replanning、零 Worker、lazy start／session reuse 不變。
- Turn 的原有 timeout 包含使用者回答等待，回答不延長 timeout。執行觀察結束時未答問題 stale；有未確認 turn 時 task 保留 blocked/unknown，需人工核對／取消，不假報完成。
- Cancel 先禁止回答與派送，等待 in-flight reply，再核對停止、關閉待處理問題及釋放 reservation。Herdr 沒有原子 compare-question-and-send，外部手動 pane 操作仍有核對與送字之間的競態。

## 持久化／重啟

新寫入使用 schema v2，可讀取 v1 並於下一次 mutation 升級；v1 optional origin/questions 可缺省。未知版本拒絕啟動；舊 Phase 1 binary 無法讀取 v2，不支援直接降版。問題 identity／歷史不可刪改，狀態轉移會驗證。

重啟將 pending/sending 問題標 unknown，保留畫面與 identity 供查詢，但不恢復舊等待函式或自動送答。原 Phase 1 session quarantine／人工核對與取消規則不變；不宣稱重啟後可繼續原 turn。未實作 Discord durable delivery retry、按鈕/select UI、journal compaction、多 bot 共用 state writer lock、方向鍵選單或 CLI 未回報 blocked 的追問。

## Live 驗收

記錄 bridge commit、Herdr／CLI 版本、task/question IDs、來源 thread 與畫面：

1. 兩 Worker 同時 blocked，在 Discord／console 反向順序答題，確認不串線、其他 Worker 不被中斷。
2. Lead planning、零 Worker direct synthesis、多輪 Worker 再次追問，檢查回覆最終仍由 Lead 統整。
3. 換 thread/workspace、session replaced、畫面更新、重複及跨介面同時回答皆拒絕錯誤送答。
4. reply acknowledgement 遺失、回答途中取消、timeout、blocked 中重啟；不重送、不假 completed、不提前釋放 reservation。
5. 驗證原 ISSUE-014 settlement 與 conversation／attach／watch 分離。

自動化 fixture 不代表以上 live 驗收。本輪沒有部署／重啟或對使用者真實 CLI 送字。
