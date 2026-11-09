# 多種 Lead 規劃：讓 agy、pi 通過開放條件

日期：2026-11-09。卡片 `REQ-20261109-autopick-four-leads`，issue 見 [ISSUE-130](known-issues.md)。

> **本文是規劃，不代表 agy、pi 已能當 Lead。** 目前只有 P0 的程式與單元測試；agy、pi 從未當過 Lead。所有結論附日期，沒有實機證據的項目明載「未驗證」。

## 範圍

- **本卡做：**`autopick_lead` 接受 claude、codex、agy、pi（單一值）；agy、pi 的開放條件；Lead 啟動等待。
- **本卡不做（另開卡）：**`autopick_lead` 多個與選擇規則；卡片指定 Lead；流程紀錄記 Lead 的選擇依據；`card assign` 指定 Lead。**`card assign` 目前沒有也不新增指定 Lead 的方式**，Lead 就是目前路由的 Agent（手動流程）或 `policy.yml` 的 `autopick_lead`（自動撿卡），兩者都不讀卡片欄位。
- Lead 角色目前已有紀錄：流程紀錄的 `role_assigned` 事件會記 `lead：<種類>`（ISSUE-127），本卡沒有新增紀錄。

## 開放條件（使用者選擇，2026-11-09）

Lead 是 agy 或 pi 時，`config.json` 的 `agentProfiles` 必須有**同種類**、且 `capabilities` 含 `implementation` 的 profile；否則 bridge 不撿這張卡，console 每張卡記一次原因，不改用別的 Lead。claude、codex 不需要。

- 這是「使用者明確宣告該種類的 coding 已驗證」，與 Worker 自動入池（ISSUE-107）同一個機制；bridge 不判斷 CLI 是否可靠。
- 所以要「通過檢查」，實際上是使用者在驗證後才在 profile 加上 `implementation`；下面的階段是在累積可以宣告的證據。
- 不是安全邊界：能改 `config.json` 的人（含同一個 OS 使用者的 Agent）就能宣告。

## 現況與證據

**agy**

- **已確認（2026-11-06，`REQ-20261106-agy-verify`，PR #141，ISSUE-107）：**當 `--coding` writer 走完一張卡；session 被正確登記；codex 獨立 review 為 pass；bridge 在 L2 merge。writer 的完成回報能被 bridge 讀到並登記成 artifact。
- **已知限制：**新資料夾會停在「信任這個資料夾」提示，bridge 不替人確認（ISSUE-113、ISSUE-116）；啟動時 Herdr 回報 `blocked`，`waitUntilReady` 只跳過已知的更新提示，其餘信任、權限、登入提示會以「blocked」失敗，要人處理。卡片 worktree 已有 `agy trust add` 的接線，但 Lead 在來源 workspace 啟動的路徑是否涵蓋**未驗證**。
- **未驗證：**當 Lead（規劃回覆的 JSON、多輪 session、hook 回報）；當 reviewer；權限提示的偵測與等人處理（目前只靠 Herdr 的 `blocked` 狀態，沒有 agy 專屬判斷）。`capabilities` 目前只標 `analysis`。

**pi**

- **沒有找到任何 coding 證據**（Worker、reviewer、Lead 都沒有）；只有圖片白名單（ISSUE-049），與 coding 無關。

## Lead 專屬的已知缺口（讀碼確認，影響尚未重現）

1. `runTeamTask` 沒把第 0 輪新登記的 session 回寫 `input.lead`；新啟動的 agy Lead 後續輪次可能用 null session。
2. `hookFinal` 有 session 時只查 `stopSince`，無結果不 fallback `stopForPane`，可能退回 terminal scraping。
3. `parseAssignmentPlan` 只有 codex 的 terminal fallback 做 JSON 硬換行 unwrap；非 codex 的長 JSON 可能失敗。
4. Lead 使用 CLI 預設參數，不套用 Worker profile 的 args／model。

這些先重現再修，這份規劃不宣稱它們已造成問題。

## 分階段

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 | 四種 Lead、agy／pi 開放條件、Lead 啟動等待（來源與 worktree） | **已實作，僅單元測試**：`npm run check` 為 1602 tests／1601 pass／0 fail／1 skipped，`npm run lint` 通過（2026-11-09，本機） |
| P1 | **agy 當 Lead 的驗證卡**（見下） | 未開始 |
| P2 | P1 通過後，使用者在 agy profile 長期宣告 `implementation`，讓 agy 當 autopick Lead 走完一張 L1 卡到 PR | 未開始 |
| P3 | **pi 重複 P1、P2**。pi 連 Worker 都沒驗過，順序是先驗 pi 當 Worker，再驗當 Lead | 未開始 |

**P1 步驟（agy 當 Lead，確保真的是 agy）：**

1. 先確認開放條件會擋：agy profile 不宣告 `implementation`，`policy.yml` 設 `autopick_lead: agy`，重啟 bridge，ready 一張無害卡，預期 bridge 不撿並在 console 記原因。
2. 使用者**暫時**在 agy profile 加 `implementation`（視為驗證用宣告），重啟 bridge，同一張卡預期被撿，Lead workspace label 為 `autopick-agy-<卡片 id>`。
3. 以卡片流程紀錄的 `role_assigned` 的 `lead：agy` 與 task journal 的 Lead 種類確認 Lead 真的是 agy；一張只改一個文件檔的卡走到 PR（L1）。
4. 記錄遇到的缺口（上節 1 到 3）、逐一重現與修正；失敗就移除宣告並記進 ISSUE-130。

手動路徑只能當輔助：`card assign` 用目前路由的 Agent 當 Lead，要先 `agent use` 選定 agy pane，並同樣用 `role_assigned` 確認。

每個階段都附日期、環境與結果；單元測試通過不等於該階段完成。

## Worker 與 reviewer 組合

- reviewer 偏好：codex Lead 用 claude，其餘（含 agy、pi）用 codex（`reviewerFor`）；這只是偏好，**驗收依據是作者與 reviewer 為不同 session 的 gate**。
- Worker 自動入池不因 Lead 改變：claude、codex 預設；agy 需 `implementation` 或 `review`；pi 不自動入池。
- Lead 不能指派自己，review 也不能與作者同 session（既有規則）。

## 風險

- agy 在新資料夾的信任提示可能讓 Lead 啟動卡住；bridge 不會替人確認。
- pi 沒有任何 coding 證據，P3 可能發現大量缺口。
- L2 專案下 Lead 失敗後的卡可能留下未 commit 的 worktree（REQ-20261109-codex-lead-agy 實際發生過），要人工處理。
- 開放條件只看使用者的宣告，宣告錯誤時 bridge 不會攔。

## 驗收

- [ ] P1：agy 當 Lead 走完一張無害卡，附日期與環境。
- [ ] P2：宣告後 agy 當 autopick Lead 走到 PR。
- [ ] P3：pi 當 Worker、再當 Lead 的同等證據。
- [ ] 以上完成前，文件與 issue 都標「待驗收」，不宣稱 agy、pi 可當 Lead。
