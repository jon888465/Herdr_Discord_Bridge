---
id: REQ-20261030-card-to-merge
type: requirement
status: refined          # draft | discussing | refined | recorded | ready | in_progress | done | cancelled
title: 卡片驅動：從工作單到 PR／CI／Merge
version: 2
created: 2026-10-30
updated: 2026-11-02
source: 與使用者的架構討論（含 ChatGPT 分享對話的規格稿，其內容未能自動讀取，由使用者貼上）
links: { related_docs: [docs/coding-workflow-proposal.md, docs/durable-task-engine.md, docs/hook-transport-proposal.md, docs/adr/0001-portable-md-cards.md], related_issues: [ISSUE-025, ISSUE-041, ISSUE-052] }
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

1. **卡片 = 一個 md 檔（frontmatter + 內文），不使用 DB。營運卡片放 plugin 狀態目錄 `<stateDirectory>/cards/`，不進 git**（[ADR-0002](../adr/0002-operational-cards-in-plugin-state.md)，取代 ADR-0001 的「版本歷史交給 git」）。`docs/cards/` 與 `docs/card-examples/` 只放範例與設計文件。
2. **卡片是流程帳本**：記錄從開單到結束的進度、結果與異動專案（`projects`、`## 異動專案`、`## 流程紀錄`）。執行狀態的權威來源仍是 Team 任務 journal，卡片紀錄由事件衍生且可重複寫入不重複（ADR-0002，取代 ADR-0001 的「執行態不進卡片」）。
3. **卡片可隨手刪除。** 已完成的卡被刪不影響系統；**執行中的卡被刪 → 暫停並詢問使用者**，不默默繼續也不默默取消。
4. **先不做任何 Tracker Adapter。** Mantis 流程為：Agent 整理成可貼上的 md，使用者自行建單。Notion／Trello 之後只做匯出入，不做雙向同步。
5. **自動化程度為「每個專案各自的政策」**，政策檔放在各專案 repo 內並進版控（預定 `.herdr/policy.yml`）：
   - L0：只在 worktree／分支工作，不 push。
   - L1：push 分支並開 PR，由人 merge（預設）。
   - L2：review 通過、測試通過、CI 綠後自動 merge。
   - **（2026-11-03 修改）政策檔放在 plugin 設定目錄 `<config dir>/policy.yml`，不放專案 repo**：使用者擔心 Agent 在 worktree 裡改 repo 內的政策檔把自己升級到 L2。格式為受限 YAML 子集；檔案不存在或不合法時全部 L0。見 SPEC「專案政策」。
6. **herdr bridge 本身目標為 L2（全自動到 merge）。** 授權止於 merge；**不含部署、重啟與 live 驗收**（見 AGENTS.md，merge 不等於「已驗收」）。
7. **認領第一版為人工指派**（使用者在 CLI／Discord 指定一張卡）。自動撿 `status: ready` 的卡留待後續。
8. **卡片開始開發時才建立 worktree**（討論、記錄、轉換、Vibe Coding 不建立），使用 Herdr 原生 `herdr worktree`，一卡一個 worktree workspace，bridge 彙整結果寫卡片；專案自己的 issue、README、CHANGELOG 由 Agent 在 worktree 裡修改、隨 PR 進專案（[REQ-20261101-worktree-isolation](REQ-20261101-worktree-isolation.md)）。

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

1. 卡片 schema 與匯出入：schema、解析、匯入、序列化、驗證指令與範例已完成；Mantis 匯出受阻（需要實際表單）。
2. worktree 隔離：方向已定（Herdr 原生 worktree workspace，一卡一個；見 REQ-20261101-worktree-isolation），尚待實作。
3. 專案政策檔，先做 L0／L1。
4. ~~CI 進 `main` 並建立 ruleset~~ 已完成（2026-10-30，ISSUE-052；action 已釘 SHA）；剩 CODEOWNERS、bot 身分、紅燈 PR 實測、`strict` 檢查與 Dependabot。
5. L2 自動 merge，先拿 herdr bridge 自己試。
6. 之後再評估：自動撿卡、Tracker 匯入、遠端 worktree。

## 風險

- **Agent 自行升級權限：** 政策檔／CI／AGENTS.md 變更必須人工 merge。
- **Bridge 修改自己：** merge 後維持舊版運行，由使用者確認後重啟。
- **卡片與 ticket 內容為不可信輸入：** 匯入時驗證 frontmatter，內文只當資料，不當指令。
- **多機器產生卡片 ID 衝突：** ID 採 `REQ-<日期>-<短名稱>`，不使用遞增編號。

## 待確認

- ~~卡片目錄放哪~~ 已決定：plugin 狀態目錄，不進 git（ADR-0002）。
- 流程紀錄的大小已決定（先提高上限、超過再輪替到旁檔，ADR-0002 決定 10，數字已確認）；機敏內容與單筆長度規則已決定（ADR-0002 決定 11：結構化優先、自由文字遇疑似機敏整筆省略）。
- CI 檢查是否足以作為 L2 閘門（現為 typecheck、lint、test；對照 SPEC.md 第 8 節驗證與完成定義）。
- ~~是否打開 `strict_required_status_checks_policy`（分支需與 `main` 同步才可合併）~~：使用者 2026-11-03 已開啟（Agent 以 `gh api` 唯讀確認為 `true`）。
- 以行為測試確認 ruleset 擋得住（直接 push `main`、CI 紅燈 PR）。
- **公開 repo：** issue 與 PR 內容任何人都能寫，視為不可信輸入；fork PR 的 workflow 權限也要檢查。
- CODEOWNERS 保護政策檔、`.github/`、AGENTS.md，並要求 Code Owner 審查；需要第二個身分才有意義（作者不能批准自己的 PR）。
- Agent 專用的 bot 帳號或 GitHub App，以及第二個權限較大的 token（見討論紀錄的權限清單）。
- ~~action 釘 commit SHA~~ 已完成（PR #4）；Dependabot 尚未啟用。

逐項進度與依賴見 [Card-to-Merge 追蹤清單](../card-to-merge-tracker.md)，那是剩餘工作的唯一權威來源。

## F2 決定：GitHub 身分（2026-11-03）

使用者決定（先記錄，進 F3 前再做，**目前沒有任何程式**）：

- **L1 第一版先用現有的 `gh`／ssh 登入**（本機 `jon888465`：`gh` 為 fine-grained token、git 走 ssh）。不新增 bot 帳號或 GitHub App。
- **代價（已知）：** 所有 PR 都會顯示是 `jon888465` 開的；CODEOWNERS 無法要求「獨立審查」（作者與審查者是同一人）；Agent 若能在同一環境執行 `gh`／`git`，就能用同一份憑證（目前已是如此）。因為第一版只做 L1（你自己 merge），這個代價可以接受。
- **L2 用現有的 `gh`／ssh 登入（使用者 2026-11-03 選 A，與 L1 相同）**，不新增 bot 帳號或 GitHub App，也不要求先改用單一 repo 的 fine-grained token。（2026-11-03 更正過一次：先前此處寫「L2 之前必須改成獨立身分」，那是 Agent 的建議，不是使用者的決定。）取捨見下方「L2 的身分選擇」。
- **bridge 只做這些 GitHub 動作（L1）：** push `card/<卡片 id>` 分支、開 PR、讀 CI 狀態。**不做**：push `main`（ruleset `protect-main` 也會擋）、merge、改設定、改 workflow。
- **最小權限（fine-grained token，單一 repo）：** Contents 讀寫（push 分支）、Pull requests 讀寫（開 PR）、Metadata 讀取；讀 CI 結果需要 Commit statuses／Checks 讀取。**不要給**：Administration、Workflows、Secrets、Actions 寫入。（ssh push 用的是帳號的 ssh key，權限比 token 寬，這是用現有登入的另一項代價。）
- **PR 內容（已決定）：** 標題用卡片標題，內文只放卡片 id 與 bridge 產生的結構化事實，不貼描述與驗收條件。
- **受專案政策限制：** 只有政策等級為 L1 以上的專案才允許 push 與開 PR（F1 已提供查詢；強制屬 F3）。

### L2 的身分選擇（2026-11-03，使用者問「不能繼續使用現在身份 merge 嗎」後的整理；**使用者選 A：現有登入**）

**可以繼續用現在的身份做 L2，技術上可行。** `gh pr merge` 只需要該 repo 的 Pull requests 寫入權限；ruleset `protect-main` 要求經過 PR 與兩個平台的 CI、沒有 bypass，所以自動 merge 仍會被 CI 擋住，被拿掉的只有「人」這個關卡。目前核准數是 0，使用者本來就是自己 merge 自己的 PR，所以獨立身分**不會**自動讓「第二個人 review」成立（除非有第二個真人）。

獨立身分真正多出來的好處（不是前提）：

1. **憑證範圍：** 現在 push 用 ssh key＝整個 GitHub 帳號的權限（所有 repo）。改用**單一 repo 的 fine-grained token** 就能把 Agent 可能用到的範圍縮到這個 repo，**不需要新帳號**——這是最實際的理由。
2. **稽核與撤銷：** PR 作者不是使用者；出問題只撤銷 bot 而不影響使用者本人。
3. **CODEOWNERS：** 只有存在第二個真人 reviewer 時才有意義。

**使用者的決定（2026-11-03）：選 A，L2 用現有登入。** 三個選項是：A 現有登入；B 現有身分加單一 repo 的 fine-grained token（不用 ssh key）加 G3；C 獨立 bot 帳號或 GitHub App。選 A 的代價（已知）：Agent 在同一環境就能用同一份憑證（含 ssh key＝整個帳號的權限），自動 merge 只靠 `protect-main` 要求的 PR 與兩個 CI 檢查把關；沒有第二個身分，CODEOWNERS 無法要求獨立審查。

**G3 已完成：** 使用者 2026-11-03 開啟 `strict_required_status_checks_policy`（Agent 以 `gh api` 唯讀確認為 `true`）。B、C 之後想加強時再選。

### L2 的 review 閘（2026-11-04，使用者決定；**目前沒有任何程式**）

**使用者的決定：**
1. **review 閘第一版 = PR 上的獨立 review（追蹤清單 F5）。** PR 開出後，由**不同 session** 的另一個 Agent 審 PR 的 diff；判定（`pass`／`changes_requested`／`inconclusive`）連同 **head commit sha** 寫回卡片的 `review_verdict` 事件。只有 `pass`、head sha 與審過的一致、CI 全綠，才允許 merge；review 之後有新 commit 就作廢、重審。
2. **敏感路徑一律不自動 merge（F6）。** 不論 review 結果，PR 動到敏感路徑就退回人工 merge。

**為什麼不是另外兩個選項（Agent 的分析，使用者採納）：**
- 「沿用 `--coding` 的 review」：現有的 review 綁**工作樹指紋**，不是 PR 的 head commit，而且 bridge 不替 Agent commit；review 之後再 commit 的內容不會被擋，要另外做「指紋對 commit」的對應，風險較高。
- 「第一版只看 CI」：沒有任何程式碼審查，寫程式的 Agent 自己就是唯一把關者。

**已知限制（誠實說明）：** reviewer 與作者很可能是同一家模型，**獨立的只是 session，不是判斷能力**；review 通過不等於沒有 bug，也擋不住 prompt injection 讓 reviewer 與作者同時出錯。這個閘降低風險，不取代人。

**使用者對子決定的回答（2026-11-04；以下「決定」是使用者的原意，「我的理解」「衝突」是 Agent 的補充，待確認）：**

1. **誰當 reviewer — 決定：** 盡量用不同種類的 Agent；沒有任何可用的、或 quota 用完時，用同種類也可以。注意：這時獨立的只剩 session，與 F5 的限制一致。
2. **reviewer 看到什麼 — 決定：** repo 的唯讀權限，「與調整需求」。*使用者 2026-11-04 確認以下理解：* reviewer 能讀整個 repo（唯讀、不能改），並且可以**建議**調整需求（驗收條件），但不能自己改卡片；調整由作者／Lead 或人決定。卡片內容可能含機敏資訊而 repo 是公開的，所以給 reviewer 的卡片欄位仍限標題、描述、驗收條件（同 `card assign` 的規則）。
3. **什麼算 `pass` — 決定：** 先試逐條對驗收條件回答。diff 太大代表 Lead 規劃功能時切得太大（問題在規劃，不是 review）；若是單一 commit，就針對單一 commit 審；**最後整個需求（可多個 commit）還要做一次整體 review**。*使用者 2026-11-04 確認以下理解：* 兩層 review——每個 commit 一次、整個 PR 一次；merge 的依據是**整體 review 的 pass 綁 head sha**。diff 太大時不是 `inconclusive` 了事，而是退回 Lead 要求重新切分。
4. **輪數與誰修 — 決定：** 先設定審 **2 輪**，之後退給 Agent；Lead Agent 若判斷需要人為判斷才退回人工，否則**像 skill goal 一樣朝目標 loop 到結束**。quota 不夠時，要能**記錄並 handoff 給別的 Agent**。
   - **與既有驗收的衝突，已由使用者定奪（2026-11-04）：** 需求卡與追蹤清單 F4 寫「任何失敗都退回人工並附證據，不無限重試」，與「loop 到結束」衝突。使用者的決定：**loop 保留總上限，先設 5 次**（2026-11-04 使用者再改為 **3 次**；之後可依要求調整）；超過一律退回人工並附證據。*Agent 的理解（待確認）：* 兩個數字分開——**每次審查最多 2 輪**，整個「審查→修正」loop **總共最多 5 次**；一次「審查→修正」算一次。F4「不無限重試」因此維持成立。
   - handoff（quota 不夠時把進度交給別的 Agent）是新能力，追蹤為 F7，尚無設計；至少要記錄：做到哪、剩什麼、已審過的 commit、未處理的 findings，寫在卡片的流程紀錄。
5. **敏感路徑清單 — 決定：** 同意暫定清單（`.github/`、`AGENTS.md`、`package.json` 與 `scripts/`、政策相關檔），並**加上** `SPEC.md`、`src/policy.ts`、`src/github.ts`；「之後仍可由使用者要求調整」。*Agent 的補充：* 清單本身要放在 bridge 端（程式或使用者的政策設定），不能放在 Agent 在 worktree 裡能改的檔案；放在程式裡時，**該檔案本身也要列入敏感路徑**，否則 Agent 可以先改清單再 merge。
6. **findings 寫在哪 — 決定：** 寫在**卡片**，卡片**多一個專門放 findings 的欄位**；**不貼成 PR 留言**（PR 是公開的）。findings 是 reviewer 發現的問題清單（檔案、位置、說明、嚴重度）。*實作時才決定的形式：* 是 frontmatter 欄位或內文段落；Agent 的建議是內文段落（例如 `## Review 發現`），因為 frontmatter 的解析器是受限子集、findings 可能很長，而且段落可以保留每一輪、每個 commit 的紀錄。需新增卡片格式（ADR-0001／0002）與 `card show` 的顯示，尚無設計。

### 新開 pane 的 reviewer 與 coding Agent，以及跨機器（2026-11-04，使用者決定；**目前沒有任何程式**）

這一節**取代**階段 3c 原本「由使用者指定一個現有 pane 當 reviewer」的設計。

**使用者的決定：**
1. **Lead 的 review 與 coding 一律用新開的 pane、新開的 Agent，用完就關閉。** 使用者原話：「還是都 lead 都以新開 pane, agent 來做 review, coding. 用完就關閉」。
2. 使用者對 Agent 的整理（4 點）回「照建議」：
   - **review 指令：** `card review <卡片 id> [--agent <種類>]`，不再帶 pane。bridge 在新 pane 啟動一個全新的 reviewer Agent，送出 review 提示，等回覆，寫入 findings 與 `review_verdict`，然後關閉這個 pane。
   - **獨立性靠「新開」保證：** 新 pane、新 terminal、新 session，一定和作者不同；不再要求 session 事先已知（這解掉 `agy` 新開時沒有 session 的卡點，見 ISSUE-066／069）。種類預設選**和作者不同**，不行才用同種類；`--agent` 可指定。
   - **coding：** `card assign --worktree` 開的 Agent 在任務完成後也由 bridge 關閉它的 pane；**worktree 本身保留**（之後還要 review、`card pr`、merge 後才清理）。這等於把追蹤清單 E13（關閉 bridge 自己開的 workspace）從「已決定、不做」改成要做，範圍改為「bridge 自己開的 pane」。
   - **reviewer 在卡片的 worktree 裡啟動**（可以讀到 PR 的實際程式碼）。代價：不同種類的 Agent 第一次進這個目錄會遇到它自己的信任提示，**bridge 不會替人按**（沿用既有規則）。
   - **關閉的安全規則：** 只關 bridge 自己開的 pane，關之前核對 terminal id 是同一個；reviewer 逾時或卡住（blocked，例如信任提示沒人按）時，記 `inconclusive` 然後**仍然關掉**。
   - **種類啟動失敗（包含 quota 用完）時：** 回報「這個種類啟動失敗」並停下，**不自動換種類**；由使用者用 `--agent` 指定。
3. **跨機器（使用者補充）：** coding 可能在 A pod、review 可能在 B pod，兩邊都從 **repo（遠端 git）拉回**同一個 feature branch。**設計限制（Agent 的整理）：**
   - review 的材料必須來自 GitHub 的 PR（head sha、檔案清單、diff，階段 3b 已是這樣），**不能依賴 coding 那台機器的本機 worktree**。
   - 所以 review 只在 feature branch **已 push 並開了 PR 之後**進行；reviewer 的工作目錄是它所在機器上、從 `origin` 取回 PR head 的**新 worktree**（review 用完連同 pane 一起清理，唯讀）。
   - 每台機器都要有這個 repo 的 clone；Herdr 已支援 `--machine <label-or-id>`，卡片的 `## 異動專案` 已記錄機器 id（專案名稱 `<機器 id>:<repo>`）。
   - 目前 bridge 的卡片功能**只支援本機**（worktree、`card pr`、清理都是）；遠端 pane／worktree 的實測需要使用者同意（不得未經同意在 `agy-pod` 上執行指令，追蹤清單 H1／ISSUE-055）。

**第一版範圍（Agent 的建議，待使用者確認）：** 3c 先做**本機**的新 pane reviewer（含關閉），但介面不綁死本機（review 材料來自 PR、reviewer 的 checkout 來自 `origin`）；遠端機器另開階段（F9），先用最小的實驗確認 Herdr 的 `--machine` 對 pane／worktree／agent 的支援，再決定。

**尚待使用者確認：** (a) 第一版先做本機、遠端另開階段；(b) 每台機器上這個 repo 的 clone 在哪裡、怎麼找（每台固定路徑，還是靠 Herdr 的 worktree 來源）；(c) coding 與 review 在不同機器時，卡片的哪些欄位要記錄是哪台機器做的。


### loop 的第一步：手動版 `card fix`（2026-11-04，使用者決定）

使用者對 Agent 的設計提案回答「照建議，先做手動版 card fix」：
1. **每圈新開 pane、新 Agent；作者「就看最後 pane 是誰」**：種類沿用卡片最後一個任務的 Lead（它的 pane 還在才行），`--agent` 可指定。
2. **先做手動版** `card fix <id>`，驗收後再串成自動 loop。
3. 計數：每次審查最多 2 輪、整個 loop 總上限 **3**（由 5 改為 3）。Agent 的實作理解：總上限以「整體 review 的輪次」計，最新一輪整體 review 已是第 3 輪還沒通過就退回人工；inconclusive 的那幾輪也算（保守）。「每次審查最多 2 輪」目前**沒有**實作（手動版每次 `card review` 就是一輪），留給自動 loop 時決定。

實作與限制見 SPEC「`card fix`」與 ISSUE-081。
