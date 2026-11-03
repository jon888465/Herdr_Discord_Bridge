# Card-to-Merge 追蹤清單

建立：2026-11-02。對應 [REQ-20261030-card-to-merge](cards/REQ-20261030-card-to-merge.md)、[ADR-0001](adr/0001-portable-md-cards.md)、[ADR-0002](adr/0002-operational-cards-in-plugin-state.md)、[REQ-20261101-worktree-isolation](cards/REQ-20261101-worktree-isolation.md)。

> **這份清單是「Card-to-Merge 還有什麼沒做」的唯一權威來源。** 原本這些項目散在規劃卡切片、兩份 ADR、兩張需求卡與五個 issue 裡，容易遺漏。清單內容是規劃與盤點，**不代表任何尚未實作的能力已可使用**。問題與驗收的正式紀錄仍以 [known-issues.md](known-issues.md) 為準。

最後更新：2026-11-02（**階段 1 全部完成**：1a、1b、1c；`main` 在 `8cc4111`，本 PR 後全套測試 589 項：588 通過、0 失敗、1 略過，本機 macOS，非 CI）。

## 使用規則

1. 每個 PR 內文要註明它完成或推進了哪幾個項目編號，合併的同一個 PR 更新本清單的狀態與日期。
2. 狀態用語：**已實作**（程式在 `main`、自動化測試通過）、**待驗收**（需要使用者實機或實際流程驗證）、**已驗收**（有具體驗收證據，記錄在 known-issues）、**未開始**、**待決定**（需要使用者決定）、**受阻**（缺條件，寫明如何解除）。「已實作」不等於「已驗收」。
3. 每個階段結束做一次對帳：對各文件搜尋「尚未」「待確認」「未決」「待驗收」，確認都能對上本清單的某一項；對不上的補進來。**2026-11-02 第一次對帳**找到四處遺漏或過時（ADR-0001 的 cards 目錄未決已被 ADR-0002 取代；需求卡待確認第 8 項、泛用 `update` 的缺口、`setStatus` 轉換規則的確認都原本不在清單上），已補進 E10、C7、I7 並修正 ADR-0001。
4. 每個階段要過同一道門：① TDD，測試先看到失敗 ② 文件同步（ADR、SPEC、README、known-issues）③ 兩個平台 CI 全過 ④ 需重啟才生效的列入驗收，由使用者實機驗收後才標已驗收 ⑤ 既有行為的回歸測試 ⑥ 在 worktree 開發並走 PR。

## A. 文件與追蹤

| ID | 項目 | 狀態 | 備註 |
|---|---|---|---|
| A1 | 修正過時的狀態描述（ISSUE-052／053 索引與段落、規劃卡、ADR-0001 實作狀態、known-issues 開頭日期） | 已實作（PR #21） | 歷史紀錄中的「未 commit／push」是當時狀態，依 AGENTS.md 保留不改 |
| A2 | 單一追蹤清單（本檔） | 已實作（PR #21） | |

## B. 卡片格式與工具

| ID | 項目 | 狀態 | 來源 |
|---|---|---|---|
| B1 | 受限 frontmatter 解析與驗證 `parseCard` | 已實作 | PR #6 |
| B2 | 匯入 `importCard`（強制 `draft`、清空 `external`、不覆蓋） | 已實作 | PR #7 |
| B3 | 序列化 `serializeCard`（寫出前自我讀回檢查） | 已實作 | PR #8 |
| B4 | 單檔驗證指令 `herdr-card-check` | 已實作、**待驗收** | PR #10、ISSUE-054 |
| B5 | 範例卡與 Mantis 轉換指引 | 已實作、**待驗收** | PR #9、#11、ISSUE-054 |
| B6 | 整檔大小上限依用途帶入（匯入 512 KiB、營運卡片 1 MiB） | 已實作 | PR #17 |
| B7 | 檔案層 `CardStore`（讀、列表、建立、帶雜湊更新、匯入；拒絕符號連結與路徑跳脫） | 已實作（**無呼叫端**） | PR #12 |
| B8 | bridge 專用受限寫入 `setStatus`／`appendLog` 與 0600 權限 | 已實作（**無呼叫端**） | PR #18 |
| B9 | 共用機敏內容遮蔽 `redactSecrets`；handoff 摘要先遮蔽再截斷 | 已實作、**待驗收**（需重啟 bridge 後實際 handoff） | PR #20、ISSUE-056 |
| B10 | Mantis 匯出（純文字，不呼叫 API） | **受阻**：需要使用者提供實際 Mantis 建單表單才能核對欄位 | ADR-0001 決定 8 |
| B11 | 匯出到 Mantis／Notion 預設排除 `## 流程紀錄` 與 `## 異動專案` | 未開始（隨 B10 一起做） | ADR-0002 決定 11 |

## C. 卡片端內容規則（階段 1，**已全部完成**，尚未接 bridge）

依賴：B6、B8、B9。

| ID | 項目 | 狀態 | 來源 |
|---|---|---|---|
| C1 | 事件模板與固定說明格式（14 種事件，`buildLogEntry`／`CardStore.recordEvent`） | 已實作（無呼叫端）；清單使用者回覆「照提議的做」，未逐項增刪 | ADR-0002 決定 11 |
| C2 | 說明長度上限改為結構化 300 字、自由文字 200 字（取代程式裡暫定的 1000） | 已實作 | ADR-0002 決定 11 |
| C3 | 疑似機敏時整筆說明改固定訊息（事件時間、事件名、事件 id 保留）；套用於所有欄位，檢查在截斷之前 | 已實作 | ADR-0002 決定 11 |
| C4 | `projects` 欄位取代 `project`（暫時仍相容）；專案名稱 `<機器 id>:<repo 目錄名>`，被改寫的目錄名加雜湊避免撞名 | 已實作 | ADR-0002 決定 4 |
| C5 | `## 異動專案` 的寫入（機器、repo 路徑、分支、worktree 路徑、base／head commit、PR 網址、remote）：`upsertProjectSection`／`CardStore.recordProject`，更新而非只追加 | 已實作（無呼叫端） | ADR-0002 決定 4 |
| C6 | 輪替：超過門檻（硬上限的 75%）時舊紀錄移到 `logs/<id>/NNNN.md`，卡片保留最近 5 筆；事件 id 去重（含旁檔）；先建旁檔再更新卡片；旁檔失敗拒絕追加；`readLog`；單次追加最多 200 筆 | 已實作（無呼叫端） | ADR-0002 決定 10 |
| C7 | 受限通道的強制：目前泛用的 `CardStore.update` 仍公開，「bridge 只動自己的區域」只是使用約定；另 frontmatter 註解與欄位順序會在 bridge 寫入時被正規化 | **待決定**（是否移除或限縮泛用 `update` 對 bridge 呼叫端的可見性） | ADR-0002 實作狀態的限制 |

## D. 入口與整合（階段 2：bridge 第一次真的用到卡片，第一個有 live 風險的階段）

依賴：C 全部。**沒有入口，worktree 與政策檔都無法被使用或驗收，所以排在 worktree 之前。**

| ID | 項目 | 狀態 | 來源 |
|---|---|---|---|
| D1 | 營運卡片目錄 `<stateDirectory>/cards/` 的建立與權限檢查 | **2a 已驗收 2026-11-02**（ISSUE-057；第一次寫入時建 0700，既存且他人可存取則拒絕並提示 chmod，不是「啟動時」檢查） | ADR-0002 未決 6 |
| D2 | 卡片索引、搜尋與列表（依 `projects`、`status`） | 部分：`card list [status]` 已實作並驗收（2a，2026-11-02）；依 `projects` 搜尋未做 | ADR-0002 未決 7 |
| D3 | 指令入口：建卡、列卡、看卡、指派 | **已決定**（Q1：加進 `handleCommand`，Discord＋console）。`list`／`show`／`import` 2a 已驗收（2026-11-02）；`assign` 屬 2b | ADR-0002 階段 2 決定 |
| D4 | 卡片 → Team 任務 → journal → 紀錄 的串接；journal 事件到紀錄行的對照表與事件 id 產生方式 | **進行中（階段 2b）**：第一步卡片資料層已實作（`tasks` 欄位、`completed` 事件、`recordTask`）；第二步 `card assign` 啟動已驗收（ISSUE-058，2026-11-02）；第三步 journal 同步已驗收（`src/card-sync.ts`，ISSUE-059，2026-11-02）。事件 id 暫定 `<taskId>-<journal sequence>`，見 ADR-0002 | ADR-0002 未決 3 |
| D5 | `projects` 的專案名稱規則 | **已決定**（使用者 2026-11-02 選 `<機器 id>:<repo 目錄名>`）並已實作於 C4 | ADR-0002 未決 2 |
| D6 | 執行中的卡片被刪除時停止寫入並詢問，不默默繼續或取消 | **已驗收 2026-11-02**（階段 2c，ISSUE-060；引擎只有取消沒有暫停，所以是「停止寫入並詢問」） | ADR-0001 決定 7、ADR-0002 決定 7 |
| D7 | 卡片內容是不可信輸入：指派時如何交給 Agent，內容當資料而非指令 | 已實作（`src/card-handoff.ts`，Q3；ISSUE-058，已驗收 2026-11-02）。**不能防止 prompt injection** | card-to-merge 風險 |
| D8 | 回歸測試：既有 `team ask`、Vibe Coding、Discord／CLI 指令行為不變 | 未開始 | card-to-merge 驗收條件 |
| D9 | 重啟與 live 驗收；SPEC、README 同步 | 2a 的 SPEC、README 已同步；重啟與 live 驗收已完成（2026-11-02，ISSUE-057） | AGENTS.md |

## E. worktree 隔離（階段 3，先本機）

依賴：D（至少 D1、D3、D4）。方向已定：Herdr 原生 `herdr worktree`，一卡一個 worktree workspace，只在卡片開始開發時才建（見需求卡）。

| ID | 項目 | 狀態 |
|---|---|---|
| E1 | 查出 Herdr socket API 中 worktree 方法的名稱與參數（`herdr api` 可查）；bridge 走 socket 而非 CLI | **已完成（3a）**：`worktree.list`／`create`／`open`／`remove`，參數與回應見需求卡「Socket API 與 3a 轉接層」 |
| E2 | 路徑與分支命名（含 `/` 的分支名 slug 規則需實測）；`--base` 預設與是否先 `git fetch` | **已決定並實測（3a）**：分支 `card/<卡片 id>`、基準＝repo 目前 HEAD、不先 `git fetch`（使用者 2026-11-02）；實測 slug：`/`→`-` 且轉小寫（`card/REQ-20261102-ab` → `card-req-20261102-ab`） |
| E3 | 建立與清理：永不使用 `--force`、有未提交修改時保留並通知、不自動刪分支 | **已實作並驗收（3a 轉接層＋3b `card cleanup`，ISSUE-062，2026-11-03）**；清理觸發改為「卡片 merge 後」見 E11：`removeWorktree` 不送 `force`、髒檢出保留並寫 `cleanup_pending`；只由 `card cleanup <id>` 手動觸發，不自動清理 |
| E4 | `allowedWorkspaceIds` 規則：只自動納入 bridge 自己建立的 workspace | **已決定並實作（3b；本機未設 `allowedWorkspaceIds` 限制，限制情境未驗）**：只放行索引 `card-worktrees.json` 記錄的 worktree workspace，且來源 workspace 本來就被授權；重啟依索引重新納入；清理時撤銷（使用者 2026-11-03 決定） |
| E5 | 新 workspace 的 Discord thread 對應 | **已決定**（使用者 2026-11-02）：沿用卡片的 thread，bridge 把該 thread 的路由切到新 workspace。**使用者 2026-11-03 改選「一步」**：`card assign --worktree` 在新 workspace 自動啟動同種 Agent 再啟動任務（取代先前「第一版不自動啟動 Agent」）。已實作並驗收（3b）；Agent 被擋住（blocked）時不啟動任務，見 E9 |
| E6 | 啟動時檢查 Herdr 最低版本（實測只在 0.9.1，文件為 v0.9.5） | **檢查函式已實作（3a，未接線）**：`checkWorktreeSupport` 以 socket `ping` 的 `version` 判斷，最低 0.9.1（Agent 的選擇：實測過的版本）；何時呼叫屬 3b |
| E7 | 版本指紋、單一 writer、不同 session review、artifact 在樹外，在 worktree 內仍成立 | 未開始 |
| E8 | worktree 內 Agent 的結果 → 卡片紀錄（只寫結構化事實，不寫自由文字） | 未開始 |
| E9 | 在 worktree 的 pane 啟動 Agent、含 `/` 的分支名等**未實測**項目 | 部分：含 `/` 的分支名已實測（3a）。**在 root pane 啟動 Agent 已實測（3b，2026-11-03）**：`agent.start` 後 Agent 約 2–4 秒才被偵測到；Claude Code 在新資料夾會先問「信任這個資料夾」→ 狀態 `blocked`，所以一步流程在新資料夾通常會停在需要人確認的狀態（bridge 不替你確認）；Codex 等其他 Agent 未測 |
| E11 | **卡片 merge 後清理 worktree**（使用者 2026-11-03）：完成不等於清理；**卡片已 merge 才應該清理**。對「沒辦法 merge、沒辦法被清理」的卡片（髒檢出、PR 未 merge、被擋住），要讓使用者能**從卡片先看到狀況**（見 E12）。依賴 PR／merge 事件，屬政策檔與 PR 自動化（F、G）；在那之前維持手動 `card cleanup` | **已決定、未實作** |
| E12 | **卡片呈現 worktree 與清理狀況與決議**（使用者 2026-11-03）：使用者確認「卡片的說明欄位本來就可以寫自由文字」，並**選選項 1**：(a) bridge 在 `## 異動專案` 自動寫結構化的 `worktree 狀態`（作用中／已清理／因未提交修改保留），`card show` 單獨列出；(b) `## 決議` 由人或 Agent 自己寫、bridge 不改寫、`card show` 單獨顯示。「尚未 merge 而保留」等狀態待 E11（merge 自動化）。選項 2（bridge 自動寫 Agent 摘要，需機敏檢查、放寬決定 11）尚未做 | **選項 1 已實作並驗收 2026-11-03**（ISSUE-062 後續；「作用中」與「保留」狀態的顯示只有自動化測試證據） |
| E13 | **關閉 bridge 自己開的來源 workspace**（使用者 2026-11-03）：`create` 若是為了這個 worktree 才開了來源 repo 的 workspace，清理最後一個 worktree 時一併關閉；使用者自己開的來源 workspace 不動。需要在建立時記錄「來源 workspace 是否由 bridge 開啟」（`worktree.list` 的 `open_workspace_id` 可在建立前判斷）；關閉要用 `close_group` | **已決定、未實作** |
| E10 | 專案政策 L0（不 push）是否也需要 worktree | **待決定**（需求卡待確認第 8 項）；目前由 `--worktree` 旗標決定，政策檔階段（F）再議 |

## F. 政策檔與 PR 自動化（階段 4：L0／L1，不 merge）

依賴：E。

| ID | 項目 | 狀態 |
|---|---|---|
| F1 | 專案政策檔的 schema、載入方式與信任邊界（Agent 不得自行升級權限） | **已實作並驗收 2026-11-03**（ISSUE-063）。使用者 2026-11-03 決定：**只放 plugin 設定目錄、不放專案 repo**（取代原預定的 `.herdr/policy.yml`）；受限 YAML 子集自己解析；第一版只做載入與唯讀查詢。限制：同一 OS 使用者的 Agent 仍能改檔案 |
| F2 | GitHub 認證：bot 帳號或 App、階段二 token 權限（見 ISSUE-052 討論） | **已決定、未實作**（使用者 2026-11-03）：**L1 第一版先用你現有的 `gh`／ssh 登入**（`jon888465`），不新增帳號或憑證；**進 F3 前再做**。**L2 要用什麼身分尚未決定**：Agent 的建議是至少改用單一 repo 的 fine-grained token（不要用 ssh key）並打開 G3；獨立身分（G2）是更強的選項、不是前提，取捨見需求卡「F2 決定」。最小權限清單見同一節 |
| F3 | 開 PR、等 CI、回報（L0 只在 worktree、L1 開 PR 由人 merge） | **已實作，主要路徑 live 驗收通過 2026-11-03**（ISSUE-064）。使用者 2026-11-03 決定：`card pr <id>` 要卡片 done、專案政策 L1 以上；第一版包含 CI 輪詢與回報；第一次 live 驗收用 Herdr_Discord_Bridge 本身的無害文件卡；PR 標題用卡片標題、內文只放卡片 id 與結構化事實；身分用現有 gh／ssh（F2）。`merged` 事件與 merge 後清理屬 E11，尚未做 |
| F4 | 失敗處理：review 不過、測試失敗、CI 紅、衝突都退回人工並附證據，不無限重試 | 未開始 |

## G. L2 與防護（階段 5）

依賴：F。**授權止於 merge；merge 不等於部署、重啟或驗收。**

| ID | 項目 | 狀態 |
|---|---|---|
| G1 | CODEOWNERS：政策檔、`.github/`、`AGENTS.md` 強制人工審查（需要第二個身分才有意義） | 未開始 |
| G2 | Agent 專用 bot 帳號或 GitHub App | 未開始、**待決定**。**不是 L2 的前提**（2026-11-03 更正：先前這裡把「L2 前必須獨立身分」寫成使用者的決定，那其實是 Agent 的建議；使用者只決定了 L1 先用現有登入）。好處：憑證範圍可縮小、稽核與撤銷、CODEOWNERS 有第二個身分時才有意義 |
| G3 | 打開 `strict_required_status_checks_policy` | **待決定**（自動 merge 前建議開） |
| G4 | 紅燈 PR 被擋的實測（直接 push 被拒已測） | 未開始（ISSUE-052 剩餘） |
| G5 | 啟用 Dependabot（action 已釘 SHA） | 未開始（ISSUE-052 剩餘） |
| G6 | 公開 repo 的不可信輸入、fork PR 的 workflow 權限 | 未開始 |
| G7 | L2 自動 merge，先拿 herdr bridge 自己試；首次試跑建議用 L1 | 未開始 |

## H. 延伸（階段 6）

| ID | 項目 | 狀態 |
|---|---|---|
| H1 | 遠端 worktree 與清理、殘留偵測（ISSUE-055）；遠端 `herdr --machine … worktree` 實測需使用者同意 | 待決定 |
| H2 | 自動撿卡（`status: ready`） | 未開始 |
| H3 | Tracker（Mantis／Notion／Trello）匯入或同步 | 未開始 |
| H4 | **端到端自動化測試案例**：流程完成後，用 ISSUE-061（較小、較低風險，**先用這個驗證流程本身**）與 ISSUE-055（刪除檢出，風險較高，之後）各跑一次「建單 → 分配 → 開發 → review → test → PR → merge → 結單」。第一次以 L1（人 merge）進行，不直接用 L2。前提與目前缺口見 ISSUE-061、ISSUE-055 的「預定用途」 | 未開始（review、test、PR、merge 自動化尚未實作；建單、分配、結單同步已有） |

## I. 驗收債（獨立於階段，等使用者）

| ID | 項目 | 需要的動作 |
|---|---|---|
| I1 | ISSUE-054：真實 Mantis 單走完「請 Agent 轉卡片、跑驗證」 | 拿一張真實 Mantis 單 |
| I2 | ISSUE-056：實際 session handoff 驗收 | 重啟 bridge 後跑一次 handoff |
| I3 | ISSUE-053：是否標已驗收（沒有 live 項目） | 使用者決定 |
| I4 | ISSUE-052 剩餘：紅燈 PR 實測（G4）、Dependabot（G5） | 見 G4、G5 |
| I5 | 需求卡 `REQ-20261030-standalone-example-cards` 的驗收勾選，以及兩個預設選擇（虛構標示放 `source`、保留 Mantis 範例的「Agent 推測」句） | 使用者確認 |
| I6 | ISSUE-055 的三個問題：清理不阻擋完成的原則、L0 遠端是否先推送、是否定期掃描 | 使用者決定 |
| I7 | `setStatus` 的轉換規則（bridge 只能設 `in_progress`／`done`、只能 `ready → in_progress → done`）是 Agent 的預設，使用者尚未逐項確認 | 使用者確認 |

## 事件模板提議（C1，**尚未確認**）

說明文字一律由模板組出；只有 `failed` 的短原因是自由文字（走 C3 的機敏檢查）。

| 事件 | 觸發 | 結構化欄位 |
|---|---|---|
| `assigned` | 人工指派 | 機器、Agent／profile |
| `worktree_created` | 建立 worktree | 機器、路徑、分支、base SHA |
| `started` | 開始開發 | task id |
| `review_verdict` | review 結束 | 角色、判定（pass／changes_requested／inconclusive）、第幾輪 |
| `verify_result` | 驗證結束 | pass／fail、測試通過與失敗數 |
| `pr_opened` | 開 PR | PR 網址、編號、head SHA |
| `ci_result` | CI 結束 | 結論、run 網址 |
| `merged` | 合併 | merge SHA、方式 |
| `blocked`／`resumed` | 被擋或恢復 | 原因分類碼（問題、額度、連線、髒工作樹） |
| `failed` | 失敗 | 分類碼，可選一段短原因 |
| `cancelled` | 取消 | 取消者 |
| `cleanup_done`／`cleanup_pending` | 清理 | 結果碼 |

## 原始規格稿中刻意不做的項目

最初的對話式多機器編排規格稿（Conversation Engine、Requirement Engine、HTTP API、Web UI、Machine Scheduler、SQLite schema）**不在本計畫內**：卡片改為 md 檔、營運卡片放 plugin 狀態目錄、先走 IPC 與 Discord／CLI，多機器沿用現有的 `machines` 設定（ISSUE-041）。若日後要重新評估，從 [REQ-20261030-card-to-merge](cards/REQ-20261030-card-to-merge.md) 的「非目標」開始。
