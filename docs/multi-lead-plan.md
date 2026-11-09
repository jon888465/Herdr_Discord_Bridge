# 多種 Lead 規劃：讓 agy、pi 通過開放條件

日期：2026-11-09。卡片 `REQ-20261109-codex-lead-agy`，issue 見 [ISSUE-130](known-issues.md)。

> **狀態：程式部分已在 PR #185，文件在本 PR。本文是規劃，不代表 agy、pi 已能當 Lead。** 所有數字與結論都附日期；沒有實機證據的項目明載「未驗證」。

## 目標（使用者 2026-11-09）

1. 自動撿卡的 Lead 可以是 claude、codex、agy、pi。
2. `autopick_lead` 可設多個，但自動撿卡一次仍只做一張卡。
3. 卡片可指定自己的 Lead。
4. **agy、pi 都要能通過「開放條件檢查」。**

## 開放條件（使用者選擇，2026-11-09）

Lead 是 agy 或 pi 時，`config.json` 的 `agentProfiles` 必須有**同種類**、且 `capabilities` 含 `implementation` 的 profile，否則 bridge 不撿這張卡，並在 console 對每張卡記一次原因，不改用別的 Lead。claude、codex 不需要宣告。

- 這是「使用者明確宣告這個種類的 coding 已驗證」，與 Worker 自動入池（ISSUE-107）使用同一個機制；bridge 不自己判斷 CLI 是否可靠。
- 「通過檢查」的實際意義是：**使用者在驗證完成後，才在 profile 加上 `implementation`**。所以下面的階段是在替使用者累積可以宣告的證據。
- 這不是安全邊界：能改 `config.json` 的人（包含同一個 OS 使用者的 Agent）就能宣告。它的作用是避免未驗證的種類被誤選為 Lead。

## 現況與證據

| 項目 | agy | pi |
|---|---|---|
| 當 `--coding` writer | **有一次實機證據**：`REQ-20261106-agy-verify`（PR #141，2026-11-06），session 登記正確、codex 獨立 review pass、bridge 在 L2 merge（ISSUE-107） | **沒有找到任何證據** |
| 當 reviewer | 未驗證 | 未驗證 |
| 當 Lead | **從未驗證** | **從未驗證** |
| 啟動就緒 | 新資料夾會停在「信任資料夾」提示（ISSUE-113、ISSUE-116）；已有 `agy trust add` 的接線，但 Lead 路徑是否涵蓋未驗證 | 未驗證 |
| 其他 | `capabilities` 目前只標 `analysis` | 只有圖片白名單（ISSUE-049），與 coding 無關 |

## Lead 專屬的已知缺口（ISSUE-130，讀碼確認、影響尚未重現）

1. `runTeamTask` 沒有把第 0 輪新登記的 session 回寫 `input.lead`；新啟動的 agy Lead 後續輪次可能用 null session。
2. `hookFinal` 有 session 時只查 `stopSince`，無結果不 fallback `stopForPane`，可能退回 terminal scraping。
3. `parseAssignmentPlan` 只有 codex 的 terminal fallback 做 JSON 硬換行 unwrap；非 codex 的長 JSON 可能失敗。
4. Lead 使用 CLI 預設參數，不套用 Worker profile 的 args／model。

這些都要先重現再修，**這份規劃不宣稱它們已造成問題**。

## 分階段

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 | 政策接受四種、可列多個；卡片 `lead:`；Lead 啟動等待 working → idle／done（來源與 worktree）；開放條件檢查 | **已實作、僅單元測試（PR #185）** |
| P1 | **agy Lead 驗證卡**：用 `card assign --worktree --coding` 讓 agy 當 Lead 跑一張無害卡（改一個文件檔），在 `policy.yml` 把 `autopick_lead` 暫設 `claude, agy` 並由卡片 `lead: agy` 指定。先預期會遇到上面 1 到 3 的缺口，逐一重現、修正、補測試 | 未開始 |
| P2 | agy 通過後，使用者在 agy profile 加 `implementation`，再讓 agy 當 autopick Lead 走完一張 L1 卡到 PR | 未開始 |
| P3 | **pi 重複 P1、P2**。pi 連 Worker 都沒驗過，順序是先驗 pi 當 Worker，再驗當 Lead | 未開始 |
| P4 | 多 Lead 的選擇規則：目前只有「卡片指定優先、否則清單第一個」。是否要輪流、依 quota 或可用性換人，**等使用者決定**，不在本文預設 | 待決定 |

每個階段都要附日期、環境與結果；單元測試通過不等於該階段完成。

## Worker 與 reviewer 組合

- reviewer 偏好：codex Lead 用 claude，其餘（含 agy、pi）用 codex（`reviewerFor`）。這只是偏好，**真正的驗收是作者與 reviewer 為不同 session 的 gate**。
- Worker 自動入池不因 Lead 改變：claude、codex 預設；agy 需 `implementation` 或 `review`；pi 不自動入池。
- Lead 不能指派自己，review 也不能與作者同 session（既有規則）。

## Discord 指令範圍

- 本階段**沒有新增 Discord 指令**。卡片的 `lead:` 欄位由寫卡的人或 Agent 直接寫在卡片檔，`card import` 照常讀取。
- 卡片指定 Lead 只能在政策檔允許的種類中選，且仍要通過開放條件；它不能新增 Lead、不能改專案等級、不能繞過 autopick 白名單。因為 Agent 能寫卡片，卡片指定不能成為提權途徑。
- 是否要讓 `card assign` 也能帶 `--lead`：未決定，不在本階段。

## 風險

- agy 在新資料夾的信任提示可能讓 Lead 啟動卡住；bridge 不會替人確認。
- pi 沒有任何 coding 證據，P3 可能發現大量缺口。
- 舊版 bridge 讀到含 `lead:` 的卡會因未知 key 拒絕解析，回滾前要先移除這個欄位。
- L2 專案下 Lead 失敗後的卡可能留下未 commit 的 worktree（本卡實際發生過）；需人工處理。

## 驗收（本規劃）

- [ ] P1：agy 當 Lead 走完一張無害卡，附日期與環境。
- [ ] P2：使用者宣告後 agy 當 autopick Lead 走到 PR。
- [ ] P3：pi 當 Worker、再當 Lead 的同等證據。
- [ ] 以上完成前，文件與 issue 都標「待驗收」，不宣稱 agy、pi 可當 Lead。
