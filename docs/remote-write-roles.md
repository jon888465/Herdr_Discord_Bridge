# 遠端寫入角色：implement／fixer

ISSUE-171。2026-11-18，**第 1 階段（取回與套用的純管線）與第 2 階段（task 內 implement 接線）已實作並有單元測試，fixer 仍是設計**（見文末「分階段」）。目前 remote implement／fixer 仍會在撿卡前被拒絕（「remote 寫入尚未支援」，見 `src/card-role-assignment.ts` 的 `remoteReviewMachine`）。

## 目標與決定（使用者 2026-11-18）

讓 `machines[].cardReview` 開放的遠端機器（目前是 agy-pod 的 agy、devbox 的 codex／pi）也能擔任寫入角色 `implement` 與 `fixer`。

| 決定 | 選擇 | 理由 |
| --- | --- | --- |
| 改動怎麼回到本機 | **打包回傳**，遠端不放任何 GitHub 憑證 | 遠端 agent 能碰到的只有一份快照目錄；信任範圍最小 |
| 第一階段範圍 | **implement 與 fixer 一起** | 使用者要求；兩者共用同一條「快照→遠端改→取回→驗證→本機 commit」管線 |
| 誰 commit | **bridge 在本機 commit** | 遠端 agent 不碰 git 歷史與憑證；push 走既有本機流程 |

## 現有機制（可重用）

- `src/remote-snapshot.ts`：`createLocalSnapshot` 以暫時 index 做快照 commit（含未追蹤、不含 ignored），`bundle` 只含 origin 沒有的物件，上限 50 MiB；`prepareRemoteSnapshot` 經 ssh stdin 送到遠端並驗證 HEAD／tree；`startRemoteRole` 負責建 workspace、啟動 agent、`afterTurn` 與 `cleanup`（blocked／timeout／uncertain 保留現場，記 `cleanup_pending`）。
- 唯讀角色在 `afterTurn` 比對遠端指紋，**被改動就不採用**；寫入角色要反過來：把改動當成輸出。
- 本機 fixer（`src/card-fix-flow.ts` 的 `runCardFix`）在 worktree 裡產生 commit（`headBefore`→`headAfter`），`card-loop` 再檢查敏感路徑（`src/sensitive-paths.ts`）後 push。

## 設計

### 流程（兩個角色共用）

```text
本機 worktree（HEAD = H）
  createLocalSnapshot        → 快照 S（tree T_S），digest D（現有）
  prepareRemoteSnapshot      → 遠端目錄 R，HEAD = S（現有）
  遠端 agent 在 R 內修改檔案（不需要 commit、沒有憑證）
afterTurn（寫入模式）
  遠端：暫時 index → add -A → write-tree → T_R；git diff --binary --full-index T_S T_R > patch
  本機：ssh stdout 讀回 patch（大小上限；超過就不採用）
  本機驗證：
    1. 本機工作樹 digest 仍等於 D（快照之後本機沒被改動），否則不採用
    2. patch 路徑檢查（見下）
    3. git apply --check 通過
  本機套用：git apply --index patch → write-tree 必須等於遠端回報的 T_R（完整性）
  本機 commit：固定訊息與身分，parent = H，得到 headAfter
  回報 FixOutcome / implement 結果（files、sensitivePaths…）給既有流程
```

**與「bundle」的差異（需使用者知悉）：**回傳用的是 `git diff --binary --full-index` 產生的 patch，不是 git bundle。理由：bundle 的前置物件是快照 commit S，而本機的暫時 ref 在送出後已刪除（`dropRef`），物件可能被 gc；patch 不依賴本機保留 S。完整性靠「套用後的 tree sha 必須等於遠端回報的 tree sha」保證，強度不低於 bundle 的物件雜湊檢查。若實作時發現 patch 無法表達某些變更（例如 submodule、檔案模式特例），再評估改用 bundle。

### 路徑與內容檢查（遠端產物不可信）

- 拒絕：絕對路徑、含 `..`、任何 `.git` 路徑元件（含 `.gitmodules` 以外的 `.git/` 底下）、符號連結指向 repo 外、submodule 變更、單一 patch 超過上限（預設 10 MiB）、檔案數超過上限。
- 敏感路徑（`SENSITIVE_PATHS`）：不拒絕，但照本機規則回報 `sensitivePaths`，由既有 `card-loop`／review 流程擋在 push 前。
- 套用在本機 worktree 前再次確認 digest；套用或 commit 任何一步失敗都 `git reset --hard` 回到 H 並以 `git clean` 還原本次新增的檔案（只動本次 patch 涉及的路徑），結果不採用。

### 角色接線

- `REMOTE_TASK_ROLES` 加入 `implement`、`fixer`（現為 `diagnose／review／verify`）；`remoteReviewMachine` 不再對寫入角色直接拒絕，改成檢查 `cardReview` 與 kinds，寫入角色另需 machine 的 `cardReview.write: true`（**預設關閉**，要明確開放才會被派寫入工作）。
- `startRemoteRole` 增加寫入模式：略過唯讀指紋檢查，`afterTurn` 改走上面的取回流程並回傳 commit 結果。
- task 內 implement：Lead 以 `remote:<machine>:implement:<profile>` 指派（沿用現有 target 格式）；卡片 `roles.implement`／`roles.fixer` 指向遠端時，撿卡前驗證 machine、kind、`write: true`。
- PR 階段 fixer：`card-fix-flow` 在遠端模式下不分割本機 pane，改用同一條管線，輸出相同的 `FixOutcome`（`headBefore`／`headAfter`／`files`／`sensitivePaths`），後續 push 與 review 不變。
- 失敗一律不 fallback 到本機；對外只回固定標籤「遠端角色失敗：…」，細節只進 console。

### 取消、逾時與清理

沿用現有 `RoleCleanupReason`：completed 之外（blocked／timeout／uncertain）保留遠端 workspace 與目錄並記 `cleanup_pending`。寫入模式額外規則：**取回前取消或逾時不採用任何遠端改動**，遠端目錄保留給人檢查。

## 風險與限制（預先列出）

- 遠端 agent 可寫任意檔案內容：靠路徑檢查、大小上限、敏感路徑回報與既有 review 擋；**不能防止內容本身惡意**，所以 `write: true` 預設關閉、只對信任的機器開。
- 快照只含 `add -A` 看得到的檔案（不含 ignored）；遠端若需要 ignored 的檔案（例如 `.env`）無法取得，行為與唯讀角色相同。
- 本機工作樹在遠端工作期間被改動會使整輪作廢（digest 不符），與唯讀角色一致；寫入模式的代價更大（遠端工作白做）。
- patch 方案的邊界：二進位大檔、submodule、檔案模式或換行轉換可能與 bundle 方案行為不同，需要測試涵蓋。
- 取回流程在本機同步呼叫 git 的部分要避免卡住事件迴圈（沿用快照的限制）。
- 遠端 codex／pi 的啟動提示、信任與 `--dangerously-bypass-approvals-and-sandbox` 等參數尚未在遠端驗證；agy 的預先信任只對 agy 有效。

## 分階段

1. 純函式與管線：patch 取回、路徑檢查、套用＋tree 驗證＋commit、失敗還原（單元測試，不連真機器）。**已完成（2026-11-18，`src/remote-write-result.ts`）。**實作時補上的細節：寫入模式要求派工前本機工作樹乾淨（快照 tree 等於 HEAD tree），否則不派工，因為 commit 會是「HEAD＋patch」，不能夾帶先前未提交的本機改動；遠端 patch 寫成 `.git` 底下的檔案再用位元組取回（`RemoteExec` 只留 64 KiB）；符號連結一律拒絕；沒有任何改動視為失敗。
2. task 內 `implement` 接線與 `write` 設定、preflight 與 Lead 候選。**已完成（2026-11-18，只有單元測試）：**`cardReview.write`（布林、預設關閉）驗證與凍結進角色快照；`REMOTE_TASK_ROLES` 加入 implement、target `remote:<machine>:implement:<profile>`、候選在沒有 write 時標 `available:false`；`startRemoteRole` 寫入模式（要求 write 與取回通道、派工前 `assertCleanBase`、`afterTurn` 先確認本機 digest 再取回套用 commit）；`main.ts` 提供會尊重手動斷線的 `sshRemoteFetch`；Lead 提示說明 implement 是寫入。
3. PR 階段 `fixer` 接線。
4. 實機驗收（agy-pod／devbox 各一次成功路徑與一次失敗路徑），結果記進 ISSUE-171。

## 驗收條件

- 單元測試涵蓋：正常回傳並 commit、tree 不符、路徑違規、超過上限、digest 不符、套用失敗還原、取消與逾時不採用、`write` 未開啟時拒絕。
- 實機：在 agy-pod 與 devbox 各跑一張 `roles: {implement: "<machine>:<agent>"}` 的卡，確認遠端沒有任何憑證、本機得到預期的 commit、遠端目錄被清除。
- 未驗收前，README 與 SPEC 只能寫「設計階段」，不可寫成已可使用。
