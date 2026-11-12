# Agent 角色矩陣：讓每個 Agent 都能扮演每個角色

日期：2026-11-11。相關：[多種 Lead 規劃](multi-lead-plan.md)、[ISSUE-130](known-issues.md)、ISSUE-134、ISSUE-137、[ISSUE-140](known-issues.md)。

使用者於 2026-11-11 確認 pi coding Worker 已驗證並要求納入自動候選；具體卡片、環境與流程紀錄尚未提供，故矩陣仍不把 pi 的 implement／diagnose／verify／review 次數記為已核實成功。

> **本文是現況盤點與計畫，不是已達成的功能。** 目標還沒達成：28 格（7 個角色 × 4 種 Agent）裡，有 13 格完全沒有證據，其餘的多數也只有少量或單次的證據。所有數字附日期與來源；沒有證據的格子寫「無」，不等於「做不到」。

## 目標（使用者 2026-11-09）

**所有角色，都可以讓每種 Agent（claude、codex、agy、pi）扮演。**

「可以扮演」的驗收定義（每一格）：用一張無害的卡，由該 Agent 擔任該角色，流程走完，卡片流程紀錄有該角色的 `role_assigned`，且結果可用（不是被錯誤擋下）；附日期、環境與卡片 id。一次成功只代表「這個情境可行」，不代表可靠。

## 角色定義

| 角色 | 做什麼 | 誰決定由誰扮演 |
|---|---|---|
| `lead` | 統籌：規劃、派工、彙整 | 自動撿卡：`policy.yml` 的 `autopick_lead` 加卡片 `lead:`；手動：目前路由的 Agent |
| `implement` | 寫程式（單一 writer） | Lead 在計畫裡從 Worker 名單選；bridge 只檢查規則 |
| `diagnose` | 唯讀診斷、讀碼 | 同上 |
| `review`（task 內） | task 內的獨立審查，作者與 reviewer 必須是不同 session | 同上 |
| `verify` | 跑測試、核對版本指紋 | 同上 |
| `reviewer`（`card review`） | 對 PR 的 diff 做獨立審查，開新 pane | 偏好或 `--agent <種類>`；預設候選 `claude, codex, agy`，選第一個和作者不同的 |
| `fixer`（`card fix`） | 依 review 發現修正的新作者，開新 pane | `--agent`／`card loop --fix-agent` |

## 現況矩陣

**資料來源與限制：**42 張營運卡的流程紀錄裡的 `role_assigned`（2026-11-08 到 2026-11-09，本機；2026-11-09 pi 重測後重新統計）。角色 id 依前綴歸類（`impl*`→implement、`diag*`／`identify*`→diagnose、`rev*`／`review*`／`complete-independent-review`→review、`ver*`／`verify*`→verify），歸類是我的簡化，與先前一版（41 張卡）的數字略有不同。數字是**被分派的次數，含失敗**，不是成功次數，我沒有逐筆核對每次的結果。角色紀錄從 2026-11-08（ISSUE-127）才有，更早的證據另行標註。

| 角色 | claude | codex | agy | pi |
|---|---|---|---|---|
| lead | 8 | 2 | 1 | 2（1 次失敗、1 次成功，見註 4） |
| implement | 無 | 17 | 無（早期 1 次，見註 1） | 無 |
| diagnose | 1 | 3 | 1 | 無 |
| review（task 內） | 3 | 16 | 無 | 無 |
| verify | 13 | 6 | 無 | 無 |
| reviewer（`card review`） | 3（見註 2） | 21 | 無 | 無 |
| fixer（`card fix`） | 5 | 無 | 無 | 無 |

**註：**
1. agy 當 implement：2026-11-06 `REQ-20261106-agy-verify`（PR #141，ISSUE-107），早於角色紀錄，證據來自 `docs/known-issues.md`，未重驗。
2. claude 當 reviewer 的 3 次：2 次（2026-11-09 `REQ-20261109-lead-live-codex`）因「回覆不是單一 JSON」`inconclusive`，根因與修正見 ISSUE-134；1 次（`REQ-20261109-claude-reviewer-live`）修正後 `pass`。
3. agy 當 lead 只有 1 次極簡卡（`REQ-20261109-agy-lead-live`，PR #196 自動 merge）；codex 當 lead 2 次極簡卡；證據的限制見 `docs/multi-lead-plan.md`。
4. **pi 當 lead 的 2 次：**第 1 次 `REQ-20261109-pi-lead-live`（2026-11-09 07:56 UTC）失敗：第一個 `agent.prompt` 在 Herdr 登記完成前被拒（`agent_not_ready`），pi 沒有收到規劃 prompt（ISSUE-137）。第 2 次 `REQ-20261109-pi-lead-retest`（PR #200，08:51 到 08:59 UTC，#198 的有上限重試部署後）**成功**：pi 規劃出 6 個派工（全由 codex 執行）、task 5.5 分鐘 `completed`、codex reviewer 第 1 輪 `pass`、bridge 自動 squash merge `20faaf7`。限制：只有一張極簡卡、一次；pi 只當 Lead，所有實作、審查、驗證都是 codex 做的，所以**不代表 pi 能擔任其他角色**。
5. 表中 claude 的 implement 為「無」只代表角色紀錄裡沒有，早期文件（追蹤清單 E14，2026-11-05）曾記 claude profile 可當 Worker，沒有重驗。

## 阻礙與缺口（要讓每格都可行必須處理）

**A. 程式明確限制（讀碼確認）：**
- Worker 自動入池（ISSUE-140，2026-11-11）：claude／codex／pi 自動入池；agy 僅在 profile 宣告 `implementation` 或 `review` 時入池。一個合格 profile 即可；單一 profile roster 每個 assignment 使用 fresh session。
- reviewer 預設候選 `REVIEWER_KINDS = ["claude", "codex", "agy"]`，**不含 pi**；`--agent pi` 明確指定可以，bridge 只檢查格式（`src/review-pane.ts`）。
- Lead：四種都被政策接受；agy、pi 要先在 `config.json` 宣告 `implementation`（目前兩者都已宣告，pi 是 2026-11-09 為測試加的）。

**B. 設計缺口（2026-11-10 更新）：**
- REQ-20261110-card-role-assignment 已有原始碼實作（ISSUE-138，待驗收）：roles inline map 指定六角色 machine／agent／model、計畫與實際派工守門，reviewer／fixer 同樣套用；語法與限制見 card-role-assignment.md。無宣告保留原行為。machine 本卡只強制 local，已配置 remote 撿前明確拒絕；跨機器未支援，pi Worker 未開放。本次未部署／重啟／跑實機卡，不新增任何矩陣成功格。
- 2026-11-11（ISSUE-143）：card reviewer 可指定 `cardReview` 開放的 remote（見 remote-card-reviewer.md），其他角色 remote 仍拒絕；**未做實機驗收**，不新增成功格。
- 2026-11-12（REQ-20261111-remote-in-task-roles）：上兩條的 remote 拒絕已放寬，task 內 diagnose、review 可派到 remote（verify 要 `toolchain`）；**未做實機驗收**，不新增成功格。
- 以下為此功能之前的缺口背景；不再表示原始碼完全沒有指定機制：
- implement／diagnose／verify／review（task 內）**由 Lead 在計畫裡決定**，卡片與使用者沒有「指定某角色必須由某 Agent 扮演」的機制。要驗證「claude 當 implement」只能靠 Lead 剛好選到，沒有可控的方法。
- reviewer 與作者要是不同 session 的規則，意味著每個 Agent 當 reviewer 都需要一個不同 session 的作者。

**C. 尚未證實的疑點：**
- pi 的狀態完全由 hook 回報主導（`herdr agent explain`：`full_lifecycle_hook_authority`），啟動較慢；除了 Lead 第一個 prompt 的問題，pi 在其他角色是否有同類時序問題未知。
- agy 的信任提示、權限提示在多數角色下的行為只有 Lead 與 implement 的少量證據。

## 分階段計畫

每個階段都要附日期、環境與結果；單元測試通過不等於該格完成。

| 階段 | 內容 | 狀態 |
|---|---|---|
| R0 | 本文與矩陣 | 本 PR |
| R1 | **不需要新程式就能驗證的格子**：`card review --agent agy`（agy 當 reviewer）；`card loop --fix-agent codex`／`agy`（codex、agy 當 fixer）；~~pi 當 Lead 重測~~（**已於 2026-11-09 完成一次**，見註 4）；`card review --agent pi`（pi 當 reviewer） | 部分完成 |
| R2 | **pi 納入 Worker 名單**：改 `coding-roster.ts` 的 pi 排除規則（需要使用者決定，因為目前是刻意寫死）；先驗 pi 當 implement／diagnose／verify | 未開始，需要決策 |
| R3 | **可指定角色的機制**：roles 六角色指定，見 ISSUE-138 與 card-role-assignment.md；remote 開放 card reviewer（ISSUE-143）與 task 內 diagnose／review／verify | 原始碼已實作、待三卡實機驗收（2026-11-10）；remote 原始碼完成、未做實機驗收（2026-11-11、11-12） |
| R4 | **整張矩陣補齊**：依 R1 到 R3，每個還沒有證據的格子各跑一張無害卡，更新本文的矩陣與日期 | 未開始 |

**R1 的具體方式（不需要新程式）：**
1. agy 當 reviewer：對一張有 PR 的卡跑 `card review <id> --agent agy`（作者必須是不同 session）。
2. fixer：`card loop <id> --fix-agent codex`、`--fix-agent agy`，需要一張會 `changes_requested` 的卡，才會進修正輪。
3. ~~pi 當 Lead~~：已於 2026-11-09 完成一次（PR #200）；之後應該再用不同的卡重複，才符合「至少兩張不同卡成功」的建議。
4. pi 當 reviewer：`card review <id> --agent pi`。

## 風險

- pi 只有 Lead 一格有成功證據（1 次極簡卡），其他角色完全沒有；R1 到 R4 可能發現大量問題，不要預期一次達成。
- 每張驗證卡在 L2 專案下通過後會**自動 merge**，所以內容要保持「一行檔案」這類無害任務。
- 單次成功不代表可靠；一格要算「可以」，建議至少兩次不同卡片都成功（這是 Agent 的建議，需要使用者確認）。
- 矩陣的次數是分派次數，不是成功次數；之後更新請區分「分派」與「成功」。

## 追蹤

每完成一格，更新上面的矩陣（改次數、補日期與卡片 id），並在 `docs/known-issues.md` 對應的 ISSUE 記錄結果。本文件是追蹤表，不取代各 ISSUE 的驗收紀錄。


## ISSUE-138 實機驗收待辦（2026-11-10）

目前沒有三卡結果，不增加上表次數。merge 並重啟新版後，逐卡填 id、日期、環境、role_assigned 實際內容與結果：

1. 無害一行檔案卡：至少兩角色不同 agent，一角色明確 model；以 pane／啟動紀錄獨立佐證 model。
2. 無效 agent／model 卡：撿卡前拒絕、未啟動工作、通知標題與原因正確。
3. Lead 故意不符卡片指定：plan_rejected 且零違規 Worker prompt。

另核對 reviewer／fixer 的 fresh session。不把本機單元測試當成 remote／完整角色矩陣的實機證據。

## ISSUE-138 實機觀察（2026-11-11）

REQ-20261111-remote-agy-role（task-5c36f579-aa08-4318-bce2-c71191500f25，本機 macOS）只宣告 local 角色：

- `diagnose-remote-role：claude（opus）；machine=local；task=task-5c36f579-aa08-4318-bce2-c71191500f25；v=2,cr=d,s=C,ss=CCC,me=L`（02:10:09Z）
- `implement-remote-reviewer：claude（opus）；machine=local；task=task-5c36f579-aa08-4318-bce2-c71191500f25；v=2,cr=i,s=C,ss=CCC,me=L`（02:15:30Z）
- `herdr pane get w69:p3`：claude、label `claude·worker·opus`、cwd 為本卡 worktree；同 cwd 有 `claude --model opus`（pid 34147，10:15:25 +08:00）。Herdr 未回報 pid，pid↔pane **未直接證實**。

只是第 1 項卡的部分觀察（同 agent 兩角色），不計入次數；remote reviewer 未實機執行。
