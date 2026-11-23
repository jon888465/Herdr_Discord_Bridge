# main 合併入口稽核

2026-11-23 核對本機原始碼與紀錄，基準 commit 為 `b9de32fc355d3f244b50fe1eba51f3f609f5363f`。下表的「已核對」分為本機程式或有日期的歷史紀錄。線上設定、身分及最終寫入行為本輪均未核對，因本次指派禁止存取 GitHub。

## 審查、CI 與版本

- **任務內獨立 review／verify** 使用本機交付版本 fingerprint，涵蓋可包含未提交工作的版本。Bridge 比對指派起訖和實作版本，並檢查 reviewer 的 session 獨立性。這份結果存於任務紀錄，最終 merge guard 不讀取該 fingerprint 或將它與 PR head 比對（`src/coding-workflow.ts:124–145,431–523`、`src/coding-version.ts:300–377`）。
- **Bridge 整體 PR review** 由 `card review` 或 loop 進入。取材前後比對完整 PR head，並檢查檔案清單與 diff；遠端 reviewer checkout 另驗完整 HEAD。結果寫入卡片，持久化 head 為 12 碼。獨立執行 `card review` 無 CI 或合併步驟（`src/card-command.ts:801–875`、`src/card-review-fetch.ts:37–97`、`src/remote-checkout.ts:187–219`、`src/card-findings.ts:196,296–301`）。
- **GitHub approval** 是平台上的審查及分支規則資料。現行核准數、Code Owners、舊核准是否撤銷及最近一次 push 的核准要求均未核對。Bridge 卡片上的判定由上列本機流程產生。
- **Bridge 讀到的 checks** 是 `gh pr checks <PR> --repo <repo> --json name,state,bucket,link` 的彙整。有 pending、fail、cancel、全部 skip 或無結果時無法通過；有 pass 混合 skip 可回 `success`。程式沒有指定必要 job 名稱，也沒有取得 checks 的 SHA（`src/github.ts:389–454`）。
- **GitHub 必要檢查** 取決於適用的 protection／rulesets；**實際受測版本** 需另核對 check run 或 status 的 SHA、workflow event、checkout 版本及合併版本。Bridge 收到的 `success` 或 `CLEAN` 無法單獨證明這些條件。

## 入口與規則

| 入口 | 誰能觸發 | 是否要求 review pass | 是否要求 CI 綠 | 是否綁定實際合併的 head SHA |
| --- | --- | --- | --- | --- |
| Autopick | 已核對本機。Bridge 選取政策啟用專案的 `ready` 卡，任務完成並同步 `done` 後，L2 執行 `card loop --merge`。唯讀卡止於 `done`，L0 止於 commit，L1 止於 PR。現行專案政策與憑證未核對，未讀執行中配置（`src/autopick.ts:44–82,250–286`、`src/autopick-wiring.ts:170–183`）。 | 已核對本機。沿用下列 loop 的整體 PR review（`src/autopick-wiring.ts:170–183`）。 | 已核對本機。沿用下列 loop 的等待與末次檢查（`src/autopick-wiring.ts:170–183`）。 | 已核對本機。沿用下列 loop 的 review 前綴與完整寫入 head，CI 摘要無 SHA（`src/autopick-wiring.ts:170–183`）。 |
| `card loop --merge` | 已核對本機。授權的 Discord 或本機 console 呼叫者帶 `--merge`；由 bridge 執行。現行線上憑證權限未核對，本輪未連線（`src/discord.ts:738`、`src/main.ts:478,594,889–935`、`src/card-command.ts:1066–1148`）。 | 已核對本機。取得或沿用整體 `pass` 才等 CI，末步再走 `card merge` 閘門。未帶 `--merge` 時無合併步驟（`src/card-loop.ts:110–152`、`src/card-command.ts:1108–1148`）。 | 已核對本機。每 30 秒查 PR，最多 30 分鐘，`success` 後進末步重查（`src/main.ts:936–955`、`src/card-merge-wiring.ts:57–73,104–115`）。 | 已核對本機。末步共用下列 `card merge`，初次等待也只用 PR 編號（`src/card-command.ts:1130–1148`、`src/card-merge-wiring.ts:57–73`）。 |
| `card merge` | 已核對本機。受授權 Discord 或本機 console 呼叫，由 bridge 的 `gh` 身分寫入，要求 L2。線上有效權限未核對，本輪未連線（`src/main.ts:889–935`、`src/card-command.ts:1178–1220`、`src/card-merge.ts:48–63`）。 | 已核對本機。最新整體 PR review 要 `pass`，無 medium 以上 open finding。GitHub approval 未核對，需線上規則（`src/card-merge-wiring.ts:117–146`、`src/card-merge.ts:65–81`）。 | 已核對本機。要求當次 PR checks 彙整為 `success`。線上必要檢查未核對，需有效分支規則（`src/card-merge-wiring.ts:104–146`、`src/github.ts:389–454`）。 | 已核對本機。review 比對 head 前 12 碼，CI 無 SHA，最終呼叫以完整 head 傳 `--match-head-commit`，沒有 base 條件（`src/card-merge.ts:48–81`、`src/card-merge-wiring.ts:124–163`、`src/github.ts:738–762`）。 |
| 手動 `gh pr merge` | 未核對。沒有線上使用者／agent 憑證權限及實際 CLI 呼叫紀錄。 | Bridge 卡片閘門：已核對本機，直接執行 `gh pr merge` 不經 `mergeStep`，所以不套用（`mergeStep` 只在 bridge 呼叫路徑內，`src/card-command.ts:1210–1220`）。GitHub 規則：未核對，缺有效規則，不知道平台是否另有同等 status 或 approval。 | 未核對。缺現行必要檢查、strict、例外及實際呼叫紀錄。 | 未核對。缺實際 CLI 參數及同次合併的 head，無法確認是否使用 `--match-head-commit`。 |
| GitHub 網頁 merge | 未核對。缺線上角色、權限及可用 merge 方式。 | Bridge 卡片閘門：已核對本機，網頁操作不經 bridge，所以不套用。GitHub 規則：未核對，缺線上必要 approval、Code Owners 與例外。 | 未核對。缺線上必要檢查及 bypass。 | 未核對。缺網頁提交時的版本條件、approval 所屬 commit 與最終 head 證據。 |
| GitHub auto-merge | 未核對。缺 `allow_auto_merge`、可啟用角色與逐 PR 啟用紀錄。 | 未核對。缺排程執行時的 approval、status 與例外規則。 | 未核對。缺自動完成時適用的必要 checks。 | 未核對。缺啟用後 head 更新的處置與實際寫入版本證據。 |
| PR merge API | 未核對。缺 REST／GraphQL 呼叫紀錄、使用者 token 與 App 權限。 | Bridge 卡片閘門：已核對本機，直接呼叫 API 不經 bridge，所以不套用。GitHub 規則：未核對，缺 API 呼叫身分的有效規則與額外 gate。 | 未核對。缺 API 呼叫身分的必要檢查與 bypass。 | 未核對。缺呼叫紀錄以確認是否傳 `sha`／`expectedHeadOid`，以及值是否屬於受審版本。 |
| Merge queue | 未核對。缺 `main` 的 queue 規則、可入列角色及例外。 | 未核對。缺入列、出列及最終寫入的審查條件。 | 已核對本機。CI YAML 無 `merge_group`（[CI workflow](../.github/workflows/ci.yml)，5–9 行）。線上 queue checks 未核對，缺規則及 run。 | 未核對。缺 PR head、merge group SHA 與實際合併版本的對應。 |
| Workflow／bot／App | 已核對本機。唯一 CI workflow 為 `contents: read`，checkout 不保留憑證，無合併步驟（[CI workflow](../.github/workflows/ci.yml)，5–38 行）。外部自動化、身分及寫入權限未核對，缺線上清單。 | 已核對本機。CI 無 bridge review 或 approval 檢查步驟（同 workflow，18–38 行）。外部是否要求未核對，缺整合資料。 | 已核對本機。CI 跑兩平台測試（同 workflow，18–38 行）。外部寫入所需的必要 checks 及例外未核對，缺各身分的有效規則。 | 未核對。缺外部自動化實際走的 PR merge、queue 或直接更新 ref 入口與參數。 |
| 直接 push／更新 ref | 已核對本機。Bridge 的 push refspec 限同名 `card/…`（`src/github.ts:251–264`）。已核對歷史。2026-10-30 一次管理員直接 push 被拒（見下文）。現行 Git／ref API、一般或 force 更新權限未核對，缺線上規則及 actor 資料。 | 已核對歷史。該次拒絕要求經過 PR。現行審查要求與誰可例外未核對，缺有效分支規則。 | 已核對歷史。該次拒絕也列出兩項缺少的 checks。現行直接 ref 更新的 CI 條件未核對，缺有效分支規則。 | 未核對。缺 ref 更新的舊值／新值條件及實際寫入 commit 的審查證據。 |
| Branch protection（規則層） | 未核對。缺 classic protection、管理員適用範圍、更新限制與例外清單。 | 未核對。缺核准數、Code Owners、舊核准撤銷及最近 push 核准條件。 | 未核對。缺必要 status contexts、來源 App 及 strict。 | 未核對。缺實際 checks 對應 commit 與 head 更新時的 approval 失效條件。 |
| Rulesets／例外（規則層） | 已核對歷史。2026-10-30 `protect-main` 記為 active、無 bypass。現行匹配的 repo／父層規則及 bypass actors 未核對，缺線上明細。 | 已核對歷史。當時要求 PR、核准數 0。現行 review 條件未核對，缺適用規則與例外。 | 已核對歷史。當時要求兩平台 CI，2026-11-03 記錄開啟 strict。現行必要 checks 與 bypass 未核對，缺線上明細。 | 未核對。歷史 strict 紀錄只說明當時同步要求，現行 checks 關聯 SHA 與 approval 失效條件仍需規則與事件資料。 |

合併三入口共用的 bridge guard 還要求卡片為 `done` 或已登記 PR 的 `in_progress`、PR 開啟且非草稿、`CLEAN`，以及完整且不命中敏感路徑的檔案清單。預設 squash，`card merge --method` 可選 repo 允許方式。Bridge 呼叫沒有 `--admin`、`--auto` 或 `--delete-branch`。新建 PR 用當時預設分支，登記既有 PR 時也驗證預設分支；最終 guard 讀 `baseRefName` 但沒有使用該值，實際目標隨該 PR 的 base。相關程式為 `src/card-pr-flow.ts:149–211`、`src/card-attach-pr.ts:125–175`、`src/card-merge-wiring.ts:101–163`、`src/card-merge.ts:48–142`、`src/github.ts:652–762`。

## 歷史紀錄與已確認缺口

- [ISSUE-198](known-issues.md#issue-198) 記錄 #338 經使用者決定人工合併。當時紀錄為兩平台 CI 綠、任務內獨立 review `pass`，PR 層 review 因 diff 93,947 字元超過 80,000 字元未執行。本機 `99d6ea8` 和 `1c488f0` 有相同 parent 和 tree；commit 訊息的驗證版本欄由工作樹 fingerprint 截短而來（`src/card-commit.ts:75–86,127–156`）。操作介面、合併時 PR head、兩個 run 的 SHA、approval、bypass 和任務版本到 PR head 的比對仍未核對。此案例只證明當次缺少 bridge PR 層 `pass` 仍合併。見 [ISSUE-187](known-issues.md#issue-187)。
- [ISSUE-199](known-issues.md#issue-199) 記錄 bridge CI 摘要未保留 SHA。[ISSUE-200](known-issues.md#issue-200) 記錄 PR review 閘門只比對 head 前 12 碼。[ISSUE-201](known-issues.md#issue-201) 記錄最終 guard 未驗證 base。三項來自原始碼資料流，實際錯版或目標分支變更後合併均未重現。
- [ISSUE-052](known-issues.md#issue-052main-沒有-ci-與-branch-protection) 與 [Card-to-Merge 追蹤清單](card-to-merge-tracker.md) 記載 2026-10-30 直接 push 被拒及 2026-11-03 strict 啟用。2026-11-04 ISSUE-083 補驗觀察紅燈 PR 為 `BLOCKED` 且 bridge 拒絕，當次合併呼叫沒有送出。以上屬歷史紀錄。

## 核對命令

**已執行（2026-11-23，本機）**：以 `rg`、`sed`、`nl`、`ls` 檢查程式、腳本、workflow 與文件；`git status --short`、`git rev-parse HEAD`、`git show -s --format='%h %P %T' 99d6ea8 1c488f0`、`git diff --quiet 99d6ea8 1c488f0` 查核本機狀態、版本及內容，兩 commit 的 diff 為空。文件變更驗證涵蓋相對連結與 `git diff --check`。沒有程式測試、設定變更或重啟。

**未執行（2026-11-23）**：本輪禁止存取 GitHub。以下為後續唯讀命令或查詢；`R` 代表公開 repo 的 `OWNER/REPO`，`H` 代表待核對的 commit SHA。

- `gh api "repos/$R"` 查預設分支、`allow_auto_merge`、允許的 merge 方式與查詢身分的 repo 權限。用 `gh api "repos/$R/branches/main/protection"` 查 classic protection；若遇 403 或 404，依可見權限確認原因，原因未明時保留未核對。
- `gh api --paginate "repos/$R/rulesets?includes_parents=true"`、`gh api "repos/$R/rulesets/<id>"`、`gh api "repos/$R/rules/branches/main"` 查來源、enforcement、匹配範圍、bypass 模式、approval、status contexts 與來源 App、strict 和 queue。父層明細以各規則來源和可讀權限追查。
- `gh api "repos/$R/pulls/338"`、`gh api --paginate "repos/$R/pulls/338/reviews"`、`gh api --paginate "repos/$R/issues/338/timeline"` 查 base/head、merge commit、核准的 `commit_id` 與可見事件。以 `gh pr view 338 --repo "$R" --json headRefOid,baseRefName,mergeCommit,mergedAt,reviewDecision,reviews,statusCheckRollup,autoMergeRequest` 輔查。若事件未記錄操作介面、旗標或 API 參數，保留未核對。
- `gh api --paginate "repos/$R/commits/$H/check-runs"`、`gh api --paginate "repos/$R/commits/$H/statuses"`、`gh api --paginate "repos/$R/actions/runs?head_sha=$H"` 查來源、結果與 SHA。需要時對 PR head、測試合併 commit 和 queue 的 merge group SHA 分別查；queue 可另用 `gh api graphql` 送唯讀 `query` 查 `mergeQueueEntry`，搭配 `gh api --paginate "repos/$R/actions/runs?event=merge_group"`。
- `gh api --paginate "repos/$R/actions/workflows"`、`gh api "repos/$R/actions/permissions/workflow"` 查 workflow。依可讀權限再用 `gh api` 查 App 安裝、collaborator permission、deploy keys 與 `repos/$R/rulesets/rule-suites`；權限與規則評估結果只記角色、條件及證據狀態。
