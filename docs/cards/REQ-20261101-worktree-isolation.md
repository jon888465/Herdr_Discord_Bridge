---
id: REQ-20261101-worktree-isolation
type: requirement
status: refined
title: 為每張卡建立獨立的 git worktree 隔離
version: 2
created: 2026-11-01
updated: 2026-11-02
source: 使用者要求建立需求卡（2026-11-01）；方向與範圍於 2026-11-02 與使用者討論後定案，驗收條件仍多為 Agent 推測
project: Herdr_Discord_Bridge
links: { parent: REQ-20261030-card-to-merge, related_docs: [docs/adr/0002-operational-cards-in-plugin-state.md, docs/coding-workflow-proposal.md, docs/durable-task-engine.md, docs/adr/0001-portable-md-cards.md], related_issues: [ISSUE-025, ISSUE-041] }
---

# 為每張卡建立獨立的 git worktree 隔離

## 描述

為「開始開發」的卡片建立獨立的 git worktree，讓 Agent 在隔離的目錄與分支上工作，不動使用者正在使用的工作樹，也不與其他卡互相覆蓋。這是 [REQ-20261030-card-to-merge](REQ-20261030-card-to-merge.md) 切片順序中的第 2 項。

## 已決定（使用者，2026-11-02）

1. **只在卡片開始開發時才建立 worktree。** 討論需求、記錄卡片、把 Mantis 單轉成卡片、直接 Vibe Coding 都不需要，照舊在原本的目錄做。
2. **用 Herdr 原生的 `herdr worktree` 建立**：一張卡一個 worktree workspace，Agent 在該 workspace 的 pane 工作，pane 的 cwd 就是 worktree 路徑。
3. **結果由 bridge 彙整寫進卡片**（流程紀錄與異動專案，見 [ADR-0002](../adr/0002-operational-cards-in-plugin-state.md)）。專案自己的 issue、README、CHANGELOG 等由 Agent 在 worktree 裡修改、隨 PR 進專案，bridge 不代寫。
4. 營運卡片放 plugin 狀態目錄、不進 git（ADR-0002）。
5. **分階段（使用者 2026-11-02 選）：** 3a 先做 Herdr worktree 轉接層（不接線、bridge 行為不變、不需重啟）；3b 才接到 `card assign` 並 live 驗收。
6. **觸發點：** `card assign <id> --worktree`（明確旗標）；沒帶旗標的 `card assign` 與 `team ask` 行為完全不變，可與 `--coding` 並用。
7. **Agent 與 thread：** 沿用卡片的 Discord thread；bridge 建好 worktree 後把該 thread 的路由切到新 workspace 並回報 pane，使用者在新 workspace 開好 Agent、`use` 選取後照常 `card assign`。第一版**不**自動在 root pane 啟動 Agent。
8. **分支、基準、清理：** 分支 `card/<卡片 id>`；基準＝repo 目前 HEAD，不先 `git fetch`；**不自動清理**——只在使用者下 `card cleanup <id>` 時才移除，髒檢出一律保留並通知，永不 `--force`、不刪分支。

Agent 的推論（使用者未明說）：每個 worktree workspace 是自己的 Team，符合 `CONTEXT.md`「不同 workspace 的 Agent 是不同 Team」的不變式，所以不需要讓 Worker 加入原 workspace 的 Team。

## 現況（2026-11-01 檢查）

- **所有 Worker 都在 Lead 的工作目錄裡。** `src/herdr.ts` 的 `startProfile` 以 `pane.split` 建立 Worker pane，`cwd` 取自 Lead 的 `cwd`／`foreground_cwd`（約第 220–255 行）；取不到就拒絕啟動。因此目前沒有「Worker 在別的工作樹」的路徑。
- **`team ask --coding` 是單一 writer、同一工作樹。** 版本指紋（base／head SHA 加 staged、unstaged、未忽略 untracked 內容）針對這一棵樹；review 與 verify 期間樹改變就不留下有效 pass。SPEC 與 `docs/coding-workflow-proposal.md` 明載「多 writer、worktree 隔離」未接入，write scope 不是作業系統隔離。
- **artifact 必須在工作樹之外。** `assertArtifactsOutsideWorktree`（`src/coding-version.ts`）會拒絕放在工作樹內的 artifact；改用別的工作樹時這條規則要繼續成立。
- **Herdr 內建 `herdr worktree` 指令**（本機 0.9.1；官方文件為 v0.9.5）：`list`、`create`、`open`、`remove`。`--help` 沒有選項說明；實測結果見下方「Herdr worktree 驗證結果（2026-11-02）」。
- `src/types.ts` 的 `WorkspaceRecord` 已有 `worktree.checkout_path`，`workspacePath()` 會用它；表示 bridge 已能讀到 Herdr 回報的 worktree workspace 路徑，但沒有建立或清理的程式。
- `src/session-handoff.ts` 會比對目的地是否為不同的工作樹（第 147 行附近）。
- 遠端機器（ISSUE-041）目前只支援文字對話與附件，不支援 worktree。

## 驗收條件

使用者已確認的方向（見「已決定」）：

- [ ] 卡片開始開發時才建立 worktree；討論、記錄、轉換、Vibe Coding 不建立。
- [ ] 使用 Herdr 原生 `herdr worktree` 建立，一卡一個 worktree workspace。

以下由 Agent 推測，**需要使用者確認**：

- [ ] 使用者原本的工作樹（含未提交修改）完全不被改動；兩張卡同時進行時互不影響。
- [ ] Agent 在新 workspace 的 root pane 工作（已實測 root pane 的 cwd 等於 worktree 路徑）。
- [ ] 現有 `team ask --coding` 的版本指紋、單一 writer、不同 session review、artifact 在樹外的規則，在 worktree 內仍成立。
- [ ] 清理時**永不使用 `herdr worktree remove --force`**；工作樹有未提交修改時保留並通知。
- [ ] 清理 worktree 不自動刪分支（Herdr 本來就不刪）；分支何時刪另行決定。
- [ ] 新 workspace 的 `allowedWorkspaceIds` 處理有明確規則：只自動納入 bridge 自己建立的 workspace，不放行其他。
- [ ] Agent 的最終回報被彙整寫入卡片的 `## 流程紀錄` 與 `## 異動專案`。
- [ ] 啟動時檢查 Herdr 最低版本，不足就拒絕使用此功能。
- [ ] 現有不使用 worktree 的流程（一般 `team ask`、直接與 Agent 對話）行為完全不變。
- [ ] 以真實 git repository 與暫存 worktree 的自動化測試涵蓋：建立、重複建立、基準不存在、路徑已存在、清理時有未提交修改。

## 非目標

- 多 writer 的整合與衝突處理（隔離只是前置條件）。
- GitHub push、PR、CI、merge（見 REQ-20261030-card-to-merge 後續切片與專案政策檔）。
- 遠端機器上的 worktree。
- 自動撿卡；第一版由使用者指派。

## 風險

- 刪除 worktree 是不可逆動作；清理邏輯寫錯會丟失使用者或 Agent 的未提交工作。
- `--trust-repository` 若代表「信任並執行 repo 內定義的設定或指令」，用在不可信 repo 會有安全風險（語意未驗證）。
- 原生 `create` 會順便開一個「來源 repo」的 workspace（每個 repo 一次），需決定誰負責關閉。
- 目前 Worker 的啟動、指紋與 artifact 路徑都隱含「同一棵樹」，改動範圍可能比預期大。

## 待確認

1. ~~用原生指令還是自行呼叫 git~~ 使用者已決定用原生（見「已決定」）。
2. bridge 要呼叫的是 Herdr 的 **socket API**（遠端經 ssh 轉發的 socket），不是 CLI；對應 `worktree.create` 等方法的名稱與參數尚未查（`herdr api` 子指令可查詢 socket API 的中繼資料）。
3. 路徑與分支命名：預設路徑 `~/.herdr/worktrees/<repo>/<分支 slug>`；含 `/` 的分支名（例如 `card/<id>`）的 slug 規則未實測，可用 `--path` 自訂。
4. `--base` 預設用哪個 ref；建立前是否先 `git fetch`。
5. 清理觸發時機（完成、取消、失敗、逾時）與保留期限；失敗時預設保留以便檢查。
6. 新 workspace 的 Discord thread 對應：沿用卡片的 thread，還是另開。
7. 「Agent 最終回報 → 彙整寫入卡片」的資料路徑：現有 hook 與 `herdr-discord-send` 只送 Discord，沒有寫入卡片；需設計。依 ADR-0002 決定 11，Agent 的自由文字**不寫進卡片**，卡片只記錄 bridge 產生的結構化事實（PR 網址、SHA、判定結果等）。
8. 與專案政策檔 L0／L1／L2 的關係：L0（不 push）是否也需要 worktree。
9. 遠端機器：原生支援 `herdr --machine <名稱> worktree create`，但**尚未實測**，需要使用者同意才能在遠端機器上執行。

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
- **設計衝突（已解決，2026-11-02）：** 原生 `create` 會開新 workspace，原本擔心與「Team 只屬於一個 workspace」及 `allowedWorkspaceIds` 衝突。使用者決定一卡一個 worktree workspace、bridge 只彙整結果，該 workspace 是自己的 Team，因此不違反不變式；`allowedWorkspaceIds` 的處理規則仍待定（見待確認與驗收條件）。
- **版本相依：** 實測只在 0.9.1；文件為 v0.9.5。若採用原生指令，需決定最低版本並在啟動時檢查。

### 未實測

在 worktree 的 root pane 啟動 Agent；含 `/` 的分支名（例如 `card/<id>`）的 slug 規則；`--trust-repository` 實際效果；遠端機器的 worktree；Herdr 重啟後 worktree workspace 是否保留；多個 worktree 同時存在的負載。

## Socket API 與 3a 轉接層（2026-11-02）

來源：`herdr api schema --json`（protocol 22，Herdr 0.9.1）與本機實測。

- **方法與參數：** `worktree.list {cwd, workspace_id?, trust_repository?}`；`worktree.create {cwd, branch, base?, path?, label?, focus=false, workspace_id?, trust_repository?}`；`worktree.open {…}`；`worktree.remove {workspace_id（必填）, force=false, trust_repository?}`。回應：`worktree_created {workspace, worktree, root_pane, tab}`、`worktree_list {source, worktrees[]}`、`worktree_removed {workspace_id, forced, worktree}`。錯誤碼：`worktree_create_failed`、`dirty_worktree_requires_force`、`workspace_group_close_required`。
- **版本：** socket `ping` 回 `{version, protocol, capabilities}`，可用來檢查最低版本。
- **轉接層 `src/worktree.ts`（3a，已實作、未接線）：** `createWorktree`／`listWorktrees`／`removeWorktree`／`checkWorktreeSupport`／`branchForCard`。只送安全參數：永不送 `force`、`trust_repository`、`path`、`label`，`focus` 固定 false；分支、基準、repo 路徑、workspace id 送出前驗證；回應缺欄位就拒絕；髒檢出回報 `dirty_worktree`（保留）而不是丟錯誤；回應若顯示 `forced: true` 視為錯誤。
- **實測（2026-11-02，拋棄式 git repo、真實 Herdr 0.9.1，事後已還原 workspace 到 w1–w5 並清除所有暫存目錄）：**
  - `checkWorktreeSupport` → `{ok: true, version: "0.9.1"}`。
  - 分支 `card/REQ-20261102-ab` 建立成功，路徑 `~/.herdr/worktrees/<repo>/card-req-20261102-ab`：**slug 規則＝`/` 換成 `-` 且轉小寫**；`root_pane` 回傳 `wV:p1`。
  - 髒檢出（多一個未追蹤檔）`removeWorktree` → `dirty_worktree`，目錄保留；刪掉該檔後移除成功、目錄消失、**分支保留**。
  - 對已移除 worktree 的既有分支再 `create` 成功（可續作），會**再開一個新的 workspace**。
  - **`workspace close` 不刪檢出：** 關閉該 workspace 後，`~/.herdr/worktrees/<repo>/<slug>` 仍在，要用 `git worktree remove` 才清掉。
  - **來源 repo 的 workspace 會被留下：** `create` 開的「來源 repo」workspace 在 worktree 移除後仍在；關閉它需要 `close_group`（否則回 `workspace_group_close_required`）。誰負責關閉屬 3b。
- **仍未實測：** 在 worktree 的 root pane 啟動 Agent、`--trust-repository` 實際效果、遠端機器的 worktree（未取得同意）、Herdr 重啟後 worktree workspace 是否保留、多個 worktree 同時存在。
- 測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：`test/worktree.test.ts` 12 項（假 port）；沒有自動化測試連真實 Herdr（CI 沒有 Herdr），真實行為由上述實測涵蓋。
