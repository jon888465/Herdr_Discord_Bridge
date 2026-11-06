# REQ-20261106-agy-pool 的 Lead 診斷報告

更新日期：2026-11-06。這是卡片 `REQ-20261106-agy-pool` 第四、五、六次嘗試中，各個指派的原始內容與回報，摘自 bridge 的 task journal（不進 git，所以留在這裡）。每份報告是 Lead 指派的 Worker 當時的原話，未改寫；其中對程式的說法是當時的觀察，**不等於已驗證的事實**。主文件見 [REQ-20261106-agy-pool.md](REQ-20261106-agy-pool.md)。

## 第四次嘗試（task `task-544ae3b7-5cdc-4086-b97f-7315def8ca39`，第三個指派因角色用錯被退回）

## diag-adapter (diagnose, done)

instruction:
Read-only diagnosis; do not modify any files. Task: make agy usable as a --coding Worker/Reviewer candidate. Read AGENTS.md, SPEC.md, CONTEXT.md, docs/known-issues.md (E14, ISSUE-085/088/089/090/091/094/098/099 and every agy-related entry). Read src/coding-roster.ts (AUTO_CODING_KINDS), src/agent-pool.ts, src/review-pane.ts (REVIEWER_KINDS), src/cli-adapter.ts (antigravity adapter), src/hook-agy.ts. List concretely, with file:line, where claude/codex get special handling that agy lacks and where the logic is already generic: startup readiness, prompt submission, report/reply format, final-reply or transcript recognition, profile/capability gating (implementation/review capability), and how an opt-in 'agy profile has implementation/review capability' mechanism could be added to coding-roster without changing default behavior. Output a numbered problem list; mark each item as a confirmed gap or as already generic, and propose a minimal fix and a unit test for each gap.

report:
唯讀診斷完成。確定需要修改的是自動候選資格；其餘多數流程已通用，但 agy 的 hook／session／窄 pane 完整流程仍需實機驗收。

1. **確認缺口：即使 agy profile 宣告 coding capability，自動候選仍排除它。**
   - 證據：`src/coding-roster.ts:10,13,22–25` 只接受 claude／codex，`AutoPool.profiles` 甚至沒有 capabilities 欄位；`:33` 的錯誤訊息也只提兩者。
   - 最小修正：保留 `AUTO_CODING_KINDS` 的既有預設，將 profile 型別加入 `capabilities?: readonly string[]`；額外接受 `kind === "agy"` 且 capabilities 含 `implementation` 或 `review`。analysis-only／未設定的 agy 與 pi 維持排除。兩個候選的門檻與「已有指定 Worker 不補候選」保持原樣。
   - 單元測試：analysis-only、缺省 capability 均排除；implementation-only、review-only、兩者皆有均納入；claude／codex 無 capabilities 仍納入；一個 codex＋opt-in agy 可以達到兩候選門檻；不足兩個時不產生任何 select 副作用。

2. **確認缺口：capabilities 目前是資訊，並不是角色授權。**
   - 證據：`src/agent-pool.ts:15,50–59,85` 只驗證／保存字串；`src/team-orchestration.ts:685–699` 把完整 profile JSON 給 Lead，但沒有要求或強制 capability 與角色匹配。全 src 搜尋 capabilities 僅命中 agent-pool。
   - 最小方案有兩種，Lead 必須先定義語意：
     - 若 capability 只代表「使用者同意加入 coding 候選」，修改 roster 即足夠，文件必須明說 review-only 不限制它被 Lead 指派 implement。
     - 若宣稱 implementation／review 是角色能力，必須另加派工驗證：agy profile 的 implement 要求 implementation、review 要求 review；diagnose／verify 的政策另行明載，不能自行把 analysis 等同 verify。
   - 建議採第二種，避免 review-only 被當作者。只對 agy profile 加新規則，保留既有 claude／codex 與 live pane 行為。
   - 單元測試：review-only agy 被派 implement 時在啟動／送 prompt 前拒絕；implementation-only 被派 review 同樣拒絕；相符角色通過；非 coding 任務與既有 CLI 不變。

3. **已通用：啟動、就緒等待、shell busy 與 pane 分割。**
   - `src/agent-pool.ts:277–305,325–344` 以 profile.kind 等待同 pane 進入 idle／done，無 claude／codex 專用分支（ISSUE-091）。
   - `src/herdr.ts:240–241,265–293` 的替代分割位置與 bounded `agent_pane_busy` retry 對所有 profile 生效（ISSUE-094／098）；`src/review-pane.ts:65–81` 同樣共用分割策略。
   - 不需新增 agy startup adapter。建議把既有 readiness／busy fixture 參數化加入 agy，驗證 unknown→working→idle、不同 kind 拒絕及 timeout。
   - **尚待實機確認：** known-issues 記錄過 agy approval UI／背景工具仍被 Herdr 判 idle（`docs/known-issues.md:1056`）；這是已記錄的上游狀態限制，不能靠新增 roster entry 宣稱解決。

4. **已通用：文字 prompt 提交與回覆契約。**
   - `src/team-turn.ts:115–135` 共用 `promptAgentAndWait`，prompt stalled 不重送；`src/herdr.ts:365–379` 共用 atomic prompt 的舊版 fallback。
   - `src/coding-workflow.ts:291–294` 對所有 CLI 要求相同 codingResult JSON、verify exit code 與唯讀版本約束。
   - `src/cli-adapter.ts:477–478` 的 agy `> ` adapter 主要處理一般回覆抽取；Team turn 使用 nonce frame，不是單純沿用這個 adapter 的 prompt echo 抽取。
   - Claude 圖片補 Enter（`src/herdr.ts:437–455`）是附件 UI 特例，沒有證據顯示 agy 的純文字 coding assignment 需要相同處理。

5. **已通用：agy 原生 transcript 最終回覆已透過 Stop hook 接入 Team。**
   - `src/hook-agy.ts:6–30` 從最後 USER_INPUT 後，取最後沒有 tool_calls 的 PLANNER_RESPONSE。
   - `src/hook-cli.ts:65–87` 只轉送 `NO_TOOL_CALL`、非 `fullyIdle:false` 的完成事件，讀 transcript 後帶 conversationId／paneId 發 Stop。
   - `src/main.ts:241–248` 共用 auto hook 查詢；`src/team-turn.ts:108–114,237–251` 以本回合 nonce 截取 hook frame，只有 idle／done 才結算。因此不需要把 agy 包裝成 CodexTranscript。
   - 建議驗證 fixture：agy 長篇 framed codingResult，畫面只剩結尾，正確 conversation Stop 仍取得完整報告；錯 nonce／舊回合 hook 不結算；fullyIdle:false 不轉送。

6. **確認缺口／限制：agy 沒有 Codex 的直接 transcript 後備讀取及終端 JSON 修復。**
   - `src/team-turn.ts:100–115,202–235` 的 nonce rollout discovery／完整 final 讀取僅限 codex。
   - `src/team-task-engine.ts:435–442` 只有 codex 在 JSON 解析失敗後執行 `unwrapCodexJson`。
   - `src/cli-adapter.ts:445–452` 對 Claude／pi 有畫面正規化，agy 回傳原畫面。因此 agy hook 遺失、關閉或未成功讀 transcript 時，仍可能因 frame 捲出或 JSON 硬換行而失敗；**本次沒有實機重現這個 agy 症狀，不能稱為已確認 live bug。**
   - 最小處置：先以已存在的 agy hook 作為完整報告通道，新增上述測試並明載 parser fallback 的限制；不要直接套用 Codex 的猜測式 unwrap。
   - 若產品要求 hook 不可用時仍保證完成，才需另立 agy transcript 定位／相關性設計與 captured-screen regression，不能從本次靜態證據直接定案。

7. **已通用，但 agy session 是實機驗收關鍵。**
   - `src/team-task-engine.ts:389–398,410–413` 只有 codex 享有延後以 rollout 確認身分的特例；agy 沿用 Herdr session。
   - `src/coding-workflow.ts:124–140` 會拒絕未知 reviewer／author session 及相同 session；`src/team-turn.ts:145–181` 允許 session 首次出現，其後變動則拒絕。
   - 不應為了讓 agy 通過而複製 Codex 的豁免或放寬獨立性。需要實測新 agy profile 啟動後是否有正確 conversation session，且作者與 reviewer 的 session 不同。
   - 建議 fixture：兩個已知不同 agy session 通過；同 session 不同 pane 拒絕；未知 session 拒絕。若實機身分缺失，交由 session 診斷子題處理。

8. **已通用：Reviewer kind 與結果解析沒有額外阻擋 agy。**
   - `src/review-pane.ts:16,25–44` 已包含 agy；明確 requested kind 以語法驗證通過後照用。這是 card reviewer 的種類選擇，並不會自動把 agy 加入 `--coding` roster。
   - `src/team-task-engine.ts:438–444` 共用 parseCodingResult 並檢查回報 kind 與 assignment role 一致；agy 不需要另一份 reviewer JSON schema。
   - 既有版本指紋、獨立 review、verify gate 應保持不變。新增 agy fixture 的目的應是驗證既有契約可達，而非另設較寬鬆規則。

交接給 Lead：先決定第 2 項 capability 語意，再實作 roster／對應派工 gate；優先驗證 agy hook 長報告與新 session identity。E14／ISSUE-085／088／089／090／091／094／098／099 的歷史證據不能當成 agy 本輪驗收；單 Agent agy Stop 已驗收也不代表 coding 全流程已驗收。

本次修改檔案：無（包含設定與文件皆未修改，文件同步交由 Lead 統一處理）。執行命令：`pwd`、`git status --short`、`git diff --stat`、`cat`／`nl`／`sed` 讀取指定文件及程式、`rg`／`rg --files` 搜尋流程與測試。部分探索命令因不存在的 `src/team-plan.ts`、`test/hook-agy.test.ts` 回傳非零；未作產品測試失敗解讀。檢查發現此 checkout 沒有 dist，未執行 build／lint／tests，以維持唯讀範圍。開始及結束工作樹皆無修改。未 commit、push、merge、重啟、部署、使用 GitHub 或操作使用者設定。阻礙：沒有本輪 agy 實機派工證據；本指派不授權修改或啟動驗收流程。

{"codingResult":{"kind":"diagnose","findings":[{"id":"diag-adapter-roster-optin","summary":"coding-roster 的自動候選只接受 claude/codex，忽略 agy implementation/review capabilities；可用 capability opt-in 保持現有預設。"},{"id":"diag-adapter-capability-semantics","summary":"capabilities 目前只驗證保存並展示給 Lead，沒有角色 gate；若宣稱 review/implementation 是角色能力，需在派工前加入 agy profile 對應檢查。"},{"id":"diag-adapter-fallback-limit","summary":"agy 已透過 Stop hook transcript 共用 Team final 接收，但缺少 Codex 的直接 rollout fallback 與終端 JSON unwrap；hook 不可用時的長回覆完整性仍待驗收，未確認為 live bug。"}]}}

## diag-session (diagnose, done)

instruction:
Read-only diagnosis; do not modify any files. Task: make agy usable as a --coding Worker/Reviewer candidate. Read AGENTS.md, SPEC.md and the relevant docs/known-issues.md entries (E14, ISSUE-085/088/089/090/091/094/098/099, agy-related ones). Read src/handoff-evidence.ts, src/team-turn.ts, src/team-task-engine.ts, src/review-pane.ts and src/hook-agy.ts. Determine whether agy can: (a) report a stable session identity so that the 'reviewer is a different known session from the author' check works; (b) produce a handoff, verify report or reviewer reply that the parsers accept; (c) be detected by transcript or final-reply recognition. List the confirmed gaps with file:line, the agy-specific risks (including what would let a reviewer wrongly pass or fail the independence check), a minimal fix for each, and the unit tests needed (they must fail before the fix and pass after). Also say what can truthfully be verified live in this task, and what must be recorded as 'pending acceptance' with its missing conditions.

report:
rSession`（`:473`）是 `undefined`，之後所有 review 都被擋：「unknown author identity cannot establish an independent review」。

- `runTeamTurn` 回傳值只有 codex 的 `session`（`src/team-turn.ts:100-105`），沒有刷新後的 `AgentRecord`。

**G3：agy 換新對話時，`runTeamTurn` 會丟「Agent identity changed」。**

- `src/team-turn.ts:148` 的 `expectedSession` 只允許 session 從「無」變「有」（`:172-181`）。
- 已經有舊 session 的 agy（`team pool` 重用的 pane）在第一個 prompt 才建新對話（ISSUE-047），舊值變新值就被丟出。
- 串流路徑用 `agyConversationCreatedAt`（`src/main.ts:3059`、`:3251`）處理這個情況，team 路徑沒有。

**G4：agy 的 Stop hook 事件配對依賴 session，session 過期就退回畫面 parser。**

- `src/main.ts:244-247` 用 `hookEvents.stopSince(session.value, since)` 配對。
- hook 事件的 `sessionId` 是 `conversationId`（`src/hook-cli.ts:84`）。
- 若記錄的 session 是舊對話，配對不到，就退回畫面 parser。agy 的 adapter 只有 `MarkerCliAdapter(["> "])`（`src/cli-adapter.ts:478`），長 JSON 被窄 pane 換行時 `extractFrame` 可能失敗。
- 沒有 session 時用 `stopForPane(pane_id)`，依賴 hook 程序有 `HERDR_PANE_ID`（`src/hook-cli.ts:85`）。**agy 是否一定帶這個環境變數，我沒驗證。**

**G5：選用機制不存在。**

- `src/coding-roster.ts:10` 的 `AUTO_CODING_KINDS = ["claude","codex"]` 是寫死的種類清單。
- `profile.capabilities` 在 `src/agent-pool.ts:15`、`:85` 只被儲存和驗證，整個 `src/` 沒有其他地方讀它。
- `AutoPool.profiles` 型別（`src/coding-roster.ts:13-16`）只有 `{id, kind}`，看不到 capabilities。
- `src/coding-roster.ts:36` 的錯誤訊息只提 claude／codex。

**G6（低風險，非阻擋）：`src/handoff-evidence.ts` 與 agy。**

- `adapterName` 對 agy 回 `"agy"`（`:150`）。
- `readSessionEvidence` 只有 codex 有原生歷史讀取，agy 只能走 `checkpoint-only` 或明確匯出，這不在 `--coding` 路徑上。
- 另外，`src/review-pane.ts:16` 的 `REVIEWER_KINDS` 含 agy，但 `chooseReviewerKind` 取「第一個和作者不同」的種類，所以 agy 只有在使用者明確指定時才會被選為 reviewer。這是 card review／fix 路徑，不是 `--coding`。

### agy 特有風險（獨立性判斷會不會誤判）

- **誤判失敗（G1、G2）：** 新啟動的 agy 擔任 reviewer 或 author，review 檢查必定 fail closed，結果是 `inconclusive`。
- **誤判通過（理論風險）：**
  - **成立條件：** 作者 agy 的 `authorSession` 記的是派工前的舊對話 X，實際上 agy 在第一個 prompt 建了新對話 Y；之後另一個 pane 以 `--resume` 開同一個對話 Y 來審。
  - **為什麼會通過：** X 與 Y 不同，`sameAgentSession` 判為不同，檢查通過。
  - **現有保護：** `pane_id` 比對（`src/coding-workflow.ts:139`）仍擋得住同 pane；而且 G3 目前會讓這種情況先丟「identity changed」。
  - **風險等級：** 低。但修 G3 時如果「接受 session 變更」卻沒有同時刷新 `authorSession`，就會把這個洞打開。**修 G3 必須與 G2 一起做，並以回合結束後重新查詢到的 session 為準。**
- **回報格式：** agy 回覆中的 `codingResult` JSON 若被 Markdown 圍欄包住，`extractObjects` 能否處理，我沒有逐項驗證；沒有 agy 的 codingResult 測試。

### 最小修正與測試

| 缺口            | 最小修正                                                                                                                                                                                                                                                                             | 測試（修正前必須失敗）                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1、G2          | `runTeamTurn` 回合結束後重新 `getAgent`，回傳 `settled.agent`；`onAssignmentStart` 對沒有 session 的非 codex 只擋同 pane，其餘延到 `onAssignmentDone` 以刷新後的 session 判斷（fail closed 不變）。`src/team-task-engine.ts:410-413` 改用刷新後的記錄。                              | 新增 `test/team-task-engine-agy-session.test.ts`：(1) 新 agy 當 author，回合後 `authorSession` 有值；(2) 新 agy 當 reviewer 且與 author 不同 session 時不被拒、`independentReview=true`；(3) 回合後仍無 session 時 fail closed；(4) 同 session 或同 pane 仍判為非獨立。 |
| G3              | agy 本機且對話目錄 birthtime 晚於 `since` 時，允許 `expectedSession` 換成新值（比照 `src/main.ts:3251`），並與 G2 的刷新綁在一起。                                                                                                                                                   | `test/team-turn.test.ts` 新增：agy 的 session 在回合中換新值而且對話目錄是新建的 → 不丟錯誤；非 agy 或目錄不是新的 → 仍丟「Agent identity changed」。                                                                                                                   |
| G4              | 先不改程式。只確認 agy hook 是否帶 `HERDR_PANE_ID`；若沒有，`stopForPane` 路徑就不可用。                                                                                                                                                                                             | `test/hook-events.test.ts` 補一項 agy Stop 事件經 `stopSince` 配對 `conversationId` 的測試（現有只測 `agyFinalMessage`）。                                                                                                                                              |
| G5              | 在 `src/coding-roster.ts` 讓 `autoEnableCodingProfiles` 同時納入 `capabilities` 含 `implementation`／`review` 的 profile，並擴充 `AutoPool.profiles` 型別（`src/agent-pool.ts` 傳 `capabilities`）；`AUTO_CODING_KINDS` 預設不變，未改設定時行為與現在一致。錯誤訊息與註解同步更新。 | `test/coding-roster.test.ts` 新增：(1) 無 capability 的 agy 仍不被啟用；(2) 有 `implementation` 的 agy 被啟用；(3) 啟用後仍須至少兩個 profile；(4) claude／codex 預設行為不變。                                                                                         |
| agy parser 驗證 | 不改程式，只補測試。                                                                                                                                                                                                                                                                 | `test/coding-workflow.test.ts` 補 agy 風格回覆（Markdown 圍欄包 JSON、帶 BRIDGE 標記）能被 `parseCodingResult` 解析。                                                                                                                                                   |

### 可實際驗證與必須記為「待驗收」

**這個任務裡能真的驗證的（需要 bridge 與一個 agy pane 在線；本診斷回合沒有執行）：**

1. 在本機 workspace 把 agy 當 Worker 跑 `--coding`，收集 `implement` → `review` → `verify` 的 artifact，看 `authorSession`、`reviewerSession`、`independentReview` 是否有值。
2. 對照 hook log（`hook Stop session=… pane=…`）確認 agy 的 `HERDR_PANE_ID` 與 `conversationId` 是否能配上 Herdr 的 `agent_session`。

**必須記為「待驗收」，附缺少的條件：**

- agy 當 reviewer 的完整 `--coding`：缺一個已寫好 G1／G2 修正並重啟的 bridge、一個 agy profile（使用者要自己在 `config.json` 加 capability，我不改）、以及一次實際執行紀錄。
- agy 重用 pane（有舊 session）的 G3 情境：缺實機重現。
- 遠端 machine 的 agy：`agyConversationCreatedAt` 查不到目錄（ISSUE-047 已註明），維持停止。
- 以上都不能用單元測試通過來宣稱驗收（`AGENTS.md`）。

### 給 Lead 的交接

- 建議子任務順序：G1+G2（同一個 PR，共用「回合結束後刷新記錄」）→ G3（與 G2 綁定）→ G5（選用機制，可獨立）→ G4 的測試補強。
- 文件需同步：`docs/known-issues.md`（新增 ISSUE-104 起，ISSUE-103 已被佔用）、`SPEC.md`、`README.md`、`README.zh-TW.md`、`src/coding-roster.ts` 的註解與錯誤訊息。
- 這份診斷本身還沒找其他 agent review；卡片要求 Lead 把拆解交給別的 agent 看過再分配實作。
- 變更檔案：無。執行的指令：只有唯讀的 `grep`／`sed`／`cat`／`wc`／`git status`。測試結果：未執行測試。commit／push：無。阻擋：無。

{"codingResult":{"kind":"diagnose","findings":[{"id":"agy-g1-fresh-reviewer-rejected","summary":"src/team-task-engine.ts:398 與 src/coding-workflow.ts:128：新啟動、尚無 agent_session 的 agy 擔任 reviewer 時，assertIndependentReview 丟 unknown reviewer identity（誤判失敗）。"},{"id":"agy-g2-author-session-undefined","summary":"src/team-task-engine.ts:411-413、:473 與 src/team-turn.ts:100-105：新 agy 擔任 implement 作者時 authorSession 為 undefined，後續所有 review 被擋；runTeamTurn 沒有回傳刷新後的 AgentRecord。"},{"id":"agy-g3-session-change-throws","summary":"src/team-turn.ts:148、:172-181：已有舊 session 的 agy 在第一個 prompt 建新對話，會丟 Agent identity changed；串流路徑 src/main.ts:3251 有處理，team 路徑沒有。修此項必須與 G2 一起刷新 authorSession，否則有誤判通過的理論風險。"},{"id":"agy-g4-hook-pairing-unverified","summary":"src/main.ts:244-247、src/hook-cli.ts:84-85：agy Stop hook 事件以 conversationId 配對 session，過期則退回畫面 parser（src/cli-adapter.ts:478，換行可能切斷 JSON）；agy 是否帶 HERDR_PANE_ID 未驗證。"},{"id":"agy-g5-no-opt-in","summary":"src/coding-roster.ts:10、:13-16、:36 與 src/agent-pool.ts:15、:85：自動啟用只看寫死的種類清單，profile.capabilities 只被儲存、沒有任何讀取；需新增 capability 選用機制並讓預設行為不變，錯誤訊息一併更新。"},{"id":"agy-g6-handoff-nonblocking","summary":"src/handoff-evidence.ts:150 與 src/review-pane.ts:16：agy 只有 checkpoint-only 的 handoff 證據，REVIEWER_KINDS 含 agy 但只在明確指定時被選；皆不在 --coding 路徑上，非阻擋。"}]}}

## critique (review, failed)

instruction:
Read-only; do not modify any files. Critique the decomposition and proposals from the two diagnosis assignments diag-adapter and diag-session. Check them against the code yourself in src/coding-roster.ts, src/agent-pool.ts, src/review-pane.ts, src/cli-adapter.ts, src/hook-agy.ts, src/handoff-evidence.ts and src/team-turn.ts. Report: missed problems; wrong claims; whether the opt-in mechanism (the user adds an implementation/review capability to the agy profile in config.json; default behavior unchanged) is the best design, with alternatives; whether it weakens independent review, verify or card-merge guards in any way; the subproblem split and ordering suitable for a single writer (writeScope per file); the next available ISSUE number in docs/known-issues.md (ISSUE-103 is already taken); and the list of docs that must stay consistent (docs/known-issues.md, SPEC.md, README.md, README.zh-TW.md, src/coding-roster.ts comments and error messages). Output a concrete verdict and a final recommended plan.

report:
(none) blocker: coding review has no implementation artifact

## 第五次嘗試（task `task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd`，第二回合計畫因 finding 引用被退回）

## d1-adapter-flow (diagnose, done) dependsOn=[]

instruction:
Read-only diagnosis, do not edit any file. Audit the agy (antigravity) path through the `--coding` flow for places where claude/codex get special handling that agy lacks, and places that are already generic. Read docs/known-issues.md (E14, ISSUE-085/088/089/090/091/094/098/099 and every agy-related entry), SPEC.md, src/cli-adapter.ts (antigravity adapter), src/hook-agy.ts, src/handoff-evidence.ts, src/team-turn.ts, src/team-task-engine.ts. Cover each stage: startup readiness, receiving a prompt, report/response-marker format, transcript and final-reply recognition, session identity (the 'reviewer is a different known session from the author' check), verify report handling, reviewer reply parsing. For each stage, report: file:line evidence, claude/codex-only handling, whether agy is already generic, and the proposed minimal fix. Give a numbered list of sub-problems with a suggested risk level and the smallest write scope for each. Separate what can be verified by unit test from what only a real agy run could verify. Finish with the reply markers.

report:
rEchoedFirstLine`，ISSUE-038），註解明說是為 agy 寫的，但結案時「未實機驗收」。

- team 流程送 prompt 走 `promptAgentAndWait`（`team-turn.ts:~125`），不分種類。
- 結論：已通用，風險在多行 prompt 的實機行為。

**3. 回報格式與 `BRIDGE_BEGIN/END` 標記**

- `team-turn.ts:63–70` 的標記信封由 bridge 產生，不分種類。
- 標記擷取：`extractFrame`（`team-turn.ts:~335`）容許標記被窄終端硬換行。
- 已通用。agy 是否遵守「不要在 commentary 或 tool output 輸出標記」要實機看。

**4. transcript 與最終回覆辨識**

- agy 有專屬 Stop hook：`src/hook-agy.ts`（`agyFinalMessage`、`isAgyStopInput`）和 `src/hook-cli.ts` 的 `handleAgyStop`，會把最終回覆經 `paneId: HERDR_PANE_ID` 送回 bridge。
- `team-turn.ts:109–113` 的 `hookFrame` 不分種類。hook 有訊息就優先用，沒有才退回畫面。
- codex 專屬：`CodexTranscript.connect` 和 rollout 備援（`team-turn.ts:115, 203–210`），agy 沒有，只靠 hook 或畫面。
- claude 專屬：`stableScreen` 只對 claude 排除輸入框（`cli-adapter.ts` 末尾），agy 的游標閃爍問題（ISSUE-044 同類）可能沒處理。
- 疑點：`main.ts:~3285` 的 `readHookFinal` 在 session 為 `id` 或 `path` 時，用 `stopSince(hookSession.value)` 查事件。agy hook 送的 `sessionId` 是 `conversationId`。如果 Herdr 對 agy 登記的 `agent_session.value` 不等於 `conversationId`，hook 查不到，會退回畫面 parser。程式裡沒看到兩者相等的證據，ISSUE-045「agy Stop 已驗收」是指 Discord 單 Agent 路徑，不涵蓋 team 路徑。
- 建議：先實機看 team 路徑 hook 是否命中；不命中就改成同時嘗試 `stopForPane`（hook 已帶 `paneId`）。

**5. Session 身分與獨立性（ISSUE-088／099）**

- claude／codex 專屬：`team-task-engine.ts:46–49` 的 `isCodex` 讓 codex 改用 rollout 觀察到的 session。其他種類（含 agy）一律走 `assertIndependentReview`（`coding-workflow.ts:119–143`），靠 `sessionIdentity(worker)`（`handoff-evidence.ts:~143`）。
- agy 的缺口：
  - 新開的 agy pane 若像 codex 一樣沒有 `agent_session`，`sessionIdentity` 會丟「handoff requires a known session identity」，且 `assertIndependentReview` 在 `team-task-engine.ts:~400` 於 `onAssignmentStart` 就 fail closed。這正是 ISSUE-088 對 codex 的症狀，agy 沒有保護。
  - `team-task-engine.ts:~411` 對 author 也是 `sessionIdentity(worker)`，agy 當 Worker 時 session 還沒登記就會丟錯。
  - `team-turn.ts:~146–177` 已允許「session 第一次出現」，是通用的。
- 建議最小修法：先實機確認 agy 的 `agent_session` 何時出現。若會出現，不用改；若不會出現，才需要類似 `findCodexRolloutByNonce` 的 agy 觀察器，那是大工程，應拆成獨立子問題。
- `handoff-evidence.ts:150` 的 `adapterName` 已處理 agy，但那是 handoff 功能，不在 `--coding` 主路徑。`readSessionEvidence` 只有 codex 有原生歷史，agy 退成 `checkpoint-only`，不影響 `--coding`。

**6. Verify 回報**

- `parseCodingResult(report)` 對所有種類通用（`team-task-engine.ts:~441`）。`unwrapCodexJson` 只在 codex 啟用（ISSUE-089）。
- agy 若走畫面備援，JSON 可能被窄 pane 硬換行；hook 路徑不受影響。
- 建議：先靠實機確認；若 agy 走畫面且 JSON 被換行，再決定要不要泛化 `unwrapCodexJson`。

**7. Reviewer 回覆解析**

- `REVIEWER_KINDS`（`review-pane.ts:16`）已含 agy，`chooseReviewerKind` 通用。
- review 結果由 `parseCodingResult` 解析，不分種類。通用。
- 注意：`chooseReviewerKind` 預設偏好 claude → codex → agy，agy 只在前面都等於作者種類時才會被選，所以新增 capability 不會改變既有預設。

**8. 候選資格與選用機制（核心需求）**

- `src/coding-roster.ts` 的 `AUTO_CODING_KINDS = ["claude","codex"]` 寫死種類。`autoEnableCodingProfiles` 只看 `kind`，完全沒用 `capabilities`。
- `src/coding-workflow.ts:277` 的規劃提示明寫「capability is currently not a dispatch gate」，所以 `capabilities` 目前純屬宣告，沒有程式讀它。
- 建議設計：`autoEnableCodingProfiles` 改為「kind 在 `AUTO_CODING_KINDS`，或 profile 的 `capabilities` 含 `implementation`／`review`」。agy 預設 `capabilities: ["analysis"]`，行為不變；使用者加上 capability 才啟用。
- 要同步改的文字：`coding-roster.ts` 檔頭註解、`assertCodingRoster` 錯誤訊息、`coding-workflow.ts:277` 提示、SPEC、README 兩份、known-issues。

### 編號子問題

| #   | 子問題                                                                                                       | 風險   | 最小寫入範圍                                                                                               | 驗證方式                                            |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | capability 選用機制：`autoEnableCodingProfiles` 讀 `implementation`／`review`                                | 低     | `src/coding-roster.ts`、`test/coding-roster.test.ts`                                                       | 單元測試                                            |
| 2   | 文字與文件同步（註解、錯誤訊息、提示、SPEC、README×2、known-issues）                                         | 低     | `src/coding-roster.ts` 註解、`src/coding-workflow.ts:277`、`SPEC.md`、`README*.md`、`docs/known-issues.md` | 檢視一致性；可能影響既有測試對字串的比對            |
| 3   | agy profile 設 `model` 需要 `modelFlag`（沒有預設）                                                          | 低     | `src/agent-pool.ts`、`test/agent-pool.test.ts`；或只寫文件要求使用者自設 `modelFlag`                       | 單元測試（需先確認 agy 的實際旗標，待實機）         |
| 4   | agy 啟動就緒與 `agent` 欄位是否等於 `kind: agy`                                                              | 中     | 無（先實機）；有問題再改 `agent-pool.ts`                                                                   | 僅實機                                              |
| 5   | team 路徑 hook 是否命中（`agent_session.value` 與 `conversationId` 是否一致）；不一致時加 `stopForPane` 備援 | 中     | `src/main.ts`（`readHookFinal` 與 team 用的 `hookFinal`）、相關測試                                        | 備援邏輯可單元測試；是否真的需要只能實機判斷        |
| 6   | agy 新 pane 無 `agent_session` 時的作者與 reviewer 身分（類 ISSUE-088）                                      | 高     | `src/team-task-engine.ts`，可能還要新的觀察器模組                                                          | 邏輯可用假資料單元測試；agy 的 session 行為只能實機 |
| 7   | 畫面備援下 agy 的輸入框閃爍與硬換行 JSON（`stableScreen`、`unwrapCodexJson`）                                | 中     | `src/cli-adapter.ts`、`src/team-task-engine.ts`                                                            | 用錄下的畫面重放可單元測試；真實畫面格式要實機      |
| 8   | 多行 prompt 回顯（ISSUE-038 未實機驗收）                                                                     | 低到中 | 無                                                                                                         | 僅實機                                              |

### 單元測試可驗證 vs 只能實機驗證

- 單元測試可驗證：#1、#2（字串一致）、#3（只驗 profile 驗證邏輯）、#5 的備援邏輯、#6 的 fail-closed 行為、#7 的重放解析。
- 只能實機驗證：#4、#8、#5 是否命中、#6 的 agy `agent_session` 實際行為、agy 是否遵守標記信封、agy 在 Worker 與 Reviewer 兩種角色跑完一輪。
- 風險提醒：card 驗收條件 5 要求「驗不到的要寫成待驗收」。我這輪沒有任何 agy 實機證據，所以以上全是程式閱讀的推論。

### 建議的做法順序

先做 #1＋#2（低風險、可單元測、不改預設行為），其餘列為待實機的 issue。#6 如果實機證明 agy 的 `agent_session` 缺失，就是這張卡的主要工作量，建議在 Lead 規劃時先決定要不要先跑一次 agy 當 reviewer 來取得證據。

### 回報事項

- 變更檔案：無
- 執行的指令：只有 `grep`、`sed`、`wc`、`cat` 的唯讀指令
- 測試結果：未執行
- commit／push：無
- 阻擋：無
- 交接給 Lead：上表為子問題與範圍。#6 與 #4 需要實機證據才能定案；`docs/known-issues.md` 下一個可用編號請 Lead 另行確認（ISSUE-103、104 已被使用）。

{"codingResult":{"kind":"diagnose","findings":[{"id":"agy-pool-f1","summary":"coding-roster.ts 的 autoEnableCodingProfiles 只看 kind，完全不讀 capabilities；規劃提示也寫明 capability 不是派工守門。選用機制需改這裡：kind 在 AUTO_CODING_KINDS 或 capabilities 含 implementation／review 才啟用，agy 預設 analysis 則維持現狀。低風險，單元測試可驗。"},{"agy-pool-f2","summary":"team-task-engine.ts 的 isCodex 只讓 codex 用 rollout 觀察 session；其他種類（含 agy）一律用 Herdr 的 agent_session。若 agy 新 pane 沒有 agent_session，作者與 reviewer 身分判斷會 fail closed（類 ISSUE-088）。是否發生只能實機確認。高風險。"},{"id":"agy-pool-f3","summary":"main.ts 的 readHookFinal 以 agent_session.value 查 hook 事件，agy hook 送的是 conversationId；兩者是否相等沒有證據，不相等時 team 路徑會退回畫面 parser。可加 stopForPane 備援，是否必要要實機判斷。中風險。"},{"id":"agy-pool-f4","summary":"agent-pool.ts 的 modelFlag 預設只有 codex 與 claude；agy profile 設 model 但沒設 modelFlag 會被拒。低風險，可用文件說明或補預設。"},{"id":"agy-pool-f5","summary":"stableScreen 只對 claude 排除輸入框，unwrapCodexJson 只對 codex 啟用；agy 若走畫面備援可能遇到游標閃爍與硬換行 JSON。中風險，重放可單元測試，真實格式要實機。"},{"id":"agy-pool-f6","summary":"agy 的啟動就緒（agent 欄位是否等於 kind: agy）與多行 prompt 回顯（ISSUE-038 未實機驗收）沒有實機證據，只能實機驗。"}]}}

## d2-roster-pool (diagnose, done) dependsOn=[]

instruction:
Read-only diagnosis, do not edit any file. Audit the agent-pool and roster side of enabling agy as an opt-in `--coding` candidate. Read src/coding-roster.ts (AUTO_CODING_KINDS and its comments and error messages), src/agent-pool.ts, src/review-pane.ts (REVIEWER_KINDS), the config/profile capability parsing (find where `capabilities` such as implementation/analysis/review are validated and how profiles are selected), the existing tests for these files, and the relevant parts of SPEC.md, README.md, README.zh-TW.md and docs/known-issues.md (E14). Design an opt-in mechanism: an agy profile is enabled only when the user adds an `implementation` and/or `review` capability in config.json. With the config unchanged, the default behavior must be identical to now: auto-enable is still only claude/codex, and an agy profile with only `analysis` is not a coding candidate. Report: (1) the exact code points to change; (2) whether capabilities are currently a dispatch gate, since the planning prompt says they are not, and what that implies for the opt-in design; (3) the edge cases (agy as both writer and reviewer, the same agy profile used for author and reviewer, profile lazy start); (4) a list of the unit tests to add, each of which should fail before the fix and pass after; (5) the list of docs that must stay consistent (known-issues number: use the next free number after ISSUE-104, check the file; SPEC, both READMEs, the coding-roster.ts comments and error messages). Do not modify config.json or policy.yml. Finish with the reply markers.

report:
唯讀診斷完成。基準 HEAD：`be728e1446483d8743e992faf7a6714febab6be3`；開始、結束工作樹皆乾淨，沒有修改檔案。

1. 精確修改點與建議設計

- `src/coding-roster.ts:10`：保留 `AUTO_CODING_KINDS = ["claude", "codex"]`，不要直接加入 agy。
- `AutoPool.profiles` 型別補上 `capabilities?: readonly string[]`。
- `autoEnableCodingProfiles()` 的 filter 改為：
  `AUTO_CODING_KINDS.includes(profile.kind) || (profile.kind === "agy" && profile.capabilities?.some(c => c === "implementation" || c === "review"))`
- 維持候選少於兩個時完全不選取、至少兩個才全部選取的現有規則。
- 同檔案 E14 註解、函式註解、`assertCodingRoster()` 錯誤訊息應同步說明「claude/codex 預設；agy 明確加 implementation 或 review 才參與自動補候選；pi 仍排除」。
- `src/main.ts:1747` 的 E14 註解也需同步。現有 `coding && workers.length === 0` 呼叫條件保留：有明確 pane/profile 時不自動補任何候選。
- `src/agent-pool.ts` 不需為此新增角色守門或改變生命週期。
- `src/review-pane.ts:19` 的 `REVIEWER_KINDS` 已含 agy，不需修改。它是 `card review` 的種類選擇，不是 `--coding` pool 的候選開關；明確 requested 也不受該陣列限制。

2. Capability 是否為派工守門

目前不是，規劃提示的描述正確。

- `src/config.ts:204` 使用 `validateProfiles(source.agentProfiles)`。
- `src/agent-pool.ts:50–59` 只驗證 capabilities 是最多 32 個字串、各字串不含 NUL 且長度不超過 1000；沒有 implementation/analysis/review enum 驗證。
- 未提供 capabilities 時正規化成 `[]`。
- `select()`／`selectAll()` 依 profile ID 啟用；`roster()` 保留完整 profile；`acquire()` 檢查選取、workspace、租用與 session，沒有角色 capability 檢查。
- `src/team-orchestration.ts:689` 把 profile JSON 交給 Lead；沒有依 capability 限制 implement/review。
- `src/coding-workflow.ts:277` 明說 capability 不是 dispatch gate。

因此建議把新語意限定為「agy 自動補候選的 opt-in」，不要把它寫成角色權限。只有 review capability 的 agy 進入 roster 後，Lead 技術上仍可指定 implement。若要禁止此行為，必須另設角色守門，會擴大範圍並改變現有契約。

另需明載：analysis-only agy 不會被**自動**加入 coding roster；但使用者既有 `team select`／`team add` 明確選取仍照舊可用。若要求連手動選取都禁止，便與「有指定一律照指定」及現有行為相衝突，需要 Lead 明確決策，不能悄悄加入。

3. 邊界情況

- agy 同時具 implementation/review：只加入一次，由 Lead 分配角色，不因此具有自我 review 資格。
- 同一 agy profile 先寫再審：pool 重用同一 session；`src/team-task-engine.ts` 對非 codex 使用 `assertIndependentReview()`，同 pane／同 session 必須拒絕。
- 不同 agy profiles：不同 profile ID 不等於不同 session；仍須取得兩個不同且已知的 session。未知 author/reviewer session 維持 fail closed。
- 單一 opted-in agy：只有一個候選仍不啟用。搭配一個 claude/codex 或另一個 opted-in agy，才滿足既有兩個 profile 門檻；門檻不保證最終能建立獨立 review。
- Lazy start：自動補候選只呼叫 `select()`，不啟動 CLI；Lead 實際指派後才走 `acquire()`、`startProfile()`、最多 30 秒等待預期 kind 的 idle/done。
- capability 變更影響既有綁定：pool fingerprint 是整個 profile 的 `JSON.stringify()`。為已啟動 agy 加 capability 後，既有 binding 會因 configuration changed 被拒，需明確 `team bind`；不能默默重用。
- capability 比對應精確、區分大小寫：`implementation`／`review` 才有效，`analysis`、`Review`、未知字串不開啟。
- 設定載入需重啟 bridge；本任務不得修改實際 config/policy。

4. 應新增的紅→綠測試

放在 `test/coding-roster.test.ts`，fakePool 型別同步加入 capabilities。以下各項在現況都應失敗：

- claude + agy `[implementation]`：兩者皆選取，agy 可補足第二個候選。
- codex + agy `[review]`：兩者皆選取。
- claude/codex + agy `[implementation, review]`：agy 恰好選取一次，回傳及 select 順序一致。
- 兩個不同 opted-in agy profiles：可成為兩個候選。
- 混合 claude、codex、opted-in agy、analysis-only agy、pi `[implementation, review]`：只選前三類合格 profile。
- 錯誤訊息明載 agy 的 capability opt-in 與至少兩個候選要求。

另外保留／補強回歸測試：capability 缺省、空陣列、analysis-only、錯誤大小寫均排除 agy；claude/codex 不因缺 capability 被排除；單一 opted-in agy 不選取任何 profile。這些在修正前可能已通過，應如實列為回歸，不能宣稱全部是紅→綠。

現有 pool 測試已涵蓋 lazy start、重用、配置 fingerprint、租用、uncertain startup、readiness；review-pane 測試已有 agy author 的種類選擇。這些不是本次缺陷的紅測試，不需要為了湊新測試修改既有守門。

5. 文件一致性

查核時下一個可用編號為 **ISSUE-105**；尚未占用，Lead 寫入前須再確認。

必須同步：

- `docs/known-issues.md`：新 ISSUE-105，保留 ISSUE-091 的 E14 歷史驗收；新增 agy opt-in、已確認根因、測試日期、實機證據或待驗收條件。
- `SPEC.md:184`：移除 agy 一律排除的現況敘述，改成 opt-in；保留獨立 review／verify 守門。
- `SPEC.md:188`：capability 仍非角色 dispatch gate，與新自動候選用途明確區分。
- `SPEC.md:417` 附近：設定用途、重啟及既有 binding fingerprint 限制。
- `README.md`、`README.zh-TW.md`：profile/coding 用法、opt-in 範例、analysis-only 預設不變、lazy start、實機驗收狀態。
- `docs/card-to-merge-tracker.md` 的 E14：目前仍寫 agy 排除，必須同步新行為並保留歷史。
- `src/coding-roster.ts` 全部相關註解與錯誤訊息、`src/main.ts` E14 註解、`test/coding-roster.test.ts` 的舊排除註解。
- `docs/agent-pool-console.md` 可補 capability 的自動候選用途；`CONTEXT.md` 只有通用 ledger 索引，無需硬加逐項 issue。

交接 Lead：可先採用上述最小 roster predicate 設計；session、回覆擷取、實機 agy Worker/Reviewer 證據由其他診斷／實作分工處理。本診斷不構成實機驗收。

執行紀錄：使用 `pwd`、`git status --short/--porcelain`、`git rev-parse HEAD`、`cat`、`sed`、`rg`、`ls` 讀取指定程式、測試與文件。曾誤用 `tests/`、不存在的 profile glob／`test/config.test.ts`，後改讀 `test/` 與實際檔案。嘗試以既有 dist 執行三個相關測試，但 `dist` 不存在，前置 `test -f` exit 1，測試沒有啟動；`node_modules` 亦不存在。依唯讀指派未安裝依賴、未 build，無測試通過宣稱。

修改檔案：無。Commit／push／merge／GitHub／部署／重啟：均未執行。Blocker：沒有阻擋原始碼診斷；自動化執行缺少依賴與 dist，實機驗收未執行。

{"codingResult":{"kind":"diagnose","findings":[{"id":"d2-optin-roster","summary":"Keep claude/codex defaults and add agy to automatic coding candidates only when capabilities explicitly include implementation or review; preserve explicit roster selection."},{"id":"d2-capability-semantics","summary":"Capabilities are validated string metadata, not role dispatch gates; the proposed opt-in controls automatic candidate admission only."},{"id":"d2-binding-fingerprint","summary":"Adding capabilities changes the persisted profile fingerprint, so an existing bound session requires explicit rebinding after configuration reload."},{"id":"d2-docs-e14","summary":"ISSUE-105 is next free at the inspected version; synchronize SPEC, both READMEs, E14 tracker, roster comments/errors and main E14 comment while separating unit evidence from live acceptance."}]}}

## d3-critique (diagnose, done) dependsOn=['d1-adapter-flow', 'd2-roster-pool']

instruction:
Read-only critique before implementation, do not edit any file. This is a diagnosis critique, not a review of completed code. Read the results of d1-adapter-flow and d2-roster-pool from this round, and re-check their key claims against the source yourself: src/cli-adapter.ts, src/hook-agy.ts, src/handoff-evidence.ts, src/team-turn.ts, src/team-task-engine.ts, src/agent-pool.ts, src/review-pane.ts, src/coding-roster.ts. Judge: (a) is anything missing from the problem list, especially session-identity independence and the reviewer reply parser for agy; (b) is the opt-in design (agy enabled only when the profile has an implementation/review capability) sound, and does it keep the defaults unchanged for users who have not edited their config; (c) are the proposed fixes minimal and do they leave every existing gate unweakened (independent review, verify, `card merge` conditions); (d) is the split into sub-problems suitable for ONE writer in a single write scope, and if not, how should it be sequenced; (e) which acceptance items can only be marked 'pending acceptance' because they need a real agy run, and what conditions are missing. Rank each objection as blocker or non-blocker with file:line evidence. Finish with the reply markers.

report:
唯讀批評完成。基準與結束 HEAD 均為 `be728e1446483d8743e992faf7a6714febab6be3`，工作樹皆乾淨。結論：採用 d2 的限縮 opt-in 設計；d1 的 session 與 reviewer parser 說明須修正，不能僅完成 roster 改動就宣稱 agy 全流程可用。

1. **Blocker：session 診斷引用錯誤 helper，尚缺可信身分證據。**  
   `src/team-task-engine.ts:3–13` 匯入的是 `coding-workflow.ts` 的 `sessionIdentity`，不是 `handoff-evidence.ts:135`。實際 helper 在 `src/coding-workflow.ts:104–117`：未知身分回傳 `undefined`，不會丟 handoff 錯誤。因此 d1「agy Worker 結束時會因 handoff helper 丟錯」不成立。真正風險是 reviewer 開始前由 `team-task-engine.ts:398` 檢查已知身分；結束後再次檢查（`:419`）。agy 沒有 codex 的 nonce／rollout 身分觀察（`team-turn.ts:100–105`）。必須確認 Herdr 回報的 agy session 是否為實際 conversation、何時出現，以及不同 profiles 是否真的不同 session。不同 pane／profile ID 均不足以替代證據；未知身分必須繼續拒絕獨立 review。

2. **Blocker：roster opt-in 不能被當成全流程完成。**  
   `src/agent-pool.ts:298–305` 要求啟動後 `agent.agent === profile.kind` 且 idle／done；`src/main.ts:241–248` 的 team hook 查詢在已有 session 時只查該 session，沒有查不到後的 pane fallback；agy hook 卻以 `conversationId` 回報（`src/hook-cli.ts:84–85`）。這些目前是待實機確認的風險，尚非已證實 bug。若實測失敗，本卡仍須處理，不能僅留問題清單便稱「正式可用」。也不能直接加寬鬆 pane fallback：必須保留本回合 nonce、時間與身分檢查，避免收取錯誤 session 的回覆。

3. **Non-blocker：d1 混淆兩種 reviewer parser，且種類選擇說明不準確。**  
   coding assignment 用 `src/team-task-engine.ts:439–442` 的 `parseCodingResult`，換行復原只對 codex。另一路 `card review` 在 `src/card-review-flow.ts:257` 呼叫 `parseReviewReply`；其 `src/card-review.ts:235–245` 已對所有 CLI 嘗試 `unwrapCodexJson`。因此不能說 agy reviewer 全部缺少換行復原，也不能說全部只是同一個通用 parser。`src/review-pane.ts:42–43` 只選第一個不同作者種類：目前順序下通常是 claude 或 codex，不會因兩者「都等於作者」而選 agy；agy 可明確指定。這一路與 coding pool 候選開關應分開描述。

4. **Non-blocker：d2 opt-in 設計合理；d1 泛化條件應拒絕。**  
   保留 `AUTO_CODING_KINDS` 的 claude／codex，額外只接受 `kind === "agy"` 且 capabilities 精確包含 `implementation`／`review`。不要用「任何 kind 有 capability 即加入」，否則會順帶開啟 pi。現有入口與至少兩個候選規則維持（`src/coding-roster.ts:10–27`）；未改設定的 analysis-only agy 不自動加入。Capabilities 只表示自動候選 opt-in，不是角色權限；明確選取行為保持原狀。需將這個限定語意同步到提示與文件。

5. **Non-blocker：最小修正應依證據逐項擴充，不能預先改所有疑點。**  
   modelFlag 缺省、畫面穩定性、hook 查詢與 JSON 硬換行先列風險。沒有實際旗標證據，不宜新增 agy modelFlag 預設；沒有錄製畫面，不宜直接泛化 parser。既有獨立 review、版本一致與 verify 條件保留：`src/coding-workflow.ts:454–475` 明確要求 recorded evidence、同版本、無 drift、獨立 pass review 和成功 verify。opt-in 無須修改這些條件，也無須修改 `card merge` 條件。

**單一 writer 的順序**

- 先由 Lead 定案上述修正後的診斷，記錄討論結論。
- 一個 writer 在同一寫入範圍內完成 roster 紅→綠測試、最小 predicate、提示／文件同步。
- 用可用的 agy 環境取得啟動、prompt、hook、session 與回報證據；失敗時由同一 writer 依證據修正 transport／identity／parser 子問題。
- writer 完成後，再排獨立 review、verify。唯讀批評／review／verify 不可與 writer 平行，避免開始與結束版本不同導致報告 inconclusive。

不建議把共享 `main.ts`、`team-task-engine.ts`、文件拆給多個 writer；本卡採一位 writer、按依賴順序處理即可。

**只能待實機驗收的項目與缺少條件**

目前沒有本輪 agy 實機證據，以下不能標已驗收：

- 真實 agy 啟動就緒、CLI kind 辨識、多行 prompt 與回覆信封。
- Stop hook 安裝／啟用、transcript 格式、conversationId 與 Herdr session 的對應。
- agy 作為 Worker 與 Reviewer 各完成一輪，身分已知且獨立；同 session review 被拒。
- verify JSON／commands 正確入帳；長回覆與窄 pane 下完整擷取。
- 實際 `card review` parser 與 coding reviewer parser 各自的適用路徑。
- 執行中 bridge 使用新 build，以及必要的獨立 review、verify、merge 守門仍正常。

缺少條件包括：可用且已登入的 agy、使用者自行完成 opt-in 設定及必要重載／重啟、hook 配置、可建立獨立 session 的 pane 空間，以及可保存的 session／hook／artifact 證據。本任務不得修改實際 config／policy；未重啟與未驗收狀態須明載。

交接紀錄：

- 修改檔案：無。
- 指令：`git status --porcelain`、`git rev-parse HEAD`、`cat`、`rg`、`sed`、`head`，皆為唯讀；一次不存在的 `src/reviewer*.ts` glob 探索失敗，後續改用實際檔案查核。
- 測試：未執行；本報告是原始碼診斷，沒有測試或實機通過宣稱。
- Commit／push／merge／GitHub／部署／重啟：均未執行。
- 交接 Lead：修正 d1 的 helper／parser 結論，採 d2 的 agy 專用 opt-in；將實機證據缺口保留為待驗收，遇到實測失敗再決定最小修正。

{"codingResult":{"kind":"diagnose","findings":[{"id":"d3-session-helper","summary":"Blocker: team-task-engine imports coding-workflow.sessionIdentity, which returns undefined for unknown identity, not handoff-evidence's throwing helper. Correct d1's diagnosis and establish actual agy conversation identity before claiming independent review acceptance."},{"id":"d3-live-evidence","summary":"Blocker: roster opt-in alone does not establish agy readiness, hook/session correlation or Worker/Reviewer usability; obtain live evidence and fix demonstrated failures without weakening nonce, identity or existing acceptance gates."},{"id":"d3-review-parser","summary":"Non-blocker: coding assignment and card review use different parsers. card-review.parseReviewReply already applies wrapped-JSON fallback to all CLI kinds; team-task-engine restricts that fallback to codex."},{"id":"d3-optin-boundary","summary":"Non-blocker: adopt d2's agy-specific capability predicate, preserve claude/codex defaults and explicit selection, and document capability as automatic candidate opt-in rather than role authorization."},{"id":"d3-writer-sequence","summary":"Non-blocker: use one writer sequentially for roster/tests/docs and evidence-driven transport fixes, followed by independent review and verify on a stable version; keep live agy acceptance pending until evidenced."}]}}

## 第六次嘗試（task `task-e9cb8674-b86c-42b0-b639-544054c2632f`，完成並開出 PR #136）

### diag-agy-claude（diagnose／read，profile:claude，dependsOn=[]）

指派內容：

Read-only diagnosis, do not modify files. Goal: let agy join the --coding agent pool as an opt-in Worker/Reviewer candidate. Read AGENTS.md, SPEC.md, CONTEXT.md, docs/known-issues.md (E14, ISSUE-085/088/089/090/091/094/098/099 and every agy-related entry), src/coding-roster.ts (AUTO_CODING_KINDS and its comment), src/agent-pool.ts, src/review-pane.ts (REVIEWER_KINDS), src/team-turn.ts and src/team-task-engine.ts. List every step of the --coding full flow where claude/codex get special handling that agy does not, and every step that is already generic. Cover: capability filtering and roster selection, how the Lead sees candidates, reviewer eligibility, the 'different session from the author' independence check, and error messages. For each problem give file:line, a symptom, a proposed fix, and a test idea. Also propose a minimal opt-in design: agy is enabled for --coding only when the user's config.json agy profile declares the implementation/review capability, and the default behavior stays identical to today. Return a numbered problem list with severity and a proposed split into subtasks. Do not edit config.json or policy.yml.

回報：

wo when writing documentation, and leave `autopick.ts:94` alone.

**P12. [Low] Claude-only image handling.**

- `main.ts:2754` and `:3378`. Only matters for attachments and approval relay. Out of scope for `--coding`.

### C. How the Lead sees candidates, and the independence check

- **Candidates.** Workers are listed as `pane_id (agent; {profile JSON})`. Opted-in agy would appear automatically once it is in the roster (P1–P3). No separate prompt change is strictly required beyond the role hint in P3.
- **Independence.** The check lives in two places: start (`team-task-engine.ts:378-399`, strict for non-codex) and done (`:405-440`, uses the identity). Both must be taught that agy's session arrives after the first turn (P4–P6). `assertIndependentReview` itself (`coding-workflow.ts:119-143`) is generic and needs no change. It also fails closed, so an unknown session never yields a pass, which is the correct direction.
- **Error messages.** The wording differs between "unknown reviewer identity" (start) and "same-session review is not an independent review" (done). No change needed. P8 covers the roster message.

### D. Minimal opt-in design (default unchanged)

1. Add `codingCapable(profile)`: `capabilities` includes `"implementation"` or `"review"`. Claude/codex are always allowed by default.
2. `autoEnableCodingProfiles` selects: all claude/codex profiles, plus profiles of other kinds that are `codingCapable`. Keep the ≥2 rule over the union. No agy opt-in → exactly today's list.
3. Plan-time role check against declared capabilities for non-default kinds only (P3).
4. Generalise the codex "session known only after the turn" logic to agy (P4–P6).
5. Normalise kind comparison (P10). Update messages and docs (P8).
6. Docs: `docs/known-issues.md` gets a new issue with the next free number after ISSUE-106. Mark everything "已修正、待驗收" until live agy evidence exists. Add a live checklist: agy as diagnose, then as implement, then as review by claude/codex, then claude/codex reviewing an agy author. The user has to add `implementation`/`review` to their agy profile themselves; I did not touch `config.json` or `policy.yml`.

### E. Proposed subtasks

| #   | Subtask                                                                                     | Covers            | Role      | Depends on |
| --- | ------------------------------------------------------------------------------------------- | ----------------- | --------- | ---------- |
| S1  | `codingCapable` + roster opt-in + messages + roster tests                                   | P1, P2, P8 (code) | implement | none       |
| S2  | Plan-time capability check + role hint in the Lead prompt                                   | P3                | implement | S1         |
| S3  | Deferred-session logic for agy (start/done), refreshed worker record, `runTeamTurn` session | P4, P5, P6        | implement | none       |
| S4  | Kind normalisation (`agy`/`antigravity`) in pool                                            | P10               | implement | none       |
| S5  | Docs: `known-issues`, `SPEC`, `README`×2, `CONTEXT` index                                   | P7, P8            | implement | S1–S4      |
| S6  | Independent review of S1–S4 (claude or codex, not the author)                               | all               | review    | S1–S4      |
| S7  | Verify: `npm run build`, `npm run lint`, targeted and full tests                            | all               | verify    | S6         |
| S8  | Live agy check (diagnose/review round) and record as "待驗收" if not possible               | P9, P10           | diagnose  | S7         |

S1/S3/S4 touch different files and can run in parallel, but `team-task-engine.ts` is shared with S2, so serialise S2 after S3. The roster change (S1) should be the only part visible in the default configuration path.

Nothing here was run or verified live. The statements about agy's session timing, `antigravity` vs `agy` naming and `modelFlag` come from code and docs only (SPEC line 467, ISSUE-066), not from a live agy session.

**Report items:**

- Changed files: none.
- Commands executed: read-only `grep`, `sed`, `cat`, `wc`, `ls`.
- Test result: not applicable (diagnose only).
- Commit/push: none.
- Blocker: none.
- Handoff: start with S1, S3 and S4 in parallel, then S2; the main risk is P4/P5, because without them an agy author or reviewer cannot be judged independent.

```json
{
  "codingResult": {
    "kind": "diagnose",
    "findings": [
      {
        "id": "agy-p1",
        "summary": "High: capabilities field is stored but never read (agent-pool.ts:85, coding-roster.ts:11-26, main.ts:1745-1757); no opt-in switch exists"
      },
      {
        "id": "agy-p2",
        "summary": "High: AUTO_CODING_KINDS hard-coded list and >=2 count rule cannot include opted-in agy (coding-roster.ts:6-26)"
      },
      {
        "id": "agy-p3",
        "summary": "High: no role-vs-capability check; manually selected analysis-only agy can be assigned implement/review (main.ts:1745-1757, team-orchestration.ts:~728)"
      },
      {
        "id": "agy-p4",
        "summary": "High: new agy reviewer has no agent_session at start, so onAssignmentStart/assertIndependentReview fail with 'unknown reviewer identity' (team-task-engine.ts:378-399, coding-workflow.ts:119-143)"
      },
      {
        "id": "agy-p5",
        "summary": "High: onAssignmentDone receives the stale acquire-time worker record, so agy authorSession is recorded undefined and later reviews fail (team-orchestration.ts:504-521,562-567; team-task-engine.ts:411-413)"
      },
      {
        "id": "agy-p6",
        "summary": "Medium: observeSession/observedSession is codex-only; agy needs a refreshed agent_session returned at turn end (team-turn.ts:100-105)"
      },
      {
        "id": "agy-p7",
        "summary": "Medium: modelFlag default knows only codex/claude; agy profile with model needs explicit modelFlag (agent-pool.ts:70)"
      },
      {
        "id": "agy-p8",
        "summary": "Medium: error messages, comments, SPEC/README/known-issues and test titles hard-code claude/codex and say agy is excluded (coding-roster.ts:8-34, main.ts:1747-1751, SPEC.md:184)"
      },
      {
        "id": "agy-p9",
        "summary": "Medium: agy report capture for --coding (indented echo, fenced JSON codingResult) not proven live; needs one live round (hook-agy.ts, cli-adapter.ts:478)"
      },
      {
        "id": "agy-p10",
        "summary": "Medium: profile kind agy vs Herdr-reported antigravity may mismatch in acquire/bind/waitUntilReady (agent-pool.ts:~213,~268); unverified, needs a kind-normalising helper"
      },
      {
        "id": "agy-p11",
        "summary": "Low: REVIEWER_KINDS already includes agy but is the card-review path, not --coding; no change needed (review-pane.ts:16)"
      },
      {
        "id": "agy-p12",
        "summary": "Low: claude-only image/approval handling in main.ts:2754,3378 is out of scope for --coding"
      }
    ]
  }
}
```

### diag-agy-codex（diagnose／read，profile:helper，dependsOn=[]）

指派內容：

Read-only diagnosis, do not modify files. Goal: find the agy-specific adapter and evidence problems that would block agy as a --coding Worker/Reviewer. Read src/cli-adapter.ts (antigravity adapter), src/hook-agy.ts, src/handoff-evidence.ts, src/team-turn.ts, and the existing tests for them. Check each of these for agy: startup readiness detection, prompt submission, how the final reply is recognized (transcript or last message), the BRIDGE_BEGIN/END marker parse, session identity extraction and whether it is stable enough for the 'reviewer is a different known session from the author' check, how the reviewer verdict JSON is parsed, and how verify command reports are returned. For each gap give file:line, the reproduction reasoning, a proposed fix and an unit-test idea that fails before and passes after. Mark which gaps can only be confirmed on a real agy run. Return a numbered list with severity.

回報：

1. **High — `agy-diag-session-propagation`：回合中首次取得的 session 未交回 coding 引擎。**
   - 位置：`src/team-turn.ts:150–182`、`:101–104`；`src/team-task-engine.ts:410–413`。
   - 重現推理：agy 啟動時沒有 session，完成第一個 implement prompt 後才登記 `s1`。turn 允許 session 首次出現，但 `observedSession()` 僅回傳 codex 身分；引擎對 agy 仍讀派工前的 worker。因此 implement artifact 的 authorSession 仍可能是 unknown，後續獨立 review 被拒絕。新 reviewer 若 session 尚未登記，甚至會在 `src/team-task-engine.ts:399` 派工前被拒。
   - 建議：對非 codex 回傳回合內已驗證且持續一致的 session，並由引擎採用；對未知 reviewer 應維持 fail closed，可延後到回合完成再檢查，不能直接放寬獨立性。
   - 紅綠測試：初始 agy 無 session、settled 登記 `s1`，assert implement artifact authorSession=`s1`；不同已知 reviewer 可通過，同 session／未知 session 必須拒絕。
   - **程式缺口可確認；目前 agy 是否真的延後登記，以及 Herdr session 是否穩定，須實機確認。**

2. **Medium — `agy-diag-final-recovery`：沒有可用 hook 時，缺少完整 transcript 最終回覆恢復路徑。**
   - 位置：`src/team-turn.ts:115`、`:208–217`、`:257–300`；`src/cli-adapter.ts:484`（antigravity marker adapter）、`:456–465`（terminal normalization）；`src/team-task-engine.ts:438–442`。
   - 重現推理：agy hook 未安裝、設為 parser 或事件遺失時，若長回答讓 BEGIN 捲出可讀範圍，turn 只能逾時。若框仍完整，但 JSON 字串被終端硬換行，框解析成功後 `parseCodingResult` 失敗，review／verify 證據變 missing；只有 codex 有 JSON 換行恢復。一般 agy `latestAgentResponse` adapter 並未被這個 Team turn 框解析路徑使用。
   - 建議：優先取得可關聯到本回合 nonce 的 agy transcript 完整 final；保留 terminal fallback。若要處理畫面硬換行，先取得真實 agy fixture，再加入限定來源的 normalization，避免任意改寫 JSON。
   - 紅綠測試：hook 缺席、terminal 只剩尾段，但 transcript 有完整 nonce 框，應完成；包含長 summary／verify command 的窄 pane fixture，應保留正確 JSON 值。
   - **缺少恢復分支可確認；agy 實際終端換行、捲動和 transcript 存取條件須實機確認。**

3. **Medium — `agy-diag-hook-partial-tail`：hook transcript retry 可能過早接受較早的非工具訊息。**
   - 位置：`src/hook-agy.ts:22–28`；`src/hook-cli.ts:73–79`。
   - 重現推理：同一 USER_INPUT 後已有非工具 commentary，最後 final JSONL 行尚未完整寫入；parser 忽略未完成行並回傳 commentary。hook retry 只在 message 為空時重讀，因此立即停止重試。commentary 沒有 nonce 框時，Team turn 無法使用它；完整 final 稍後寫入也不會再次讀取，可能落入上一項的逾時。
   - 建議：重試時確認最新回合尾端完整／穩定，避免僅以「找到任意非空訊息」作為讀取成功條件；不要硬要求一般 Discord 回覆具有 Team nonce。
   - 紅綠測試：第一次讀取為 commentary＋未完成 final 行，第二次為完整 final；assert hook 最終送出 final，且只有 commentary 時不誤稱有完整 final。
   - **fixture 可重現邏輯風險；Stop 觸發與 transcript 寫入是否真的競爭，須實機確認。**

4. **Medium／驗收缺口 — `agy-diag-live-contract`：啟動、送 prompt 與獨立 session 契約尚無本輪實機證據。**
   - 位置：`src/agent-pool.ts:295–305`、`:325–345`；`src/team-turn.ts:119–131`；`src/handoff-evidence.ts:135–146`。
   - 現有行為：ready 等待與 atomic prompt／stalled 不重送已共用；ready 要求 Herdr kind **完全等於** profile kind。若設定 `agy` 而 Herdr 回 `antigravity`，會立即判身分不符。這是條件式風險，尚不能稱為已發生 bug。
   - 建議：實機記錄新 pane 的 kind、ready 狀態、首輪／次輪 session，以及兩個 agy conversation 的不同 session；僅在觀察到 alias 差異時加入一致的 kind canonicalization。
   - 測試想法：以實機結果建立 delayed-ready、實際 kind alias、首次 session、相同 conversation 重用、不同 conversation 的 fixtures。alias 確有差異時，現有完全相等判斷應先紅，再修正。
   - **只能由實機確認的部分：Herdr readiness 偵測、prompt 真正送達、conversationId 與 agent_session 的對應與穩定性。**

已通用、未發現 agy 專屬 parser 缺口：

- `src/team-turn.ts:327` 的框解析支援 marker 自身換行；END 在 prompt 中先於 BEGIN，避免單純 echo 組成回覆框。
- `src/hook-agy.ts:18–28` 依最後 USER_INPUT 範圍找最後無 tool_calls 的 PLANNER_RESPONSE；`src/hook-cli.ts:68` 僅轉送正常停止且非明確背景執行中的事件。
- `src/coding-workflow.ts:339–409` 共用 reviewer verdict／findings／verify commands JSON parser；pass 帶 findings 或 changes_requested 無 findings 會降為 inconclusive。
- `src/team-task-engine.ts:498–505` 共用 verify gate：至少一個 command、全部 exitCode=0，且版本未漂移。bridge 不重跑所報命令。
- `src/handoff-evidence.ts:258–264` 對 agy 原生 history 回 checkpoint-only，是 handoff 限制，本身不直接阻擋 coding。

交接 Lead：

- 修改檔案：無；工作樹開始及結束皆乾淨。
- 執行命令：`pwd`、`git status --short`／`--porcelain=v1`、`git diff --stat`、`cat`／`sed`／`nl`／`rg` 唯讀檢查上述原始碼、文件與測試；`ls dist/test/...`。
- 測試：2026-11-06 執行 `node --test dist/test/team-turn.test.js dist/test/cli-adapter.test.js dist/test/hook-events.test.js`，exit 1，原因為 compiled test files 不存在，**沒有測試實際執行**。唯讀範圍下未 build。
- Commit／push：未執行。
- 阻擋：本指派無實機 agy 執行證據；沒有可直接執行的 dist 測試。
- 文件：依唯讀指派未修改；請 Lead 將確認缺口及實機待驗收項目寫入 known-issues／相關契約。
- 後續引用本診斷應使用 bridge 產生的 diagnose artifactRef；以下 finding id 不代表已登記成 review finding。

{"codingResult":{"kind":"diagnose","findings":[{"id":"agy-diag-session-propagation","summary":"High: agy session first observed during a turn is not propagated to coding artifacts; unknown author or reviewer blocks independent review."},{"id":"agy-diag-final-recovery","summary":"Medium: agy lacks nonce-correlated native transcript recovery when hook is unavailable; clipped frames time out and terminal-wrapped JSON can lose coding evidence."},{"id":"agy-diag-hook-partial-tail","summary":"Medium: agy hook stops transcript retries after an earlier nonempty tool-free message, potentially missing a partially written final; real Stop/write race remains unconfirmed."},{"id":"agy-diag-live-contract","summary":"Medium acceptance gap: actual agy readiness kind, prompt delivery and stable independent conversation/session identity require a real run; strict kind matching may expose an alias mismatch."}]}}

### critique-agy（diagnose／read，profile:reviewer，dependsOn=['diag-agy-claude', 'diag-agy-codex']）

指派內容：

Read-only critique, do not modify files. Using the two diagnosis results from this round (diag-agy-claude and diag-agy-codex) and the source, critique the problem breakdown and the proposed opt-in design. Check: missing problems, wrong claims (verify each against the code), overlap between subtasks, anything that would change the default behavior for users who do not touch config.json, anything that weakens independent review, verify or card merge gates, and whether the proposed write scopes are minimal. Return the agreed final subtask list with write scopes (src/*.ts, tests, docs/known-issues.md, SPEC.md, README.md, README.zh-TW.md), the next free ISSUE number, a list of what can be proven by unit test and what must stay 'pending acceptance' with the missing conditions, and a plan for what a real agy run can verify during this task.

回報：

er.ts`目前只自動選 claude／codex。建議保留兩者原規則，只增加`kind: agy`且 capabilities 含`implementation`或`review` 的候選，保留至少兩個 profile 與「已有 Worker 就不自動加」規則。Claude 診斷提出所有其他 kind 都可 opt-in，會連 pi 等種類一起開放，超出本卡需求。已有其他種類 profile 宣告 capability 的使用者，即使不改設定，也可能因此改變行為。

2. **不要加入全域角色 capability 硬守門。** capabilities 現在是描述資料：`team-orchestration.ts:728` 已把完整 profile 給 Lead，ISSUE-104 亦明載 capability 不是派工守門。把手動選取的 analysis-only agy 突然拒絕，屬既有行為變更，不能直接稱為 bug 修復。最小方案是把 capability 當自動入池條件，明確說明角色由 Lead 判斷；若一定要強制角色限制，須另定僅適用新增 opt-in 路徑的契約與測試，不能套用全部現存 profile。

3. **session 傳遞缺口成立，且原方案漏了 pool 重用。**
   - `team-turn.ts` 允許 session 首次出現，但 `observedSession()` 僅回傳 codex rollout 身分。
   - `team-task-engine.ts:410–413` 對非 codex 使用派工前 worker，所以首次 session 不會成為 author 身分。
   - 新 agy reviewer 無 session 時，派工前會被拒。
   - **額外缺口：** `AgentPool.acquire()` 比較 live session 與啟動時持久化 binding；首次由 unknown 變 known 後，binding 沒有更新路徑。`sameAgentSession(undefined, known)` 為 false，後續重用同 profile 會拒絕。只修 artifact 不足。
   - 必須從已核對 pane／terminal／workspace／kind 且 session 持續一致的 turn 結果更新身分與 binding；不能在任意 acquire 時無條件接受未知轉已知。
   - agy reviewer 可延後至回合完成判獨立性，但派工前仍拒絕同 pane／無 implementation artifact；完成時未知作者、未知 reviewer、同 session 一律 inconclusive。Codex 仍只能使用 nonce rollout，不能回退 Herdr session。

4. **alias 與 modelFlag 不是已確認 bug。** pool 確實嚴格比對 kind；`handoff-evidence.ts` 支援 agy／antigravity alias 不代表 Herdr 實際會回傳另一個名稱。先實機記錄，沒有證據不要新增全域 canonicalization。`validateProfiles()` 明確要求非 claude／codex 的 model 提供 modelFlag；這是現有契約，不能猜 agy flag。無 model 的 agy 不受影響。

5. **final recovery 與 hook partial-tail 應合併處理，避免重複改動。** Codex 診斷的分支缺口成立：Team turn 的 native transcript recovery 是 codex 專用；agy hook retry 找到任意非空訊息即停止，可能先取 commentary。惟實際 Stop／寫檔競爭、硬換行與截框尚未證實。先取得真實 fixture，再決定修正 hook 穩定讀取或加入有 nonce 關聯的 transcript recovery；不要直接套用 `unwrapCodexJson`、猜測 transcript 路徑，或要求一般 Discord 回覆包含 Team nonce。

最終子任務與最小 write scopes：

| 子任務 | 範圍與交付                                                               | Write scope                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1     | agy capability opt-in、原預設回歸測試、註解與錯誤訊息                    | `src/coding-roster.ts`, `src/main.ts`, `test/coding-roster.test.ts`                                                                                                                                                      |
| S2     | agy turn session 傳遞、完成時獨立性檢查、可信 binding 更新與再次 acquire | `src/team-turn.ts`, `src/team-task-engine.ts`, `src/agent-pool.ts`, 對應 `test/team-turn.test.ts`, `test/team-task-engine.test.ts`, `test/agent-pool.test.ts`；只有介面確實需要才加 `src/team-orchestration.ts` 與其測試 |
| S3     | 實機 agy transport／session 調查；依 fixture 修必要的 final capture 缺口 | 先唯讀；確認後限定 `src/hook-agy.ts`, `src/hook-cli.ts`, 必要的 `src/team-turn.ts` 與對應測試，不預授權所有 `src/*.ts`                                                                                                   |
| S4     | 同步選用契約、討論結論、根因／條件式風險、測試與 live 證據               | `docs/known-issues.md`, `SPEC.md`, `README.md`, `README.zh-TW.md`                                                                                                                                                        |
| S5     | 非作者已知不同 session 的獨立 review                                     | 無                                                                                                                                                                                                                       |
| S6     | build、lint、相關與完整測試，核對固定版本                                | 無                                                                                                                                                                                                                       |

S2／S3 共用 `team-turn.ts`，應序列執行或同一 writer 整合。現行 coding 引擎限制單 writer，同輪唯讀指派必須直接依賴 writer；不能照 Claude 診斷建議在同一 coding 回合平行跑 S1／S3／S4 writers。所有文件修改完成後才做最終 review／verify。`CONTEXT.md` 已有 ledger 連結，無需為本 issue 擴大 write scope。無須修改 `review-pane.ts`、handoff、autopick、card merge、config 或 policy。

**下一個可用編號：ISSUE-107。** 本次讀到最高為 ISSUE-106；Lead 寫入前再查一次避免撞號。

單元測試可證明：

- agy 未宣告／只有 analysis 時候選清單不變；claude／codex 預設不變；pi 不因 capability 被自動加入。
- implementation／review 個別與同時宣告、至少兩個候選、一般非 coding 與明確指定 Worker 的回歸。
- 首次 session 進入 author artifact，可信更新後可再次 acquire；已知 session 改變／消失、錯 pane／terminal／workspace 仍拒絕。
- reviewer 不同 session 通過；未知、同 session、同 pane、無 implementation artifact 不能通過。
- fixture 下 nonce frame、完整 final、partial-tail retry、缺失／歧義證據與 fallback 的行為。
- review／verify 版本漂移仍無效；verify 空命令或非零 exit 不通過；既有結案 gates 不變。

必須保留「待驗收」的事項與缺少條件：

- 真實 agy 啟動 readiness、Herdr 回報 kind、prompt 真正送達：缺 live pane／事件紀錄。
- conversationId 與 agent_session 的對應、首輪出現時機、同 conversation 重用及不同 conversation 獨立性：缺至少首輪、次輪及另一 conversation 的對照。
- 真實長回覆、窄 pane、hook 正常與缺席、Stop／transcript 寫入競爭：缺可關聯 nonce 的原始 fixture。
- 更新原始碼不代表執行中 bridge 載入修正；若未載入新 build，不能用目前任務成功宣稱修正已實機驗收。
- 未改使用者設定前，不能宣稱正式 config opt-in 自動入池已端到端驗收。

本任務可做的真實 agy 驗證計畫：

1. Lead 用現有明確選取的 agy profile 派唯讀 diagnose，要求 nonce 框與 codingResult，記錄 pane kind、ready、首輪前後 session、hook／terminal 來源及耗時。
2. 同 profile 第二輪唯讀任務驗證重用；另一獨立 agy conversation 對照 session。
3. 若失敗，先保留原始 fixture，確認 alias／partial-tail／截框原因再修。
4. 修正 build 被實際測試程序載入後，讓 agy review 已完成 implementation artifact，由另一已知 session 作者提供；另由 claude／codex review agy 實作，並安排 verify。每一項只驗其實際走過的路徑。
5. 不執行 card merge、commit、push，不修改 config／policy。獨立 review、verify、版本與 card merge gates 全部維持。

交接 Lead：

- 改動檔案：無；開始與結束工作樹皆乾淨，HEAD `a64b4ff057e36cbcf3f172ca38a00ee6536d4b1d`。
- 執行命令：唯讀 `git status --porcelain=v1`、`git diff --stat`、`git rev-parse HEAD`、`cat`、`sed`、`rg`，檢查上述 source、tests、AGENTS／SPEC／CONTEXT／known-issues 與 coding proposal。
- 測試結果：未執行測試；唯讀 critique 不 build、不產生 dist。
- Commit／push：未執行；未使用 GitHub。
- Blocker：無本輪 agy live fixture；alias、Stop race 與實際 session 時機仍未確認。
- 後續：請以本 diagnose artifactRef 交接，以下 finding id 不是可直接放入 findingRefs 的已登記 review finding。

{"codingResult":{"kind":"diagnose","findings":[{"id":"critique-agy-optin-scope","summary":"Limit automatic capability opt-in to agy; generic non-default-kind opt-in includes unrequested CLIs, and global role-capability enforcement changes existing manually selected profile behavior."},{"id":"critique-agy-binding-refresh","summary":"Confirmed additional gap: pool persists the startup session but never refreshes it after a validated first-turn unknown-to-known transition, so subsequent acquire rejects the same agy conversation."},{"id":"critique-agy-session-gates","summary":"Session propagation must retain fail-closed completion checks, same-pane rejection, implementation-artifact requirement, and Codex nonce-rollout identity; deferred agy identity must not bypass these gates."},{"id":"critique-agy-evidence-first","summary":"Kind alias, model flags, terminal wrapping and Stop/transcript race are not established live bugs; collect agy fixtures before normalization or recovery changes."},{"id":"critique-agy-serial-scopes","summary":"Use serial single-writer implementation with exact source/test scopes; combine overlapping final-capture work, synchronize four required docs, then independently review and verify the final fixed version."}]}}

### impl-agy-pool（implement／write，profile:claude，dependsOn=[]）

指派內容：

Implement in one serial pass, following AGENTS.md (read it first, plus SPEC.md, CONTEXT.md and docs/known-issues.md). Use test-first: write each unit test and confirm it fails before the fix. Do not edit config.json or policy.yml. Do not commit or push. Do not weaken any independent-review, verify or card-merge gate. The agreed design comes from the three diagnose artifacts (the critique overrides the earlier diagnoses where they disagree).

Part A, opt-in roster (src/coding-roster.ts, src/main.ts, test/coding-roster.test.ts): the --coding auto roster keeps claude and codex exactly as today. Add a profile of kind agy only when its capabilities include 'implementation' or 'review'. Do not open it to other kinds such as pi. Keep the existing rules: at least two profiles, and no auto-add when Workers were already specified. Do NOT add a global role-vs-capability dispatch gate. Capabilities stay descriptive data, and the Lead decides roles (ISSUE-104). Update the comment on AUTO_CODING_KINDS and the error messages so they say agy is opt-in via capabilities and pi is still unverified. Tests: no agy, analysis-only agy, implementation-only, review-only and both declared; pi with capabilities is not added; default result with an unchanged config is identical to before; explicit Worker selection is unchanged.

Part B, deferred session identity for agy (src/team-turn.ts, src/team-task-engine.ts, src/agent-pool.ts, and src/team-orchestration.ts only if the interface needs it): an agy pane may have no agent_session before its first turn. (1) Return a session observed during the turn, verified to be the same pane/terminal/workspace/kind and stable across the turn, for non-codex kinds, and have the engine use it as the implement artifact's authorSession and the reviewer identity. Codex must still use only its nonce rollout identity. (2) For an agy reviewer with an unknown session at assignment start, defer the independence decision to turn completion, but still reject at start for the same pane or when no implementation artifact exists. At completion, unknown author, unknown reviewer or same session must stay inconclusive (fail closed). (3) Add a trusted binding refresh in AgentPool so that a session going from unknown to known after a validated first turn is persisted, and a later acquire of the same profile accepts the same conversation. A known session that changes or disappears, or a wrong pane/terminal/workspace, must still be rejected; never accept unknown-to-known at an arbitrary acquire. Tests must fail before and pass after: first-session becomes authorSession; different known reviewer passes; same, unknown and changed sessions are rejected; re-acquire after refresh works; codex behavior unchanged.

Out of scope here, record as 'pending acceptance, evidence first' and do NOT change code: kind alias agy/antigravity canonicalization, modelFlag guessing, terminal JSON re-wrapping, hook-agy partial-tail retry, transcript recovery. src/hook-agy.ts, src/hook-cli.ts, src/cli-adapter.ts and src/review-pane.ts stay untouched.

Part C, docs: re-check the highest ISSUE number first, then add a new issue (expected ISSUE-107) in docs/known-issues.md with the status 已修正、待驗收. Record: the problem list (the 12 problems from the diagnose, with which are fixed, deferred or not a bug), the discussion/review conclusions from the three agents (claude diagnose, codex diagnose, reviewer critique) including the rejected proposals (generic kind opt-in, global capability gate) and why, the reason for choosing the opt-in design, the extra pool-binding gap, today's dated build/lint/test results, and a clear split between 已實機驗證 (nothing, unless a real agy run happened) and 待驗收 with the missing conditions: real agy readiness and Herdr-reported kind, prompt delivery, conversationId to agent_session mapping and timing, long-reply/narrow-pane/hook-absent behavior, Stop vs transcript write race, a running bridge loading the new build, and the user adding implementation/review to their agy profile (the user must do this themselves; give the exact JSON example in the docs). Add a live acceptance checklist (agy diagnose, then agy implement, then claude/codex review of agy, then agy review). Sync SPEC.md (behavior contract and limits), README.md and README.zh-TW.md consistently, and make sure the wording in coding-roster.ts comments/errors matches. Do not claim live acceptance anywhere.

Finish by running npm run build, npm run lint and the full test suite, and report the exact commands, exit codes and counts with the date.

回報：

## impl-agy-pool report (2026-11-06)

agy is now an opt-in `--coding` candidate (Part A). The agy session-identity gaps are closed in the engine and the pool (Part B). The docs are synced (Part C). Build, lint and the full test suite pass. **Nothing was verified on a real agy run.**

### Changed files

- `src/coding-roster.ts`: auto-enable adds an `agy` profile only if its `capabilities` include `implementation` or `review`. `AUTO_CODING_KINDS` is still `["claude","codex"]`. The comment and error message say agy is opt-in and pi is unverified.
- `src/main.ts`: comment update; wires `onWorkerSession` with a pane-to-profile map.
- `src/team-turn.ts`: with `observeSession`, non-codex kinds return the session observed during the turn. Codex still uses only its rollout identity.
- `src/team-task-engine.ts`:
  - An agy reviewer with no session at start is rejected only for the author's own pane or a missing implementation artifact. The independence decision is deferred to completion.
  - At completion the identity is `observedSession ?? sessionIdentity(worker)` for non-codex; codex is unchanged.
  - Unknown author, unknown reviewer or same session still records `independentReview: false` and an inconclusive verdict.
- `src/agent-pool.ts`: new `refreshSession(workspace, id, owner, worker, session)`. It persists unknown→known only when all of these hold:
  - the caller holds the lease;
  - the binding is not uncertain and the profile config is unchanged;
  - pane, terminal, workspace and kind match;
  - the binding had no session, and the live pane reports the same session.

  It never replaces a known session, and it rejects codex.

- `src/team-orchestration.ts`: optional `onWorkerSession` callback, called after a done turn, not for codex.
- Tests: `test/coding-roster.test.ts`, `test/team-turn.test.ts`, `test/team-task-engine.test.ts`, `test/agent-pool.test.ts`.
- Docs: `docs/known-issues.md` (new ISSUE-107, plus an E14 pointer), `SPEC.md`, `README.md`, `README.zh-TW.md`.
- Untouched, as required: `config.json`, `policy.yml`, `src/hook-agy.ts`, `src/hook-cli.ts`, `src/cli-adapter.ts`, `src/review-pane.ts`.

### Commands and results (2026-11-06, local macOS, not CI)

- `npm run build` → exit 0.
- `npm run lint` → exit 0, `lint ok (174 TypeScript files)`.
- `node --test dist/test/*.test.js` → exit 0; 1232 tests, 1231 pass, 0 fail, 0 cancelled, 1 skipped (a skip that was already there).
- Red before the fix:
  - Roster: with the old `coding-roster.ts` restored, 3 of 10 fail.
  - Turn: 2 of 5 new tests fail.
  - Engine: 5 of 7 new tests fail; the other 2 are regression guards that already passed.
  - Pool: 2 of 5 new tests fail against a stub.

### Notes

- The worktree had no `node_modules`. I symlinked the main checkout's `node_modules` and added it to the local `.git/info/exclude`, so nothing in the repo changes.
- The pool test named "an uncertain startup or a changed profile is never repaired by a refresh" is weaker than its title. It is refused by the missing-lease check, not the profile fingerprint check.
- I did not run Prettier across the repo, because it already reports style issues in 44 files. I reverted its reformatting of unrelated old tests and kept only my additions.

### Docs status

- ISSUE-107 is "已修正、待驗收". It lists the 13 problems with their disposition and records the three agents' conclusions. The rejected proposals are the generic non-default-kind opt-in and the global capability gate.
- ISSUE-107 also records the reason for the opt-in design, the extra pool-binding gap, and today's results. It includes the exact `config.json` JSON the user must add themselves, and the live acceptance checklist (agy diagnose, then implement, then claude/codex review, then agy review).
- **已實機驗證 (verified on a real run): nothing.** The running bridge has not been restarted or loaded with this build.
- **待驗收 (pending acceptance) conditions:** real agy readiness and Herdr-reported kind, prompt delivery, conversationId→`agent_session` mapping and timing, long-reply/narrow-pane/hook-absent behavior, Stop vs transcript race, bridge restart on the new build, and the user adding the capability.
- Deferred with evidence first, no code changed: kind alias canonicalization, modelFlag guessing, JSON re-wrapping, hook partial-tail retry, transcript recovery.

### Commit/push, blocker, handoff

- No commit or push, and no GitHub use.
- Blocker: none for the code. A real agy run is impossible in this task, so acceptance stays pending.
- Handoff:
  - Have a non-author reviewer check `refreshSession` and the deferred-identity branch in `onAssignmentStart`/`onAssignmentDone`.
  - Then verify with the full suite, and run the live checklist after the bridge is restarted on the new build.

```json
{
  "codingResult": {
    "kind": "implement",
    "files": [
      "src/coding-roster.ts",
      "src/main.ts",
      "src/agent-pool.ts",
      "src/team-turn.ts",
      "src/team-task-engine.ts",
      "src/team-orchestration.ts",
      "test/coding-roster.test.ts",
      "test/agent-pool.test.ts",
      "test/team-turn.test.ts",
      "test/team-task-engine.test.ts",
      "docs/known-issues.md",
      "SPEC.md",
      "README.md",
      "README.zh-TW.md"
    ]
  }
}
```

### review-agy-pool（review／read，profile:reviewer，dependsOn=['impl-agy-pool']）

指派內容：

Independent read-only review of the captured diff from impl-agy-pool. Check: (1) default behavior for users who do not change config.json is unchanged (claude/codex auto roster, pi not added, analysis-only agy not added); (2) the independence gates still fail closed: unknown author, unknown reviewer, same session, same pane, missing implementation artifact; codex still uses only the nonce rollout identity; (3) the AgentPool binding refresh accepts only a validated unknown-to-known transition and still rejects changed or vanished sessions and pane/terminal/workspace mismatches; (4) no global capability gate was added, and no change to hook-agy, hook-cli, cli-adapter, review-pane, config.json or policy.yml; (5) each new unit test would fail without the fix (inspect, do not just trust the title); (6) known-issues, SPEC, README.md, README.zh-TW.md and the coding-roster.ts comments/errors agree with each other and with the code, with no claim of live acceptance, and the 已實機驗證 versus 待驗收 split with missing conditions is explicit; (7) write scope respected. Report the verdict with findings (id, file:line, concrete failure scenario).

回報：

判定：**changes_requested**。未發現獨立性守門被放寬，但新增 binding 更新呼叫鏈缺少回歸測試，部分測試未實際覆蓋其宣稱的安全條件。

- **agy-review-refresh-wiring（medium）— `src/team-orchestration.ts:569`、`test/team-task-engine.test.ts:800`**
  新增測試分別直接測 `refreshSession()` 和 engine artifact，沒有測 `onWorkerSession` 呼叫鏈。刪掉 orchestration 的 callback 呼叫，或漏掉 main 的 wiring，這些測試仍會通過；實際 agy 首輪 artifact 有 session，下一輪 profile acquire 卻因 binding 仍為 unknown 而失敗。請加入經 orchestration 完成首輪、更新真實 pool binding、再次 acquire 成功的整合測試；並確認 blocked／codex 不觸發更新。這項測試應在移除 callback wiring 後失敗。

- **agy-review-refresh-guards（medium）— `test/agent-pool.test.ts:458`**
  「uncertain startup or changed profile」測試建立新的 pool instance，該 instance 沒有 lease，因此在 `refreshSession()` 的 owner 檢查就返回 false。刪掉 uncertain／fingerprint 檢查，測試仍會通過；而且 fixture 根本未建立 uncertain binding。另 `:425` 標題宣稱涵蓋 vanished session，實際只測 s1→s2；`:409` 是 agy profile 搭配錯誤 worker kind，沒有測 codex profile 的專屬拒絕分支。請讓各測試先滿足其餘條件，再單獨破壞被測條件，補上 session 消失及真正 codex profile 的案例。

- **agy-review-review-only-doc（low）— `docs/known-issues.md:3600`**
  「只想讓 agy 當 reviewer 就只加 review」容易被讀成角色限制。實際 `review` capability 只讓 profile 自動入池，Lead 仍可指派 implement，程式刻意沒有角色 capability gate。請改為明確說明「只加 review 也會入池，但不限制只能 review」。

其餘核對結果：

- claude／codex 自動候選規則保持不變；analysis-only／未宣告 capability 的 agy 不加入，pi 即使宣告 capability 也不加入；已有 Worker 時不自動補選。
- 未新增全域 capability gate。
- 未知作者、未知 reviewer、同 session、同 pane、缺 implementation artifact 仍無法取得有效 review pass。Codex identity 仍只採 nonce rollout。
- `refreshSession()` 原始碼保留 lease、設定 fingerprint、uncertain、pane／terminal／workspace／kind、live session 檢查；已知 session 不會被替換，acquire 仍拒絕 session 改變或消失。上述 findings 是驗證缺口，未確認這些分支本身有功能錯誤。
- hook-agy、hook-cli、cli-adapter、review-pane、config.json、policy.yml 均無 diff；14 個變更檔案符合所列實作範圍。`main.ts` 有兩處無關的格式變動，建議順手移除。
- 文件明確保留「已實機驗證：沒有」、未載入新 build 與缺少的 live 條件。README／SPEC／roster 的 opt-in 契約基本一致。
- 新增測試不全會在舊實作失敗：預設清單、拒絕條件等回歸測試原本即可通過，這合理；不能把這些當作修正的紅燈證據。上述安全分支測試則需避免因其他前置條件提前退出。

交接 Lead：

- 本次改動檔案：無。
- 命令：唯讀 `git status --porcelain=v1`、`git diff --stat`、`git diff`、`git diff --check`、`cat`、`sed`、`nl`、`rg`、`shasum -a 256`。
- 檢查結果：`git diff --check` exit 0；未執行 build／測試，也未將作者報告的通過數字當作本次驗證結果。
- Diff 指紋：前後一致，`a3ae0a56e87b6400b3c95576a1120aea67996d23b0c26185bf0245b42c563665`。
- Commit／push／merge／GitHub：均未執行。
- Blocker：無 review 阻擋；live agy 證據仍缺。
- 下一步：補測試與修正文句，同步 ISSUE-107，再交獨立 review／verify；保留實機待驗收狀態。

{"codingResult":{"kind":"review","verdict":"changes_requested","findings":[{"id":"agy-review-refresh-wiring","summary":"medium: src/team-orchestration.ts:569 and test/team-task-engine.test.ts:800 — no test exercises onWorkerSession through orchestration into AgentPool; removing callback wiring leaves tests green but causes the next agy profile acquire to reject the stale unknown binding."},{"id":"agy-review-refresh-guards","summary":"medium: test/agent-pool.test.ts:458 — changed-profile test exits at missing lease, never tests fingerprint or uncertain guards; :425 never simulates vanished session, and :409 does not exercise a codex profile. Add isolated guard tests that fail when each corresponding protection is removed."},{"id":"agy-review-review-only-doc","summary":"low: docs/known-issues.md:3600 — saying users wanting only an agy reviewer should add only review implies a role restriction, but capability only controls auto-enabling and the Lead can still assign implement; clarify this explicitly."}]}}

### verify-agy-pool（verify／read，profile:helper，dependsOn=['impl-agy-pool']）

指派內容：

Read-only verification of the current tree, do not edit. Run and report only checks that must pass with exit 0, each with its exact command and exit code: `npm run build`; `npm run lint`; the full test command from package.json (e.g. `npm test`), plus the targeted tests for coding-roster, agent-pool, team-turn and team-task-engine. Also report absence/presence checks written so exit 0 means pass, for example `! grep -q 'agy、pi 還沒驗' src/coding-roster.ts` only if the comment was really changed, `grep -q 'ISSUE-107' docs/known-issues.md`, `grep -q 'implementation' README.md`, `grep -q 'implementation' README.zh-TW.md`, `grep -q 'agy' SPEC.md`, and `git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts`. Adjust the grep patterns to what the implementation actually wrote, and do not report any command that is expected to fail. Include the date and the test counts.

回報：

2026-11-06 驗證通過；未編輯原始碼或文件。

| 必須通過的檢查                                                                                                                                                                          | Exit | 結果                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------- |
| `npm run build`                                                                                                                                                                         |    0 | 通過                                        |
| `npm run lint`                                                                                                                                                                          |    0 | 174 個 TypeScript 檔案，通過                |
| `npm test > /tmp/verify-agy-pool-full-test-unrestricted.log 2>&1`                                                                                                                       |    0 | 完整測試 1232 項：1231 pass、0 fail、1 skip |
| `node --test dist/test/coding-roster.test.js dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js > /tmp/verify-agy-pool-targeted-test.log 2>&1` |    0 | 指定測試 75/75 pass、0 skip                 |
| `! grep -q 'agy、pi 還沒驗' src/coding-roster.ts`                                                                                                                                       |    0 | 舊註解不存在                                |
| `grep -q 'ISSUE-107' docs/known-issues.md`                                                                                                                                              |    0 | 存在                                        |
| `grep -q 'implementation' README.md`                                                                                                                                                    |    0 | 存在                                        |
| `grep -q 'implementation' README.zh-TW.md`                                                                                                                                              |    0 | 存在                                        |
| `grep -q 'agy' SPEC.md`                                                                                                                                                                 |    0 | 存在                                        |
| `git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts`                                                                      |    0 | 指定檔案沒有差異                            |

環境紀錄：首次 sandbox 內完整測試 exit 1，1228 項中 1215 pass、12 fail、1 skip；失敗涉及本機 socket `listen EPERM` 等限制。依權限流程在 sandbox 外重跑完整 `npm test` 後全部通過。上表與 JSON 記錄最終重跑結果。

版本核對：開始與結束的 `git diff --binary | shasum -a 256` 均為 `a3ae0a56e87b6400b3c95576a1120aea67996d23b0c26185bf0245b42c563665`，前後 tracked 修改清單相同。

交接 Lead：

- 本指派修改檔案：無；build 產生編譯輸出，測試日誌存於 `/tmp`。
- 現有 14 個修改檔案保持原狀：四份文件、六個 source、四個 test，與實作者報告一致。
- 額外執行：唯讀 `git status`、`git diff`、`cat`、`rg`、`tail`、`sed` 與差異雜湊核對。
- Commit／push／merge／GitHub：均未執行。
- 自動化驗證阻擋：無。
- 限制：未進行真實 agy、Discord／Herdr 端到端驗收，未重啟或部署 bridge。請 Lead 將本次驗證結果及 sandbox 重跑原因同步至 ISSUE-107，實機項目維持待驗收。

{"codingResult":{"kind":"verify","commands":[{"command":"npm run build","exitCode":0},{"command":"npm run lint","exitCode":0},{"command":"npm test > /tmp/verify-agy-pool-full-test-unrestricted.log 2>&1","exitCode":0},{"command":"node --test dist/test/coding-roster.test.js dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js > /tmp/verify-agy-pool-targeted-test.log 2>&1","exitCode":0},{"command":"! grep -q 'agy、pi 還沒驗' src/coding-roster.ts","exitCode":0},{"command":"grep -q 'ISSUE-107' docs/known-issues.md","exitCode":0},{"command":"grep -q 'implementation' README.md","exitCode":0},{"command":"grep -q 'implementation' README.zh-TW.md","exitCode":0},{"command":"grep -q 'agy' SPEC.md","exitCode":0},{"command":"git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts","exitCode":0}]}}

### fix-agy-review-findings（implement／write，profile:claude，dependsOn=[]）

指派內容：

Fix the three open review findings. Follow AGENTS.md. Do not touch config.json, policy.yml, hook-agy, hook-cli, cli-adapter or review-pane. Do not commit or push. Do not weaken any gate. Keep the product behavior of refreshSession and the opt-in roster unchanged; only add tests, fix wording, and change code if a test exposes a real defect.

1. agy-review-refresh-wiring: add an integration test (in test/team-orchestration.test.ts, create it only if no suitable file exists, or in test/team-task-engine.test.ts) that runs an agy first turn through team-orchestration with a real AgentPool binding whose session starts unknown, then the pane reports session s1. Assert that onWorkerSession fires only after a done turn, never for codex and never for a blocked or failed turn, that the pool binding is refreshed to s1, and that a later acquire of the same profile succeeds. Confirm the test goes red when the callback call in src/team-orchestration.ts is removed (do this temporarily and restore it), and report that.

2. agy-review-refresh-guards: rewrite the refreshSession tests in test/agent-pool.test.ts so that each guard is tested in isolation. Build every fixture so that all other preconditions are satisfied (lease held by the caller, binding not uncertain, config fingerprint unchanged, pane/terminal/workspace/kind match, binding had no session, live pane reports the same session), then break exactly one condition per test: uncertain binding; changed profile config fingerprint; wrong pane; wrong terminal; wrong workspace; wrong kind; a binding that already has a known session (never replaced, including s1 to s2); live pane session vanished (undefined) or different from the reported one; a real codex profile (rejected); missing lease. For each guard, temporarily remove the check and confirm that the test goes red, then restore it, and report the list of mutations tried. Fix the misleading test titles (the old 'uncertain startup or changed profile' test and the 'vanished session' test).

3. agy-review-review-only-doc: in docs/known-issues.md ISSUE-107, change the wording so it says: adding only review also auto-enables the agy profile, but this does not restrict it to reviewing; capability only controls auto-enable and the Lead may still assign implement (there is deliberately no role-vs-capability gate, ISSUE-104). Check the same wording in SPEC.md/README.md/README.zh-TW.md; if one of those needs the same clarification, add SPEC.md, README.md and README.zh-TW.md edits only for that sentence (tell me if you did; they are outside the listed scope, so prefer ISSUE-107 only and report any inconsistency instead).

Also revert the two unrelated formatting-only hunks in src/main.ts. Update ISSUE-107 with the follow-up: the review findings, the fix, and the dated results of npm run build, npm run lint and the full test suite. Keep 已實機驗證 as 'nothing' and keep the 待驗收 conditions. Report exact commands, exit codes and counts with the date.

回報：

## fix-agy-review-findings report (2026-11-06)

I added the wiring and per-guard tests and fixed the doc wording. The product code for `refreshSession` and the opt-in roster is unchanged. Build, lint and the full suite pass. **Nothing was verified on a real agy run.**

### Findings fixed

1. **`agy-review-refresh-wiring`:** `test/team-task-engine.test.ts` now has an integration test through the real `TeamTaskEngine`, orchestration and `AgentPool`. The callback wiring matches `main.ts` (pane to profile id, then `pool.refreshSession`).
   - **Cases covered:**
     - agy: the callback fires exactly once after a done turn, the persisted binding becomes s1, and a reopened pool acquires the same profile as same-session.
     - blocked turn: the callback does not fire and the binding stays unknown.
     - failed turn (identity changed): the callback does not fire and the binding stays unknown.
     - codex: the callback does not fire even though its rollout session was observed (the test first checks that `authorSession` is set).
   - **Mutations tried (temporary, restored):**
     - Removing the `onWorkerSession` call in `src/team-orchestration.ts` turned the agy test red (1 fail).
     - Removing the codex guard turned the codex test red (1 fail).
     - Removing the `settled.state !== "blocked"` condition changed nothing. A blocked turn never returns a session, so that condition is redundant.
2. **`agy-review-refresh-guards`:** The refresh tests in `test/agent-pool.test.ts` are rewritten.
   - **Fixture and tests:** The fixture satisfies every precondition, and a baseline test confirms it returns true. Each test then breaks exactly one condition:
     - missing lease (released, or another owner);
     - uncertain binding;
     - changed profile fingerprint;
     - wrong pane, terminal, workspace or kind on the worker;
     - the binding's stored Agent having another terminal, workspace or kind;
     - invalid session;
     - live pane gone;
     - live terminal, workspace or kind changed;
     - live session vanished, or different from the reported one;
     - a binding that already has a known session (s1→s2 is not replaced, same value is idempotent);
     - a real codex profile.
   - **Old tests:** The old misleading tests are removed.
   - **Mutations tried:** I removed each check one at a time in `src/agent-pool.ts` (19 compilable runs), rebuilt, ran the file, and restored it afterwards.
     - These 15 turned their test red (1 fail each): codex guard, lease, uncertain, fingerprint, binding pane, binding workspace, binding kind, worker workspace, worker kind, live pane missing, live workspace, live terminal, live kind, live session comparison, known-session-not-replaced.
     - The worker terminal check is two identical clauses. Removing either one alone changes nothing; removing both together turns the test red.
     - `!hasAgentSession(session)` can't go red on its own. The later check that the live session equals the reported one rejects invalid sessions anyway.
     - One further mutation, removing `!binding?.agent`, did not compile (TS errors), so it doesn't count.
3. **`agy-review-review-only-doc`:** The ISSUE-107 wording now says adding only `review` still auto-enables agy, but it is not a role restriction. The Lead may still assign implement, and there is deliberately no role-vs-capability gate (ISSUE-104).
   - I checked `SPEC.md`, `README.md` and `README.zh-TW.md`. They already say capabilities only decide auto-enabling, so I did not change them.

I also reverted the two Prettier-only hunks in `src/main.ts`. It now differs from HEAD only by the ISSUE-107 comment and the `onWorkerSession` wiring.

### Commands and results (2026-11-06, local macOS, not CI)

- `npm run build` → exit 0.
- `npm run lint` → exit 0 (`lint ok (174 TypeScript files)`).
- `node --test dist/test/*.test.js` → exit 0; 1249 tests, 1248 pass, 0 fail, 0 cancelled, 1 skipped (a skip that was already there). The earlier run today was 1232/1231, so 17 tests were added.

### Changed files (this assignment)

`src/main.ts` (two formatting hunks reverted), `test/agent-pool.test.ts`, `test/team-task-engine.test.ts`, `docs/known-issues.md`. `src/team-orchestration.ts` and `src/agent-pool.ts` were mutated temporarily and restored byte-identical. The whole branch still carries the earlier implementation changes.

### Docs status

ISSUE-107 now has a follow-up section covering the three findings, the fixes, the mutation results and today's results. It keeps **已實機驗證: nothing** and the 待驗收 conditions and live checklist. The bridge has not been restarted or loaded with this build.

### Commit/push, blocker, handoff

- No commit, push or GitHub use. `config.json`, `policy.yml`, `hook-agy`, `hook-cli`, `cli-adapter` and `review-pane` are untouched.
- Blocker: none.
- Handoff: needs an independent re-review and verify of this version.

```json
{
  "codingResult": {
    "kind": "implement",
    "files": [
      "src/main.ts",
      "test/agent-pool.test.ts",
      "test/team-task-engine.test.ts",
      "docs/known-issues.md"
    ]
  }
}
```

### review-agy-fix（review／read，profile:reviewer，dependsOn=['fix-agy-review-findings']）

指派內容：

Independent read-only re-review of the full captured diff after fix-agy-review-findings. Check that each of the three earlier findings is really resolved: (1) the integration test goes through orchestration into a real AgentPool, covers done/blocked/failed/codex, and would fail if the onWorkerSession call were removed; (2) every refreshSession guard has its own test that satisfies all other preconditions and would fail if only that guard were removed (inspect the fixtures, do not trust titles); (3) the ISSUE-107 wording no longer implies a role restriction, and SPEC/README/README.zh-TW/coding-roster.ts stay consistent. Also re-check that the default roster is unchanged, the independence gates still fail closed, codex still uses only its nonce rollout identity, no forbidden file changed, no unrelated formatting hunks remain in src/main.ts, and no claim of live acceptance exists. Report a verdict with findings (id, file:line, concrete failure scenario).

回報：

判定：**pass**，沒有新增 finding。三項先前 findings 已解決。

- **agy-review-refresh-wiring**：新增測試經真實 TeamTaskEngine → orchestration → 真實 AgentPool，確認 done 回合觸發 callback、持久化 s1，重新載入後可 same-session acquire。移除 callback 呼叫會使 calls／binding 斷言失敗。blocked、failed 皆確認不觸發；codex 案例先確認 rollout authorSession 有值，再確認不觸發，避免因沒有 session 而假通過。測試重建 main 的接線，沒有直接執行 main；本次已人工核對兩者一致。
- **agy-review-refresh-guards**：fixture 先 acquire 取得 lease，且 baseline 確認可成功更新。uncertain、fingerprint、worker／binding／live 身分、消失或不同 session、已知 session 不取代與真正 codex profile 均有對應案例，先前被 lease 提前擋住的問題已消除。
- **agy-review-review-only-doc**：ISSUE-107 現在明說 capability 只控制自動入池，不限制角色，Lead 仍可指派 implement；與 SPEC、兩份 README、roster 註解及錯誤訊息一致。

「刪除每一個 guard 都必須單獨變紅」仍有合理例外，文件已如實記錄：

- worker terminal 的兩個比較完全等價，刪除其中一個仍由另一個保護。
- 無效 session 即使移除 `hasAgentSession`，仍被後續 session equality 拒絕。
- blocked 回合不回傳 session，所以移除顯式 blocked 條件仍不會呼叫 callback。

這些是冗餘防護，不能宣稱每個語法子句都有獨立 mutation sensitivity；目前行為測試足以覆蓋其拒絕契約，無須為了測試刻意削弱程式。

完整 diff 再核對：

- claude／codex 預設 roster 不變；analysis-only agy、pi 不自動加入；沒有全域 capability gate。
- 未知作者／reviewer、同 session、同 pane、缺 implementation artifact 仍 fail closed；codex 仍只採 nonce rollout identity。
- 禁止修改的六個檔案沒有 diff；main 的兩處無關格式 hunks 已移除。
- 文件沒有宣稱 agy live acceptance，明列未載入新 build、未重啟與缺少的實機條件。write scope 符合本次工作。

交接 Lead：

- 本指派改動檔案：無。
- 執行命令：唯讀 `git diff`、`git diff --stat`、`git status --porcelain=v1`、`sed`、`tail`、`rg`、`shasum -a 256`；`git diff --check` 與禁止檔案的 `git diff --quiet` 均 exit 0。
- 測試：本輪未執行 build／測試；以上為原始碼與 fixture 審查，不背書為本輪重新執行的測試結果。
- Diff 指紋前後一致：`36f816878b83a5367ff1dc0ce9a355f4167f3a6a8759a3cf314642b73fcec19d`。
- Commit／push／merge／GitHub：均未執行。
- Blocker：無。
- 下一步：針對此版本完成獨立 verify；agy 實機項目繼續維持待驗收。

{"codingResult":{"kind":"review","verdict":"pass","findings":[]}}

### verify-agy-fix（verify／read，profile:helper，dependsOn=['fix-agy-review-findings']）

指派內容：

Read-only verification of the current tree, do not edit. Run and report only checks that must pass with exit 0, each with exact command and exit code: `npm run build`; `npm run lint`; the full test command `npm test` (rerun outside the sandbox if sockets give EPERM and say so); the targeted tests `node --test dist/test/coding-roster.test.js dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js` plus the new orchestration test file if one was added; `grep -q 'ISSUE-107' docs/known-issues.md`; `! grep -q 'agy、pi 還沒驗' src/coding-roster.ts`; `git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts`. Include the date and test counts and the diff fingerprint at start and end.

回報：

2026-11-06：目前版本自動化驗證通過。

| 精確命令                                                                                                                                                                          | Exit | 結果                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------- |
| `npm run build`                                                                                                                                                                   |    0 | 通過                                  |
| `npm run lint`                                                                                                                                                                    |    0 | 174 個 TypeScript 檔案，通過          |
| `npm test > /tmp/verify-agy-fix-full.log 2>&1`                                                                                                                                    |    0 | 1249 tests、1248 pass、0 fail、1 skip |
| `node --test dist/test/coding-roster.test.js dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js > /tmp/verify-agy-fix-targeted.log 2>&1` |    0 | 92 tests、92 pass、0 fail、0 skip     |
| `grep -q 'ISSUE-107' docs/known-issues.md`                                                                                                                                        |    0 | 存在                                  |
| `! grep -q 'agy、pi 還沒驗' src/coding-roster.ts`                                                                                                                                 |    0 | 舊註解不存在                          |
| `git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts`                                                                |    0 | 指定檔案未修改                        |

新增 orchestration 整合案例位於 `test/team-task-engine.test.ts`，已包含在指定測試中，沒有新增獨立測試檔。

完整測試在 sandbox 外執行：前次同環境已確認 socket `listen EPERM`，本次直接依權限流程使用 sandbox 外環境，未重跑已知受限的 sandbox 版本。

`git diff --binary | shasum -a 256`：

- 開始：`36f816878b83a5367ff1dc0ce9a355f4167f3a6a8759a3cf314642b73fcec19d`
- 結束：`36f816878b83a5367ff1dc0ce9a355f4167f3a6a8759a3cf314642b73fcec19d`

交接 Lead：

- 本指派未編輯原始碼或文件；原有 14 個 tracked 修改檔案清單保持相同。build 產生編譯輸出，日誌位於上述 `/tmp` 路徑。
- 其他執行命令：唯讀 `git status --short`、`git diff --name-only`、差異雜湊、`cat package.json`、`tail` 與 `rg`。
- Commit／push／merge／GitHub：均未執行。
- 自動化驗證無阻擋；真實 agy／Herdr／Discord 驗收、bridge 重啟與部署未執行，仍須維持待驗收。
- 請將本次獨立驗證結果同步至 ISSUE-107；本報告不取代獨立 re-review。

{"codingResult":{"kind":"verify","commands":[{"command":"npm run build","exitCode":0},{"command":"npm run lint","exitCode":0},{"command":"npm test > /tmp/verify-agy-fix-full.log 2>&1","exitCode":0},{"command":"node --test dist/test/coding-roster.test.js dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js > /tmp/verify-agy-fix-targeted.log 2>&1","exitCode":0},{"command":"grep -q 'ISSUE-107' docs/known-issues.md","exitCode":0},{"command":"! grep -q 'agy、pi 還沒驗' src/coding-roster.ts","exitCode":0},{"command":"git diff --quiet -- config.json policy.yml src/hook-agy.ts src/hook-cli.ts src/cli-adapter.ts src/review-pane.ts","exitCode":0}]}}
