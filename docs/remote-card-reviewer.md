# 遠端卡片 reviewer：基礎層

REQ-20261111-remote-agy-role，ISSUE-143。2026-11-11，**未實機驗收**。

本文件是 **PR A（基礎層，#207）**：設定、驗證、遠端 checkout 與清理；沒有 `machines[].cardReview` 時不會被呼叫，行為與 main 相同。角色接線在相依的 PR #206（PR B）；B 合併前 reviewer 不能指定 remote。

## 設定

選填，改 `config.json` 後要重啟 bridge：

<!-- prettier-ignore -->
```jsonc
"machines": [{ "id": "agy-pod", "ssh": "agy-pod", "socket": "/root/.config/herdr/herdr.sock", "cardReview": { "root": "/root/hdb-card-review", "kinds": ["agy"] } }]
```

`root` 是 bridge 專用的遠端絕對路徑（≥2 段，不含 `.`／`..` 段、空白、控制或 shell 字元，段不以 `-` 開頭）；`kinds` 是允許種類（`claude`、`codex`、`agy`、`pi`，不重複）；其他欄位拒絕。`HerdrHub` 新增 `machineConfig`、`requestOn`（只送指定機器、不經快取）、`freshAgentsOn`（當下 Agent 清單）。

## 拉取、marker、身分、清理

- origin 只接受 github.com 的 https／ssh 位址，目錄 `<root>/<owner>__<repo>__<卡片雜湊>`；ssh 固定 BatchMode、ConnectTimeout、不轉送 agent／X11／連接埠，遠端指令以 `timeout -k 10` 包住（本機多等寬限），不轉送憑證，私有 repo 需 pod 自有 credential helper。
- 第一個遠端指令是 `timeout -k 1 5 true`；缺 GNU `timeout`（exit 127 或 busybox exit 1）丟「遠端缺少 timeout」，不誤報成 clone 失敗。
- 路徑須是 canonical：先遠端 `realpath` root 與 dir（單行絕對路徑），root 或祖先、dir、`dir/.git` 是符號連結或 realpath 異常都拒絕；marker 檢查、沿用與 `rm -rf` 只用驗過的路徑。
- 目錄不存在才 https clone 並寫 `<dir>/.git/hdb-card-review`（`hdb-card-review-checkout:v1:<卡片雜湊>`，不弄髒工作樹）。**沿用與清理一律要求 marker 相符**；無 marker（即使 origin 相同）、marker 不符、origin 不同、不是 repo 都拒絕、不碰。沿用還要工作樹乾淨（`git status --porcelain --untracked-files=all` 為空），否則拒絕、不 reset／clean、目錄留著記 `cleanup_pending：directory`。之後 fetch `refs/pull/<N>/head`、detached checkout，HEAD 須等於 PR head。
- workspace 用 `requestOn` 開在該機器；label 每次執行唯一（`review-<雜湊>-<8 hex>`）。create 逾時依 label 有界重查 3 次（間隔 2 秒），找到就關；耗盡仍找不到時狀態不明（create 可能在最後一次查詢之後才完成），記 `cleanup_pending：workspace` 要人工確認，console 帶 machine 與 label。
- 結束關 pane、workspace，刪目錄：「重取 realpath、確認 root 仍 canonical 且 dir 不是符號連結、marker 相符、再 `rm -rf -- <root 底下的直接子目錄名>`」合併成同一個遠端 `sh -c` 固定腳本，值只經位置參數傳入（不拼進腳本），先 `cd -P` 到 canonical root 再刪相對名稱；檢查失敗就不刪並回固定結果。**已知限制：**視窗只縮到單一指令內，無法完全消除（沒有 openat 語意的 shell 做不到），另一個程序在這個極短視窗內置換 root 或祖先仍有理論風險。`BLOCKED_AT_START` 保留；斷線、本機逾時或指紋階段 uncertain 失敗不刪，記 `cleanup_pending`，目前不重試。
- 結果文字只放行白名單（`RESULT_WHITELIST`）：先比完整字串（`BLOCKED_AT_START` 含「：」，要保留「卡在信任提示、需人工處理」的原因），再比「：」前的固定標籤，其餘是「遠端 review 失敗：未分類」；紀錄與通知只帶固定分類。`cleanup_pending` 的 workspace id／label、完整目錄路徑與 stderr 只進 console。

## 未驗證與後續

實機未跑：pod 的 git／`timeout`／`realpath`／repo 權限、`refs/pull` fetch、marker 寫入。測試是 `test/remote-checkout.test.ts`（fake exec）。後續：`git bundle` 上傳、remote 寫入角色、cleanup_pending 重試。
