# 待做功能

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
