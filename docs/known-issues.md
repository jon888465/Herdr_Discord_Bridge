# Known Issues

維護規則見 [AGENTS.md](../AGENTS.md)。最後整理：2026-09-19。

| ID        | 問題                                                                            | 狀態             | 下一步                                                                                                              |
| --------- | ------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| ISSUE-001 | Discord reply 未觸發 bridge                                                     | 重新開啟、待驗收 | 重啟後在 mapped thread 回覆 bot                                                                                     |
| ISSUE-002 | Discord 圖片未交付 Agent                                                        | 重新開啟／待調查 | 取得格式驗證失敗的原始附件與 metadata，重播下載                                                                     |
| ISSUE-003 | 預覽與 final 未更新                                                             | 已修正、待驗收   | 重啟後驗證 metadata 更新與截圖情境                                                                                  |
| ISSUE-004 | Team 成員可跨 workspace 混入，且 stale mapping 容易造成誤解                     | 已修正、待驗收   | 重啟後確認同 workspace 限制、持久化與 stale 顯示                                                                    |
| ISSUE-005 | 本機 current 顯示未選取 Agent                                                   | 已修正、待驗收   | workspace selection 回歸修正後須重新驗收；先前 shared-thread 驗收歷史保留                                           |
| ISSUE-006 | 重啟 bridge 後 pane 所屬 workspace／位置改變                                    | 已驗收           | 2026-09-10 live topology 驗證完成；後續觀察重啟保留                                                                 |
| ISSUE-007 | 程序啟動未阻止同 bot 重複實例                                                   | 重新開啟／待調查 | 2026-09-18 完整套件入口逾時再現；核對負載與 startup 時序，live 第二實例拒絕仍待驗收                                                                                           |
| ISSUE-008 | Discord current／回應仍引用 Herdr 已不存在的舊 pane，且串流回報 session changed | 重新開啟／待調查 | 取得該 Discord thread 的 current 輸出與 bridge 啟動版本；重啟新版後以 live prompt 重現                              |
| ISSUE-010 | 1:1:N orchestration、Discord mirror 與選擇 UI                                   | 修正中／待驗收   | Phase 1 durable task／reconciliation／cancel 已實作見 ISSUE-018；blocked continuation、mirror 與 UI 仍待做                           |
| ISSUE-011 | 選取 agy 後 bridge 沒顯示追問、無法回答                                         | 已修正、待驗收   | 本機快照／blocked reply 自動化完成後進行 live agy 驗收                                                              |
| ISSUE-012 | Team 多 Agent 同時追問缺少問題識別                                              | 待調查           | 設計 task/assignment/question 綁定與回覆 UI／排隊策略                                                               |
| ISSUE-013 | Lead plan 解析失敗或誤取 planning prompt 中的範例 JSON                          | 已修正、待驗收   | 重啟新版 bridge，以新 team ask 驗證 plan 不取 prompt／歷史，兩 Worker 均收到正確 Assignment                         |
| ISSUE-014 | 未等 Worker 完成本次任務便以歷史輸出標記 done 並進入統整                        | 重新開啟／待驗收 | 載入本次修正後重啟 bridge，驗證 atomic prompt wait 的 done 回傳可直接產生本次報告，且所有 Worker 完成後才 synthesis |

| ISSUE-015 | Team 僅能加入已啟動 pane，缺少 profile 與 session lifecycle | 修正中 | 完整檢查後驗收 lazy start／重用／Lead 動態分工 |
| ISSUE-016 | use 自動刷 CLI 畫面，console 對話與終端檢視混在一起 | 修正中 | 完整檢查後驗收安靜對話與獨立 attach/watch |
| ISSUE-017 | quota 耗盡時缺少跨 CLI session 交接流程 | 已修正、待驗收 | Skill 靜態檢查完成；待真實跨 CLI 接手驗收 |
| ISSUE-018 | Phase 1 Durable Task Engine、restart reconciliation 與 whole-team cancellation | 已修正、待驗收 | targeted fixtures 通過；完整套件受 socket EPERM 阻擋，需一般環境重跑及 live 驗收 |

2026-09-09 自動化驗證：`npm run check`（typecheck、build、33/33 tests）、`npm run lint`、`git diff --check` 通過。這是前一輪程式驗證紀錄，不代表已做 live Discord 驗收。本輪僅整理文件，未重跑程式測試。

## ISSUE-013：Team ask 的 Lead JSON plan 解析失敗

狀態：已修正、待驗收（2026-09-11）。先前折行修正及自動化測試紀錄保留；本次原始碼修正已完成，live 驗收仍未完成。

最新進度（同時適用 ISSUE-014）：新增 fixture，已重現 prompt echo
誤派及舊 report 誤標 done。共用 turn 接收器等部分補丁已套用，
`npm run build && node --test --test-name-pattern='ISSUE-01' dist/test/team-orchestration.test.js`
由 0/2 變為 2/2 通過（2026-09-11）。另以兩個不同完成時間 Worker 驗證
14/14 targeted tests 通過（含 Herdr `agent.prompt` wait socket fixture）。
這確認程式缺陷已在測試 seam 修正，不證明原事件的 Herdr 內部時序。
本次 `npm run check` 於 2026-09-11 為 72/73；唯一失敗是既有
`instance-lock.test.js` 真實入口測試 10 秒 timeout，預期 exit code `1`、
實際為 `null`。此失敗不在本次 orchestration 變更範圍；不得把完整 check
稱為全通過，且需在交付報告保留。
使用者提供的 CLI／A2A 方法、Herdr 0.8.0 核對與中斷點見
[修正交接](team-orchestration-issues-013-014-handoff.md)。以下保留先前只記錄階段的歷史。

### 2026-09-11 誤取範例計畫、提前統整

Task：`task-05f771d6-7b47-48de-afed-900f8c2c060e`；原問題：
「討問1:1:N目前功能與實做問題」。Lead 為 Codex，可用 Workers 為 agy
`w2:p6`、OpenCode `w2:p8`。使用者提供的訊息中，planning 與 synthesis
指令接連出現，實際 plan 為 `short-id / w2:p6 / boundedtask`，與 prompt
範例一致，沒有針對原問題的實質拆解；無 OpenCode Assignment。
僅使用一個 Worker 本身不構成錯誤，問題在於計畫缺乏本次 Lead 產出的證據。

預期：只接受本次 Lead 完成的真實規劃，不能把 prompt 的示範 JSON 或
歷史內容當成 plan。未取得有效規劃時不得啟動 Worker 或 synthesis。
本次實際抓取範例的程式路徑與時序尚未確認，不能把推測列為已證實根因。
Worker 未等待／歷史 report 問題另見 ISSUE-014。

本輪處理：僅重新開啟並記錄，未修程式。2026-09-11 驗證方式為核對
使用者提供的 task、plan、report 與補充觀察；未新增或執行程式測試。
先前同日 70/70 是修正前述折行案例的歷史結果，未涵蓋本次失敗。
下一步：建立只有 prompt 範例、Lead 尚未回覆的 fixture，確認不會 dispatch；
再驗證真實 Lead final 到達後才採用其計畫。此次執行 build／session／wait
時間戳尚未取得，不再以舊程序推定原因。本輪未 build、重啟、部署或補送。

## ISSUE-014：未等待 Worker 完成並回報，就進入 Lead 統整

更新日期：2026-09-14。狀態：重新開啟／待驗收。先前修正雖有 targeted tests，新的 live 回報顯示 Herdr prompt stalled 後仍可能晚到 marker report，故不能沿用已修正狀態。

使用者可見症狀：在上述 Task 中，任務丟給 Agent 後，Lead 沒有等 Agent
結束並回報就開始統整。提供的 synthesis payload 將 agy Assignment 標記
`done`，但 report 是先前 GUI／mirror 討論、`commit` 指令與提交紀錄、
舊測試 13/13 及工作樹 clean 宣稱，缺少本次 Assignment 的完成證據。
這些舊宣稱不能算本次測試、提交或完成結果。

預期：每個已分派 Assignment 都必須有與本次 dispatch 對應的完成狀態及
新 report，Lead 才能作完成統整。blocked／failed 可以形成清楚標示的
partial synthesis，但仍在工作、只有舊 idle/done、舊輸出或空 report 時，
不得冒充完成。不能只因呼叫過 agent.wait 就認定已等到本次任務結束。

重現環境／證據：使用者提供 Task
`task-05f771d6-7b47-48de-afed-900f8c2c060e` 的 synthesis payload，並明確
回報未等待 Worker 結束；Lead Codex、Worker agy `w2:p6`，另一可用 Worker
為 OpenCode `w2:p8`。尚無當時 dispatch／wait／read 時間戳與狀態轉換紀錄。

根因：除先前的重複 wait 缺陷外，已確認 Herdr `agent_prompt_stalled` 只代表 5 秒內
沒有觀察到 lifecycle change，不等於 prompt 未送達。舊流程收到 stalled 就直接 failed，
因此晚到且已包含本次 marker 的 Worker report 不會再被讀取，Lead 也無法可靠 synthesis。

修正範圍：`runTeamTurn()` 遇到 `agent_prompt_stalled` 不重送 prompt，改以本次
唯一 marker 繼續 bounded wait／read；prompt 內新增 taskId、phase、assignmentId、pane、
session 與 begin／end marker debug context。新增回歸測試覆蓋 stalled 後仍取得 Worker report。
尚未重啟／部署、未 commit／push；執行中 bridge 版本未查證，失敗 task 不會自動補送。

下一步與驗收：建立「dispatch 後暫時仍 idle、稍後 working、最後完成」及
「read 只有歷史內容」回歸；證明 Worker 未完成時沒有 synthesis prompt，
完成後僅收本次 report。以兩個不同完成時間的 Worker 驗證 Lead 等待所有
必要回報，並涵蓋 blocked／failed partial synthesis。需保存各階段時間戳、
Task／Assignment／pane identity；真實 Discord／Herdr 驗收仍待完成。

## ISSUE-013 先前修正與驗證歷史

### 2026-09-11 重啟後再次失敗

使用者確認已重新編譯並重啟 bridge，Task
`task-cd7ab775-9723-4840-9239-3a803076c52d` 仍在 Lead planning 回報
`Lead did not return a JSON Assignment plan`；Codex 畫面有 JSON，但 agy
`w2:p6`／OpenCode `w2:p8` 未收到任務。先前以舊 process 解釋本次失敗
沒有依據，撤回該判斷。

重現與已確認根因：將使用者貼出的 Codex 折行形式帶入 `runTeamTask`，
`analyze-` 與 `spec`、中文 instruction 被拆成實際換行並帶兩欄縮排。
JSON 字串不允許未跳脫換行；原 parser 直接 JSON.parse，所有 read-source
fallback 都可能遇到相同問題。獨立 parser 比較也確認折行失敗、移除折行
成功，不需要 adapter 或等待時序變化即可重現。未取得失敗當下原始 socket
response，不能排除該次還有完成狀態過早等因素。

修正範圍：planning dispatch 前連接既有 CodexTranscript，優先消費精確
prompt／turn 對應且 task_complete 的 final，避開 terminal 寬度影響。
終端 fallback 僅對 Codex、strict parse 失敗時，消除字串內換行與兩欄
continuation 縮排；保留原有空白與 JSON 跳脫，非 Codex／結構化 final
仍嚴格解析。損壞外層 JSON 的子 Assignment 不再被誤認為 plan。
Worker roster／dependency 驗證仍在 dispatch 前執行。

2026-09-11 驗證：`npm run build && node --test --test-name-pattern='wrapped Codex' dist/test/team-orchestration.test.js`
修正前 0/1 通過，錯誤文字與使用者回報一致；修正後
`node --test dist/test/team-orchestration.test.js` 第一輪 6/6 通過，包含
兩 Worker dispatch 與 synthesis。最終 `npm run check` 通過（typecheck、
build、70/70 tests，其中 orchestration 8/8）；`npm run lint` 與
`git diff --check` 通過。新增測試包含 CRLF、跳脫與既有空白、部分 Assignment
折行，以及實際暫存 session JSONL → matching final → Worker dispatch。
測試使用隔離 fixture，並非 live Discord／Herdr 驗收。

限制與下一步：terminal fallback 無法還原終端已丟失的空白，需優先使用
結構化 transcript；尚未改變既有 agent.wait 完成契約。本輪未重啟／部署、
未 commit／push；checkout build 不代表執行中 bridge 已載入本輪修正。
失敗 task 不會因後來出現 JSON 自動恢復或補送。需載入本輪 build 後以新的
team ask 驗證 Discord／bridge pane → 兩 Worker → Lead synthesis。

### 使用者可見症狀

從 Discord 或 bridge pane 執行 `team ask` 後，收到：
`❌ Lead did not return a JSON Assignment plan`。

### 2026-09-10 根因（歷史）

已確認 orchestration planning 直接將 `agent.read recent_unwrapped` 的整段
transcript 傳給 `parseAssignmentPlan`，沒有保存 prompt 前的 baseline，也沒有
透過 CLI adapter 擷取本次 Lead 回覆。Discord 與 bridge pane 雖然入口不同，兩者
最後都會進入同一個 `runTeamTask`，因此會同時受影響。這不是 Team roster 或
Worker dispatch 本身的錯誤。

### 修正

planning 現在會先讀取 Lead baseline，送出 planning prompt 後再次讀取 transcript，
再使用 `latestAgentResponse` 擷取本次 Codex／agy／OpenCode 回覆；若 adapter 沒有
辨識到邊界，才 fallback 到 transcript parser。若 `recent_unwrapped` 沒有包含本次
回覆，會依序嘗試 Herdr 的 `recent`、`visible`、`detection` read source。新增回歸
測試覆蓋「舊 transcript + 本次 Codex JSON 回覆」與「recent_unwrapped 缺少回覆」
情境。

### 驗證

2026-09-10：`npm run build` 通過；
`node --test dist/test/team-orchestration.test.js` 通過（5/5），包含 Discord／
bridge 共用 planning seam 的 transcript 與 read-source fallback regression。
當時執行中的 bridge process（`node dist/src/index.js`）在該次 fallback 修正前
啟動；尚未重啟，因此尚未完成 Discord 與 bridge pane live 驗收，舊執行程序不會
自動載入本次修改。

## ISSUE-004：Team 成員跨 workspace 與持久化行為

狀態：已修正、待重啟後驗收（2026-09-09）。

使用者觀察到同一 Team 清單混入 x3 與 Herdr_Discord_Bridge，且部分 mapping 顯示 stale。預期 Team 必須限制在同一 workspace，因不同 workspace 不應共享同一份專案協作上下文。

已確認原因：原有 thread route 雖然會持久化，但 `team add` 沒有檢查 workspace；因此跨 workspace mapping 可被保留，重啟後仍會出現。pane 或 CLI 未啟動時，持久化 mapping 仍存在，但 Herdr 查不到 live Agent，應顯示 stale 且不可 dispatch。

修正範圍：新增成員時拒絕不同 workspace；`team list` 只列出 active Team workspace 的成員；`team ask` 遇到歷史跨 workspace mapping 時 fail closed；保留 routing state 讓同一 Team 可跨 bridge 重啟恢復。

驗證：2026-09-09 `npm run typecheck`、`npm test`（35/35）、`npm run lint`、`git diff --check` 通過。尚未完成重啟後 Discord live 驗收；下一步確認同 workspace add、跨 workspace add 被拒絕、重啟後 members 保留，以及未啟動 pane 顯示 stale。

## ISSUE-001：Discord reply does not trigger the bridge

Status: Fixed in source; pending live Discord acceptance (2026-09-09)

### Observed behavior

Replying to an existing Agent/bridge message in Discord does not reliably
trigger the bridge. The reply may receive no response even when the Discord
bridge process is connected and the thread has an active Agent.

### Expected behavior

A reply to a bridge message inside a mapped Discord thread should be treated
as the user's next prompt for the thread's active Agent, subject to the same
authorization, routing, busy, and stale-target checks as an ordinary thread
message.

### Scope to investigate

- Discord `MessageCreate` handling of `message.reference` and reply messages;
- whether a reply is posted in the parent channel instead of the mapped thread;
- mention and command-prefix parsing for replies;
- allowlist and `messageContent` behavior;
- whether the bridge sends an acknowledgement or error when prompt dispatch
  fails;
- regression coverage for replies to progress, completion, and split-output

### Acceptance criteria

- A valid Discord reply in a mapped thread reaches the active Agent exactly
  once.
- A reply to a bridge message can identify the related thread when Discord
  provides a message reference.
- Invalid, unauthorized, stale, or non-thread replies receive a clear response
  instead of being silently ignored.
- Existing ordinary thread prompts and command handling remain unchanged.

## ISSUE-002：Discord 圖片附件未傳達至 Agent

狀態：重新開啟／待調查（2026-09-10）。2026-09-09 已實作附件下載與本機交付，但尚未完成 CLI 讀圖端到端驗收。

使用者從 Discord 傳送圖片後詢問 Agent 是否看得到；本次 Agent 對話僅收到文字，未收到可檢視的圖片附件。已確認入口略過空文字訊息，且原 dispatch 未處理 attachments；現已加入下載與本機檔案交付。Agent 實際讀圖能力仍待端到端驗收，不應直接歸因於模型不支援圖片。

### 2026-09-10 格式驗證失敗回報

使用者收到 `❌ Image content does not match its declared format`。
預期有效且格式相符的支援圖片可交付 Agent；非圖片或不符宣告格式的內容應拒絕。

已確認觸發條件：`prepareImages` 下載成功並讀完 response body 後，將 bytes
簽章與附件 `contentType` 指定的格式比較，不相符時拋出此錯誤，清除當次批次，
不交付圖片。這是附件準備階段的錯誤，不能歸因於 Agent 讀圖能力。
本次實際根因尚未確認：缺少失敗附件、附件 contentType、下載 response 與執行版本。
過去已修正的入口與交付問題不代表這次格式錯誤已修正。

驗證（2026-09-10）：`npm run build && node --test dist/test/attachments.test.js`
通過（3/3），涵蓋有效 PNG 簽章寫入、無效 bytes 拒絕與批次清理。
此為既有 fixture，未重現使用者附件，亦不代表真實圖片解碼或 Discord 驗收通過。
`git diff --check` 通過。本輪僅更新 issue，未改程式；checkout build 已完成，
執行中的 bridge 版本未確認，未重啟／部署，失敗訊息不會自動補送。

下一步：取得這次失敗的原始圖片或 Discord 附件連結，連同可取得的附件
contentType 與下載 response 建立重播，再判定是格式宣告不符、下載內容異常
或驗證邏輯問題；修正後仍需重新傳圖確認 Agent 實際可讀。

### 調查範圍

- Discord attachments 的接收、下載與暫存；只有圖片的訊息是否遭略過。
- 圖片與原問題、指定 pane／session 的對應。
- Codex／agy 的圖片輸入方式；避免只轉發無法存取的 URL 或路徑。
- 不支援的格式、下載失敗、權限或輸入能力不足時的明確錯誤回報。

### 驗收條件

- 指定 Agent 能實際讀取支援的圖片，且與問題正確對應。
- 覆蓋圖文訊息、只有圖片、多張圖片及回覆訊息附圖。
- 圖片轉送失敗不無聲略過，也不誤報已成功交付。

## ISSUE-003：更新後 Discord 預覽與 final response 未更新

狀態：已修正、待驗收（2026-09-10 重新開啟後修正 metadata 誤判）。2026-09-07 解析器修正與重播歷史保留如下。

使用者回報：更新回應呈現功能後，CLI 執行中未在 Discord 顯示內容；CLI 結束後也未更新 Discord response。已透過實際 session 紀錄重播確認事件格式不相容，詳見下方修正紀錄。

### 調查與驗收

- 確認實際執行的 plugin 版本、bridge 日誌與串流是否啟動。
- 檢查預覽擷取、Codex transcript 問答對應、完成判斷與 Discord 傳送錯誤。
- 驗證執行中可見最新內容、結束後 final 獨立送達、失敗時明確顯示原因。
- blocked 不提前結案；來源或傳送失敗不使後續問題永久失去回應。

### 已確認根因與修正（2026-09-07）

目前 Codex session 使用 event_msg/item_completed，內含 UserMessage、AgentMessage；
上一版只接受 user_message／agent_message，導致沒有匹配 turn，final 永遠為空。
真實已完成 turn 重播修正前得到 completed=false、finalLength=0；修正後
completed=true、finalLength=159。

已支援新舊事件格式、turn_id 篩選及公開 commentary 預覽，排除 Reasoning。
preview 編輯失敗後不再把未送達內容記為已更新，下一輪可重試。
已新增 test/codex-items.test.ts；完整測試 27/27 通過。
Discord 圖片附件問題於 2026-09-09 補上本機交付流程，仍需端到端讀圖驗收。

## 2026-09-09 修復紀錄

- Reply 根因：requireMention 只檢查訊息文字，未驗證 message.reference。現在同一 guild/channel 回覆本 bot 可免再次 mention；其他 bot 不享有此例外。
- 純圖片根因：空 content 提前返回，且 dispatch 沒有處理 attachments。現在允許圖片進入 prompt 流程。
- 附件交付：本機 Codex／agy 使用圖片工具讀取下載檔案，不是原生 multimodal API 注入；附件現在存於目標 Agent cwd 下，降低 CLI sandbox 無法讀取的風險，仍需端到端驗收。
- 圖片限制：每則最多 4 張 PNG/JPEG/WebP，每張最多 5 MiB；限定 Discord HTTPS CDN，拒絕 redirect，驗證內容簽章；失敗清除當次部分檔案並回報。
- 成功檔案存於目標 Agent 工作目錄下的 .herdr-discord-bridge/attachments/message-*，目前保留供後續問答使用，尚無自動過期清理。管理者需按需求清理。
- 暫停模式不再繼續處理普通 thread prompts；等待核准時不把圖片當作核准回答。
- 未新增 mirror/UI 開關；其仍是功能待辦。

## 2026-09-09 狀態耗時顯示驗收

驗證（2026-09-09）：npm run check（typecheck、build、35/35 tests）、npm run lint、git diff --check 通過。

狀態：已實作、待驗收。working 顯示已耗時，每十秒刷新；finished 顯示完成時總耗時。測試：`test/progress-time.test.ts` 驗證無內容變動時仍刷新、十秒節流、完成立即更新與秒／分／小時格式。時間從回應追蹤開始計算，包含 blocked 等待；實際 Discord 顯示待重啟後驗收。

- 下一步驗收：重啟 bridge 後測試純文字 reply、reply 附圖、純圖片、長回覆，確認 Herdr pane 收到 prompt，並確認 Agent 實際能讀圖.
- 本輪修正：附件改存於目標 Agent cwd 下的 `.herdr-discord-bridge/attachments/message-*`，降低 CLI sandbox 無法讀取的風險；reply 驗證不再依賴被引用訊息的 guildId 欄位.
- 使用者提供 PNG：檔案存在於 `/home/jones/.local/state/herdr/plugins/herdr-discord-bridge/attachments/message-g0olbv/1.png`，大小 109641 bytes、1057x677。圖片檢視工具受 sandbox 限制未能讀取畫面內容；不可據此宣稱 Agent 已看到圖片.
- 使用者回報：在 Discord 回覆 bridge／CLI 訊息後，從 CLI 與 Discord 畫面看不到內容被送進 Agent。問題重新開啟，需以實際 reply message、mapped thread、Agent 狀態與 bridge 日誌重現.

## 2026-09-09 再現紀錄

## ISSUE-005：本機 current 顯示未選取 Agent

更新日期：2026-09-10。狀態：已修正、待驗收（workspace selection 回歸；見本文件末尾）。2026-09-10 shared-thread 功能的已驗收歷史保留如下。

以下為共用功能加入前的調查歷史；最新實作與驗證見本文件末尾 2026-09-10 交付紀錄。

使用者可見症狀：在 `bridge>` 輸入 `current` 後，收到
`No Agent is selected. Use /herdr agents, then /herdr use <agent>.`
使用者未提供先前是否已在同一本機 console 執行 `use`、執行版本或重啟歷史。

預期行為：本機 console 顯示自己的有效 mapping；無 mapping 時提示選取。
Discord thread 的選取不會自動套用到本機 console。

已確認程式條件：`src/console.ts` 使用固定 `local-console` routing identity；
`src/main.ts` 的 `currentTarget` 在 `RoutingStore.resolve` 無結果時回覆此提示。
尚未確認使用者環境為何沒有 mapping，不能據此判定持久化失敗或 Discord mapping 遺失。

修正範圍：僅補充 SPEC 與中英文 README 的既有路由範圍及選取步驟，未改程式。
驗證（2026-09-10）：靜態檢查 console identity、routing resolve 與 current 分支；
`git diff --check` 通過。純文件更新未重跑程式測試或 build。

未驗證與下一步：在原 bridge console 執行 `agents`，以回傳的 pane ID 執行
`use <pane ID>`，再執行 `current`；若仍失敗，保留三個指令的輸出以建立重現。
目前僅有單次提示，尚無可判定選取功能故障的重現流程；未操作執行中的 bridge、
未部署或重啟，未完成 CLI／Discord 端到端驗收。

## 2026-09-10 截圖與重新調查

- ISSUE-002：使用者提供 `test/1.png`（43,202 bytes）與 `test/2.png`（228,454 bytes）。以 `node --input-type=module` 呼叫 checkout build 的 `prepareImages`，用兩張原始 bytes 作為 mocked fetch response、宣告 `image/png`，兩張均通過簽章檢查並寫入成功；測試暫存已清除。未取得原 Discord 附件 metadata 或 HTTP response，格式錯誤根因仍待調查，不能宣稱修復。
- ISSUE-003：截圖顯示問題已進入 Codex，但 Discord card 出現 `Agent exited or session changed; response capture stopped.`。2026-09-10 `npm run build && node --test dist/test/response-delivery.test.js` 新增 regression 首次結果為 3 通過、1 失敗：同一 session ID 的 metadata 更新使 final 未送出。原比較完整 `agent_session` JSON，將 source 等 metadata 視為 identity。此缺陷可重現，但沒有當時前後 snapshot，尚不能確認它是截圖事件的唯一原因。
- ISSUE-005：新增本機明確選取 Discord thread 的共用 routing，採同一份 thread record，非複製 mapping；已通過本輪回歸測試。先前本機獨立 identity 調查成立；本次新版已重啟並載入。

## ISSUE-006：重啟 bridge 後 pane 位置與 workspace 改變

更新日期：2026-09-10。狀態：已修正、待驗收。

症狀：使用者重編譯並啟動 Herdr 後，回報 bridge 從 x1 到 w2，原 w2 未加入 Team 的 Codex／agy 不見。重啟指令及 x1 的確切意義仍待補充。
預期：bridge 重啟保留其他 Agent pane／程序位置，Team membership 不決定 Herdr 哪些 Agent 存在。

2026-09-10 只讀 `herdr agent list`、`herdr tab list`、`herdr pane list`、`herdr workspace list`：w1（x3）Agents tab 有 Codex w1:p1E 與 agy w1:pM；w2（Herdr_Discord_Bridge）tab 1 有 Codex w2:p4 與 bridge w2:p5。這證明目前仍有三個 Agent，但無重啟前 snapshot，無法認定它們全是原本程序。

已確認腳本風險：`scripts/run.sh` 原先在關閉 bridge 後全域搜尋第一個 number=1 tab，並將其他 pane 搬至第一個 label=Agents tab，未限制相同 workspace；bridge 偵測也以 cwd 子字串辨認，可能誤認其他 pane。Team routing 本身不保存／還原 Herdr 程序。使用者此次重啟根因仍需指令與前後 topology 確認。

隔離驗證：新增 `test/restart.test.ts` 以假的 Herdr CLI 記錄命令，不操作真實 pane。初版 fixture 缺少 Agents root pane，兩次測試提前失敗（2026-09-10），已補齊 fixture，完整 regression 隨後確認原腳本錯誤移動 w1:p1（預期只移動新 bridge）；修正後通過。
修正範圍：鎖定專用 bridge workspace／tab 後才重開 bridge，停止自動搬移其他 Agent；不恢復或搬動 live pane。未重啟／部署，未完成 live 驗收。
下一步：取得原啟動方式後確認 live 驗收與是否需要恢復布局，不能自動猜測原位置。

## 2026-09-10 交付紀錄

- ISSUE-003：以 session kind/value 比較穩定 identity，忽略 source／欄位順序等 metadata；仍要求 terminal、pane、workspace 與 Agent kind 相符，真正更換 session 或移動 workspace 時停止。regression 原先 final=[]，修正後送出 answer。沒有原事件的前後 snapshot，截圖情境仍需驗收；不將所有提前停止視為已解決。
- ISSUE-005：新增本機 `threads`、`thread <ID>`、`thread off`。共用同一份 thread active Agent／Team，選取持久化；每次套用 guild/channel/workspace allowlist。未選取時維持本機獨立路由，未知或失效 thread 不自動回退。本機 command／stream 仍在 pane 輸出，Agent pane 直接對話的鏡像仍未實作。另補上 console message 的空 attachments collection，避免本機發問進入附件流程時拋錯。
- ISSUE-006：重啟先鎖定名為 bridge 的 workspace 之 tab 1，僅替換明確標示且沒有 Agent 的 bridge pane；不再以 cwd 猜測 bridge，不搬移其他 Agent。依使用者最新要求固定使用名為 bridge 的 workspace，不存在時建立，同名多個則拒絕；其他 workspace 若有舊 bridge 則列出位置並停止，需明確遷移／停止後才能啟動，避免重複 bot。僅剩 bridge 時先 split 保留原 tab。既有 live Agent 位置未更動，原消失回報的歷史仍待核對。
- 文件：SPEC、README、README.zh-TW、CONTEXT、help 與本清單已同步。前述舊的「獨立路由／未改程式」段落是當時歷史，不代表此版沒有共用能力。
- 驗證日期 2026-09-10：`npm run check` 通過（typecheck、build、40/40 tests）；`npm run lint`、`bash -n scripts/run.sh`、`git diff --check` 通過。重啟測試使用假的 Herdr CLI，沒有操作 live pane；圖片兩張原始 bytes 重播通過，但未驗證 Discord HTTP metadata。
- 發布／驗收：原始碼已修改、checkout 已 build；未 commit、push、重啟或部署。執行中的 bridge 仍是先前程序，不能使用本輪新指令直到載入新 build。Discord／Herdr／CLI live 驗收未完成；舊訊息不會自動補送。驗收需確認雙向 use／Team 變更、重啟保留 thread 選取、final 送達，以及非 bridge pane identity／位置不變。

### 2026-09-10 固定 bridge workspace

使用者指定 bridge 固定放在名為 `bridge` 的 workspace。已將腳本與文件改為此契約，取代本輪早期「呼叫端 workspace」方案；Team 仍屬於 Discord thread／目標專案 workspace，不移到 bridge workspace。
自動核准審查拒絕過跨所有 workspace 關閉舊 bridge 的修改，該修改未執行。安全替代實作僅替換專用 workspace 的 bridge pane；其他 workspace 偵測到舊 bridge 時先停止，不進行關閉／搬移。目前已知舊 bridge 為 w2:p5，本輪未遷移／重啟，首次使用新腳本前需明確處理該 pane。
新增專用 workspace 已存在、首次建立、同名歧義、舊 bridge 位於別處的隔離 regression。首次建立 fixture 一度誤放尚不存在的 bridge pane，2026-09-10 targeted 結果為 3 通過／1 失敗；修正 fixture 後 `npm run check` 通過（43/43），lint、shell syntax、diff check 通過。

## ISSUE-007：同一 bot 重複啟動缺少程序防護

更新日期：2026-09-18。狀態：重新開啟／待調查。完整套件再現入口子程序 10 秒逾時，尚不能確認為 lock 缺陷或啟動負載問題；先前修正與驗證歷史保留，最新證據見文末。

以下為 2026-09-10 修正歷史（當時狀態：已修正、待驗收）。
使用者指出同一 bridge 不應能啟動兩個。預期第二個相同 bot 的本機實例在讀取
routing state 與 Discord login 前失敗，不能僅依賴重啟腳本檢查 pane。

已確認原因：原 `run()` 直接建立 routing store、Discord client 並 login，沒有
singleton lock。以本機 abstract Unix socket 排他 bind 的隔離 probe 重現第二次
bind 為 EADDRINUSE、釋放後重新取得成功；未啟動第二個真實 bot。

修正：新增以 bot ID／token 雜湊鍵的本機 IPC 排他鎖，與 config 路徑或 workspace
無關；鎖由 OS 持有，啟動失敗釋放，Linux 異常退出後也自動釋放。Windows 使用
named pipe；其他 Unix filesystem socket 異常殘留時不自動冒險接管。鎖不是 HTTP
或控制端點，不接收命令。dry-run 不登入 Discord，故不取鎖。

測試新增：同時競爭只成功一個、重複 release、token 輪替保持相同 bot 鎖、Linux
隔離子程序 SIGKILL 後可重新取得。測試只終止測試自己啟動的子程序。
未驗證：Windows／其他 Unix、live Discord 雙開與舊程序升級。舊版 bridge 沒有鎖，
新版本不能據此排除舊程序；首次遷移仍須處理 w2:p5。未重啟或部署。
驗證（2026-09-10）：targeted lock tests 初次 3/3 通過；補上真實 CLI 入口測試後 `npm run check` 通過（typecheck、build、47/47），`npm run lint`、`bash -n scripts/run.sh`、`git diff --check` 通過。CLI 入口測試使用假 token 且先由測試取得鎖，確認 exit code=1、未讀寫 routing 檔、未連線 Herdr／Discord。
下一步：驗收升級後第二次啟動立即失敗與正常重啟。

最新交付狀態（2026-09-10）：全部原始碼與文件更新完成、checkout build 與 47/47 自動化測試通過。仍已完成 live 重啟／遷移：關閉 w2:p5，建立 bridge workspace w4，啟動新版 bridge w4:p2 並顯示 Discord Gateway connected；w1:p1E、w1:pM、w2:p4 保留。ISSUE-002 格式錯誤與 ISSUE-003 截圖事件仍待 Discord 端到端驗收；ISSUE-007 live 第二實例拒絕仍待驗收。

## ISSUE-008：Discord 目標與 Herdr live pane 不一致

更新日期：2026-09-10。狀態：重新開啟／待調查。

使用者回報 Herdr 看不到 `w2:p1`，但 Discord `current` 有顯示；同時 Discord 回應卡片顯示 `w2:p4`，並回報 `Agent exited or session changed; response capture stopped.`。預期 Discord current、routing mapping 與 Herdr `agent.list` 的 live pane 應一致；有效 prompt 的 response capture 不應因相同 session 的非 identity metadata 變更而停止。

2026-09-10 live 調查：`herdr agent list` 回報 `w2:p4`（codex、working）與 `w2:p6`（agy、idle），沒有 `w2:p1`；`herdr pane list` 亦沒有 `w2:p1`。因此 `w2:p1` 是 stale mapping 或舊 Discord 訊息中的 pane ID，不能作為目前可 dispatch 的 pane。Discord 卡片所示 `w2:p4` 與 live Herdr 回報一致。尚未取得該 thread 的完整 `current` 原文、routing state 片段與執行中 bridge build／啟動時間，故尚不能確認錯誤訊息是舊版 bridge、session 實際替換，或其他 live race。

原始碼條件：目前 checkout 的 `streamAgent` 會比對 terminal、pane、workspace、agent 種類及 `agent_session.kind/value`；只要任一不同就停止 capture。`sameAgentSession` 已忽略 `source` 等 metadata。此 checkout 的自動化 regression 已覆蓋 replacement session／pane／terminal 變更，但尚未完成本次 Discord／Herdr live 驗收。

驗證（2026-09-10）：唯讀 `herdr agent list`、`herdr pane list`、`herdr workspace list`；確認 `w2:p1` 不存在、`w2:p4` 存在且 working。未重啟、未部署、未補送舊 Discord 訊息。下一步：提供該 thread 的 `/herdr current` 原文，確認執行中 bridge 的 build／啟動時間，重啟 checkout 新版後以新 prompt 驗證 current、dispatch、progress 與 final。

## ISSUE-009：Team scope 誤綁 Discord thread

更新日期：2026-09-10。狀態：已修正、待驗收。

根因：原實作把 Team 成員存於 `threadRoutes`，因此 bridge console 的 `team list` 沒有 Discord thread context 時會拒絕，且 Team 語意錯誤地依 thread 分割。修正後新增持久化的 workspace-scoped Team；`team list/add/remove/ask` 依目前 workspace 操作，Discord thread 僅是交付上下文。

驗證：2026-09-10 `npm run typecheck` 與 `npm test` 通過；尚未重啟執行中的 bridge，也尚未完成 Discord／bridge console live 驗收。下一步在 bridge console 執行 `wk use <workspace>`、`team list`，再從不同 Discord thread 驗證同一 workspace 顯示相同 Team；不同 workspace 應分開。

## 2026-09-10 指令與文件同步紀錄

本輪已同步 pane 與 Discord 指令契約：pane 使用 `agent`、`agent use <pane>`、`wk`；Discord mention 支援 `@herdr agent`、`@herdr agent use <pane>`，既有 `agents` 仍相容。Pane 的 `ask <prompt>` 使用 workspace active Agent；pane 內無法辨識的整行輸入預設視為 prompt。更正先前說法：Discord 未知 mention 文字在 mapped thread 中仍可能走原有 direct prompt，不是一律拒絕。Pane Agent selection 以 workspace scope 保存，Discord user/thread mapping 維持獨立。

驗證日期 2026-09-10：typecheck、47/47 tests、lint、`git diff --check` 通過。尚未重啟 live bridge；部署後仍需驗證 Discord mention、pane `current`、default ask 與不同 workspace routing。

## ISSUE-010：1:1:N Team Task、mirror 與 Agent 選擇介面尚未完成

更新日期：2026-09-10。狀態：修正中／待驗收。第一階段 orchestration 已實作；
完整 persistence、recovery、blocked continuation、mirror 與 UI 仍未完成。

需求：實作 1 位使用者對 1 個 Lead 與 N 個 Team Participant 的任務討論與執行；同步研究 Herdr 端是否有可點選的 Agent／workspace 選擇介面；以實際任務驗證 Codex／agy，包含 agy 需要向使用者追問或等待回覆的情境，所有失敗與互動中斷都要記錄。

目前狀態：repo 已實作第一階段 task planner、Assignment lifecycle、bounded Worker report 與 Lead synthesis；`team ask` 會透過 Herdr `agent.prompt`／`agent.wait`／`agent.read` 執行。尚未實作 task persistence、restart recovery、cancel、heartbeat cleanup、blocked Assignment 的互動續接或 task-level UI。`docs/pending-features.md` 的 Herdr pane → Discord mirror 也仍是規劃中，尚未有 MirrorRoute、output watcher 或去重 relay。

2026-09-10 targeted evidence：`test/team-orchestration.test.ts` 3/3 通過，涵蓋獨立 Assignment 平行 dispatch、非 roster Worker plan 拒絕，以及 blocked Worker 保留 task blocked 並由 Lead 產生 partial synthesis。`npm run build`、`npm run lint`、相關 Markdown Prettier check、Draw.io XML parse 與 `git diff --check` 通過。這些是 fake Herdr／Discord seam 測試，尚未完成 live Discord／Herdr 驗收；本輪沒有重跑完整測試套件。

Herdr 能力調查（2026-09-10）：已安裝 CLI 提供 terminal TUI 與 `agent list/get/read/focus/prompt/wait` 等 API；目前未發現 bridge 可使用的瀏覽器式 GUI 或自訂 Agent select widget。若要提供可點選選擇，候選位置是 Discord button/select menu，或使用 Herdr 既有 TUI focus；兩者不能混稱為 Herdr GUI。

未驗證：Discord／Herdr live 的 1:1:N dispatch、Lead plan 實際品質、agy／OpenCode blocked／追問／使用者回覆、task recovery、mirror 去重與 Discord 失敗恢復、任何點選選擇介面。下一步補 task persistence／recovery 與 blocked Assignment question identity，再進行 live orchestration 驗收。

## ISSUE-011：agy 單 Agent 追問與 Team Task 多 Agent 互動路由

更新日期：2026-09-10。狀態：已修正、待驗收。以下為先前僅盤點 Discord baseline 的歷史；本輪已實作本機單 Agent 通道，詳見末尾；多 Agent 互動移至 ISSUE-012 追蹤。

單 Agent baseline：Herdr 將單一 Agent 標為 `blocked` 時，Bridge 會在對應 Discord thread 建立 pane／terminal 綁定的 approval；使用者在同一 thread 回覆後，Bridge 驗證 guild、channel、thread、terminal、workspace、pane 與目前 `blocked` 狀態，再送回該 Agent。新版 Herdr 拒絕 `agent.prompt` 時使用官方 `pane.send_input` fallback。這條路徑可涵蓋 agy 需要使用者回答的情境，但尚未完成 agy live end-to-end 驗收。

Team Task 複雜性：同一個 1:1:N 任務可能同時有多個 Agent／Assignment 進入 blocked 或提出問題。僅依 Discord thread 無法判斷使用者回覆的是哪一個問題；若不標示並綁定 task、assignment、Agent、pane、approval/question ID，可能把回答送給錯誤 Agent。也必須決定 blocked 時是否暫停其他 Assignment、是否允許多個問題排隊、Lead 是否代收並轉發，以及使用者明確指定某一問題的語法。未定義前，Team Task 不應直接重用單 Agent 的 thread-level approval。

驗收規劃：先以單一 agy Agent 驗證「blocked → Discord 問題 → 使用者回覆 → agy 繼續 → final」；記錄 approval message、pane identity、重啟／過期／錯誤回覆。之後才設計多 Agent 問題卡片與 assignment-scoped reply。驗證日期與 live bridge／agy 版本需補入本節。

### ISSUE-010 追加觀察（2026-09-10）

使用者實際觀察：目前 bridge pane 與 agy pane 之間的直接互動沒有顯示在 bridge。包含在 agy pane 內直接輸入、agy 的追問／回覆，以及不經 Discord dispatch 的 terminal 對話。

先前判定（保留歷史，本機部分已由下方修正取代）：當時只在自身 dispatch／watcher／approval 流程取得狀態與輸出，尚無 bridge console 觀察器。使用者澄清已選取 agy 的本機互動就是本次應修正範圍，不能只以 Discord mirror 未實作為由結案。

當時下一步：實作單一 pane → bridge／Discord thread 的 opt-in mirror。後續使用者澄清：本機互動應在 agent use 後自動開始，不另要求 mirror 開關；Discord mirror 仍需獨立 opt-in。以下為本次實作與剩餘驗收。

### ISSUE-005／ISSUE-011 本機單 Agent 修正（2026-09-10）

症狀：使用者已切換到 agy，但 bridge 沒顯示追問；先前只驗證 Discord approval，錯誤地以此代表本機通道也具備。使用者要求非 blocked 時也能下控制指令。

已確認根因：本機 agent use 只存 workspace Team active，未同步本機目前 workspace；新 console 隨後 current 無目標。沒有選取後持續觀察的 reader，ask 仍受一般 activeStreams/busy gate 影響而無法當作 blocked 回答。console parser 拆詞並 lower-case 第一個字，普通回答大小寫／空白會被改寫。

重現：`node --test dist/test/local-agent.test.js` 初始 2/2 失敗：agent use → current 回覆 No Agent is selected；`Yes  Use A` 變成 command=yes、args=[Use,A]。補丁後該最小重現通過，另補實際 console handler 與模擬 Herdr 的連續追問測試。測試使用 fixtures，不向使用者真實 agy 送字。

修正：新增 ConsoleAgent，選取即顯示 bounded visible snapshot，輪詢文字／狀態變化、切換丟棄舊 read；新增 `agent detach` 停止本機 observer，不停止 Agent 或清除 routing，之後可用 `agent use <pane>` 重新 attach。回答綁定已顯示 blocked 畫面與 pane/terminal/session/state sequence，送出前重驗；回答不重試不確定 socket 送達，同一問題拒絕重複回答。idle/done 可送新 prompt，working/unknown 仍可操作控制指令。保留輸入內容、重畫 readline 正在編輯的行；source=console 不因共用 thread 而遺失。修正本機 workspace/current 選取及 help，並恢復 bridge pane 原本完整中文分類 help（不顯示 Discord 前綴）。Pane 也支援 `ask <agent-name-or-pane-id> <prompt>`；明確指定 Codex 會走既有 response capture，避免只送出 prompt 而沒有 bridge 回應。Codex 保留既有 final 擷取。本機假 guild routing 排除在 Discord watcher destination 外。

限制：40 行／6,000 字元快照不代表完整 transcript 或完整 final；沒有讀取隱藏 reasoning record。缺少 session metadata 的同 terminal restart 無法完全辨識；Herdr 目前沒有原子 question-ID 比較後送答 API。agy 特定版本的狀態偵測、只支援方向鍵的 UI 尚待 live 驗收。未確定送達的回答須人工檢查 Agent，不自動重試。

驗證（2026-09-10）：本次 `local-agent.test.js` 的 14/14 項針對性測試通過，涵蓋選取後 current、無須 ask 即顯示各狀態畫面、`agent detach` 停止 observer、`agent use <pane>` 恢復、blocked 回答與下一個問題、問題變更／重複回答拒絕、切換途中不顯示或回答舊問題、working／blocked 控制指令、授權與 session 更換。typecheck、build、lint 與 `git diff --check` 通過。這些是 fixture／handler 驗證，不是 live agy 驗收。

另記非本次互動範圍的檢查結果（2026-09-10）：完整 `npm run check` 為 59/60 通過，ISSUE-007 的入口程序測試達 10 秒逾時，exit code 為 null 而非預期 1；未調整斷言或延長 timeout。單獨重跑 `node --test dist/test/instance-lock.test.js` 為 4/4 通過，逾時根因尚未確認。後續完整重跑被使用者中斷，無完成結果，不列為通過；依使用者要求停止擴大測試範圍。

本輪未重啟／部署、未 commit／push；執行中 bridge 是否載入本輪程式未驗證，舊互動不補送。下一步載入新版後在 bridge 執行 agent use <agy-pane>，驗證當前畫面、進度、blocked 問題、回答、恢復；在 working 與 blocked 分別執行 current／agent／切換，確認可操作且目標正確。live 驗收需記錄 Herdr／agy 版本及畫面證據。

## ISSUE-012：Team 多個 Agent 同時提問的回覆識別

更新日期：2026-09-10。狀態：待調查。

預期／待驗收場景：team ask 下多個 Agent 同時提出不同問題，bridge 必須清楚顯示是哪個 workspace／task／assignment／Agent／question，使用者回覆只能送給所選問題。現有 thread 級 approval 或單一 active Agent 不能證明此流程安全；目前未進行 live 多 Agent 重現，屬已識別設計缺口。

已確認限制：目前無 task/assignment/question 級的回覆佇列與選擇 UI。本輪只實作單一選取 Agent 的本機問答，不更動其他 Agent 狀態。是否暫停其他輸出、允許多問題排隊、由 Lead 代收、跨介面同時回答的互斥與逾時取消，均需後續設計。

修正範圍：本輪僅記錄，未實作 Team 問答。驗證：文件及現有流程盤點；沒有自動化或端到端通過證據。下一步建立兩 Agent 同時 blocked 的 fixture、問題識別／明確 reply 選擇及回覆不串線的驗收。不能把單 Agent 通過視為本項驗收。

## ISSUE-015：Agent Profile／Pool 與長駐 session 分離

更新日期：2026-09-18。狀態：修正中。
症狀／需求：分享對話要求 Team 可選尚未啟動的 Agent，Lead 自由分工，重用同一 session 保留 context。原 team add 只解析 live agent.list。
預期：勾選 profile 不啟動，只有本次計畫選中的 profile 才 acquire；session identity 不明時不可宣稱上下文延續，不固定 coding pipeline。
重現／環境：本機 TypeScript 原始碼檢查；Herdr 已安裝 binary 的 agent/pane help、api schema 與 pane layout 唯讀核對。未派送真實任務。
已確認根因：Team 只有 pane mapping，無 profile registry、session binding 與 acquire lifecycle；Lead 只有單輪 plan→synthesis。
修正範圍：AgentPool、config、Herdr pane.layout/split/agent.start、Team 勾選／bind、租用與 terminal reservation、多輪 Lead planning、零 Worker、原任務與有界報告 handoff。原始需求與使用見 [架構文件](agent-pool-console.md)。
驗證（2026-09-18）：第一輪 targeted 執行 35/36，失敗為 ISSUE-014 fixture 依賴既有 synthesis 提示文字；已保留該辨識文字並加入新行為要求，未降低等待順序斷言。此數字是中途結果，最終驗證另記。
未驗證：真實 CLI 模型／cwd／啟動、連續兩輪同 session、Discord 選取、重啟後重用。Task recovery、多問題續接、跨 bridge 租用尚未實作。
下一步：完成下方自動化檢查，再載入新版進行 live 驗收。

## ISSUE-016：Console use／attach／response 分離

更新日期：2026-09-18。狀態：修正中。
使用者可見症狀：use Lead 後持續印 CLI UI／工具文字，難以辨識對 bridge 下的指令與回答；原本必須 detach。
預期：use 只選對話目標；attach/watch 明確檢視且不改送話目標；console 新 prompt 只呈現本次明確回答；blocked 問題仍可安全回答。
重現／環境：分享對話使用者回報及 src/main.ts／console-agent.ts；目前沒有新的 live 畫面證據。
已確認根因：bindActiveAgent 自動啟用快照 observer，非 Codex 本機問答只依靠快照輸出；selection 與 observation 綁在一起。
修正範圍：conversation／attach／watch 模式、獨立 inspector、同一 turn 接收器、跨 CLI marker final、blocked 後繼續等待、保留問題 identity 驗證。順帶移除 debug context 中重複 begin/end，避免 echo 被辨識成回覆框。
驗證（2026-09-18）：第一輪本機模式／問題回覆 fixtures 通過（上述 35/36 中包含 16 項 local-agent 測試）；完整與新增 handler/receiver 測試待下方最終紀錄。
未驗證：真實 readline 勾選／多語言 CLI 畫面、agy marker 遵循、模型追問後完整回答；attach 仍是 40 行／6,000 字元快照，非原生完整 PTY stream。
下一步：載入新版驗證 use 不刷畫面、attach Worker 後 ask 仍送 Lead、blocked 問題與回答。

本輪原始碼已修改；build／最終驗證尚在執行。未重啟／部署、未 commit／push、未修改真實設定，執行中的 bridge 未驗證載入新程式；舊任務／訊息不自動補送。既有 ISSUE-011 的先前自動快照契約保留作歷史，本輪 use 行為以 SPEC 與 ISSUE-016 為準。

### 2026-09-18 中途完整檢查與 ISSUE-007 重現

`npm run typecheck`、`npm test` 內的 build 通過；完整 `npm test` 為 **89/90**。唯一失敗是 ISSUE-007 的 `the real entrypoint rejects a duplicate before contacting Herdr or Discord`：子程序在 10 秒內未結束，exit code 為 null，預期 1。不能把這次完整套件列為全通過；此現象延續 2026-09-11 的紀錄，負載／module startup 時序的確切根因仍未確認，未修改 timeout 或斷言。

差異檢查另發現 ISSUE-016 模式切換若重設 observer identity，會一併清除 blocked 回答去重；已改為只取消舊讀取、不清除已回答問題，並新增 regression。Inspector 的 blocked 提示明示先 use 該 Agent 才能回答，避免誤導使用者把 Worker 答案送到 Lead。以下最終驗證需涵蓋此最新修正。

### 2026-09-18 勾選介面隔離 smoke test

在真實 PTY 執行只載入 startConsole 的假 profile harness，輸入 `team select` → `1 2` → `done`，清單從 helper 未勾／reviewer 已勾變成 helper 已勾／reviewer 未勾，輸出 `SELECTION_RESULT=["helper"]`，程序 exit 0。此項驗證 readline 勾選／儲存互動，不是 Discord／Herdr／CLI 端到端驗收；未連線外部服務或啟動真實 Agent。

## ISSUE-017：跨 CLI quota 交接缺少可攜流程

更新日期：2026-09-18。狀態：已修正、待驗收。

症狀／需求：來源 Agent 接近 quota 上限或已不能回答時，希望由其他 CLI 復原指定 session，包含 AGY。現有 bridge handoff 只有近期有界 terminal output，不保證保留原始目標、決策及未完成工作。

預期：原生可讀歷史優先、portable checkpoint fallback，接手核對實際檔案並繼續；不依賴來源再次推論，不宣稱完整模型上下文或 quota 移轉。

重現／環境：使用者分享對話、src/main.ts handoffAgent／SPEC／AgentPool 文件唯讀盤點；本機 agy --help 與官方 CLI 文件核對。未讀取真實私人 session，未發送真實 Agent prompt。

已確認根因／限制：bridge handoff 僅 agent.read recent_unwrapped、預設 40 行／6,000 字元，沒有 portable session recovery protocol。AGY help 的 resume／print format 不證明具備通用歷史 export；自動 skill 搜尋位置亦非所有 CLI 共用。

修正範圍：新增 skills/session-handoff 的 SKILL.md、來源 adapter 指引與 HANDOFF.md 範本；docs/session-handoff.md 比較與用法，同步 README 雙語、SPEC、CONTEXT。無 Bridge runtime 變更、無 quota watcher 或自動切換。

驗證（2026-09-18）：

- `python3 /home/jones/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/session-handoff` 通過。
- `node_modules/.bin/prettier --check 'skills/session-handoff/**/*.md' docs/session-handoff.md` 通過。
- `python3` inline 本機 Markdown 連結檢查：9 個相關檔案、37 個相對路徑均存在。以 `tempfile.TemporaryDirectory`／`shutil.copytree` 隔離複製整個 skill，再執行 quick_validate 並確認內部附件皆位於複製目錄，通過；未安裝到 home。
- `git diff --check` 通過；人工核對 prepare／takeover、quota 已耗盡、identity 歧義、過期檔案與 writer ownership 分支，以及 bridge handoff 原始碼比較。這是靜態審查，不是真實 CLI 行為測試。

標準 apply_patch 讀取既有文件受環境 bwrap namespace 錯誤阻擋，改用已授權 shell 的檔案更新完成；非 skill 執行測試失敗。比較時另確認本機 console effectiveTarget 優先 workspace active target，故文件要求 handoff 後以 current 核對，不將 dispatch 成功等同所有介面已切換；本輪不更動 routing。

未驗證：所有真實跨 CLI session 接手、AGY 原生歷史可讀性、CLI 自動 discovery、來源耗盡時與並行 writer 的實際操作。沒有重跑 Bridge build／unit tests；無原始碼修改、未重啟／部署，執行中 bridge 未驗證，舊訊息不補送。未全域安裝、未 commit／push。

下一步：依 docs/session-handoff.md 驗收矩陣記錄實際 CLI 版本／ID／工作樹與接手結果；尚未有全 CLI 原生相容或 live 接手成功證據。

## ISSUE-018：Phase 1 Durable Task Engine

更新日期：2026-09-19。狀態：已修正、待驗收；完整驗證 gate 受執行環境限制，未通過 live 驗收。

症狀／已確認根因：原 `team ask` 是記憶體中的 run-to-completion function；Bridge restart 丟失 task／Assignment／report，無 whole-team cancel。AgentPool session binding 與 routing persistence 不能替代 task lifecycle。

預期：durable task／frozen roster／Lead/session identity、shared Assignment state、可追蹤 journal；重啟核對而不假報 running；whole-team cancel 不誤殺其他 CLI。

修正範圍：新增 `src/team-task-store.ts`、`src/team-task-engine.ts`、`test/team-task-engine.test.ts`；整合 main／orchestration／turn receiver，提供 `team status`／`team cancel`、持久化派送意圖／報告、restart quarantine、取消後 reservation／lease 清理。`src/herdr.ts` 的 Ctrl-C 不再 transport retry，避免失去 acknowledgement 後重複中斷後續工作。同步 SPEC／CONTEXT／雙語 README、orchestration spec/plan、Agent Pool／pending docs 及 [完整架構／驗收](durable-task-engine.md)。

重現／驗證環境：本輪隔離 checkout 的 `phase1-durable-task-engine`，Linux Node.js runner，fake Herdr／Discord fixtures 與臨時 state 目錄；沒有使用者真實 CLI／Discord。未變更 main。

### 自動化紀錄（2026-09-19）

- 中途 typecheck：新增 event union 時 main event message map 尚未同步（TS2739）；新增 Ctrl-C 測試時 dynamic import 被用作 type（TS2749）。均已修正，最終 typecheck 通過。
- 第一輪既有 orchestration／AgentPool／console：25/25 通過；初版 durable engine：16/16 通過。
- 擴大 targeted：63/65，兩項 `herdr.test.js` 因 Unix socket `listen EPERM` 失敗；這是中途結果，不列為全通過。
- 最終 `npm run typecheck`、`npm run build`、`npm run lint` 通過（42 個 TypeScript 檔案）；`git diff --check` 通過。
- 最終 targeted：`node --test dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js dist/test/agent-pool.test.js dist/test/console-conversation.test.js dist/test/local-agent.test.js` **63/63 通過**，含 **21 項 durable engine tests**。涵蓋 state transition、round trip／schema／atomic failure、restart missing/replaced/unknown/offline/stale running、平行 Worker／blocked Lead／lazy acquire／atomic prompt in-flight 取消、uncertain Ctrl-C 不重送、reservation 釋放、workspace scope、動態多輪與零 Worker、ISSUE-014 及 console 模式回歸。
- 完整 `npm test`：build 通過；socket fixtures `EPERM`，instance-lock 子程序無法建立 lock／輸出 ready，套件沒有自然完成，手動停止 exit 130，無完整總數。未改動該測試 assertion 或 timeout。
- 補跑完整 compiled suite `node --test --test-timeout=15000 dist/test/*.test.js`，以 runner timeout 收集受限環境結果；初次為 111 項：105 pass、5 fail、1 cancelled。最終為 **112 項：106 pass、5 fail、1 cancelled（15 秒 timeout）**，exit 1。5 fail 是兩項 Herdr socket fixture 及三項 instance-lock fixture；另有 Linux killed-owner fixture 逾時 cancelled。增加 runner timeout 不代表受阻測試通過。

### 限制及下一步

完整檢查失敗集中在 Herdr Unix socket 與 instance-lock fixtures；本機 `listen` 權限受限，不是 live bridge failure 證據。需在允許本機 IPC 的一般開發環境重跑原始 `npm test`；ISSUE-007 的先前入口逾時／live duplicate-instance 驗收仍未關閉。

Phase 1 recovery 保存並核對任務，不自動 resume/replay。Recovered active turn 即使 same-session 也不證明 turn ownership，需人工確認停止後 `team cancel`；未知 identity／uncertain delivery 保持 cancelling，不假報 cancelled。取消等待 in-flight prompt 可受既有 approvalTimeoutMs + transport overhead 影響。Herdr 沒有 compare-session-and-cancel 原子 API，外部手動 pane 操作仍有競態。

沒有 Phase 2 multi-Agent question queue／blocked continuation、journal retention／compaction／migration、跨 bot state-directory writer lock 或 durable Discord delivery retry。Windows rename／power-loss、真實 CLI session continuity、兩 Worker 取消、restart reconciliation、lazy start／reuse 與 conversation/attach/watch 需依架構文件 live 驗收。

原始碼與 build 已完成；本輪沒有部署／重啟使用者 Bridge，執行中版本未核對，舊任務／訊息不補送。Unit fixtures 不等於 Discord／Herdr／CLI end-to-end acceptance。ISSUE-010 的 durable 部分由本項接續，ISSUE-012 保留 Phase 2；ISSUE-014、015、016 live 狀態不因本轮 fixture 通過而改為已驗收。
