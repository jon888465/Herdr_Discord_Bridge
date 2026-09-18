# Agent Pool 與 Console 分離

日期：2026-09-18。原始碼實作與驗證狀態見 [ISSUE-015／016](known-issues.md)；尚未重啟／部署或 live 驗收。
需求來源：[Herdr 自動分工流程分享對話](https://chatgpt.com/share/6aac9d08-6f70-83ee-bd68-153e15dffa69)。採用使用者後續澄清：不固定 coding 角色，保留長駐 session，use 不自動 attach。

## 分工

| 層               | 已實作責任                                                  |
| ---------------- | ----------------------------------------------------------- |
| Console／Discord | 路由使用者指令、呈現回覆；本機檢視模式與對話路由獨立        |
| Team／Profile    | workspace 可使用的設定清單；尚未啟動的成員也可勾選          |
| Lead             | 決定零或多個 Worker、相依關係、後續工作與最終驗證           |
| AgentPool        | acquire/release、租用互斥、持久化 session 綁定與 continuity |
| Herdr            | 依實際 pane 尺寸分割、啟動長駐 CLI、送 prompt／等待／讀取   |

`src/agent-pool.ts` 封裝 profile 授權與 session lifecycle；`src/team-orchestration.ts` 驗證 Lead 計畫並排程；`src/team-turn.ts` 關聯本次回覆。既有 Discord 單 Agent streaming 保留。

## 設定與使用

在 plugin config.json 加入：

```json
{
  "agentProfiles": [
    {
      "id": "helper",
      "kind": "codex",
      "capabilities": ["implementation", "analysis"]
    },
    { "id": "reviewer", "kind": "codex", "capabilities": ["review"] }
  ]
}
```

模型未指定時使用 CLI 預設。指定 `model` 時 Codex 預設 `modelFlag=-m`，Claude 預設 `--model`；其他 kind 必須提供正確 modelFlag。`args` 是字串陣列，直接交给官方 `agent.start`，不組合 shell。Profile 不會替你安裝 CLI、登入帳號或猜測可用模型。修改設定需下次啟動載入；本輪未修改使用者的實際設定。

```text
agent use <lead-pane>
team pool
team select
```

本機清單顯示 `[x]`／`[ ]`；輸入一或多個編號切換，`done` 原子儲存，`cancel` 放棄。這是 readline 的編號勾選介面，非 Herdr 原生 GUI widget。Discord／腳本可用：

```text
team select helper on
team select reviewer on
team add profile:helper
team remove profile:reviewer
```

勾選代表該 workspace 的 Lead 可以使用 profile，不會立即啟動。若已有想重用的 CLI：

```text
team bind helper <worker-pane>
team ask <任務>
```

Bind 檢查 workspace、kind 與 idle/done；不重新設定既有 CLI 的模型，操作者應先確認。未綁定 profile 按需建立長駐 CLI；不依同名 pane 猜測 identity。Lead 本身仍需先啟動並選取。

## 分派與 context

Lead 只可使用凍結 roster 中的 live pane 或 `profile:<id>`，角色自由決定，空 assignments 表示進入直接處理／驗證／統整。每輪工作完成後再詢問 Lead 是否追加工作；最多 8 次 planning、每輪 16 項、總共 64 項。ID 跨輪唯一、依賴限同輪；同 Worker 每波只執行一項。

Acquire 回報 `new-session`、`same-session` 或 `unknown`。同 pane 不代表同 context；既有綁定須核對 terminal、workspace、kind 與 session kind/value。缺少 metadata 不聲稱延續。新 session prompt 包含原任務、Assignment 與已完成的有界報告，並要求核對實際 repository 狀態；不會複製完整 context 或 hidden reasoning。

Release 保留 CLI 與 pane。Team 勾選與綁定寫入 state directory 的 agent-pool.json，重啟後重新核對；這不代表 task 可以恢復。啟動前先持久記錄 uncertain，split/start 不盲目重試；送達不明時先檢查 pane，再 `team bind`。失敗建立的 pane 留下供檢查，不自動關閉。版面太小則拒絕新增，可調整版面或 bind 現有 pane。

## Console

| 操作                               | 結果                                          |
| ---------------------------------- | --------------------------------------------- |
| `use <agent>` / `agent use <pane>` | 選對話目標，預設不印 CLI UI                   |
| `ask <prompt>` / 普通文字          | 送入所選長駐 session，呈現本次明確回答        |
| `attach [pane]`                    | 有界 visible snapshot inspector，不改對話目標 |
| `watch [pane]`                     | 狀態變化，不改對話目標                        |
| `detach` / `agent detach`          | 關閉 inspector，回安靜對話；不停止 Agent      |
| `read [pane]`                      | 一次性明確讀取終端輸出                        |

Blocked 問題保留有界畫面及原有「已顯示問題、identity、state sequence」驗證；檢視其他 Agent 不會把回答改送給它。要回答另一 Agent 需先 use 選取。新 prompt 在 working/unknown 時仍拒絕；不注入第二個並行對話。Codex 優先使用相符 transcript final；其他來源只接受本次隨機 marker 回覆。無法取得時顯示 capture incomplete，從 read/attach 診斷。

## 驗收與尚未完成項目

自動化涵蓋 profile 授權、lazy start、既有 session 重用、重啟、busy／替換、並行 acquire、啟動送達不確定、動態追加任務、零 Worker 與 console 模式。結果記錄於 known-issues。

Live 驗收需在授權環境依序確認：勾選未啟動 profile → Lead 只啟動所需成員 → 正確 cwd／模型且不搶 focus → 第一次任務 → 同 session 追加修正 → 明確來源的完整回覆 → use 不刷 CLI → attach/detach 不改目標 → blocked 問答 → 重啟後重用。

仍未完成 task persistence/recovery、Team 多問題佇列／續接、跨 bridge 全域租用、原生 PTY 串流 attach、Discord mirror、完整事件匯流排。CLI 若不遵守 marker 或畫面截斷，擷取會失敗而非假裝完整。未重啟的 bridge 仍執行旧版本；舊任務與訊息不自動補送。
