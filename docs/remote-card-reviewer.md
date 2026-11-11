# 遠端卡片 reviewer：基礎層

REQ-20261111-remote-agy-role，ISSUE-143。2026-11-11 原始碼與自動化測試完成，**未實機驗收**。

基礎層（設定、驗證、遠端 checkout、marker、清理）在 PR #207（PR A），角色與接線在 PR #206（PR B，依賴 A；A merge 後 B 要 rebase）。沒有 `machines[].cardReview` 設定時一切不變。

## 範圍

只有 card reviewer（PR 後的 review／loop，唯讀）可在 remote 執行；implement／fixer 拒絕「remote 寫入尚未支援」，diagnose／review／verify 拒絕「remote 目前只支援 reviewer」。卡片：`roles: {implement: "local:claude:opus", reviewer: "agy-pod:agy"}`。

**資料流：**卡片標題、描述、驗收條件與 PR diff 會隨 review prompt 送到 pod 上的 agy；只對使用者信任的 machine 開 `cardReview`。

## 設定

選填，bridge 不改 `config.json`，改後要重啟：

<!-- prettier-ignore -->
```jsonc
"machines": [{ "id": "agy-pod", "ssh": "agy-pod", "socket": "/root/.config/herdr/herdr.sock", "cardReview": { "root": "/root/hdb-card-review", "kinds": ["agy"] } }]
```

`root` 是 bridge 專用的遠端絕對路徑（≥2 段，不含 `.`／`..` 路徑段、空白、控制或 shell 字元，路徑段不以 `-` 開頭）；`kinds` 是允許種類（`claude`、`codex`、`agy`、`pi`，不可重複）。其他欄位一律拒絕。`HerdrHub` 新增 `machineConfig`、`requestOn`（只送指定機器，不經快取，ID 參數必須帶該機器前綴）與 `freshAgentsOn`（當下 Agent 清單）。

## 名單與守門（PR B）

Lead prompt 列 remote reviewer 候選（machine／kind／profile／model），由 bridge 在 PR 後派工，不是 Team Worker target。machine 須有 `cardReview` 且 agent 在 `kinds`，否則撿卡前拒絕「machine 未開放卡片 review」。快照凍結 `remoteMachines` 並重驗；readiness 與送 prompt 前讀當下遠端清單（`freshAgentsOn`）驗身分；main 只在 `HerdrHub` 才注入遠端介面（`remoteReviewInjection`）。

## 拉取、marker、身分、清理

- origin 只接受 github.com 的 https／ssh 位址（`githubOriginRepo`），目錄 `<root>/<owner>__<repo>__<卡片雜湊>`。
- 第一個遠端指令是 `timeout -k 1 5 true`：每個遠端指令都由 GNU `timeout` 包住，遠端沒有時（exit 127，或 busybox 的 usage error exit 1）丟固定標籤「遠端缺少 timeout」，不誤報成 clone 失敗。
- 目錄不存在才固定參數 https clone，clone 後在 `<dir>/.git/hdb-card-review` 寫 marker（`hdb-card-review-checkout:v1:<卡片雜湊>`；放 `.git` 裡，不弄髒工作樹與指紋）。**沿用既有目錄與清理一律要求 marker 存在且內容相符**；沒有 marker（即使 origin 相同）、marker 不符、origin 不同或不是 repo 的目錄都拒絕，不碰、不視為 bridge 所有。之後 fetch `refs/pull/<N>/head`、detached checkout，HEAD 須等於 PR head。
- ssh 用 BatchMode、ConnectTimeout、ForwardAgent=no、ForwardX11=no、ClearAllForwardings=yes；遠端指令以 `timeout -k 10` 包住，本機多等寬限。argv 每個元素都以 shell 單引號包住，不接受控制字元；不轉送憑證，私有 repo 需 pod 自有 credential helper。
- workspace label 每次執行唯一（`review-<卡片雜湊>-<隨機 8 hex>`）：`workspace.create` 失敗時依 label 關閉，不會關到前一次保留給人處理信任提示的 workspace。
- 清理：關 pane／workspace，只刪 root 直接子目錄且 marker 相符的目錄（目錄已不存在視為已清理）；斷線或本機逾時（遠端可能仍在跑）不刪，記 `cleanup_pending`，目前不重試。
- 紀錄與通知只帶固定分類（逾時、連線失敗、clone 失敗、遠端缺少 timeout、HEAD 與 PR head 不符等）。`cleanup_pending` 的定位資訊只進 console：workspace 關閉失敗帶 workspace id 與 label，目錄 pending 帶完整目錄路徑；machine id、stderr 不進紀錄與通知。

## 未驗證與後續

實機未跑：pod 的 git／`timeout`／repo 權限、`refs/pull` fetch、marker 寫入、agy 信任提示（ISSUE-113／116，第一次很可能停在這裡並保留 pane，保留的 workspace 之後要人工關閉）。單元測試用 fake exec／fake port：`test/remote-checkout.test.ts`（A）、`test/card-role-remote.test.ts`（B，含 main 的接線 helper）。驗收：merge A、B，加 `cardReview`、重啟後跑一張無害卡，確認 `role_assigned` 的 reviewer 為 agy-pod／agy、遠端 HEAD 相符、結果寫回、已清理。後續：本機 `git bundle` 上傳取代 GitHub 拉取、remote 寫入角色、cleanup_pending 重試。
