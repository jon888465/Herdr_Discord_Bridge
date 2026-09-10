# 待做功能

## 已實作基礎：bridge 本機單 Agent 互動（2026-09-10，待驗收）

`agent use <pane>` 自動開始本機可見畫面觀察；顯示進度／問題，blocked 時可從 bridge 回答，控制指令在各狀態持續可用。這是 40 行／6,000 字元的 terminal snapshot，不是下述完整 Discord mirror。詳見 SPEC「本機選取 Agent 後的互動」及 ISSUE-011。

後續多 Agent 問題須有 task／assignment／question identity 與回覆 UI／排隊；尚未決定是否凍結其他輸出，不自動暫停其他 Agent。Herdr GUI 選擇與 Discord select menu 仍待評估；`focus` 只改畫面焦點，不能作為 routing 選擇的替代。

## 將 Herdr 內直接互動鏡像轉發到 Discord

狀態：規劃中，尚未實作。

### 功能目標

使用者直接在 Herdr pane 內與 Agent 互動時，將問題與回應轉發到該 pane 綁定的 Discord 討論串（thread），保留問答的上下文。

此流程與現有的 Discord → Herdr 發問流程分開處理。Bridge 不得將鏡像訊息再次送回 Herdr，也不得形成重複派送循環。

### 預計使用方式

在目前的 Discord 討論串中，選擇 pane 並啟用鏡像：

```text
/herdr use w2:p1
/herdr mirror on
```

預計提供的管理指令：

```text
/herdr mirror off
/herdr mirror status
```

啟用後，直接在 `w2:p1` 輸入的問題，以及 Agent 完成後的回應，都會發布到同一個 Discord 討論串。鏡像訊息應標示來源 Agent、工作區（workspace）與窗格（pane）。

以上指令為功能提案，目前尚不可使用。

### 第一版範圍

- 單向轉發：Herdr pane → 綁定的 Discord 討論串。
- 每組討論串與 pane 綁定均須明確啟用，預設關閉。
- 每個鏡像 pane 路由只對應一個 Discord 討論串；目的地不明確時拒絕轉發。
- 透過讀取位置（cursor）或內容指紋去重，避免輪詢與 bridge 重啟後重複轉發。
- 長回應依 Discord 訊息限制安全分段。
- 發布前移除 ANSI 與終端控制序列。
- 不轉發隱藏推理，也不轉發與本輪問答無關的完整終端歷史。

### 實作規劃

1. 新增可持久儲存的 `MirrorRoute`，包含 pane／terminal 識別、Discord 伺服器（guild）／頻道（channel）／討論串識別、啟用狀態，以及最後觀察到的讀取位置。
2. 新增 `AgentOutputWatcher`，偵測 Herdr 內直接輸入的問題與 Agent 完成的輸出。目前 watcher 只提供狀態轉換，沒有原始終端輸出事件，因此初期可使用 Herdr 輪詢。
3. 新增 `MirrorRelay` 模組，負責路由驗證、問答邊界辨識、去重、輸出格式化與 Discord 傳送。
4. 儘量重用現有 CLI adapter、Discord 分段及錯誤處理，並透過模擬的 Herdr／Discord adapter 測試 watcher。
5. 補上本地直接發問、長輸出、重複輪詢、bridge 重啟恢復、失效 pane、路由歧義、Agent 等待核准，以及 Discord 傳送失敗等測試。

### 驗收條件

- 在已啟用鏡像的 Herdr pane 內直接發問，問題只在綁定的 Discord 討論串出現一次。
- 該輪完成的回應只在同一討論串出現一次，並保留問題與回應的對應關係。
- 原本從 Discord 發出的問題不會因鏡像模式而重複發布。
- 關閉鏡像後停止轉發，但不停止 Agent 或 Discord bot。
- 路由缺失、失效、未授權或有歧義時，不廣播內容。
- 長回應保持可讀，不會僅因需要分成多則訊息，就被顯示為 `no response`。




以下保留早期討論紀錄；其中以 focus 代替 routing 的方案已撤回，現行範圍以文首與 SPEC 為準。

  - Discord：提供 Agent／workspace 的 select menu。
  - Herdr：使用原生 TUI／CLI 的 herdr agent focus <target> 選擇
    Agent。

  - 1:1:N Task、mirror、agy 互動都納入同一輪實作與驗收。

  目前調查確認 Herdr 沒有可由 plugin 擴充的瀏覽器式 GUI；因此 Herdr 端
  會整合原生 TUI focus，而 Discord 端提供真正的點選介面。這項限制與待
  驗收內容已記錄在 ISSUE-010。

──────────────────────────────────────────────────────────────────────

─ Conversation recap ─────────────────────────────────────────────────

  已確認採用第 3 方案：Discord 使用 Agent/workspace select menu，Herdr
  使用 `herdr agent focus <target>`，並一併實作與驗收 1:1:N Task、
  mirror、agy 互動。已知 Herdr 無 plugin 可擴充的瀏覽器 GUI；下一步是
  完成整合與驗收。


› herdr focus在這次題問世要解決什麼問題


• herdr focus 在這次需求中不是必要功能。

  它只會把 Herdr TUI 的視覺焦點切到某個 Agent pane，不能解決：

  - 1:1:N Team Task 的 Lead／Participant routing
  - Discord thread 到 Agent 的 mapping
  - mirror 到 Discord
  - agy 追問與使用者回覆
  - workspace Team 的 active Agent 選擇

  因此這次應區分：

  - 「選擇要派任務的 Agent」：由 Bridge routing／Discord select menu
    處理。

  - 「讓 Herdr 畫面跳到該 pane」：才使用 herdr focus，屬於可選的 UI
    convenience。

  我會把 Herdr focus 從必要方案移除，不讓它被誤當成 Team Task 或
  mirror 的核心依賴。


› workspace Team 的 active Agent 選擇 ->這個呢


• workspace Team 的 active Agent 選擇 是這次需求的核心，但它不應依賴
  herdr focus。

  正確分工是：

  - Team 的 active Agent：由 Bridge routing state 保存，例如
    workspaceTeams[w2].activeAgentKey。

  - Discord 的 agent use w2:p4：只更新目前 Discord thread/user 的
    active Agent。

  - Pane 的 agent use w2:p4：更新 workspace Team 的 active Agent。
  - herdr focus：只改 Herdr TUI 顯示焦點，不改 Team，也不改 Discord
    routing。

  所以 Team Task 開始時，Lead 應從 workspace Team 的 activeAgentKey 讀
  取；若沒有 active Agent，就拒絕啟動並要求先選擇。 Discord select
  menu 應更新 Discord route，若要選 workspace Team active Agent，則需
  要明確的 workspace Team 選擇操作。
