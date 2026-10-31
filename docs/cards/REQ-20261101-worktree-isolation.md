---
id: REQ-20261101-worktree-isolation
type: requirement
status: draft
title: 為每張卡建立獨立的 git worktree 隔離
version: 1
created: 2026-11-01
updated: 2026-11-01
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
- **Herdr 0.9.1 內建 `herdr worktree` 指令**（本機 `herdr --version` 為 0.9.1）：`list`、`create`、`open`、`remove`。`create` 的選項有 `--workspace`、`--cwd`、`--branch`、`--base`、`--path`、`--label`、`--focus`／`--no-focus`、`--trust-repository`；`remove` 有 `--force`、`--trust-repository`。**`--help` 沒有任何選項說明**，`--trust-repository` 與 `--force` 的語意、`--path` 的預設位置、是否會建立新的 workspace，Agent 都**尚未驗證**，也沒有執行過任何 `herdr worktree` 的建立或移除。
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

1. **用 Herdr 原生 `herdr worktree`，還是 bridge 自己呼叫 `git worktree`？** 原生的好處是與 Herdr UI 與 workspace 狀態一致；代價是依賴 0.9.1 以上、選項語意未文件化。自行呼叫則完全可控，但可能與 Herdr 脫節。Agent 傾向先驗證原生指令語意（在拋棄式的暫存 repo 上）再決定。
2. worktree 放哪裡（專案旁、`~/.herdr/...`、或由 Herdr 預設）；分支命名（例如以卡片 id 為基礎的 `card/<id>`）。
3. worktree 的生命週期綁「一張卡」還是「一次 Team Task」。
4. 基準（`--base`）預設用哪個 ref；建立前是否先 `git fetch`。
5. Lead 自己是否也進 worktree，還是只有 Worker 進。
6. 清理觸發時機（完成、取消、失敗、逾時）與保留期限；失敗時預設保留以便檢查。
7. `--trust-repository` 與 `--force` 的實際語意，以及 bridge 是否一律不使用 `--force`。
8. 與專案政策檔 L0／L1／L2 的關係：L0（不 push）是否也需要 worktree。
