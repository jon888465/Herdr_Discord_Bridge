---
id: REQ-20261101-worktree-isolation
type: requirement
status: draft
title: 為每張卡建立獨立的 git worktree 隔離
version: 1
created: 2026-11-01
updated: 2026-11-02
source: 使用者要求建立 worktree 隔離的需求卡（2026-11-01），內容由 Agent 依現況查核後整理，尚未與使用者討論細節
project: Herdr_Discord_Bridge
links: { parent: REQ-20261030-card-to-merge, related_docs: [docs/coding-workflow-proposal.md, docs/durable-task-engine.md, docs/adr/0001-portable-md-cards.md], related_issues: [ISSUE-025, ISSUE-041] }
---

# 為每張卡建立獨立的 git worktree 隔離

## 描述

使用者要求為「worktree 隔離」建立需求卡。這是 [REQ-20261030-card-to-merge](REQ-20261030-card-to-merge.md) 切片順序中的第 2 項：指派一張卡後，在獨立的 git worktree 與分支上開發，不動使用者正在使用的工作樹，也不與其他卡互相覆蓋。

使用者尚未說明細節；下方「驗收條件」與「待確認」都是 Agent 的整理，**不是使用者已確認的需求**。

## 現況（2026-11-01 檢查）

- **所有 Worker 都在 Lead 的工作目錄裡。** `src/herdr.ts` 的 `startProfile` 以 `pane.split` 建立 Worker pane，`cwd` 取自 Lead 的 `cwd`／`foreground_cwd`（約第 220–255 行）；取不到就拒絕啟動。因此目前沒有「Worker 在別的工作樹」的路徑。
- **`team ask --coding` 是單一 writer、同一工作樹。** 版本指紋（base／head SHA 加 staged、unstaged、未忽略 untracked 內容）針對這一棵樹；review 與 verify 期間樹改變就不留下有效 pass。SPEC 與 `docs/coding-workflow-proposal.md` 明載「多 writer、worktree 隔離」未接入，write scope 不是作業系統隔離。
- **artifact 必須在工作樹之外。** `assertArtifactsOutsideWorktree`（`src/coding-version.ts`）會拒絕放在工作樹內的 artifact；改用別的工作樹時這條規則要繼續成立。
- **Herdr 內建 `herdr worktree` 指令**（本機 0.9.1；官方文件為 v0.9.5）：`list`、`create`、`open`、`remove`。`--help` 沒有選項說明；實測結果見下方「Herdr worktree 驗證結果（2026-11-02）」。
- `src/types.ts` 的 `WorkspaceRecord` 已有 `worktree.checkout_path`，`workspacePath()` 會用它；表示 bridge 已能讀到 Herdr 回報的 worktree workspace 路徑，但沒有建立或清理的程式。
- `src/session-handoff.ts` 會比對目的地是否為不同的工作樹（第 147 行附近）。
- 遠端機器（ISSUE-041）目前只支援文字對話與附件，不支援 worktree。

## 驗收條件

以下全部由 Agent 推測，**需要使用者確認**：

- [ ] 指派一張卡後，bridge 在獨立的 git worktree 與專屬分支上工作；使用者原本的工作樹（含未提交修改）完全不被改動。
- [ ] 兩張卡同時進行時，各自的工作樹互不影響，沒有共用的可寫路徑。
- [ ] Worker 與 Lead 能在指定的 worktree 路徑啟動，而不是只能用 Lead 的 `cwd`。
- [ ] 現有 `team ask --coding` 的版本指紋、單一 writer、不同 session review、artifact 在樹外的規則，在 worktree 內仍成立。
- [ ] 任務完成、取消或失敗後，worktree 依規則清理：**有未提交修改或未推送 commit 時絕不強制刪除**，改為保留並通知。
- [ ] 現有不使用 worktree 的流程（一般 `team ask`、直接與 Agent 對話）行為完全不變。
- [ ] 以真實 git repository 與暫存 worktree 的自動化測試涵蓋：建立、重複建立、基準分支不存在、路徑已存在、清理時有未提交修改。

## 非目標

- 多 writer 的整合與衝突處理（隔離只是前置條件）。
- GitHub push、PR、CI、merge（見 REQ-20261030-card-to-merge 後續切片與專案政策檔）。
- 遠端機器上的 worktree。
- 自動撿卡；第一版由使用者指派。

## 風險

- 刪除 worktree 是不可逆動作；清理邏輯寫錯會丟失使用者或 Agent 的未提交工作。
- `--trust-repository` 若代表「信任並執行 repo 內定義的設定或指令」，用在不可信 repo 會有安全風險（語意未驗證）。
- 若 bridge 自行呼叫 `git worktree`，可能與 Herdr 內建的 worktree workspace 狀態不一致，或在 Herdr UI 看不到。
- 目前 Worker 的啟動、指紋與 artifact 路徑都隱含「同一棵樹」，改動範圍可能比預期大。

## 待確認

1. **用 Herdr 原生 `herdr worktree`，還是 bridge 自己呼叫 `git worktree`？** 2026-11-02 已驗證原生指令的行為（見下），安全面比預期好（髒檢出拒絕移除、不刪分支）；但原生 `create` 會**開新的 workspace**，與 bridge「一個 Team 只屬於一個 workspace」的不變式衝突（見下方「設計衝突」）。仍待使用者與 Agent 一起決定。
2. worktree 放哪裡（專案旁、`~/.herdr/...`、或由 Herdr 預設）；分支命名（例如以卡片 id 為基礎的 `card/<id>`）。
3. worktree 的生命週期綁「一張卡」還是「一次 Team Task」。
4. 基準（`--base`）預設用哪個 ref；建立前是否先 `git fetch`。
5. Lead 自己是否也進 worktree，還是只有 Worker 進。
6. 清理觸發時機（完成、取消、失敗、逾時）與保留期限；失敗時預設保留以便檢查。
7. ~~`--trust-repository` 與 `--force` 的實際語意~~ 已查明（見下）。待決定：bridge 是否一律不使用 `--force`（Agent 建議一律不用）。
8. 與專案政策檔 L0／L1／L2 的關係：L0（不 push）是否也需要 worktree。

## Herdr worktree 驗證結果（2026-11-02）

環境：本機 Herdr 0.9.1、macOS。在 `$CLAUDE_JOB_DIR/tmp` 下的**拋棄式 git repo**上實測，未碰專案本身。實驗前後各列一次 workspace，確認已還原為基準（w1 到 w5）；實驗建立的 workspace、worktree 與目錄都已移除，`~/.herdr/worktrees/` 下兩個空目錄已 `rmdir`。官方文件（v0.9.5）由另一個 Agent 查閱並回報，與實測一致，僅下表標明「文件」的項目沒有實測。

| 行為 | 結果 |
|---|---|
| `list --cwd <repo>` | 任何 repo 皆可用，無副作用（不會開 workspace）；JSON 含 `branch`、`path`、`is_linked_worktree`、`open_workspace_id` |
| `create --cwd --branch --base --no-focus` | 成功；預設路徑 `~/.herdr/worktrees/<repo>/<分支 slug>`（用分支名，**不是** `--label`：label 為 `lab-one-again` 時路徑仍是 `.../lab-one`）；`--path` 可自訂且有效 |
| `create` 的 workspace 副作用 | **同時開兩個 workspace**：worktree 本身一個，另有一個「來源 repo」workspace（若尚未開）。兩者互相群組。`list` 不會開。`--no-focus` 下焦點沒有改變 |
| `create` 的結果內容 | JSON 含新 `workspace_id`、`root_pane`（`pane_id`、`cwd` 等於 worktree 路徑）。**未實測**在該 pane 啟動 Agent |
| 對既有分支再 `create`（不給 `--base`） | 成功：檢出該分支，先前的 commit 仍在（可用於續作）。文件：「`--branch` 為既有本機分支則檢出，否則由 `--base` 或 `HEAD` 建立」 |
| 失敗情境 | 重複建立、`--base` 不存在、`--path` 已存在：皆為 `{"error":{"code":"worktree_create_failed","message":"<git 訊息>"}}`，結束碼 1，不開 workspace。路徑已存在時會**留下孤兒分支**（純 `git worktree add -b` 也是如此，是 git 行為） |
| `remove` 遇未提交修改（已追蹤檔被改或有未追蹤檔） | **拒絕**：`dirty_worktree_requires_force`，結束碼 1，目錄、分支、workspace 皆不變 |
| `remove` 遇乾淨工作樹但分支有**未合併 commit** | **照常移除**（目錄刪除、worktree workspace 關閉），**分支與 commit 保留**；沒有任何未合併警告。來源 repo workspace 不會被一起關閉 |
| `remove --force` | 移除髒工作樹，**未提交修改永久消失**（實測 `notes.txt` 與修改皆無法復原）；分支保留 |
| `open --branch <已移除的分支>` | `worktree_not_found`：`open` 只開**現有**的 checkout，不能重建；要續作用上面的「對既有分支再 `create`」 |
| `open` 對已開啟的 worktree | 冪等，回傳 `already_open: true` |
| `--trust-repository` | 文件：只繞過 Git 對「他人擁有的 repository」的擁有者檢查，僅限該次指令；**與 repo 內的設定檔或 hook 無關**（文件未提及這類機制）。**未實測**（無法在不動使用者環境下製造他人擁有的 repo） |
| 文件另載 | `remove` 執行 `git worktree remove`、**從不刪分支**；`workspace close` 只關 Herdr 狀態、不刪檢出；遠端用法 `herdr --machine "<名稱>" worktree create ...`（未實測）；每個 repo 的 worktree 設定檔：未見文件 |

### 對需求的影響

- **安全面可接受：** 髒檢出預設拒絕移除，且 `remove` 從不刪分支。只要 bridge **永不使用 `--force`**，就不會因清理而丟失未提交工作。
- **但「分支累積」是新問題：** 移除 worktree 後分支永遠留著，沒有任何清理或未合併提示；需要另行決定何時刪分支（刪分支是不可逆動作）。
- **設計衝突（待決定）：** 原生 `create` 會開**新的 workspace**。`CONTEXT.md` 的不變式：「Team 屬於且只屬於一個 Herdr workspace；成員必須在 Team 的 workspace；不同 workspace 的 Agent 是不同 Team」。若 Worker 在 worktree 的 workspace 啟動，它就不是該 Team 的成員；`allowedWorkspaceIds` 白名單也不認得新 workspace 的 id。解法方向（未決）：(a) 把一張卡視為一個獨立 Team／workspace；(b) bridge 自行呼叫 `git worktree`，仍用 `pane.split` 並指定 `cwd` 為 worktree 路徑，維持單一 workspace；(c) 放寬不變式。
- **版本相依：** 實測只在 0.9.1；文件為 v0.9.5。若採用原生指令，需決定最低版本並在啟動時檢查。

### 未實測

在 worktree 的 root pane 啟動 Agent；含 `/` 的分支名（例如 `card/<id>`）的 slug 規則；`--trust-repository` 實際效果；遠端機器的 worktree；Herdr 重啟後 worktree workspace 是否保留；多個 worktree 同時存在的負載。
