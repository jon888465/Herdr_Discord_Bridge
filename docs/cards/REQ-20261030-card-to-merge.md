---
id: REQ-20261030-card-to-merge
type: requirement
status: refined          # draft | discussing | refined | recorded | approved | in_progress | done
version: 1
created: 2026-10-30
updated: 2026-10-30
source: 與使用者的架構討論（含 ChatGPT 分享對話的規格稿，其內容未能自動讀取，由使用者貼上）
links:
  related_docs:
    - docs/coding-workflow-proposal.md
    - docs/durable-task-engine.md
    - docs/hook-transport-proposal.md
  related_issues: [ISSUE-025, ISSUE-041]
external: { notion: null, github: null, mantis: null }
---

# 卡片驅動：從工作單到 PR／CI／Merge

> **狀態：規劃中，尚未實作。** 本卡只記錄需求與決策，不代表任何能力已可使用。
> 卡片是可隨手刪除的工作單；執行歷史以 journal 為準，不依賴本檔。

## 背景

使用者主要以 CLI 與 Agent 直接互動（Vibe Coding）。希望需求討論後能整理成卡片，
再交給 Agent 走「開發 → 多 Agent review → test → CI → merge」，並依專案決定自動化程度。
原 ChatGPT 稿（Conversation-driven 多機器編排，含 SQL schema 與 HTTP API）範圍過大，
且假設「沿用 SQLite Durable Task Engine」與實況不符（現為 atomic journal，見 SPEC.md Phase 1）。
本卡改採較小、可攜的方向。

## 已決定

1. **卡片 = 一個 md 檔（frontmatter + 內文），檔案為需求的真相來源，不使用 DB。** 版本歷史交給 git。
2. **執行態不寫進卡片。** 誰在跑、跑到哪、哪台機器留在現有 journal；卡片只放需求、驗收條件、關聯與結果摘要。
3. **卡片可隨手刪除。** 已完成的卡被刪不影響系統；**執行中的卡被刪 → 暫停並詢問使用者**，不默默繼續也不默默取消。
4. **先不做任何 Tracker Adapter。** Mantis 流程為：Agent 整理成可貼上的 md，使用者自行建單。Notion／Trello 之後只做匯出入，不做雙向同步。
5. **自動化程度為「每個專案各自的政策」**，政策檔放在各專案 repo 內並進版控（預定 `.herdr/policy.yml`）：
   - L0：只在 worktree／分支工作，不 push。
   - L1：push 分支並開 PR，由人 merge（預設）。
   - L2：review 通過、測試通過、CI 綠後自動 merge。
6. **herdr bridge 本身目標為 L2（全自動到 merge）。** 授權止於 merge；**不含部署、重啟與 live 驗收**（見 AGENTS.md，merge 不等於「已驗收」）。
7. **認領第一版為人工指派**（使用者在 CLI／Discord 指定一張卡）。自動撿 `status: ready` 的卡留待後續。
8. 每張卡預設使用獨立 git worktree；不同卡不共用可寫工作樹。

## 現況（2026-10-30 檢查）

- 已有：`team ask --coding` 首版（單一 writer、不同 session review、版本指紋、本機 verify）；遠端 Herdr 機器文字對話（ISSUE-041）。
- 未有：worktree 隔離、卡片 schema／匯出入、專案政策檔、push／PR／CI／merge、狀態回寫。
- GitHub 實況（2026-10-30，以 `gh` 唯讀查詢）：
  - `origin` 為 `git@github.com:jon888465/Herdr_Discord_Bridge.git`，**公開（PUBLIC）**，帳號 `jon888465` 權限為 ADMIN，預設分支 `main`。
  - **CI 已進 `main`**（PR #2，`175981c`，ISSUE-052）：Ubuntu 與 macOS、Node 22，執行 typecheck、lint、`npm test`，已移除 `paths-ignore`。`main` push run 41019618373 兩平台通過（Ubuntu 286/286；macOS 285 通過、1 略過、0 失敗）。
  - **`main` 已有 ruleset `protect-main`**（id 26191256，使用者於 2026-10-30 建立）：active、無 bypass；禁止刪除、禁止 force push、必須經 PR（核准數 0）、兩個平台的 CI 為必要檢查。設定已用 `gh api` 核對，**行為未測試**；`strict_required_status_checks_policy` 為 false。
  - 舊 PR #1（CI 加 Team 答覆介面功能）已關閉；分支 `followup-team-question-ui-ci` 保留，其功能未合併。
  - 尚未具備：CODEOWNERS 與「政策檔／`.github/`／AGENTS.md 強制人工審查」、action 釘 SHA、Agent 專用身分（bot 或 GitHub App）。合併方式設定（auto-merge、squash 等）查詢結果為 null，未確認。
- 本機 `gh` 已用 fine-grained token 登入（SSH 協定）；token 實際權限範圍未逐項核對。上傳 SSH key 被 403 拒絕屬預期（該 token 無金鑰管理權限），不影響既有 SSH 連線。

## 驗收條件

- [ ] 卡片 schema 定案，並可匯出為 Mantis 可貼上的 md、可匯入既有 md 卡。
- [ ] 指派一張卡後，在獨立 worktree 完成實作，並經不同 session review 與 verify（沿用 coding workflow）。
- [ ] L0：不 push。L1：只開 PR、不 merge。L2：僅在 review 通過、測試通過、CI 綠且符合 branch protection 時 merge。
- [ ] 政策檔、CI 設定與 AGENTS.md 的變更強制人工 merge（防止 Agent 自行升級權限）。
- [ ] 執行中的卡被刪除時暫停並詢問；已完成的卡被刪不影響 journal。
- [ ] 任何失敗（review 不過、測試失敗、CI 紅、衝突）都退回人工並附證據，不無限重試。
- [ ] merge 後不自動重啟 bridge；「已驗收」仍須人工 live 驗收並記錄於 `docs/known-issues.md`。
- [ ] 既有 `team ask`、Vibe Coding、Discord／CLI 指令行為不受影響（回歸測試）。

## 非目標（本卡不做）

- Conversation Engine／Requirement Engine 作為獨立服務、HTTP API、Web UI。
- 多機器 Scheduler、Machine Registry（遠端 Herdr 機器沿用 ISSUE-041 現有機制）。
- Notion／Trello／Mantis 雙向同步與 webhook。
- 自動部署、自動重啟。

## 建議切片順序

1. 卡片 schema 與匯出入。
2. worktree 隔離（coding workflow 已列為未做）。
3. 專案政策檔，先做 L0／L1。
4. ~~CI 進 `main` 並建立 ruleset~~ 已完成（2026-10-30，ISSUE-052）；剩 CODEOWNERS、釘 SHA、bot 身分與行為測試。
5. L2 自動 merge，先拿 herdr bridge 自己試。
6. 之後再評估：自動撿卡、Tracker 匯入、遠端 worktree。

## 風險

- **Agent 自行升級權限：** 政策檔／CI／AGENTS.md 變更必須人工 merge。
- **Bridge 修改自己：** merge 後維持舊版運行，由使用者確認後重啟。
- **卡片與 ticket 內容為不可信輸入：** 匯入時驗證 frontmatter，內文只當資料，不當指令。
- **多機器產生卡片 ID 衝突：** ID 採 `REQ-<日期>-<短名稱>`，不使用遞增編號。

## 待確認

- 卡片目錄放各專案 repo 內（與政策檔同處），還是 bridge 自己的目錄；是否以 `.gitignore` 排除以維持「可隨手砍」。
- CI 檢查是否足以作為 L2 閘門（現為 typecheck、lint、test；對照 SPEC.md 第 8 節驗證與完成定義）。
- 是否打開 `strict_required_status_checks_policy`（分支需與 `main` 同步才可合併）；自動 merge 前建議開。
- 以行為測試確認 ruleset 擋得住（直接 push `main`、CI 紅燈 PR）。
- **公開 repo：** issue 與 PR 內容任何人都能寫，視為不可信輸入；fork PR 的 workflow 權限也要檢查。
- CODEOWNERS 保護政策檔、`.github/`、AGENTS.md，並要求 Code Owner 審查；需要第二個身分才有意義（作者不能批准自己的 PR）。
- Agent 專用的 bot 帳號或 GitHub App，以及第二個權限較大的 token（見討論紀錄的權限清單）。
- action 釘 commit SHA 並啟用 Dependabot。
