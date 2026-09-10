# Known Issues

維護規則見 [AGENTS.md](../AGENTS.md)。最後整理：2026-09-10。

| ID | 問題 | 狀態 | 下一步 |
| --- | --- | --- | --- |
| ISSUE-001 | Discord reply 未觸發 bridge | 重新開啟、待驗收 | 重啟後在 mapped thread 回覆 bot |
| ISSUE-002 | Discord 圖片未交付 Agent | 重新開啟／待調查 | 取得格式驗證失敗的原始附件與 metadata，重播下載 |
| ISSUE-003 | 預覽與 final 未更新 | 已修正、待驗收 | 重啟後驗證 metadata 更新與截圖情境 |
| ISSUE-004 | Team 成員可跨 workspace 混入，且 stale mapping 容易造成誤解 | 已修正、待驗收 | 重啟後確認同 workspace 限制、持久化與 stale 顯示 |
| ISSUE-005 | 本機 current 顯示未選取 Agent | 已修正、待驗收 | workspace selection 回歸修正後須重新驗收；先前 shared-thread 驗收歷史保留 |
| ISSUE-006 | 重啟 bridge 後 pane 所屬 workspace／位置改變 | 已驗收 | 2026-09-10 live topology 驗證完成；後續觀察重啟保留 |
| ISSUE-007 | 程序啟動未阻止同 bot 重複實例 | 已修正、待驗收 | live 第二實例拒絕仍待驗收 |
| ISSUE-008 | Discord current／回應仍引用 Herdr 已不存在的舊 pane，且串流回報 session changed | 重新開啟／待調查 | 取得該 Discord thread 的 current 輸出與 bridge 啟動版本；重啟新版後以 live prompt 重現 |
| ISSUE-010 | 1:1:N orchestration、Discord mirror 與選擇 UI | 待調查 | 本機單 Agent snapshot 已另實作；完整功能仍待做 |
| ISSUE-011 | 選取 agy 後 bridge 沒顯示追問、無法回答 | 已修正、待驗收 | 本機快照／blocked reply 自動化完成後進行 live agy 驗收 |
| ISSUE-012 | Team 多 Agent 同時追問缺少問題識別 | 待調查 | 設計 task/assignment/question 綁定與回覆 UI／排隊策略 |

2026-09-09 自動化驗證：`npm run check`（typecheck、build、33/33 tests）、`npm run lint`、`git diff --check` 通過。這是前一輪程式驗證紀錄，不代表已做 live Discord 驗收。本輪僅整理文件，未重跑程式測試。
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

更新日期：2026-09-10。狀態：已修正、待驗收。
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

更新日期：2026-09-10。狀態：待調查／規劃中。

需求：實作 1 位使用者對 1 個 Lead 與 N 個 Team Participant 的任務討論與執行；同步研究 Herdr 端是否有可點選的 Agent／workspace 選擇介面；以實際任務驗證 Codex／agy，包含 agy 需要向使用者追問或等待回覆的情境，所有失敗與互動中斷都要記錄。

目前狀態：`docs/team-orchestration-spec.md` 與 `docs/team-orchestration-plan.md` 是規格／計畫，repo 尚未實作 task planner、Assignment lifecycle、bounded report、synthesis、task recovery 或 task-level UI。`docs/pending-features.md` 的 Herdr pane → Discord mirror 也仍是規劃中，尚未有 MirrorRoute、output watcher 或去重 relay。

Herdr 能力調查（2026-09-10）：已安裝 CLI 提供 terminal TUI 與 `agent list/get/read/focus/prompt/wait` 等 API；目前未發現 bridge 可使用的瀏覽器式 GUI 或自訂 Agent select widget。若要提供可點選選擇，候選位置是 Discord button/select menu，或使用 Herdr 既有 TUI focus；兩者不能混稱為 Herdr GUI。

未驗證：1:1:N 實際 dispatch、Lead plan、N 個 Assignment、agy blocked／追問／使用者回覆、mirror 去重與 Discord 失敗恢復、任何點選選擇介面。下一步先確認選擇介面放在 Discord 還是 Herdr TUI，再分階段實作 orchestration、mirror、互動測試與驗收紀錄。

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

修正：新增 ConsoleAgent，選取即顯示 bounded visible snapshot，輪詢文字／狀態變化、切換丟棄舊 read；回答綁定已顯示 blocked 畫面與 pane/terminal/session/state sequence，送出前重驗；回答不重試不確定 socket 送達，同一問題拒絕重複回答。idle/done 可送新 prompt，working/unknown 仍可操作控制指令。保留輸入內容、重畫 readline 正在編輯的行；source=console 不因共用 thread 而遺失。修正本機 workspace/current 選取及 help，Codex 保留既有 final 擷取。本機假 guild routing 排除在 Discord watcher destination 外。

限制：40 行／6,000 字元快照不代表完整 transcript 或完整 final；沒有讀取隱藏 reasoning record。缺少 session metadata 的同 terminal restart 無法完全辨識；Herdr 目前沒有原子 question-ID 比較後送答 API。agy 特定版本的狀態偵測、只支援方向鍵的 UI 尚待 live 驗收。未確定送達的回答須人工檢查 Agent，不自動重試。

驗證（2026-09-10）：本次 `local-agent.test.js` 的 13/13 項針對性測試通過，涵蓋選取後 current、無須 ask 即顯示各狀態畫面、blocked 回答與下一個問題、問題變更／重複回答拒絕、切換途中不顯示或回答舊問題、working／blocked 控制指令、授權與 session 更換。typecheck、build、lint 與 `git diff --check` 通過。這些是 fixture／handler 驗證，不是 live agy 驗收。

另記非本次互動範圍的檢查結果（2026-09-10）：完整 `npm run check` 為 59/60 通過，ISSUE-007 的入口程序測試達 10 秒逾時，exit code 為 null 而非預期 1；未調整斷言或延長 timeout。單獨重跑 `node --test dist/test/instance-lock.test.js` 為 4/4 通過，逾時根因尚未確認。後續完整重跑被使用者中斷，無完成結果，不列為通過；依使用者要求停止擴大測試範圍。

本輪未重啟／部署、未 commit／push；執行中 bridge 是否載入本輪程式未驗證，舊互動不補送。下一步載入新版後在 bridge 執行 agent use <agy-pane>，驗證當前畫面、進度、blocked 問題、回答、恢復；在 working 與 blocked 分別執行 current／agent／切換，確認可操作且目標正確。live 驗收需記錄 Herdr／agy 版本及畫面證據。

## ISSUE-012：Team 多個 Agent 同時提問的回覆識別

更新日期：2026-09-10。狀態：待調查。

預期／待驗收場景：team ask 下多個 Agent 同時提出不同問題，bridge 必須清楚顯示是哪個 workspace／task／assignment／Agent／question，使用者回覆只能送給所選問題。現有 thread 級 approval 或單一 active Agent 不能證明此流程安全；目前未進行 live 多 Agent 重現，屬已識別設計缺口。

已確認限制：目前無 task/assignment/question 級的回覆佇列與選擇 UI。本輪只實作單一選取 Agent 的本機問答，不更動其他 Agent 狀態。是否暫停其他輸出、允許多問題排隊、由 Lead 代收、跨介面同時回答的互斥與逾時取消，均需後續設計。

修正範圍：本輪僅記錄，未實作 Team 問答。驗證：文件及現有流程盤點；沒有自動化或端到端通過證據。下一步建立兩 Agent 同時 blocked 的 fixture、問題識別／明確 reply 選擇及回覆不串線的驗收。不能把單 Agent 通過視為本項驗收。
