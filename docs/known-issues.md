# Known Issues

維護規則見 [AGENTS.md](../AGENTS.md)。最後整理：2026-10-05。

| ID        | 問題                                                                            | 狀態             | 下一步                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ISSUE-001 | Discord reply 未觸發 bridge                                                     | 重新開啟、待驗收 | 重啟後在 mapped thread 回覆 bot                                                                                                           |
| ISSUE-002 | Discord 圖片未交付 Agent                                                        | 已修正、待驗收   | 重啟後以副檔名與內容不符（如 PNG/JPEG 互換）之圖片驗收本機交付                                                                            |
| ISSUE-003 | 預覽與 final 未更新                                                             | 重新開啟／待調查 | 暫時缺失子缺陷已修正；2026-10-02 重跑 195/195，載入新版原 thread 驗收與核對 live identity                                                 |
| ISSUE-004 | Team 成員可跨 workspace 混入，且 stale mapping 容易造成誤解                     | 已修正、待驗收   | 重啟後確認同 workspace 限制、持久化與 stale 顯示                                                                                          |
| ISSUE-005 | 本機 current 顯示未選取 Agent                                                   | 已修正、待驗收   | workspace selection 回歸修正後須重新驗收；先前 shared-thread 驗收歷史保留                                                                 |
| ISSUE-006 | 重啟 bridge 後 pane 所屬 workspace／位置改變                                    | 已驗收           | 2026-09-10 live topology 驗證完成；後續觀察重啟保留                                                                                       |
| ISSUE-007 | 程序啟動未阻止同 bot 重複實例                                                   | 重新開啟／待調查 | 2026-09-21 完整與單獨重跑入口逾時再現；核對負載與 startup 時序，live 第二實例拒絕仍待驗收                                                 |
| ISSUE-008 | Discord current／回應仍引用 Herdr 已不存在的舊 pane，且串流回報 session changed | 重新開啟／待調查 | 取得該 Discord thread 的 current 輸出與 bridge 啟動版本；重啟新版後以 live prompt 重現                                                    |
| ISSUE-010 | 1:1:N orchestration、Discord mirror 與選擇 UI                                   | 修正中／待驗收   | Phase 1 durable task／reconciliation／cancel 已實作見 ISSUE-020；Phase 2 blocked continuation 已實作見 ISSUE-012；mirror 與點選 UI 仍待做 |
| ISSUE-011 | 選取 agy 後 bridge 沒顯示追問、無法回答                                         | 已修正、待驗收   | 本機快照／blocked reply 自動化完成後進行 live agy 驗收                                                                                    |
| ISSUE-012 | Team 多 Agent 同時提問識別                                                      | 重新開啟／待調查 | 2026-10-02 同 session 128 questions 仍未確認根因；coding 原始碼續作見 ISSUE-025，cap 未修                                                 |
| ISSUE-013 | Lead plan 解析失敗或誤取 planning prompt 中的範例 JSON                          | 已修正、待驗收   | 重啟新版 bridge，以新 team ask 驗證 plan 不取 prompt／歷史，兩 Worker 均收到正確 Assignment                                               |
| ISSUE-014 | 未等 Worker 完成本次任務便以歷史輸出標記 done 並進入統整                        | 重新開啟／待驗收 | 載入本次修正後重啟 bridge，驗證 atomic prompt wait 的 done 回傳可直接產生本次報告，且所有 Worker 完成後才 synthesis                       |

| ISSUE-015 | Team 僅能加入已啟動 pane，缺少 profile 與 session lifecycle | 修正中 | 完整檢查後驗收 lazy start／重用／Lead 動態分工 |
| ISSUE-016 | use 自動刷 CLI 畫面，console 對話與終端檢視混在一起 | 修正中 | 完整檢查後驗收安靜對話與獨立 attach/watch |
| ISSUE-017 | quota 耗盡時缺少跨 CLI session 交接流程 | 已修正、待驗收 | 2026-10-01 已補 Grok skill adapter；真實跨 CLI 接手（含 Grok）仍待驗收 |
| ISSUE-018 | `scripts/run.sh` 在 macOS 內建 Bash 上無法執行 | 已修正、待驗收 | 以 macOS `/bin/bash` 執行 restart regression，並驗證 `-r` 的 build/link/live 流程 |

| ISSUE-020 | Phase 1 Durable Task Engine、restart reconciliation 與 whole-team cancellation | 已修正、待驗收 | 2026-09-21 完整 113/114 通過；ISSUE-007 入口逾時，live 驗收仍待完成 |

| ISSUE-021 | Phase 3 Session Handoff Runtime | 重新開啟／待調查 | 2026-10-02 完整套件與單獨重跑再次出現並行 verify/cancel ENOENT；未改 handoff，live 未驗收 |
| ISSUE-025 | 本機 Git coding workflow 首版 | 已修正、待驗收 | 2026-10-02 重新開啟後已補 read-only 起迄指紋與 finding id；live 未驗收 |
| ISSUE-026 | Claude 模型／終端擷取相容性；integration 安裝前缺 session | 已修正、待驗收 | integration 後短互動及最終 30/30 回歸通過；重啟後驗收 Discord／Team／blocked |

| ISSUE-022 | Phase 4 Quota / Failover Manager | 已修正、待驗收 | 2026-09-21 新增 28 項通過；完整 181/184，ISSUE-007／021 待調查，live 待驗收 |

| ISSUE-023 | Grok 回答框與折行標記無法解析 | 已修正、待驗收 | Grok live turn probe 通過；Discord 交付、長文及 blocked 續答待驗收 |
| ISSUE-024 | Herdr 重啟後 Grok 未自動恢復 | 待調查 | 已確認缺少 Grok integration；安裝後以 exact session resume，取得 session metadata 並驗收下一次重啟 |

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

狀態：已修正、待驗收（2026-10-01 新增二進位簽章自動偵測與副檔名正規化；自動化回歸通過，live 待驗收）。2026-09-09 已實作附件下載與本機交付，但尚未完成 CLI 讀圖端到端驗收。

使用者從 Discord 傳送圖片後詢問 Agent 是否看得到；本次 Agent 對話僅收到文字，未收到可檢視的圖片附件。已確認入口略過空文字訊息，且原 dispatch 未處理 attachments；現已加入下載與本機檔案交付。Agent 實際讀圖能力仍待端到端驗收，不應直接歸因於模型不支援圖片。

### 2026-10-01 跨格式容錯與副檔名正規化修正

更新日期：2026-10-01。狀態：已修正、待驗收。
使用者回報 Discord 上傳圖顯示 `Image content does not match its declared format`。
已確認原因：原實作嚴格要求 Discord `attachment.contentType` 必須與下載二進位 magic bytes 完全一致。若使用者手動修改副檔名（例如 JPEG 存為 `.png`）或 Discord MIME 判定與二進位不同，即拋出錯誤中斷 dispatch。
修正範圍：維持二進位 Magic Bytes 安全簽章檢驗（拒絕非圖片、未支援格式或惡意檔案），新增 `detectImageFormat` 判斷真實格式（PNG/JPEG/WebP），並自動依真實格式正規化儲存副檔名（如宣告 `image/png` 但內容為 JPEG 時儲存為 `.jpg`），避免下游 Agent 解碼器 crash，兼顧安全性與相容性。
驗證（2026-10-01）：新增 `test/attachments.test.ts` 回歸測試（包含 PNG 宣告+JPEG 內容、JPEG 宣告+PNG 內容、含 charset 參數之 WebP 內容及非法內容拒絕）。全套 gate 通過。未重啟／部署 bridge，live 待驗收。

### 2026-10-01 相同格式錯誤再次發生

使用者再次回報 Discord 上傳圖顯示 `Image content does not match its declared format`。
狀態維持重新開啟／待調查，保留以下歷史。期望支援且有效的圖片可交付正確 Agent，
非圖片／格式不符仍需拒絕，不移除簽章驗證以掩蓋錯誤。

已確認：目前 checkout 的 `src/attachments.ts` 在下載 body 完成後，比對 PNG/JPEG/WebP
簽章與 attachment.contentType；不符即清除本次批次、拒絕 dispatch。錯誤出現在
本機圖片準備階段，與 Grok terminal response parser 無關。`src/main.ts` 目前
只允許 Codex／agy／Antigravity 本機圖片交付；Grok 會先得到另一個不支援交付錯誤。
尚未核對此次執行中 bridge 的版本或使用者當時選取 Agent，不據此推定實際目標。

重現／環境：本機 Linux Node.js v22.23.3；未取得失敗訊息連結、原始附件、
attachment.contentType 或 HTTP response metadata，故尚未重現本次真實上傳。
已要求使用者提供該訊息／附件下載連結與選取 Agent。真實根因仍未確認。

驗證（2026-10-01）：`node --test dist/test/attachments.test.js` 3/3 通過，
涵蓋 URL／大小／格式限制、PNG signature bytes 寫入、invalid bytes 拒絕及清理。
現有 fixture 僅驗證簽章，不等於完整圖片解碼或 Discord／CLI 端到端成功。
修正範圍：本輪僅同步 issue 證據，尚未更改圖片 runtime 或放寬驗證。
未因本次回報重新 build／重啟／部署；先前 Grok build 不代表此圖片問題已修復。
失敗圖片不會自動補送。下一步取得同一附件及 metadata，建立確切重播，再修正與重新上傳驗收。

### 2026-10-01 使用者檔案重播

使用者提供 `/media/sf_tmp/1.png`、`/media/sf_tmp/2.png`。`file` 確認均為
8-bit RGBA PNG，分別 741×397／84,729 bytes、1017×267／40,334 bytes。
兩者 header 均為完整 PNG signature。將原始 bytes 透過 mock fetch 送入真正
`prepareImages`、contentType 設為 `image/png`：2/2 成功，讀回檔案與來源 bytes 完全相同。
這不含 Discord CDN 下載，不能證明 Discord attachment.contentType 與 body 相符。
尚待訊息／附件連結及 metadata，未放寬驗證或宣稱 ISSUE-002 已修復。
圖片內容為 Herdr `agent_not_idle` 與 Discord capture incomplete 截圖；另見 ISSUE-003。

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

狀態：重新開啟／待調查（2026-10-02 使用者附圖再現 capture stopped；最新證據見本文件末尾）。2026-10-01 busy-history fallback、2026-09-10 metadata 與 2026-09-07 解析器修正歷史保留如下。

使用者回報：更新回應呈現功能後，CLI 執行中未在 Discord 顯示內容；CLI 結束後也未更新 Discord response。已透過實際 session 紀錄重播確認事件格式不相容，詳見下方修正紀錄。

### 調查與驗收

- 確認實際執行的 plugin 版本、bridge 日誌與串流是否啟動。
- 檢查預覽擷取、Codex transcript 問答對應、完成判斷與 Discord 傳送錯誤。
- 驗證執行中可見最新內容、結束後 final 獨立送達、失敗時明確顯示原因。
- blocked 不提前結案；來源或傳送失敗不使後續問題永久失去回應。

### 2026-10-01 工作中歷史擷取失敗

更新日期：2026-10-01。狀態：已修正、待驗收（本次完整 gate 已通過，live 待驗收）。
使用者 1.png 顯示 `agent.read: agent_not_idle cannot read 2000 lines while w2:p4
is working`，提示 `--source visible`；2.png 顯示 Codex 完成後 capture incomplete。
預期：busy history 無法讀取時仍可觀察可見畫面，保留 prompt 範圍的片段，
不把片段誤標完整 final；無片段時仍明示 incomplete。

已確認根因：Discord `streamAgent` 固定讀至少 2000 行 recent_unwrapped，沒有
agent_not_idle fallback，working 時的可見片段因而遺失。這解釋截圖的持續讀取錯誤；
未取得當次 prompt/session transcript，不能宣稱這是 final 缺失的唯一原因。
修正：僅 typed HerdrError code=agent_not_idle 時追加 visible read，沿用 outputLines；
idle 恢復 recent_unwrapped。其他錯誤不吞掉，identity、prompt scope、settlement、
最長 excerpt 與 structured final 優先規則保持不變。SPEC 同步。

驗證（2026-10-01）：新增 regression 經 streamAgent 真實入口重現 busy error，
修正前 0/1（未呼叫 visible），修正後 build + response-delivery/progress-time/attachments
11/11 通過；覆蓋 working visible 片段在 idle 畫面消失後仍保留，且不標完整 final。
最終 gate（2026-10-01，Linux Node.js v22.23.3）：`npm run lint`、
`npm run typecheck`、`npm test`（含 build）通過，完整 190/190、0 fail、0 skipped。
修改的 TypeScript Prettier check、文件相對連結及本次新增差異 whitespace 檢查通過；
README.zh-TW.md:49 使用者原有 trailing whitespace 保留。
未重啟／部署 bridge、未驗收 Discord live；visible 仍可能缺 prompt
或早已捲出答案，不能保證補回歷史或完整 final，舊訊息不自動補送。

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

更新日期：2026-09-21。狀態：已修正、待驗收；最新合併驗證見下方 2026-09-21 紀錄。以下保留 2026-09-20 的受限環境結果。

症狀／已確認根因：原來僅有 thread-level approval 與單 Agent 問答，缺少 task／assignment／question identity，同時 blocked 時不能安全選擇答案目的地。先前 2026-09-10 僅盤點，無 live 多 Agent 重現；本次完成 Phase 2 原始碼與 fixture，尚無 live 驗收。

預期／實作：持久問題佇列、明確 questions/reply 指令、task／workspace／assignment／phase／Agent／pane／session identity、state sequence／snapshot 驗證、跨介面單次送答；其他同 wave Worker 不被中斷，原 turn 等候 report，沿用動態 Lead 規劃。答案先保存 sending，再以 retries=0 送出；unknown 不重送。取消等待 in-flight answer，重啟問題 unknown、不自動續接。Discord 限原 guild/channel/thread，console 限選取 workspace。Team-owned watcher 不再另發單 Agent approval。Schema v2 讀取 v1，未知版本 fail closed；最多 128 個歷史問題。詳見 [Phase 2 契約／live 清單](team-question-queue.md)。

修正範圍：team-task-engine/store、team-orchestration/turn、main、console/Discord parser；新增 team-questions tests，同步 SPEC、CONTEXT、README 與架構文件。Phase 2 位於 `phase2-team-question-queue`，基於本機 Phase 1 `ffa33b7`；未修改 main。

驗證環境：2026-09-20，隔離 Linux Node runner、fake Herdr／Discord／temporary state，不向真實 CLI 送字。

- `npm run typecheck`、`npm run build`、`npm run lint` 通過（43 TS files）。
- Targeted：`node --test dist/test/team-questions.test.js dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js dist/test/console-conversation.test.js dist/test/local-agent.test.js dist/test/agent-pool.test.js`：**79/79 通過**，含 16 項新 question tests。
- 涵蓋兩 Worker 同時提問與反序回答、Lead planning 問答、duplicate／in-flight 去重、snapshot/session/workspace/thread 拒絕、保留空白、timeout、問題更新、unknown delivery 不重試、restart、cancel/answer race、schema v1 升級及 immutable question。既有動態多輪、零 Worker、lazy-start/reuse、ISSUE-014、console 回歸通過。
- 中途 72/73：optional origin undefined 與 JSON round-trip 物件欄位不一致，已改成沒有 origin 時省略欄位。中途 74/75：舊測試將 v2 視為未知 schema；依新 v2 契約改用 999，保留未知版本拒絕斷言。
- 原始 `npm test` build 通過，但 socket fixtures 無法 listen，instance-lock 子程序卡住；人工停止 exit 130，無完整總數，不列全通過。
- 完整限時 compiled suite：`node --test --test-timeout=15000 dist/test/*.test.js`：**128 項，122 pass、5 fail、1 cancelled**。5 fail 為既有兩個 Herdr socket／三個 instance-lock fixtures（EPERM），1 為 killed-owner fixture 15 秒 timeout。未更改 socket 斷言或宣稱 live 故障／成功。

限制／下一步：在允許 IPC 的環境重跑原始 npm test，並依 Phase 2 文件完成 Discord／console 兩 Worker、Lead synthesis／零 Worker 提問、多輪相同問題、回答途中取消與 restart live 驗收。Herdr 缺少原子 question compare-and-send，外部手動 pane 操作仍有競態；無 session metadata 或完全相同画面且無新 sequence 的問題不猜測。未提供點選 UI、restart 自動 resume、durable Discord retry、方向鍵選單或非 blocked 偵測。Timeout 包含使用者等待，不延長原 turn 期限。Journal 仍需後續 retention/compaction。

原始碼／build 已完成；未部署、未重啟使用者 Bridge，執行中版本未核對，舊訊息不補送。自動化不等於 live Herdr／Discord／CLI 驗收。ISSUE-014／015／016／020 不因此標成已驗收。

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

更新日期：2026-10-01。狀態：已修正、待驗收。

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

### 2026-10-01 補上 Grok Build adapter

症狀：session-handoff skill 已涵蓋 Claude、Codex、Copilot、AGY、OpenCode，沒有 Grok Build（`grok` CLI）的身份、匯出與 thought 排除方式。Bridge 終端 parser 只處理畫面回答，不能代替 session 接手。

預期：接手方能依 exact session ID 讀 Grok 公開歷史或 checkpoint，排除 thought／reasoning，核對工作樹後繼續；不把 `grok usage` 當帳戶 quota，也不讓 Bridge runtime 自動解碼 Grok session 檔。

環境：Linux，`grok` 1.0.46（2026-10-01）。核對 `grok export --help`、`grok sessions list`、本機 user guide `17-sessions.md`，以及 [Sessions](https://x.ai/docs/build/features/sessions)。用既有本機 session 檢查匯出標題與 thought 是否出現；未把匯出內容寫入 repo，未呼叫來源模型做摘要。

根因：adapter 指引當初沒有 Grok 列。`grok export <id> <file>` 會寫出 `## User`／`## Assistant`／`## Tools` Markdown，且不含 `agent_thought_chunk`、reasoning 或 system prompt；工具節是摘要，不是完整 raw output。可直接讀的對話紀錄是 `updates.jsonl`；`chat_history.jsonl` 含 system prompt 與 reasoning。

修正範圍：`skills/session-handoff/SKILL.md` 描述、`references/adapters.md`、`docs/session-handoff.md`、SPEC、CONTEXT、runtime 文件的範圍說明、README 雙語。無 Bridge TypeScript、runtime decoder 或 quota watcher 變更。

未驗證：真實 Grok → 其他 CLI 與反向接手、quota 耗盡、同名 session、過期封包與其他 writer。未重跑 Bridge build／unit tests，未重啟或部署，執行中的 bridge 未變更，舊訊息不補送。未 commit／push。

下一步：依 docs/session-handoff.md 第 7 項記錄兩端版本、exact session ID、workspace／HEAD 與接手結果。通過前不得宣稱 Grok 原生交接已驗收。

## ISSUE-018：`scripts/run.sh` 不相容 macOS 內建 Bash

更新日期：2026-09-21。狀態：已修正、待驗收。

症狀：在 macOS 內建 `/bin/bash` 3.2 執行 `scripts/run.sh -r` 時，腳本進入 Herdr workspace／tab／pane 解析後會因 `mapfile: command not found` 中止，因此尚未完成 local plugin link 與 bridge pane 開啟。

根因：`mapfile` 是 Bash 4 才提供的 builtin；專案腳本的 shebang 沒有要求新版 Bash，而 README 宣稱支援 macOS。

修正：將三個 `mapfile` 呼叫改為 Bash 3.2 可用的 `while IFS= read -r` 陣列填充，保留空結果與多筆結果的原有判斷語意。

驗證：2026-09-21 已確認 `/bin/bash` 為 GNU bash 3.2.57，`bash -n scripts/run.sh` 通過；`npm run build` 受目前受限環境禁止寫入既有 `dist/` 阻擋，尚未完成 macOS live Herdr restart、local link 與 Discord bridge 驗收。

下一步：在可寫入的本機環境以 `/bin/bash scripts/run.sh -r` 執行 restart regression，確認 build、`herdr plugin link`、pane replacement 與新 bridge 啟動完整通過。

### 2026-09-21 再次失敗與空陣列修正

狀態歷程：使用者回報後重新開啟／待調查 → 已修正、待驗收。先前移除 mapfile 未涵蓋 Bash 3.2 的 nounset 空陣列行為。

症狀／重現：使用者執行 `./scripts/run.sh -r`，build 與 headless server ready 後，於建立 bridge workspace 時出現 `bridge_panes[@]: unbound variable`。本機 `/bin/bash` 3.2.57 以 `set -u`、空 bridge_panes 陣列及未防護的 for 迴圈重現相同錯誤（exit 127）。預期首次啟動無舊 pane 時應直接繼續 link/open/move，不關閉任何 pane。

已確認根因：Bash 3.2 在 nounset 下展開空陣列會視為未設定。保留工作樹已有的陣列長度防護，補上原因註解；回歸測試在 macOS 明確使用 `/bin/bash`，避免 PATH 上新版 Bash 隱藏問題，並新增首次啟動 `-r` 情境，斷言 plugin link、pane move 與零 pane close。同步 SPEC 的 Bash 3.2 相容要求。

驗證（2026-09-21）：`npm run lint`、`npm run typecheck`、`npm test`（包含 `npm run build`）及 `/bin/bash -n scripts/run.sh` 通過；完整測試 92 項，91 通過、1 項 Linux 專用測試跳過、0 失敗。5 項 restart fixtures 全數通過。fixtures 使用假的 Herdr/npm，不會操作真實 pane；真實 TypeScript build 已由 npm test 執行成功。

未驗證／下一步：未重啟或部署真實 bridge，未完成 Herdr／Discord 端到端驗收，未 commit／push；執行中的 bridge 未確認載入新版，舊訊息不補送。請於專案執行 `./scripts/run.sh -r` 驗收首次／再次啟動。

## ISSUE-019：Herdr plugin pane 啟動後消失，Discord 未上線

更新日期：2026-09-21。狀態：已修正、待驗收。
症狀／環境：macOS、Herdr 0.9.1；使用者回報 Discord 未上線，初始程序清單只有 Herdr server，沒有 bridge。執行修正後 `./scripts/run.sh -r` 成功 build/link/open/move（exit 0），但後續讀取新 pane 回傳 pane_not_found，pane list 亦無 bridge。plugin log list 為空。
預期：plugin pane 維持執行並連上 Discord。
已確認根因：macOS 預設 `TMPDIR` 為 `/var/folders/.../T`（約 49 字元），加上 `herdr-discord-bridge-${key}.sock` 後路徑長度達到 115 位元組，超過 macOS POSIX `sockaddr_un.sun_path` 的 104 位元組限制，導致 `acquireInstanceLock` 於 `net.createServer().listen()` 時拋出 `EINVAL`，bridge 程序於啟動時立即 exit 1，Herdr 偵測到指令退出因而自動關閉 pane。先前直接以診斷程序執行成功是因為該子程序環境未帶 `$TMPDIR`（Node 預設回退至 `/tmp`，長度 71 位元組 < 104 位元組）。
修正：在 `src/instance-lock.ts` 中，若為 macOS (Darwin) 或 socket 路徑長度超過 104 位元組，使用 `/tmp` 存放 socket，確保長度維持在 71 位元組，避免 `EINVAL`。在 `test/instance-lock.test.ts` 加入長 `TMPDIR` 取得 instance lock 的回歸測試。同步 `SPEC.md` 的 macOS socket 路徑限制。
驗證（2026-09-21）：`npm run lint`、`npm run typecheck`、`npm test`（包含 `npm run build`）及 `/bin/bash -n scripts/run.sh` 通過；完整測試 93 項，92 通過、1 項 Linux 專用測試跳過、0 失敗。5 項 restart fixtures 全數通過，5 項 instance-lock 測試全數通過。
未驗證／下一步：未重啟或部署真實 bridge，未完成 Herdr／Discord 端到端驗收，未 commit／push；執行中的 bridge 仍為診斷直接程序，未確認載入新版或恢復 Herdr plugin pane 託管，舊訊息不補送。請於本機執行 `./scripts/run.sh -r` 驗收 Herdr pane 託管啟動與 Discord 連線。

## ISSUE-020：Phase 1 Durable Task Engine

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

Phase 1 當時未包含 Phase 2 question queue／blocked continuation；2026-09-20 已由 ISSUE-012 接續。仍無 journal retention／compaction／migration、跨 bot state-directory writer lock 或 durable Discord delivery retry。Windows rename／power-loss、真實 CLI session continuity、兩 Worker 取消、restart reconciliation、lazy start／reuse 與 conversation/attach/watch 需依架構文件 live 驗收。

原始碼與 build 已完成；本輪沒有部署／重啟使用者 Bridge，執行中版本未核對，舊任務／訊息不補送。Unit fixtures 不等於 Discord／Herdr／CLI end-to-end acceptance。ISSUE-010 的 durable 部分由本項接續，ISSUE-012 追蹤 Phase 2 與剩餘 live 驗收；ISSUE-014、015、016 live 狀態不因本轮 fixture 通過而改為已驗收。

### 2026-09-21 main 合併驗證（ISSUE-020／ISSUE-007）

使用者授權將 `origin/phase1-durable-task-engine`（`23cd8a2`）合併至 main（合併前 `9cd8ba8`）。保留 main 的 macOS Bash／socket 修正；Phase 1 原 ISSUE-018 與 main 重號，改為 ISSUE-020 並同步引用，既有 ISSUE-018／019 不變。

環境：Linux、Node.js v22.23.2，本機 checkout；預設 sandbox 因 bwrap loopback 權限錯誤無法啟動，改於允許本機 IPC 的執行環境驗證，未操作真實 Discord／Herdr session。

- `npm run lint` 通過（42 個 TypeScript 檔案）；`npm run check` 的 typecheck、build 通過。
- 完整測試 114 項：113 通過、1 失敗、0 跳過，check exit 1。Phase 1 的 21 項 durable engine 測試通過；唯一失敗為 ISSUE-007 的 real entrypoint duplicate-instance 測試，10 秒 timeout 後 exit code 為 null，預期 1。
- 單獨重跑 `node --test dist/test/instance-lock.test.js`：5 項中 4 通過、1 失敗，相同入口 timeout；未放寬 timeout 或修改斷言。這次不再受 socket EPERM 阻擋，但完整驗證 gate 仍未通過。
- `bash -n scripts/run.sh`、`git diff --cached --check` 通過；45 個文件相對連結均存在。

ISSUE-007 保持「重新開啟／待調查」：症狀與先前相同，啟動逾時的確切根因仍未確認，本輪沒有修正該問題。下一步調查入口 module startup／負載及逾時，再重跑完整檢查。ISSUE-020 保持「已修正、待驗收」，不將本次合併視為完整 gate 或 live 驗收通過。

本輪完成本機 main 合併提交；未 push、未部署或重啟 bridge，執行中版本未核對；舊任務／訊息不補送。使用者原有 README.zh-TW.md 未提交修改保留於合併提交之外。

### 2026-09-21 Phase 2 合併驗證（ISSUE-012／ISSUE-007）

使用者授權將 `origin/phase2-team-question-queue`（`90981c8`）合併至本機 main（合併前 `e5b2dab`）。保留 Phase 1 合併紀錄、ISSUE-020 編號與 main 的 macOS 修正；文件衝突依 Phase 2 questions/reply 契約整合，未改動功能分支的程式邏輯或測試斷言。

驗證環境：2026-09-21，Linux、Node.js v22.23.2、本機 checkout，可使用本機 IPC；fake Herdr／Discord fixtures，未對真實 CLI 送字。

- `npm run lint` 通過（43 個 TypeScript 檔案）。
- `npm run check` 的 typecheck、build 通過；完整 130 項測試：129 通過、1 失敗、0 跳過，exit 1。16 項 Phase 2 question tests 全數通過。
- 唯一失敗仍為 ISSUE-007：real entrypoint duplicate-instance 測試超過既有 10 秒上限，exit code 為 null，預期 1。先前 Phase 1 同日完整及單獨重跑已記錄相同症狀；本輪未重複單獨測試、未延長 timeout。精確根因仍待調查，不將完整 gate 記為通過。
- 55 個文件相對連結均存在；`git diff --cached --check` 通過。合併後 src/test/scripts 相對 Phase 2 分支只保留 main 的 instance-lock／restart macOS 修正及測試。

ISSUE-012 保持「已修正、待驗收」，ISSUE-007 保持「重新開啟／待調查」。下一步調查啟動逾時並重跑完整 gate；真實 Discord／console 兩 Worker 問答、session 更換、跨介面回答、cancel/restart 等仍需依 team-question-queue.md 驗收。Schema v2 可讀 v1，但舊 Phase 1 binary 不支援讀 v2；重啟不自動恢復舊 turn。

本輪完成本機 main 合併提交，README.zh-TW.md 原有未提交修改保留於提交之外。未 push、未部署或重啟 bridge，執行中版本未核對，舊任務／訊息不補送；自動化不代表 live 驗收。

## ISSUE-021：Phase 3 Session Handoff Runtime

更新日期：2026-09-21。狀態：重新開啟／待調查。合併驗證出現並行 verify/cancel 測試 ENOENT，單獨重跑仍失敗；詳見末尾。以下保留 2026-09-20 的實作與受限環境驗證歷史。

症狀／根因：既有 handoff 僅傳送有界 terminal output，session-handoff skill 尚未成為 runtime；缺乏持久 checkpoint、repository acceptance、ownership transfer 與 receiving receipt。原分期（2026-09-19）Phase 3 為 Session Handoff Runtime，Phase 4 為 Quota / Failover Manager。

修正：新增 handoff-evidence/store、session-handoff runtime 與測試；整合 main 指令／ownership guards、現有 runTeamTurn 與 bundled skill。保存版本化 after-image journal、derived HANDOFF.md、exact source session、原 goal、task artifacts、公開 evidence、repo HEAD／branch／staged／unstaged／untracked fingerprint。verify → accept → continue 明確分離；未知／失敗／restart 轉 blocked，無 automatic replay。Herdr legacy prompt fallback 改 retries=0，防止 acknowledgement 遺失後重複工作。完整契約見 [Phase 3](session-handoff-runtime.md)。

驗證環境：隔離 Linux Node runner、temporary Git repositories／state、fake Herdr／Discord；沒有呼叫真實模型或操作使用者 session。

- `npm run typecheck`、`npm run build`、`npm run lint` PASS（47 TS files）。
- 首批新測試 22/22；擴大後中途 103/104，唯一失敗是 fixture 以隨機檔案排序第一筆當成目前 checkpoint。改依 prompt 中 handoff ID 讀取正確 journal，保留「派送前已持久化」斷言。
- 最終 targeted：`node --test dist/test/session-handoff.test.js dist/test/team-questions.test.js dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js dist/test/agent-pool.test.js dist/test/console-conversation.test.js dist/test/local-agent.test.js`：**105/105**，含 **26 項 Phase 3 tests**。涵蓋流程、原子失敗、未知 schema、immutable fields、dirty bytes／HEAD／branch／index／nested cwd、session replacement、active Team／worker、錯誤 receipt、驗證期間寫檔、並行操作、restart quarantine、explicit export、Codex exact-ID／公開 channel filtering、context guard、legacy retry。
- `timeout --signal=INT 30s npm test`：build PASS；Herdr socket fixtures 失敗、instance-lock 等待無法自然完成，30 秒停止 exit 124，無完整總數。
- 完整限時 suite：`node --test --test-timeout=15000 dist/test/*.test.js` 最終 **154 項：148 pass、5 fail、1 cancelled**（exit1）；5 fail 為既有兩項 Herdr socket 與三項 instance-lock 的 EPERM，1 cancelled 為 killed-owner fixture 15 秒逾時。不能把限時 runner 或 targeted 等同完整 gate 通過。

限制／未驗證：只支援同機同 workspace／canonical Git tree；active Team 先結束／取消，不改 frozen roster。Codex native adapter 支援特定公開 event_msg；其他 CLI 為明確 public-export-v1／checkpoint fallback，不宣稱原生 DB 相容。Ignored files／submodule／外部資料與背景 writer 不在完整自動驗證範圍，submodule 明確拒絕。驗證提示不是 OS read-only sandbox，外部 writer 仍有競態。Phase 4 尚未於本 commit 實作；不改帳戶或憑證。

下一步：允許 IPC 的環境重跑 npm test，再依架構文件驗收 AGY/OpenCode、Codex/native fallback、quota 已耗盡、兩端版本／session、dirty preservation、真正 receiving receipt、cancel/restart。未部署／重啟使用者 Bridge，running version 未核對；fixture 不代表 live 驗收。

### 2026-09-21 Phase 3 合併驗證（ISSUE-021／ISSUE-007）

使用者授權將 `origin/phase3-session-handoff-runtime`（`d97c41b`）合併至本機 main（合併前 `51f2351`）。保留既有 macOS 修正與 Phase 1／2 驗證歷史；Phase 3 原 ISSUE-019 與 main 的 macOS socket 問題重號，改為 ISSUE-021 並同步引用。未修改功能分支程式或測試邏輯。

環境：2026-09-21、Linux、Node.js v22.23.2、本機 checkout、允許本機 IPC；使用 temporary Git repositories 與 fake Herdr／Discord，未操作真實模型／session。

- `npm run lint` 通過（47 個 TypeScript 檔案）。`npm run check` 的 typecheck、build 通過。
- 完整 156 項測試：154 通過、2 失敗、0 跳過，check exit 1。Phase 3 的 26 項測試中 25 通過、1 失敗。
- ISSUE-007 的 real entrypoint duplicate-instance 再次超過 10 秒，exit code null 而非 1；保留重新開啟／待調查，未更改 timeout 或斷言。
- Phase 3 `concurrent handoff verification and cancellation cannot race in-flight dispatch` 出現 unhandledRejection：HandoffStore.write 寫入臨時 journal 時 ENOENT，呼叫鏈為 SessionHandoffRuntime.block → HandoffStore.update/write。
- 單獨重跑 `node --test --test-name-pattern='concurrent handoff verification and cancellation' dist/test/session-handoff.test.js`：0/1 通過，同樣 ENOENT，exit 1。
- 55 個文件相對連結均存在，`git diff --cached --check` 通過。src/test/scripts 相對功能分支僅有 main 既有 instance-lock／restart macOS 修正及回歸測試。

預期：並行 verify 與 cancel 應被拒絕，第一個 verify 完成後才清理 fixture，不得有未處理拒絕或遺失 journal。已確認症狀是臨時 journal 路徑不存在；精確根因尚未確認。原測試以 100 次 10ms 輪詢等待 beforeReport，finally 會清除暫存目錄，後續需調查等待條件與未完成 verify 的清理順序；不能僅憑此推測宣稱 runtime 安全或已證實產品缺陷。本輪僅合併及記錄，未修改失敗測試或 runtime，不放寬驗收條件。

ISSUE-021 由已修正、待驗收重新開啟／待調查。下一步釐清並行測試 ENOENT、完成修正及完整 gate，再依 session-handoff-runtime.md 做實際 receipt／ownership／dirty preservation／cancel/restart 驗收。不得將本次合併視為完整自動化或 live 驗收通過。

本輪完成本機 main 合併提交；原 README.zh-TW.md 未提交修改保留於提交之外。未 push、未部署或重啟 bridge，執行中版本未核對，舊任務／訊息不補送。Phase 4 未納入本輪。

### 2026-10-01 Grok 工作期間再現（ISSUE-021）

狀態維持重新開啟／待調查。首輪完整套件的 concurrent verify/cancel 與 command
contexts 測試均於 fixture 清理發生 ENOTEMPTY（187 項中 2 fail）；
精確原因仍未確認，未修改 handoff 程式與測試。最新完整重跑結果見 ISSUE-023。

### 2026-10-02 coding 工作期間再次再現（ISSUE-021）

狀態維持重新開啟／待調查。本輪沒有修改 `src/handoff-store.ts`、`src/session-handoff.ts` 的寫入路徑，也沒有放寬 `test/session-handoff.test.ts`。`session-handoff.ts` 只沿用既有的 `sameTaskSession` import，與本次 ENOENT 無關。

環境：2026-10-02、Linux、Node.js v22.23.3、本機 checkout。`npm test`（`npm run build && node --test dist/test/*.test.js`）建置通過後 **206 項：205 通過、1 失敗、0 cancelled、0 skipped**，exit 1，duration_ms 224941。唯一失敗是 not ok 145：`concurrent handoff verification and cancellation cannot race in-flight dispatch`（`dist/test/session-handoff.test.js:265`，原始碼 `test/session-handoff.test.ts`），failureType `unhandledRejection`，`HandoffStore.write` 開啟 `/tmp/handoff-runtime-liGhJS/state/handoff-2b7c1f17-5210-4750-a729-d566f097f91b.json.8627767a-6279-41e8-b607-f89db75ecdc7.tmp` 時 ENOENT。呼叫鏈仍是 `SessionHandoffRuntime.block` → `HandoffStore.update/write`。

單獨重跑 `node --test --test-name-pattern 'concurrent handoff verification' dist/test/session-handoff.test.js`：**0/1 通過**，exit 1，duration_ms 15608，同樣 ENOENT，路徑改為 `/tmp/handoff-runtime-36BhUQ/state/handoff-40ac39ff-50dd-490a-9436-d77c88ef404b.json.17a7e832-d8b3-4711-9e59-50bd5d9e8af1.tmp`。與 2026-09-21 合併紀錄的症狀相同。精確根因仍未確認，本輪不修、不把完整套件記為通過。

## ISSUE-022：Phase 4 Quota / Failover Manager

更新日期：2026-09-21。狀態：已修正、待驗收；本機 main 合併後新增 28 項 Phase 4 測試通過，但完整 gate 因 ISSUE-007／021 未通過。以下保留 2026-09-20 的受限環境歷史；最新結果見末尾。

症狀／已確認根因：Phase 3 可明確交接，但沒有額度 observation registry、候選 policy 或從限額訊號到 checkpoint／驗證續作的協調層。不同 CLI 可能共用同一耗盡額度池；不能只按 CLI 名称或假設經過時間就有額度。

預期／修正：新增 `src/quota-failover.ts`，atomic schema-v1 quota/policy after-image journal、session-scoped TTL observations、ordered frozen候選、共享 budget group 衝突防護、來源 limited/exhausted report 自動 checkpoint。`failover run ... confirm-source-stopped` 選可用候選後串接 Phase 3 verify/accept/continue，成功更新目前 route。main／Discord／console 加入 quota/report/status、failover/arm/status/run/cancel；保持 context scope、active Team／ownership guards。Restart quarantine、先保存 intent、不明派送不重試／cascade。完整契約、命令與限制見 [Phase 4](quota-failover-manager.md)。

第一版使用操作者回報；沒有 provider API／背景 quota watcher，不推算百分比或 reset，也不改帳號／憑證。候選能力與 budget-group 歸屬由使用者確認；不能將本版描述為全自動 provider 額度偵測。

驗證環境：隔離 Linux Node runner、fake Herdr/Discord／clock、temporary state/Git；沒有呼叫真實模型或使用者 session。新 `test/quota-failover.test.ts` 27 項加 Phase 3 fixture 中 1 項完整串接，共新增 28 項。

### 自動化紀錄（2026-09-20）

- 中途 typecheck：測試誤用不存在的 `parseConsoleLine` export（TS2305）；改用既有 `parseConsoleCommand`，未改 parser 行為。
- 第一批 Phase 3/4：52/52 通過；後續補上 restart 保留 armed/ready、跨 Discord context 回報遮蔽及 workspace 限制。
- 最終 `npm run typecheck`、`npm run build`、`npm run lint` PASS（49 TypeScript files）。
- Targeted：`node --test dist/test/quota-failover.test.js dist/test/session-handoff.test.js dist/test/team-questions.test.js dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js dist/test/agent-pool.test.js dist/test/console-conversation.test.js dist/test/local-agent.test.js` **133/133 PASS**。
- 涵蓋：先持久化再副作用、unknown/stale/時鐘倒退、同 pool／衝突、來源已可用、候選換 identity／busy、ordered fallback、checkpoint失敗、quota 在 verify/accept 期间過期、停止聲明、並行 run/cancel、unknown delivery 不重送／不換第二個、原子保存失敗、schema/immutable fields、restart quarantine、command scope／route。整合 fixture 執行真正 SessionHandoffRuntime，檢查 receipt／ownership／两次目的地 prompt 與 dirty 檔案保留。
- 完整 compiled suite：`node --test --test-timeout=15000 dist/test/*.test.js` **182 項：176 pass、5 fail、1 cancelled**（exit 1）。兩項 Herdr socket fixtures、三項 instance-lock fixtures 因本機 listen EPERM／無法取得 lock 失敗，killed-owner fixture 15 秒逾時 cancelled。這次 build 與全套 runner 分開執行；沒有把限時套件稱為原始 npm test 通過。未修改受阻 fixtures。
- 本次程式／文件格式與 diff 檢查通過；新文件的本機連結均存在。

限制／下一步：在允許本機 IPC 的開發環境重跑原始 npm test，再依架構文件進行真實跨 CLI／quota／Discord scope／restart／ownership 驗收。額度觀察可能於下一次呼叫耗盡，不能保證 destination 有實際餘額；檔案改變需重新 checkpoint。Failover／handoff 分開 journal，崩潰邊界可能留下 orphan checkpoint 或最後狀態不同步，需人工查 evidence，不自動 replay。無 retention/compaction、跨程序 writer lock、provider-specific adapter、自動能力探測、mid-turn Team migration。Phase 3 的同機同工作樹、submodule 拒絕、ignored/external 不涵蓋與外部 writer 競態仍在。

原始碼／build 完成；未 merge main、未部署／重啟使用者 Bridge，running version 未核對，舊訊息／工作不補送。Fixture 不能當成 live 驗收；既有 ISSUE-007/014 等狀態不因此關閉。

### 2026-09-21 Phase 4 合併驗證（ISSUE-022／ISSUE-021／ISSUE-007）

使用者授權將 `origin/phase4-quota-failover-manager`（`f813a53`）合併至本機 main（合併前 `5f04a33`）。保留前輪 issue／驗證歷史與 macOS 修正；Phase 4 原 ISSUE-020 改為 ISSUE-022，避免與已合併 Phase 1 重號，所有引用同步。原始碼與測試邏輯維持功能分支內容。

開始解衝突與測試前，工具自動審核曾因額度耗盡拒絕整個指令；該次指令沒有執行。使用者確認 reset 並要求繼續後，重新核對 MERGE_HEAD、衝突與 README stash，再完成合併及檢查。

環境：2026-09-21、Linux、Node.js v22.23.2、本機 checkout／IPC、temporary Git repositories、fake Herdr／Discord／clock；未使用真實 CLI 或 provider quota。

- `npm run lint` 通過（49 個 TypeScript 檔案）；`npm run check` 的 typecheck、build 通過。
- 完整 184 項：181 通過、3 失敗、0 跳過，check exit 1。27 項 quota tests 與 1 項真正 SessionHandoffRuntime 串接 fixture 均通過（本輪新增 28 項）。完整 gate 未通過，不以 targeted 結果取代。
- ISSUE-007：real entrypoint duplicate-instance 再次超過既有 10 秒，exit code null 而非 1；沒有更改 timeout 或斷言。
- ISSUE-021：並行 verify/cancel 再次 unhandledRejection／ENOENT，HandoffStore.write 寫臨時 journal 時路徑不存在；延續 Phase 3 完整及單獨重跑結果。
- ISSUE-021 新增觀察：`command contexts restrict packets and replies, block normal prompts while ownership is held` 清理 `/tmp/handoff-runtime-*` 時 ENOTEMPTY。單獨重跑 `node --test --test-name-pattern='command contexts restrict packets and replies' dist/test/session-handoff.test.js` 為 1/1 通過、exit 0；不能抵銷完整套件失敗，確切根因仍待調查。
- 65 個文件相對連結均存在，`git diff --cached --check` 通過。src/test/scripts 相對 Phase 4 分支只保留 main 的 instance-lock／restart macOS 修正與測試。

ISSUE-021 的預期行為包含完成驗證後安全清理 fixture、無未處理拒絕；新增 ENOTEMPTY 的修正範圍本輪僅記錄，未改程式。下一步查明非同步工作與 fixture cleanup 時序及完整套件負載因素，並調查 ISSUE-007，再重跑完整 gate。兩項保持「重新開啟／待調查」，ISSUE-022 保持「已修正、待驗收」。Phase 4 依賴 Phase 3，因此不能因新增 fixture 通過宣稱整體 failover 已驗收。

本輪完成本機 main 合併提交，README.zh-TW.md 既有未提交修改保留於提交之外。未 push、未部署或重啟 Bridge，running version 未核對；舊訊息／工作不補送。provider watcher、自動 reset 等候與 live quota／跨 CLI／Discord 驗收未完成；實際功能仍以 operator observations 與明確 stopped-writer run 為準。

## ISSUE-023：Grok terminal adapter 相容性

更新日期：2026-10-01。狀態：已修正、待驗收。

症狀／預期：Grok 已回覆且 idle，但共用 turn receiver 逾時；Discord 通用 parser
無法擷取被縮略 prompt 後的回答。預期能取得本次回答並驗證隨機標記，不混入 UI 或歷史。
環境／重現：Linux，本機 Herdr `w2:p6`、Grok Build 1.0.46，畫面顯示 Grok 4.7 (high)。
透過 `runTeamTurn` 送出只回覆 GROK_ADAPTER_OK、禁止工具與修改檔案的 probe；
CLI 9.6 秒完成，接收器最終回報 `last state: idle; no verified completion`。
已確認根因：Grok prompt 顯示縮略；回答框每列有 `│`，首列有時間，begin/end 標記
被折行且混入 UI。原 `extractFrame` 僅容許標記間 whitespace，通用 adapter 無對應框線 parser。

修正範圍：cli-adapter 的 Grok 方框 parser；team-turn 僅在終端來源套用清理，
保持 nonce／identity／settled 檢查。同步 SPEC、README 雙語、CONTEXT。
測試歷史（2026-10-01）：初次 fixture 缺 tab_id，build TS2345；補齊後
`npm run build && node --test dist/test/cli-adapter.test.js` 為 2 pass／2 fail，
兩個失敗分別為空回答與 idle timeout，與 live 症狀相符。最終驗證待補。

限制／下一步：終端 parser 不讀 Grok session 檔。可攜交接見 ISSUE-017 的 2026-10-01 skill adapter，與本 parser 無關。不保證截斷框線／捲出內容／未觀察格式。
相同 baseline 回答保守忽略。尚未測試 Discord 交付、長文與 blocked 續答。
未重啟或部署 bridge、未 commit/push；執行中的 bridge 未載入本次修正，舊訊息不補送。

### 2026-10-01 第二種 live 格式與完整套件

第一版方框修正 targeted 4/4 通過；第二次真實 probe 回覆 GROK_ADAPTER_FIXED，
但仍 idle timeout。重新讀取顯示後續回合改為無框回答、首列時間與右側 `█` scrollbar。
已補上 user-message 邊界／空行／`Worked for` footer 限定的無框 parser，
不以整張畫面當回答。增加兩種 rendering 的 turn-level tests 與 incomplete/redraw guards。
中途 targeted 6/6 通過，新增雙 rendering 測試後最終結果另記。

首輪完整 `npm test`（含 build）187 項：185 pass、2 fail（2026-10-01）；
lint、typecheck 通過。兩個失敗屬 ISSUE-021：concurrent verify/cancel 清理 state
目錄 ENOTEMPTY；command contexts 清理 fixture ENOTEMPTY。保留重新開啟／待調查，
未調整 unrelated handoff 程式、timeout 或斷言。此輪執行期间追加無框 parser，
因此不能把首輪套件視為最終版本驗證；最終 gate 已另行重跑。

### 2026-10-01 最終 Grok 驗證

- `node --test dist/test/cli-adapter.test.js`：7/7 通過（含既有 Codex/OpenCode 2 項）；
  Grok 五項涵蓋方框／無框、折行 nonce、首行時間、ANSI、內文縮排、舊回答與不完整輸出。
- 已重播兩次實際 terminal capture。第三次以修正後 compiled `runTeamTurn` 對
  同一 `w2:p6` 發出禁止工具／改檔的 probe，得到
  `{ state: 'done', text: 'GROK_PARSER_PASS', terminal: true }`。
  這是 Herdr → Grok → Bridge receiver 的 live 驗證，不含 Discord delivery。
- 修改的 TypeScript Prettier check、文件相對連結檢查通過。此次新增差異 whitespace
  檢查通過；全域 `git diff --check` 仍報 README.zh-TW.md:49 使用者原有 trailing
  whitespace，保留未改。
- 原始碼與 build 已更新；執行中 bridge 未重啟／部署，未確認載入新版。
  Discord 交付、長文／截斷、blocked 續答仍待驗收，舊訊息不補送，未 commit/push。

最終完整 gate（2026-10-01、Linux Node.js v22.23.3）：`npm run lint`、
`npm run typecheck`、`npm test`（含 `npm run build`）全部通過；
完整 **189/189 pass，0 fail，0 skipped**。首輪 ISSUE-021 的兩項 ENOTEMPTY
本次未再現；因未調查或修正其根因，保留重新開啟／待調查與首輪失敗歷史，
不以一次全綠宣稱已修復。Grok 保持已修正、待驗收（Discord／長文／blocked 尚待驗收）。

## ISSUE-024：Herdr 重啟後 Grok 未自動恢復

更新日期：2026-10-02。狀態：待調查（已確認本機缺少 integration；尚未修正或完成重啟驗收）。

症狀：使用者回報 Herdr 關閉前執行中的 Grok 沒有隨重啟重新啟動。預期：有有效 native session reference 的 Grok pane 可恢复原對話；沒有 reference 時應明確說明只恢復 shell。

環境／證據（2026-10-02，Linux、Herdr 0.8.0）：

- `herdr integration status`：`grok: not installed`；Codex v7、Antigravity CLI v1 已安裝。
- `herdr agent list`：目前只有 Codex、agy，沒有 Grok。`herdr pane list` 與 `herdr pane read w2:p6 --source visible --lines 40`：原 Grok 所在 pane 保留，但畫面只有 shell prompt。
- 唯讀檢查 `~/.config/herdr/session.json`：w2:p6 對應 internal pane 6 只有 cwd，沒有 agent_session；Codex、agy 的 pane 有 exact session ID。沒有把私有 session 檔複製進 repo。
- Herdr server log：2026-10-01 09:21 UTC 曾辨識 pane 6 的 Grok；09:37 UTC server shutdown 時該 pane 收到 Hangup；2026-10-02 00:55 UTC 完成三個 workspace 的 layout restore，沒有新 Grok agent detection。時間為 UTC，對應台北 2026-10-02 08:55 啟動。

已確認原因：目前沒有 Grok 官方 integration，保存檔也沒有 Grok native session reference，因此不具備自動恢復條件。程序辨識（agent=Grok）與 session identity 回報是不同機制。[官方 session restore 文件](https://herdr.dev/docs/session-state/) 說明 Grok 需 integration v2 以上及有效 reference，以 `grok --resume <id>` 恢復；無有效 reference 時只恢復原目錄的 shell。當時是否另有自訂 hook、關閉前 reference 是否曾存在仍未取得證據，不推定其他 Grok pane 的個別原因。

修正範圍／下一步：尚未改原始碼或本機 integration。先安裝 `herdr integration install grok`，再核對 `grok sessions list` 的 exact ID、於原 pane 恢復對話，確認 `herdr agent get w2:p6` 回報 agent_session，才驗收下次使用者授權的 Herdr server restart。安裝 integration 本身不會補回已遺失的 Herdr reference，也不會重新啟動既有 shell 中的 Grok。

驗證與限制：本輪只執行上述唯讀 CLI、保存欄位與日誌核對，未建立重啟 pass/fail loop，未重現一次新的關閉／重啟；不宣稱修正或端到端驗收完成。只更新問題文件並檢查 diff，未改 Bridge source/build、未部署／重啟、未對任何 Agent 送字、未 commit／push；既有未提交修改保留。

## 2026-10-02 ISSUE-003／008：送出問題後立即停止回覆擷取

更新日期：2026-10-02。ISSUE-003 重新開啟／待調查，ISSUE-008 維持重新開啟／待調查。先前 source 修正與自動化紀錄保留，不當作本次 live 通過。

使用者症狀／證據：附圖 `.herdr-discord-bridge/attachments/message-F8GzI8/1.png` 已以圖片工具讀取。Discord 08:59 回應卡片標示 Codex、w2、w2:p4，並顯示 `Agent exited or session changed; response capture stopped.`；使用者回報「問完就沒等回應」。預期：有效 prompt 送達後持續等待本次回覆；同 session metadata 更新不可停止，真正替換不得轉發其他對話。

環境與核對：Linux、Herdr 0.8.0；running Bridge PID 7007，cwd 為本 checkout，entry 為 `dist/src/index.js`，main.js 建置時間為台北 2026-10-02 08:55:27。Herdr server log 00:59:34 UTC（台北 08:59:34）的 `agent.prompt` 回傳 ok。目前 `herdr agent get w2:p4` 回報 Codex working，session ID `01a0fa1d-bedf-7c41-80e0-7272f5f90e1c`。Bridge pane 另有 console selected Agent exited／session changed 警告，但未含時間與前後 identity，不能直接認定與這張 Discord 卡片相同事件。

已確認程式路徑：`streamAgent` 第一次輪詢前就記錄 initial identity；每輪比對 terminal、pane、workspace、agent kind、session kind/value，找不到相符 Agent 即編輯成附圖訊息並 return，後續 final 不再讀取或交付。`sameAgentSession` 已忽略 source metadata。尚未確認根因：缺當次 initial／current snapshot，無法分辨真正 session 更換、暫時缺失或其他不相符欄位；不以目前 Agent 存在證明當時 identity 未變。

驗證（2026-10-02）：`node --test dist/test/response-delivery.test.js` **6/6 通過**，包含相同 session metadata 更新仍送 final、真正 session／pane／terminal 更換停止、busy visible fallback。這是既有 build fixtures，沒有重現當次失敗，也不是端到端驗收。另執行唯讀 live agent／process-info／Bridge visible log／Herdr server log 與 build timestamp 核對。未建立能重播這次身分變更的 pass/fail loop。

修正範圍：本輪只重新開啟 issue 並補上證據，未改程式或降低 identity 驗收標準。下一步：確認使用者當時是否新建／切換 Codex session，取得一次停止前後的完整 identity diff；以該 trace 建立 streamAgent 回歸 fixture，確認根因後修正。若現有日誌無法取得 snapshot，需在下一次 live 重現加入有界 identity 診斷紀錄。

限制：沒有 build、部署、重啟、重送 prompt、操作其他 Agent 或 commit／push。執行中 Bridge 的出錯分支仍存在，舊回覆不自動補送。已有未提交文件修改保留；本輪文件 diff 檢查不等同 live 驗收。

### 2026-10-02 使用者補充與暫時 identity 缺失修正

使用者確認：沒有在送問前後手動 `/new`、resume 或切換對話；是今天開機後的對話，Herdr 曾重新啟動，Discord 使用原有 thread。`resolveContextAgent` 每次先依 thread pane mapping 查詢 live Agent；routing 不保存 session ID，因此沒有證據能將「舊 thread」列為直接原因。重啟後 metadata 回報時序仍需 live trace 確認。

回歸重現：新增 streamAgent 真實 seam，分別讓一輪 Agent 清單缺少原 Agent、或原 Agent 的已知 session 欄位缺失，下一輪恢復完整原 identity。`npm run build && node --test --test-name-pattern='temporary.*disappearance' dist/test/response-delivery.test.js` 修正前 **0/2 通過、2 失敗**（2026-10-02），同樣顯示 capture stopped 並提前 return。這確認原程式會把暫時缺失當永久退出；沒有當次 live snapshots，仍不能斷言是附圖唯一根因。

修正範圍：`src/main.ts` 的 Discord streamAgent 暫時缺失先等待最多 30 秒，在下一輪成功查詢判定逾時。期間不讀 transcript／terminal、不完成 settlement 或送 final；只有完整原 identity 回來才續接。已知不同 session ID、同 pane terminal 被替換，或同 terminal 移到別的 pane／workspace，立即停止。初始未知 session 不會自動採納後來的新 ID。卡片與程序 log 分別說明 identity 缺失逾時或明確替換；不重送 prompt、不自動綁定其他對話。SPEC／CONTEXT／雙語 README 已同步。

修正中驗證歷史：第一輪修正未追蹤同 terminal 的 moved pane，原 moved-pane fixture 因等待而 cancelled，結果 **4 通過、4 cancelled**，不是全通過。補上同 terminal 候選辨識後，`npm run build && node --test dist/test/response-delivery.test.js` **10/10 通過**（2026-10-02），新增四項涵蓋暫時 Agent／session 缺失後續接、30 秒逾時、缺失後出現真正 replacement；後兩者不得讀來源或送 final。完整 gate 尚在執行，結果另補。

狀態：ISSUE-003／008 維持重新開啟／待調查；上述可重現子缺陷已 source 修正、targeted 通過，但使用者本次環境的 identity 變化根因仍未確認。未部署／重啟執行中的 Bridge，running process 仍載入修正前程式，舊回覆不自動補送；沒有 commit／push。下一步完整 gate 後在載入新版的原 Discord thread 驗收，若再停止，依新的分支訊息取得前後 identity。

2026-10-02 完整檢查補記：`npm run lint`（49 TypeScript files）、`npm run typecheck`、`npm run build` 通過。`npm test` 首輪 **195 項、194 通過、1 失敗、0 cancelled、0 skipped**，總耗時 174 秒。首輪串流輸出有截斷，未保留唯一失敗的詳細內容，不能猜測是 ISSUE-007 或 ISSUE-021；已開始將重跑完整 TAP 保存於 `/tmp/herdr-bridge-full-20261002.tap`。另 `node --test dist/test/instance-lock.test.js` 單獨重跑 **5/5 通過**；`timeout 45s node --test dist/test/session-handoff.test.js` 在第 13 項之後達到人為 45 秒上限，exit 124，沒有完整結果，不將它當作新的已確認 handoff 根因或全通過。以上不涉及 running Bridge 或 live Agent 操作。

2026-10-02 最終驗證：`timeout 240s node --test dist/test/*.test.js` 使用本輪 `npm test` 建置的相同 dist，**195/195 通過、0 fail、0 cancelled、0 skipped**，exit 0，耗時 60.4 秒；完整 TAP 位於 `/tmp/herdr-bridge-full-20261002.tap`。lint、typecheck、build 已通過；兩個修改的 TypeScript 檔 Prettier check、文件相對連結與 `git diff --check` 通過。首輪 194/195 的失敗未再現且詳細原因未確認，保留失敗歷史，不宣稱修復它。暫時 identity 缺失子缺陷原 0/2 已變為 targeted 10/10；ISSUE-003／008 保留重新開啟／待調查，待驗收使用者實際重啟後的舊 Discord thread 情境及確切 identity 變化。原始碼／build 已更新；執行中 Bridge 未重啟／部署、未載入本輪程式，舊訊息不補送，未 commit／push。

### 2026-10-02 ISSUE-010：Coding 任務流程建議與現有約束差距

狀態沿用 ISSUE-010 的修正中／待驗收；本輪建議未定案、未實作。使用者要求保留 Lead 拆解與分派原則，評估 coding 流程，並提供分享連結；web open 兩次皆 cache miss，未取得內容，不假裝已讀。

靜態確認：`src/team-orchestration.ts` 的 AssignmentPlan 只有 id／workerPaneId／instruction／dependsOn；已有依賴、多輪與 wave 執行，但沒有結構化檔案寫入範圍／衝突檢查或以實際測試 exit code 驗證結果的 coding 結案規則。文件的同檔案不平行修改要求目前依賴 Lead／Worker 遵守。這是程式約束的缺口，沒有新的使用者衝突重現或已確認失敗。

建議範圍與下一步：先以指引試行 Lead → 分工實作 → 按需 review／驗證 → Lead 整合及多輪修正，再評估 plan schema 的寫入範圍／唯讀、交付物／驗收條件與 runtime 驗證；較後期才評估隔離 worktree。詳見 [未定案提案](coding-workflow-proposal.md)。待使用者提供分享重點後再比較，不將本建議當成已決定需求。

驗證（2026-10-02）：只讀設計／原始碼，檢查提案內容、連結與 diff；無新的程式行為變更，不重跑程式測試。未部署／重啟或對 Agent 派工，前輪尚未部署的回覆捕捉修正狀態不變。既有未提交修改保留。

### 2026-10-02 ISSUE-010：分享全文提供後的 coding workflow 比較

使用者已貼上原分享全文，先前缺少分享內容的條件解除；保留原 cache miss 調查歷史。採用方向：Lead 動態安排 troubleshoot／implement／PR／review／fix／verify，Role 與 Agent 分開，不加入 Bricks skill。提案未定案、runtime 未實作。

靜態確認 `TeamTaskStore` 現有 TaskState 及 `AssignmentPlan`：没有 coding stage、PR／SHA／CI artifact 或 reviewer session 獨立性欄位。建議保留 lifecycle，另加 coding stage／artifact；結案證據要對應目前 commit；Agent session 的獨立性與 GitHub actor 的 approval 權限分開。GitHub 官方文件確認作者不能 approve 自己的 PR、required checks 需對應最新 SHA。詳見已更新的 [完整提案](coding-workflow-proposal.md)與其中來源。

驗證（2026-10-02）：核對使用者原文、Team schema／scheduler、GitHub 官方 primary docs，检查提案相對連結、內容一致性與 `git diff --check`。純文件更新，沒有新程式測試或 runtime 行為變更；未安裝 skills、發 PR／review、commit／push、merge、部署／重啟，既有未提交修改與未部署的 capture 修正保留。下一步由使用者決定是否試行指引與 artifact 格式，再規劃 schema／GitHub 接入；不視為已授權實作或發布。

### 2026-10-02 ISSUE-010：改為本機 Git coding workflow

使用者要求流程針對本機 Git、不推 GitHub。最新提案已以本機 commit／diff 取代 PR、以 review report／本機 test log 取代線上 approval／CI，移除 GitHub 整合的必要階段；前述 PR 方案保留為歷史讨论，現行提案以 [本機 Git 版本](coding-workflow-proposal.md) 為準。

預期：Lead 仍拆解／分派／決定修正，可在沒有 remote／GitHub 的 repository 工作。支援 commit SHA 或未提交 diff 指紋的交接；untracked 不能漏掉，既有 dirty tree 保留。Review 與 test 綁定具體版本，修改後重新核對；沒有有效證據不能結案。需要的新 schema／gate／session 獨立性約束仍是提案，不是現成功能；ISSUE-010 狀態不變。

驗證（2026-10-02）：本輪純文件更新，核對內容、相對連結與 `git diff --check`，未重跑程式測試。只修改提案／CONTEXT 索引／本清單，不改 Team runtime 或實際設定；未 commit、merge、push、部署／重啟，所有原有修改保留。下一步先試行本機交付格式，若要程式支援再規劃並驗收 runtime；本輪不把設計提案當作已完成實作。

### 2026-10-02 ISSUE-010：本機 coding workflow 與既有 team ask 相容性

使用者詢問是否與目前流程矛盾。靜態核對確認概念相容，但直接套固定 pipeline 會衝突：空計畫進 synthesis 後 Lead 可改碼且沒有現成回派獨立 review 入口；將 review「需修正」標成 failed 會停止正常 replanning；結案目前依 synthesis 與 Assignment state，沒有當前 SHA／diff 的 review／test gate；跨輪 dependsOn 會被 validator 拒絕。這些是提案接入風險，不是本輪新重現的 runtime bug。

已補入 [相容條件](coding-workflow-proposal.md#與現有-team-ask-的相容條件)：保留單一 scheduler、一般零 Worker、多輪限制與 lifecycle；coding 規則只明確選用；review 執行狀態與 verdict 分開；結案前驗證版本與證據；跨輪以 artifact／finding reference 交接。首版建議 Worker 實作、不同 session review、Lead 只讀結案，Lead 直接實作再 review 的入口需另行設計。未定案、未實作，ISSUE-010 原狀態不變。

驗證（2026-10-02）：核對 runTeamTask／planningInstruction／synthesisInstruction／plan parser／validator 與 Task engine 結案分支，檢查文件連結及 diff。純文件補充，未改程式、未新增 CLI mode、未重跑測試、未部署／重啟／commit／push；既有修改保留。下一步若實作，需驗收 review findings 後正常重派、最終 Lead 不改碼、gate 不提前 completed、一般任務行為不受影響。

### 2026-10-02 ISSUE-012／010：本機 coding 實作任務因 question cap 中斷

Task：`task-f5b17ade-7cd6-484f-aebb-edc7a5612f1d`。ISSUE-012 重新開啟／待調查；ISSUE-010 本機 coding 功能實作中、未完成驗收。使用者已要求依提案實作，不再把該要求描述為只有提案討論。

症狀／任務回報：實作 Assignment `local-coding-implementation-01`（Grok w2:p6）failed，report 為空，blocker 為 `Team question limit reached; inspect/cancel task`。Reviewer Assignment `local-coding-independent-review-01`（agy w2:p8）因 dependency 未完成而 failed，沒有 review report。

已驗證證據（2026-10-02）：唯讀 task journal 最新 after-image 顯示 schema v2、task `blocked`、140 events、128 questions（127 stale、1 pending），128 個不同 fingerprint，全部來自同一 Grok session；首題 02:28:47 UTC、最後 02:42:23 UTC。Grok assignment turn 為 uncertain，Lead synthesis 為 dispatched。`herdr agent get w2:p6` 仍是 working；w2:p8 為 idle。不能將觀察失敗當成 Worker 停止，也不能聲稱 review 已執行。

已確認直接條件：onQuestion 在累積 questions >=128 時拋出上述錯誤；只在相同 fingerprint 或上一題 sending／unknown 時略過新題。128 題為何產生尚未確認，不將「畫面誤辨識 blocked」或「去重失效」當成已證實根因。未讀取／轉錄 question terminal snapshot 或模型 thought。

部分成果：工作樹新增 `src/coding-version.ts`、`src/coding-workflow.ts`、`test/coding-workflow.test.ts`，並修改 main／team-orchestration／team-task-engine／team-task-store；原始碼出現 `team ask --coding`、coding fields 與 schema v3 等實作。這只是部分改碼證據，沒有有效作者交付與獨立 review，不宣稱功能完成、編譯成功或現已可用。先前 195/195 是新增 coding 程式前的歷史結果，不能套用本次修改。

本輪驗證／限制：只核對 git status、部分 source 分支、journal 統計與 live agent identity；`git diff --check` 當次通過。Writer 仍工作，沒有接管產品碼、建置／執行完整驗收、發送新 prompt 或重派工作，沒有取消／停止任何 CLI。只維護本事件紀錄及設計文件狀態，保留所有既有與 Worker 修改；未 commit／merge／push／部署／重啟。執行中 Bridge 未載入本機 coding 修改。

下一步：先確認仍工作中的 Grok 的結果與 ownership，透過 task status／questions 查詢後依使用者授權處理取消或等待；釐清 question 辨識／fingerprint／cap 的重現條件。Writer 明確停止／完成後，取得可驗證交付版本、補完實作與 SPEC gate，再由 agy 獨立 review。未處理 uncertain turn 前不可重送原實作 prompt 或讓第二個 writer 同時改碼。

同一 Assignment 在上下文截斷後於本 session 續寫。上方「部分成果、writer 仍工作、沒有編譯成功」是截斷當下的觀察，保留不改寫。後續原始碼、測試與文件狀態以 ISSUE-025 為準。作者續作當時沒有改 `onQuestion`、沒有取消或重啟該 live task；後續 Lead 清理見下段，cap 仍未修正。

### 2026-10-02：作者晚完成、Lead busy 與舊任務清理

使用者回報 Grok 後來完成，但 Discord 再向 Lead w2:p4 提問得到 `agent is busy (w2:p4); wait for it to settle before assigning another prompt`。預期在既有 turn 完成並解除 task 占用後能接收新 prompt。已確認先前 synthesis 是 Bridge 在 question cap 失敗後派送，並不代表 Grok CLI 已停止；response transport 的 `BRIDGE_END` 也不控制 CLI idle 或 task reservation。

已確認程式條件：`assertAgentAvailable` 檢查 working／active stream；task engine 對 blocked task 保留 roster reservation，只有 completed／failed／cancelled 才釋放。舊 task journal 仍 blocked 並保留 uncertain turn。使用者該次 busy 訊息缺少精確時點的 agent／stream 證據，不能單憑字串判定是 reservation 或 working；Lead 在這輪檢查時確實仍 working。沒有證據把此事故稱為單純 timeout。

處理與驗證：確認 Grok w2:p6 同一已知 session 已 idle 後，透過執行中的 bridge console 執行 `team cancel task-f5b17ade-7cd6-484f-aebb-edc7a5612f1d`。Journal 確認 cancelled、turns 為 0，detail 為 `All task turns settled; no CLI session was closed.`，舊 task reservation 已解除；沒有關閉 CLI、刪除工作樹修改、commit／push 或重啟 bridge。作者完成後已接續 agy 唯讀獨立 review；此為舊 task 之外的交付核對，不把舊 failed assignments 改稱成功。

仍待驗證：question cap 的根因與修正、Lead 本輪 CLI settled 後 Discord 新 prompt 是否正常送達，以及 coding 的 live 驗收。原始碼測試與執行中 bridge 版本須分開判定。

後續複查另觀察到 agy 同一 session 的權限對話框（sha256sum 與 build／指定測試）仍被 Herdr 回報 idle；背景 Node 測試執行時也曾 idle。Lead 實際核對具體命令後，僅對原授權的唯讀雜湊／驗證單次確認，沒有永久變更 permission 設定；等待背景程序完成並取得正式報告後才判定 review 執行完成。此為已觀察到的狀態辨識限制，尚未修正，不能推定為 Grok 128 questions 的根因。下一步須分別重現 CLI approval UI 與背景工具的 status 偵測。

## ISSUE-025：本機 Git coding workflow 首版

更新日期：2026-10-02。狀態：已修正、待驗收。獨立 review 後曾重新開啟；版本漂移與重複 finding id 的修正見末段。以下首版測試結果保留為歷史，不能單獨代表漂移已修。

識別碼：ISSUE-025。對應任務 `task-f5b17ade-7cd6-484f-aebb-edc7a5612f1d`、Assignment `local-coding-implementation-01`。契約見 [提案實作狀態](coding-workflow-proposal.md) 與 `SPEC.md` 的 `team ask --coding`。

使用者可見症狀（實作前）：一般 `team ask` 沒有本機 Git 版本 gate。Review「需修正」若標成 failed 會停掉 replanning；結案只看 synthesis 與 Assignment state，不綁目前 SHA／diff。空計畫後 Lead 仍可改碼。

預期行為：`team ask --coding <prompt>` 才進入 coding。一般 team ask、零 Worker、以及 prompt 文字裡的 `--coding` 維持原指令解析。共用既有 scheduler、TaskState、blocked／cancel／restart，以及 8 輪 planning、每輪 16 個 Assignment、總計 64 個。首版單一 writer；diagnose／review／verify 為 read；review 必須是與所有 implement 作者不同的已知 session。Review 執行成功與 findings／verdict 分開；需修正時 Assignment 仍 done，Lead 下一輪用 artifact／finding reference 派工。版本改動、未處理 findings、驗證失敗或缺少證據不得 `task_completed`。未知 reviewer identity 不是獨立 review。Artifact 在工作樹外。任務開始前的 dirty baseline 只做雜湊快照，不還原工作樹。

已確認根因（設計，不是線上事故）：結案缺少對目前版本的 review／test gate；跨輪 `dependsOn` 不能引用上一輪。首版因此把 gate 放在 scheduler 結案之前，跨輪只接受 artifact／finding reference。

修正範圍：新增 `src/coding-version.ts`、`src/coding-workflow.ts`、`test/coding-workflow.test.ts`。接入 `src/team-orchestration.ts`、`src/team-task-engine.ts`、`src/team-task-store.ts`、`src/main.ts` 的 `--coding` 入口與 status。文件同步 `SPEC.md`、`README.md`、`README.zh-TW.md`、`CONTEXT.md`、`docs/coding-workflow-proposal.md`、`docs/durable-task-engine.md` 與本清單。Coding journal 寫 schema v3；一般任務新寫入仍是 schema v2。v2 帶 coding mode，或 v3 沒有 coding mode，載入時失敗。

設計取捨：不新增第二條 pipeline。Prompt 與 write scope 不是作業系統隔離，文件不宣稱已強制隔離。不同 pane 不是不同 session。Bridge 不重跑 Worker 回報的測試命令，只把回報的 exit code 綁到指紋。Ignored 檔與 submodule 不進指紋；submodule 直接拒絕。沒有本機 commit 當 base SHA 時無法建立 baseline。Lead 直接實作後回派 review、多 writer、worktree 隔離、GitHub 不在首版。

驗證（2026-10-02，Linux，Node.js v22.23.3，本機 checkout，fake agent／temporary git，沒有真實模型、沒有 commit／merge／push／GitHub、沒有重啟 bridge）：

- 修正 harness 計數、schema 檢查順序與測試讀檔路徑後，`npx tsc && node --test --test-name-pattern '...' dist/test/coding-workflow.test.js` 針對先前後五項失敗名稱重跑：**5/5 通過**，exit 0，duration_ms 77272。
- `npm test`：build／tsc 通過，接著 `node --test dist/test/*.test.js`。**206 項：205 通過、1 失敗**，exit 1，duration_ms 224941。Coding 測試在這次執行裡是 ok 21–31，**11/11 通過**，涵蓋一般任務相容、review findings 後重派、版本失效、untracked、既有 dirty 保留、同 session／未知 reviewer 拒絕、結案 gate、取消與重啟、artifact 讀取範圍、`--coding` 只在第一個參數生效、第二個 writer 與未知 finding reference 拒絕。
- 唯一失敗是既有 ISSUE-021：not ok 145 concurrent handoff verification ENOENT。單獨重跑仍 0/1。不是本輪 coding diff，未改該測試。完整套件不記為通過。
- `npm run lint`：`lint ok (52 TypeScript files)`，exit 0。
- `git diff --check`：exit 0（只涵蓋已追蹤 diff）。
- `npm run format:check`：exit 1。警告是 `src/attachments.ts`、`test/session-handoff.test.ts`、`CONTEXT.md`、`README.md`、`README.zh-TW.md`。前兩項不是本輪 coding 修改。後三項在本輪之前已有未提交修改，本輪又補了 `--coding` 說明；沒有對這五個檔執行 `prettier --write`。本輪新增的 coding TypeScript 不在這份警告名單。隨後只對 `docs/known-issues.md` 與 `docs/coding-workflow-proposal.md` 執行 `prettier --write`，索引表對齊有跟著改動。

未驗證：執行中的 bridge 未重啟、未載入這份原始碼。沒有 Discord／Herdr／CLI 端到端驗收，沒有對真實 dirty repository 做 live `team ask --coding`。ISSUE-012 question cap 未修。未 commit、未 push。

下一步：獨立 reviewer 核對 diff 與測試證據。使用者授權後才 commit。重啟 bridge 後，用新的 `team ask --coding` 做 live 驗收：單一 writer、不同已知 session 的 review、版本改變不得結案、既有 dirty 檔保留、一般 `team ask` 行為不變。舊訊息與已 blocked 的 live task 不補送。

### 2026-10-02 獨立 review 後重新開啟：read-only turn 期間版本漂移

agy 初次 review 後，Lead 以真實 engine fixture 補查，agy 亦獨立重現並將 verdict 改為 changes_requested。已確認 `onAssignmentStart` 未記錄 read-only assignment 開始版本，`onAssignmentDone` 直接把結果綁到結束時指紋；因此第二輪 review 期間改動 `added.txt`，回報 pass 後 verify 新版，task 仍 completed。這不是只靠 prompt 強制唯讀的問題，而是證據綁定缺少開始／結束版本核對。

Lead 重現命令（2026-10-02）：`node --test --test-name-pattern 'coding review findings are replanned' /tmp/herdr-readonly-version-repro.mjs`，以既有 compiled fixture、臨時 Git repo 注入第二次 review 改檔，**0/1 通過、exit 1**，斷言「不得 completed」但實際 completed。重現只寫 `/tmp`，沒有修改產品碼。agy 重現腳本 `/tmp/repro-version-drift.mjs`；其報告位於 `/tmp/herdr-local-coding-review-agy.md`。報告中列出的 `dist/test/team-task-store.test.js` 在本 checkout 不存在，所稱 35/35 回歸結果尚無可核對輸出，不採用為已驗證證據，已要求 reviewer 更正。

Reviewer 後續補上實際 stdout 並更正範圍：35 項由 orchestration 14 項、engine 21 項組成，Store 經 engine／coding fixtures 間接覆蓋；不存在獨立 store 測試檔。此為漂移修正前版本的 review 證據，不替代修正後複查。

已回派原唯一 writer Grok：先加正式紅測試，再補 read-only start／end fingerprint gate；漂移不得留下可接受的 pass、解決 findings 或完成 task。另要求處理跨 review 重複原始 finding ID 的 assignment failure，保持 findingRefs 可追蹤。尚在修正，待新版本獨立複查；不把初次 11/11 當成版本漂移已修正，不宣稱 live 驗收完成。

Lead 修正中獨立核對（2026-10-02）：確認 `dist/src/team-task-engine.js` 已包含 `readonlyStarts`／`settleReadonlyVersion` 後，以上 `/tmp` engine 重現 **1/1 通過、exit 0**（duration_ms 45861），確認第二次 review 改檔後 task 不 completed，review artifact 為 inconclusive。先前在作者建置完成前啟動的重跑仍讀到舊 build 並失敗，未把它當成新版本修正失敗。作者尚未完整交付，其他測試與 agy 新版本複查仍待完成。

### 2026-10-02 修正交付：read-only 起迄指紋與 finding id

狀態改為已修正、待驗收。上一段「尚在修正」是回派當下的紀錄。根因是 review／verify 的結論被綁到 turn 結束時的指紋。diagnose／review／verify 現在在 `onAssignmentStart` 保存開始指紋，`onAssignmentDone` 用 `settleReadonlyVersion` 比對結束指紋。漂移、缺少開始指紋，或 review 對不上實作 artifact 時，artifact 仍寫到工作樹外並保留 `reportedVerdict` 與 `driftReason`；有效 verdict 為 inconclusive，verify 的 `verificationPassed` 為 false。Pass 不會改貼到開始或結束指紋，漂移報告不新增、不解決 findings，gate 理由包含 `read-only version drifted`。同輪 writer 與其餘 assignment 仍必須有依賴，未依賴會在派工前失敗。重複 finding 原始 id 保留第一筆，其後存成 `assignmentId:id`；`findingRefs: ["f1"]` 仍指向第一筆。沒有擴充「沒有 implement artifact 的純 review」。

紅測試（修正前，Node.js v22.23.3，`npx tsc` 後）：`node --test --test-name-pattern 'read-only review drift|verify drift and an earlier pass|repeated raw finding ids|writer round cannot overlap' dist/test/coding-workflow.test.js`。**4 項：1 通過、3 失敗**，exit 1，duration_ms 69081。review drift 實際 `completed`；verify drift 沒有 `driftReason`；第二輪相同原始 id `f1` 使 `rev-b` 為 failed。同輪重疊那項已由既有 validator 拒絕。

修正後同一環境、工作樹建置（不是新 commit）：

- 先前後五項名稱再加 happy path：`npx tsc && node --test --test-name-pattern 'read-only review drift|verify drift and an earlier pass|repeated raw finding ids|writer round cannot overlap|coding review findings are replanned' dist/test/coding-workflow.test.js`。**5/5 通過**，exit 0，duration_ms 145074。
- `npx tsc && node --test dist/test/coding-workflow.test.js dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js`：**50/50 通過**，exit 0，duration_ms 241542。其中 coding 檔為 ok 1–15。本 checkout 沒有 `dist/test/team-task-store.test.js`；store 行為由 coding journal 與 engine seam 覆蓋。
- `npm run lint`：`lint ok (52 TypeScript files)`，exit 0。
- 上述修改過的 TypeScript 與本輪相關 Markdown `prettier --check` 通過。`git diff --check` exit 0。
- 本輪沒有重跑完整 `npm test`。上一輪完整套件仍是 **206 項：205 通過、1 失敗**，失敗是既有 ISSUE-021 concurrent handoff ENOENT。不把本次 50/50 當成完整套件通過。

未驗證：bridge 未重啟、未載入這份程式。沒有 Discord／Herdr／CLI live `team ask --coding`。未 commit、未 push。ISSUE-012 question cap 未修。下一步是另一個已知 session 的獨立複查，以及使用者授權後的 live 驗收。

### 2026-10-02 修正後獨立複查完成

agy 同一已知 reviewer session 已交付 `/tmp/herdr-local-coding-rereview-agy.md`，execution done、原始碼 review verdict pass。獨立執行 `npm run build && node --test --test-name-pattern 'read-only review drift|verify drift and an earlier pass|repeated raw finding ids|writer round cannot overlap' dist/test/coding-workflow.test.js`：**4/4 通過**，duration_ms 58291；另以指定 name pattern 執行 Lead 的 /tmp engine 重現 **1/1 通過**，duration_ms 28234。六個核心 source 檔案的開始／結束 SHA-256 一致。Lead 補充規格／提案，明載任務歷史保留 review／verify drift 時 gate 採保守失敗，後續 pass 不解除；正常 changes_requested 可同任務修正。

Reviewer 報告的「Pass / Accepted」僅採用為原始碼 review 通過，不改成 live 已驗收。狀態保持「已修正、待驗收」。已知限制：開始／結束指紋無法發現中途改檔後完全還原；coding stage 顯示不是結案 gate 的替代。Bridge 未重啟、原始碼未部署，question cap 與 ISSUE-021 未修；完整 suite 沒有修正後的新結果。Lead 修正後 lint（52 TypeScript files）、相關文件 Prettier 與 diff 空白檢查通過。此輪保存所有未提交修改，沒有 commit／merge／push。

## ISSUE-026：Claude adapter 相容性與身分限制

更新日期：2026-10-05。狀態：已修正、待驗收。環境：Linux、本機 checkout，Claude Code
2.1.289。工作開始 `git status --short` 為空；除使用者要求的 Claude 短互動測試外，未操作其他 Agent pane。

症狀／預期：新加入的 Claude 被 Herdr 辨識，但 bridge 模型選單列 GPT，
通用 parser 在多行 prompt 可能傳出 banner／prompt／footer，且同一歷史回答
重繪時可能再擷取。預期模型指令符合 Claude；只傳送本次 scope 的可辨識
文字，缺失明示，不以 fixture 當 live final。

重現與根因：Claude 沒有 adapter 分支，modelOptionsFor fallback 為 GPT；
MarkerCliAdapter 完整 prompt 字串不支援兩欄 continuation，且 prompt 分支
沒有 baseline 去重。2026-10-05 `npm run build && node --test
 dist/test/cli-adapter.test.js`（命令實際不含換行）：build 通過，13 項中
8 通過、5 失敗，exit 1。失敗涵蓋 Claude 模型選單、多行回覆、舊回答／UI、
baseline 與 normalization；此為新測試對修正前 build 的結果。

修正範圍：`src/cli-adapter.ts` 新增 Claude adapter 與共用 terminal 清理；
`test/cli-adapter.test.ts` 合成 fixture 覆蓋多行／空行、code indentation、
重繪與不同 turn、overlap 缺失、工具結果區塊與折行 nonce 接收。模型 aliases
與 `/model` 參考 [Claude 官方模型設定](https://code.claude.com/docs/en/model-config)
及 [官方 Help Center](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)，
不固定 alias 版本、不聲稱帳號所有模型可用。

安裝前實測證據為唯讀 `agent.list`／`agent.read visible`：`w2:p8`、kind `claude`、
idle；畫面顯示 v2.1.289、`❯ /model`、`⎿ Set model`、兩欄 continuation 與
底部輸入區。該階段未擷取真實 assistant answer，當時回答 fixture 是合成的；安裝後 live 證據見下段。
當時 Herdr 未回報 `agent_session`；使用者後來指出 integration 尚未安裝，安裝後 metadata 已恢復（因果由安裝前後觀察支持，未另稽核 hook 安裝細節）。Bridge 不猜 `.claude`
最近 session，不能承諾 coding reviewer、handoff／failover 接受此 pane；
同 terminal 的無 metadata restart 不能可靠辨識。Claude 圖片交付原被既有
allowlist 拒絕；2026-10-05 已將 claude 加入 allowlist（使用者回報 Discord 上傳圖片顯示「此 Agent 尚未支援本機圖片交付」），待實機驗收 Claude 是否能讀取附圖；native transcript adapter 仍未擴充。

2026-10-05 驗證：`npm test`（build＋220 項）220/220 通過；另以 `claude -p` 在暫存 cwd 的 `.herdr-discord-bridge/attachments/message-x/1.png`（含紅方塊、藍橢圓與文字 K7Q-93 的合成 PNG）使用與 bridge 相同的附圖提示，Claude 正確描述顏色、形狀並讀出 K7Q-93，證明 Claude 能真實辨識本機路徑圖片。未驗證：Discord 實際上傳經執行中 bridge 到 Claude pane 的端到端流程（bridge 未重啟）。

2026-10-05 重新開啟（使用者實測）：Discord 送圖後 bridge 已把文字轉到 Claude pane（w1:p1E），但訊息停在輸入框、未送出，Claude 無動作。根因（已重現）：Claude Code 把貼上的本機圖片路徑轉成 `[Image #n]` 附件，`agent.prompt` 的 Enter 偶爾被吞掉（測試 pane w2:p9 首次貼上同樣重現；之後 4 次未重現，屬間歇性，觸發條件未確認）。修正：`HerdrClient.submitStuckImagePrompt` 於 Claude 附圖 dispatch 時背景輪詢最多 15 秒，若輸入框（最後兩條分隔線之間）仍有 `[Image #n]` 且 Agent 未 working，補送一次 Enter（`hasPendingImageInput` 有單元測試）。驗證：對實際卡住的 w1:p1E 執行該方法，回傳 true、訊息送出並開始處理；`tsc`／新增 2 項單元測試通過。未驗證：重啟後的 bridge 端到端 Discord 流程；完整 `npm test`（2026-10-05，222 項）220 通過、2 失敗，失敗為既有 handoff ENOENT 競態（session-handoff.test，已列於本檔；同日稍早一次為 220/220），與本修正無關；lint 通過。

2026-10-05 第二次實測（使用者 Discord 截圖）：圖片已送達並由 Claude 處理（pane 顯示完成並回覆），但 Discord 顯示「finished — capture incomplete／Bridge could not capture its final response」。根因（由截圖與程式碼確認）：Claude 輸入框回顯為 `[Image #3] [Image #4]1.png …` 且省略路徑行，`claudePromptTail` 與送出的 prompt 比對失敗，回覆被判為不屬於本輪而丟棄。修正：比對時兩側皆去除 `[Image #n]` 與附圖路徑行（`src/cli-adapter.ts`）；新增回歸測試，修正前失敗、修正後通過。驗證：`npm test`（2026-10-05，223 項）222 通過、1 失敗（既有 handoff ENOENT 競態）；lint 通過。未驗證：重啟後的 Discord 端到端回覆擷取；該次已遺失的回覆無法補送。

驗證：最終 build／targeted／lint／typecheck 已完成，詳細命令與結果見下段；完整套件仍有既有失敗。
原始碼已修改，執行中 bridge 未重啟／未確認載入新版，未部署、未 commit／push。
新測試不算 Discord／Herdr／Claude 回覆端到端驗收；舊訊息與舊任務不補送。

下一步／未驗證：完成自動化檢查後，於授權重啟後用新文字 prompt、多行／
長回答、blocked reply、完整 Team 任務與 model picker 做 Discord live 驗收；
需要已知 session 的進階流程仍須分別驗收。安裝後已知 session 與 marker
短互動證據見下段。

### 2026-10-05 使用者安裝 integration 後重試

使用者明確要求安裝 Herdr Claude integration 後重試；`HERDR_ENV=1` 驗證
通過，依 Herdr skill（`/home/jones/.agents/skills/herdr/SKILL.md`） 的 agent prompt／
read 流程測試，不改 pane 拓樸、不切換模型、不使用工具／不讀寫專案。
Claude `w2:p8`（同 workspace）已回報 `agent_session.kind=id`；短測試前後
session ID 一致。上段無 metadata 是安裝前紀錄，不代表目前仍缺失。

真實共用 turn：以 built `HerdrClient` 與 `runTeamTurn` 發送一次短 token
prompt，回傳 `{"state":"done","text":"CLAUDE_BRIDGE_OK","terminal":true}`。
這證明 marker 接收器的 Herdr→Claude→read→capture 短互動成功，沒有建立
完整 Team 任務或透過執行中 bridge／Discord。可見回答使用 `●`，兩欄 gutter，
`✻ Cogitated for 6s` footer。暫存 raw snapshots 在 `/tmp/claude-bridge-live-*.txt`，
不提交 runtime state。

一般 prompt 另送一次只回答 `CLAUDE_SINGLE_OK` 的中文請求；Herdr 回傳 idle
與同 session，Claude 正常回答，但 `latestAgentResponse` 回傳空字串，檢查
腳本 exit 1。已確認根因：視窗在「工具／，也」之間軟折行，原 prompt 沒有
空白，adapter 卻強制把每次換行當成一個空白；故比對失敗。回放來源為
`/tmp/claude-bridge-single-output.txt`；新回歸保留觀察到的中文行與 `●` 格式，
另測英文單字中間折行及更改文字不得比對成功。

修正只將「顯示列邊界」匹配為可選空白，每列字元仍核對；不把所有 prompt
空白刪除。修正後已回放同一份 live 回答並驗證一般 adapter，最終 build／
回歸結果見下段。前次完整測試被使用者訊息中斷，沒有總結，不算套件通過。
初步修正 targeted `npm run build && node --test dist/test/cli-adapter.test.js`
13/13 通過（1374 ms），不包含後來的中文字內折行、工具 heading echo 和
Discord seam 新測試；`npm run typecheck`、`npm run lint`（52 TS files）先前
通過，但字內折行修正後仍須重新驗證。

### 2026-10-05 完整檢查再次重現既有 ISSUE-007／021

環境：Linux、Node.js v22.23.3，本機 checkout；不是執行中的 bridge 測試。
`npm test`（log `/tmp/claude-adapter-npm-test-final.log`）：build 通過，
**219 項：217 通過、2 失敗、0 skipped**，exit 1，duration_ms 226571。
此 build 在中文字內折行最終修正前啟動，未包含後加的一項字內折行測試；
其結果不能當最終版本完整套件全通過。Claude adapter／Discord seam 新測試
在這份結果通過，兩項失敗均對應已追蹤的症狀：

- ISSUE-007（更新 2026-10-05，保持重新開啟／待調查）：
  `the real entrypoint rejects a duplicate before contacting Herdr or Discord`
  約 10.5 秒 timeout，actual exit code null，預期 1；根因仍未確認，未改
  instance lock、入口或 timeout。下一步調查 startup／負載與原門檻。
- ISSUE-021（更新 2026-10-05，保持重新開啟／待調查）：
  `concurrent handoff verification and cancellation cannot race in-flight dispatch`
  unhandledRejection／ENOENT，HandoffStore.write 的臨時 state journal 不存在；
  與先前症狀一致，精確 async／cleanup 根因未確認，未改 handoff runtime
  或測試。下一步修正並重跑該 seam／完整套件；不宣稱 live handoff 已驗收。

一般 adapter 的 source 回放已確認 `CLAUDE_SINGLE_OK`，相同畫面 baseline
回傳空字串，exit 0。回放使用 TypeScript transpileModule 讀取最終 source
並 import 現有 format module，不等同完整 tsc；最終 build／回歸另列。

### 2026-10-05 最終交付與驗收範圍

狀態：已修正、待驗收。最終 source 已編譯，Linux／Node.js v22.23.3：

- `npm run build && node --test dist/test/cli-adapter.test.js dist/test/model.test.js dist/test/response-delivery.test.js`：build 通過，**30/30 通過**，exit 0，duration_ms 10869；包含中文字內折行、tool marker echo 拒絕與 Discord fallback 去重／缺失標示。
- `npm run typecheck`、`npm run lint`：exit 0，lint 為 52 TypeScript files。
- 最終 `dist/src/cli-adapter.js` 重播 `/tmp/claude-bridge-single-output.txt`，斷言新回答為 `CLAUDE_SINGLE_OK`、相同 baseline 為空：exit 0，`BUILT_LIVE_CAPTURE_REPLAY_OK`。不是再次送 prompt，也沒有重送舊 Discord 訊息。
- 本輪修改 TypeScript 與 Markdown 的 Prettier check、`git diff --check` 通過；文件連結人工核對，沒有提交 private config／token／raw runtime snapshot。
- 完整套件只有上段 **217/219** 的結果（中文字內折行最終修正前 build）；最終版沒有再次重跑完整 suite，不把 30/30 當完整 gate 通過。ISSUE-007／021 維持待調查，本輪未修。

已驗證範圍：真實 Herdr integration 的 session 身分、一次無工具的 marker
短回答，以及另一次普通短回答的擷取回放。這不代表完整 Team／coding／
handoff／failover、長回答、approval 或 Discord delivery 已驗收。
執行中 bridge 未重啟／未確認載入新 build，未部署、未 commit／push。下一步
在授權重啟後以新 prompt 驗收 Discord 模型選單／回覆、blocked 問答與完整
Team 任務；圖片本機路徑交付已加入 allowlist，仍待 Discord 端到端驗收；沒有 native Claude transcript reader。
