# Known Issues

## ISSUE-138：卡片缺少六角色 machine／agent／model 指定與 bridge 強制守門

更新日期：2026-11-10。狀態：已修正、待驗收（原始碼與自動化檢查完成；尚未實機驗收）。卡片：REQ-20261110-card-role-assignment。

**症狀／預期：**舊卡只有 lead 指定；Worker 由 Lead 自選、reviewer／fixer 由臨時 CLI 指定，不能可控驗證角色矩陣。預期六角色可宣告 machine／agent／model，無宣告完全相容，無效指定在撿卡前拒絕且原因正確，Lead 不符派工被擋，流程記實際身分與來源。

**已確認根因（2026-11-10 讀碼）：**Card／serializer 只有 lead；autopick 只驗 Lead；計畫驗證沒有角色約束、acquire 沒 assignment context；model 只有格式／flag 驗證而非同 kind 配置允許清單；CardStore 的正常帳本必須 parse 成功，壞卡被掃描排除；原角色紀錄無六角色／來源 metadata 且只有 best-effort。

**修正範圍：**新增 card-role-assignment／card-role-session／card-role-rejections。roles inline map、同 kind 已開放 profile 及 modelFlag／args；preflight 與 manual assign；凍結候選、Lead prompt、整份計畫與實際 Worker 守門、每 assignment fresh session；review／fix／loop 卡片指定與 CLI 衝突；嚴格送出前角色紀錄與失敗清理；≤300字 v2 來源模板且舊模板／hash不變；壞卡獨立持久診斷、card show 查詢、通知重試。詳見 card-role-assignment.md。

**範圍決定與限制：**Lead 明確決定本卡 machine 交付宣告＋驗證＋local 強制執行。已配置 remote 撿卡前明確拒絕「卡片流程尚未支援 machine X」，跨機器未實作／未驗收；pi Worker 不開放。配置允許 model 不保證供應商可用，保留 CLI 實際錯誤。無可信 notify 不猜路由；通知送達但 sent 寫入失敗可能重複。卡片宣告不等於每個角色已實機通過。

**重現／測試環境：**2026-11-10，本機 macOS、此卡 worktree、fake Herdr ports／暫存卡片與 journal，未呼叫真 Agent、未讀 GitHub。原始 HEAD c0208815175e059b6aec824d1d2a7215993c01a4。初次 typecheck 因尚未安裝依賴找不到 tsc，npm ci --ignore-scripts 後解除；開發階段另修 optional 介面型別錯誤。新增測試曾抓到 role target 的三段 id 被誤判成 remote machine，已加明確 local；測試 fixture 的 session kind 與 Lead plan wire 格式已依既有協定修正，沒有修改任何既有測試。這些早期失敗不作最終通過證據。

**驗證（2026-11-10，階段結果）：**既有未改測試 npm test：1635項／1634 pass／0 fail／1既有 skipped。新增核心與 flow 測試40項／40 pass／0 fail。送出前非同步身分守門接線時，既有 source-wiring 測試曾因 hookFinal 不再是 context 第一欄而失敗；保留原 hookFinal 欄位位置、把新守門放其後後解除，未修改既有測試。

**w1 階段驗證（2026-11-10，本機）：**`npm run typecheck` exit 0；`npm run lint` exit 0（198個 TypeScript 檔）；`npm test` exit 0（含 build），1682項／1681 pass／0 fail／1既有 skipped，約63.5秒。比原套件新增47項，原有 test 檔案一行未改（`git diff --quiet -- test/` exit 0；兩個新測試檔為未追蹤新增）。`git diff --check` exit 0。fresh session 使用建立時 terminal 核對清理；strict 紀錄失敗僅釋放該 owned profile lease，保留既有 binding，不釋放其他 Worker。

### r1 審查修正（2026-11-10，w2；狀態維持已修正、待驗收）

r1 在 w1 通過自動化檢查後發現六項缺口，前一輪測試未涵蓋，保留上方歷史；這不是實機驗收通過後復發。本輪修正範圍：

- r1-omitted-model：profile 未配置 model、actor 回報 CLI 預設 model 時誤拒並關 pane。只在 profile.model 存在時比對，省略時保留觀察值與 observed 證據。
- r1-blocked-cleanup：fresh Worker finally 無條件關 pane，會丟失 blocked／待回答／逾時／送達不明的現場。新增 cleanup disposition，只有派工前失敗與確認完成可關閉，其他保留 session，既有停止／清理流程負責後續。以 durable question 實際 reply 及原 turn 續接測試確認。
- r1-retry-identity：身分檢查只在重試迴圈外，agent_not_ready 等待期間換 terminal／session／model 仍可能收到第二次 prompt。新增每次實際嘗試前 hook；beforeDispatch 單次事件不變，Team／review／fix 均接線。
- r1-ineligible-rejection：roleGate 對 draft／done／未 opt-in 卡也記事件通知。共用 ready＋autopickFor eligible 判定，非 eligible 零拒絕事件、零通知。
- r1-malformed-notify-gate：壞卡通知缺完整選單檢查與讀畫面後身分／狀態複核。與正常 notifier 共用 gate，完整選單與兩次送前檢查；readAgent 期間替換 terminal／kind 或變忙碌／blocked 不送，保留 pending 重試。
- r1-invalid-doc-example：主要 roles 範例被格式化為 parser 不支援的多行 map。改單行 inline map；契約與兩語 README 加 prettier-ignore，新增三份文件範例解析測試。

**本輪重現與測試（2026-11-10）：**新增 test/card-role-r1.test.ts，既有測試（含 w1 新增檔）一行不改。先跑 `npm run build && node --test dist/test/card-role-r1.test.js`：6項／2 pass／4 fail，確認省略 model、非 eligible、重試與契約範例四項症狀。修正後第一輪22項／22 pass／0 fail；新增執行中 timeout／uncertain 與各維度重試替換檢查後，targeted 27項／27 pass／0 fail。所有測試均 fake port／暫存 journal，不呼叫真 Agent、不部署。

**w2 最終驗證（2026-11-10，本機）：**`npm run typecheck` exit 0；`npm run lint` exit 0（199個 TypeScript 檔）；`npm test` exit 0（含 build），1709項／1708 pass／0 fail／1既有 skipped，約64.9秒。新增27項 r1 回歸測試；w2 開始時所有既有 test 檔案（含 w1 的兩份新增測試）SHA-256 核對未變。`git diff --check` exit 0；文件範例解析已包含於新測試。未使用 GitHub、未 commit／push／merge、未部署／重啟。狀態仍為已修正、待驗收；三張 merge／重啟後實機卡仍待 Lead 執行。

**部署／未驗項目：**本輪未 commit／push／merge／重啟／部署，執行中的 bridge 尚未載入新版，歷史事件／失敗不補送。build／unit test 不代表 Discord／Herdr／CLI 實機驗收。

**下一步（三張真卡仍待 Lead 在 merge 並重啟新版後執行）：**
1. 無害一行檔案卡，至少兩角色不同 agent、至少一角色指定 model；保存 role_assigned，另取 pane／啟動紀錄證明實際 model。
2. 不允許 agent／不合法 model 卡，證明撿卡前拒絕、零工作啟動，通知標題與原因正確。
3. Lead 故意派出違反指定的計畫，證明 plan_rejected 且零違規 Worker prompt。

每張都補卡 id、日期、環境、role_assigned 原文與結果到本 issue 及 agent-role-matrix；未完成維持已修正、待驗收，失敗則重新開啟，不得標已驗收。

## ISSUE-137：Lead／Worker 首次 prompt 在 Herdr 登記完成前回 agent_not_ready

更新日期：2026-11-09。狀態：已驗收（2026-11-09，範圍：pi 當 Lead 一次實機成功，見「實機驗收」段；請求 A 已指認為卡片通知；其他 Agent 種類、非 Lead 角色的重試未被觸發也未驗）。

**使用者可見症狀／重現環境：**2026-11-09 卡片 `REQ-20261109-pi-lead-live`（`lead: pi`）開始後約 1 秒 blocked：`herdr agent.prompt: agent_not_ready agent w5V:p1 is not an active named agent`。本輪使用假 port 重現，沒有實機驗證 pi 當 Lead。

**預期行為：**第一個 prompt 因登記尚未完成被拒絕時，有上限等待後重試，Herdr 只接受一次 prompt；成功、stalled、其他錯誤不重送，超限說明原因及秒數，不降低既有驗收要求。

**已確認根因（2026-11-09 讀碼）：**bridge 原本沒有處理 agent_not_ready，錯誤直接結束 turn；autopick-wiring.ts 使用的 waitUntilReady 只檢查 agent_status，不保證 Herdr 已登記 active named agent。**未確認推論：**pi 在 Herdr 登記完成前就顯示 idle／done。另假設 agent_not_ready 表示 Herdr 沒有接受 prompt，為推論（Herdr 契約未讀）；accepted 計數測試依此前提建模，不是真實 Herdr 收件證明。

**兩個 agent.prompt 請求來源：部分確認（2026-11-09，Agent 在實機 task journal 與 Herdr 伺服器日誌取得證據）。**先前（fixer）搜尋失敗的原因：找錯了目錄。執行中的 bridge 的狀態目錄是 `~/.local/state/herdr/plugins/herdr-discord-bridge`（由 `HERDR_PLUGIN_STATE_DIR` 決定），task journal 在其 `team-tasks/task-e07c60cf-8005-4128-9ced-ef7875127c7a.json`；Herdr 日誌在 `~/.config/herdr/herdr-server.log`（記請求 id 與方法，沒有 pane id，所以搜不到 w5V:p1）。

07:56:53（UTC）的時間對照：
- `.112` 請求 A（`herdr-discord-1794211013112`）送出，Herdr 記 received。
- `.231` journal `turn_dispatched`。
- `.251` 請求 B（`…013251`）送出（Herdr 記 received 在 .3619）。
- `.3627` 請求 B 回 error（`agent_not_ready`）；`.363`、`.377` journal 兩筆 `task_failed`。
- `.4157` 請求 A 才回 `ok`，此時 task 已失敗。

**直接觀察到的（只有時序與方法）：**上面時間對照裡的每一個時間與結果，都來自 journal 與 Herdr 日誌；請求 A、B 都是同一個 pane 的 `agent.prompt`；A 早於 journal 的 `turn_dispatched` 119 ms，B 晚於它 20 ms；B 的 error 與第一筆 `task_failed` 相差約 1 ms。

**推論（沒有直接證據，審查指出 2026-11-09）：**
- B 是這個 turn 的規劃 prompt：依據是 `runTeamTurn` 在送 prompt 之前才呼叫 `beforeDispatch`（讀碼）加上 B 緊接在 `turn_dispatched` 之後、其 error 與 `task_failed` 幾乎同時；但日誌沒有「請求 id 對應哪個 turn」的欄位，所以不能直接確認。
- A 是「另一個程式路徑」：只因為它早於 `turn_dispatched`，而 `runTeamTurn` 的送出在其後；也可能是 journal 事件寫入與請求送出的相對順序和我的理解不同。
- 兩個請求都沒有把 prompt 送進 pi：依據是 pi 的 session 資料夾當時是空的、畫面沒有對話；這**不足以證明** A（回 `ok`）沒有送達，可能是 pi 當時還沒寫 session 檔、畫面也還沒重繪。A 回 `ok` 的原因不明。

**實機驗收（2026-11-09，本機 macOS，bridge 為 main `945ccd6`（#198）merge 後重啟的程序；`policy.yml` 為 `autopick_lead: claude, codex, agy, pi`，`config.json` 的 pi profile 為了測試宣告了 `implementation`（兩者都是這次測試期間改的，備份 `policy.yml.bak-pi-gate-20261109`、`config.json.bak-pi-impl-20261109`，是否保留待使用者決定））：**重測卡 `REQ-20261109-pi-lead-retest`（`lead: pi`，新增一個一行檔案）：08:50:59Z 撿起，08:51:03Z `role_assigned` 為 `lead：pi；…；leadSelection=card`；08:51:04.702Z pi 的規劃 prompt（`w5Z:p1`，5686 字）被 Herdr 回 error（`agent_not_ready`），#198 的重試在 08:51:05.3Z 再送一次，08:51:19.7Z 回 `ok`（約 14 秒，是 Herdr 等 pi 完成規劃那一回合）；pi 規劃出 6 個派工（`implement-card-file`、`review-card-file`、`identify-author-session`、`complete-independent-review`、`verify-current-card-artifact`、`verify-with-accepted-evidence-schema`，**全由 codex 執行**，全部 `done`），Team 問題數 0、64 個事件；08:56:32Z task `completed`；08:56:59Z commit `03e2b73`；08:57:07Z 開 PR #200（只改一個檔案，內容 `ok`）；08:57:14Z reviewer（codex）第 1 輪 `pass`；08:59:05Z bridge 自動 squash merge `20faaf7`；09:00:01Z `cleanup_done`，worktree 與 Lead workspace 都已移除。**全程沒有手動介入。**

**請求 A 的身分（已確認，取代上方的未確認）：**重測時新加的追蹤紀錄 `agent.prompt prompt target=w5D:p1 chars=117 ts=1794214264678` 顯示，與 pi 的規劃 prompt（`…264702`）同時出現的另一個請求，**目標是 `notify` 對象的 Claude pane `w5D:p1`，不是 pi**——它是卡片通知（`notify: agent:w5D:p1:…`），回 `ok`。上次失敗那張卡 `REQ-20261109-pi-lead-live` 的流程紀錄也有「Agent sending：已認領」與「Agent 通知已送出」都在 07:56:53Z，與請求 A（`…013112`）的時間吻合。所以先前「同一個 pane 兩個 `agent.prompt`」是誤讀：Herdr 日誌沒有目標欄位，兩個請求其實是兩個不同的 pane；不是 bridge 重複送出，也沒有重複送出的 bug。這解釋了「A 回 `ok` 但 pi 什麼都沒收到」。**追蹤紀錄的 `via=` 欄位實測沒用**（非同步呼叫下是空的或只有 `Object`），有用的是 `target`、`chars`、`ts`；當時建議之後移除或修正 `via`，後續移除紀錄見下段。

**追蹤紀錄移除 `via=`（2026-11-09，`REQ-20261109-trace-drop-via`）：已修正、待驗收。**上述實機觀察確認堆疊解析在非同步呼叫下無法提供有用的呼叫位置；`src/herdr.ts` 的 `tracePromptRequest` 已移除 `new Error().stack` 堆疊解析與 `via=` 欄位，格式改為 `agent.prompt <kind> target=<pane> chars=<字數> ts=<毫秒>`，仍不記 prompt 內容。`test/herdr.test.ts` 與 `SPEC.md` 已同步更新：每個請求一行、包含 target／chars／ts、不含 `via=` 或 prompt 內容，且時間戳不早於請求開始。本次檢查（2026-11-09，本機 macOS）：首次 `npm run check` 因缺少依賴而於 typecheck 回報 `tsc: command not found`（exit 127，測試未執行，0 tests／0 pass／0 fail／0 skipped）；`npm ci --ignore-scripts` 安裝鎖定依賴成功後重跑 `npm run check` 通過（exit 0），typecheck／build 通過，1631 tests／1630 pass／0 fail／1 skipped（既有略過）；`git diff --check` 通過（exit 0）。沒有實機驗證，執行中的 bridge 未部署、未重啟。下一步由 Lead 安排部署／重啟後檢查新請求的 console 格式；舊紀錄不回寫、舊訊息不補送。上方已驗收狀態僅指原有 pi Lead 重試，不包含此次 `via=` 移除；下方含呼叫位置的格式與測試為歷史紀錄。

**這個驗收沒有證明的：**只有一張極簡卡、一次；pi 只當 Lead，所有實作、審查、驗證都是 codex，所以不代表 pi 能擔任其他角色；`agent_not_ready` 重試只在 pi 這一次被觸發過，其他 Agent 種類沒有被觸發；Herdr 「拒收」的契約（被拒的 prompt 確定沒送進去）仍是推論，這次的結果（重試後只被執行一次）與它相符但不是證明。

**（以下是 #198 merge 當時的未確認狀態，已由上方實機驗收取代，保留作為歷史）**

**未確認（驗收條件 1 在這個 PR 無法完成，審查第 3 輪 F4 指出）：**請求 A 由哪個函式送出，讀碼無法指認（`dispatchPrompt` 的六個呼叫者、`console-agent`、通知路徑都不在 `card assign --worktree --coding` 的明顯流程裡）。為了下一次能直接指認，本 PR 在 `HerdrClient` 每次送 `agent.prompt` 時印一行 console 紀錄（`agent.prompt <prompt|prompt+wait|send-fallback> target=… chars=… ts=<毫秒> via=<呼叫位置>`，不含 prompt 內容；`ts` 可對 Herdr 日誌請求 id 裡的毫秒），重測 pi 當 Lead 時就能在 bridge console 對出 A。

**修正範圍：**僅 runTeamTurn 首次派送，在 baseline 與 beforeDispatch 之後有界迴圈，turn_dispatched 一次；重用 agent-start.ts 已匯出的 Clock（該檔無須修改），context 可注入 clock、timeout、interval，預設 15 秒／500 ms。僅重試 HerdrError agent_not_ready，睡眠與 atomic wait 受 turn 剩餘時間約束，每次重試檢查 abort，睡眠可取消。ok（含 undefined）停止，stalled 沿用 marker，其他錯誤原樣丟出。HerdrClient、其他 prompt 呼叫端與 Agent kinds 不變。同步 SPEC 與 CONTEXT。

**測試（2026-11-09）：**第一次 npm run check 因缺少依賴 tsc: command not found，exit 127，未執行測試（0 pass／0 fail）；npm ci --ignore-scripts 成功安裝鎖定依賴後重跑 npm run check，exit 0：typecheck、build 通過，1627 tests／1626 pass／0 fail／1 skipped（2026-11-09，本機，假 port；既有略過）。git diff --check 通過（2026-11-09）。新增 atomic／fallback 前 N 次拒收後恰 1 accepted、beforeDispatch 一次、agent_blocked 原樣一次、假 clock 超限／turn budget、ok／undefined／stalled 一次、取消重試，以及 Lead／Worker 重試後 task completed。

**Review 修正（retry-deadline-1，P2，2026-11-09）：**重新開啟後修正完成，狀態維持「已修正、待驗收」。reviewer 發現原 marker 觀察期限在 atomic prompt 返回後重新起算，只扣除 dispatch 前的 retryElapsed，未扣除 atomic wait；原先「受回合上限限制」的驗證不完整。reviewer 的唯讀重現為 120 ms 上限、30 ms 重試等待、接著 stalled 且無 marker，總耗時 212 ms。修正為回合進入時計算一次固定 deadline；重試、atomic wait、後續 waitAgent／marker 觀察及 hook grace 共用同一 clock 與剩餘預算，不在 stalled 後重設期限。ok／stalled 不重送、其他錯誤不重試、abort 與 beforeDispatch 一次的契約不變。新增兩個假 clock 回歸案例：30 ms 重試後 atomic 消耗 60 ms／90 ms，再 stalled 且無 marker；斷言總計恰 120 ms、observation 預算分別僅 30 ms／不再等待，兩次嘗試但僅一次 accepted。首次 npm run check 因新增 fake waitAgent 的可選 timeout 型別未縮窄而 typecheck 失敗（exit 2，測試未執行，0 pass／0 fail），補上 timeout 存在檢查後重跑 npm run check 通過（2026-11-09，exit 0）：typecheck／build 通過，1629 tests／1628 pass／0 fail／1 skipped；兩個 retry-deadline-1 假 clock 案例皆通過。git diff --check 通過（2026-11-09）。

**Review 修正（round 1，F2，2026-11-09）：**reviewer 唯讀重現：100 ms 預算、baseline 耗時 120 ms 仍送出一次 prompt。修正為每次派送前（含第一次）檢查回合期限，用盡即失敗並說明「未送出」；新增假 clock 測試斷言 0 次派送。npm run check 通過（2026-11-09，exit 0）：1630 tests／1629 pass／0 fail／1 skipped。F1（兩個請求來源）當時未取得 journal；之後由 Agent 取得並補在上方「兩個 agent.prompt 請求來源」段（部分確認：B 是引擎、A 未指認）。

**CI 不穩定的測試（2026-11-09，Agent 查出並修正）：**head `3e29dcd` 的 ubuntu CI 失敗（macOS 通過）：`ISSUE-124 Lead 規劃、每個 Worker、Lead 彙整都以 timeoutMs 為等待上限`（`test/team-orchestration.test.ts`，既有測試、本 PR 沒改它）斷言 `1233 !== 1234`。**根因（已確認）：**本 PR 把送給 `promptAgentAndWait` 的等待上限從 `timeoutMs` 改成 `Math.max(1, deadline - clock.now())`（剩餘預算），從算出 deadline 到送出之間只要過 1 毫秒就變成 `timeoutMs - 1`，違反 ISSUE-124 契約「等待上限＝timeoutMs」。對同一個測試各跑 60 次（本機）：本 PR 的程式 48 次通過、12 次失敗（約 20%）；修正後 60 次全過。前三次 CI 通過只是剛好沒跨毫秒。

**修正：**`src/team-turn.ts` 沒有重試過（`lastNotReady` 為空）時維持傳 `timeoutMs`，重試之後才改傳共享預算的剩餘時間；既有測試與契約不變，沒有放寬任何測試。副作用：沒重試時 atomic wait 可能比回合 deadline 多出「算 deadline 到送出」那幾毫秒（與本 PR 之前的行為相同）。

**最新完整檢查（2026-11-09，本機，對修正 CI 不穩定測試後的程式內容）：**`npm run check` 通過（exit 0）：typecheck／build 通過，1631 tests／1630 pass／0 fail／1 skipped（既有略過）；`npm run lint` 通過（193 TypeScript files）；`git diff --check` 通過。新增的 `test/herdr.test.ts` 追蹤紀錄案例（每個請求一行、含呼叫函式名稱、不含 prompt 內容）通過。上方較早的 1627、1629、1630 是歷次修正當時的數字，不是最新結果。

**更正（2026-11-09，Agent）：**下一段 round 2 說「搜尋 … 沒有任何檔案含 w5V:p1」是因為搜錯目錄（見上方「兩個 agent.prompt 請求來源」段）。

**Review 修正（round 2，F1／F3，2026-11-09）：**reviewer 再次要求補上兩個 agent.prompt 的逐次來源。再次搜尋 ~/.config、~/.herdr、~/Library/Logs、/tmp 及 ~/.config/herdr-discord-bridge（hooks.sock、send.sock、state、tunnels），除本 repo 的測試與文件外沒有任何檔案含 w5V:p1，仍沒有原 task journal／完整 request log。此條需要現場資料，無法由修改程式或文件取得，來源維持「未確認」，不以推測改寫為已確認；驗收條件 1 的來源追查部分仍未完成，留待取得 journal 後處理。

**（歷史，已由實機驗收取代）未驗證／下一步：**沒有實機驗證 pi 當 Lead；Lead 需取得原 task journal／完整 request log，確認兩次請求來源與 Herdr 拒收契約，部署／重啟後重跑原卡。原始碼修正不等同 Discord／Herdr／CLI 端到端成功；執行中的 bridge 未部署、未重啟，舊失敗 prompt／訊息不補送。本輪不 commit、不 push、不使用 GitHub。

## ISSUE-136：卡片通知在對象的 Agent 顯示忙碌時排隊，延遲很久才送出（`REQ-20261109-agy-lead-live`）

更新日期：2026-11-09。狀態：待調查（現象已觀察；根因未確認；沒有修正）。

**使用者可見症狀：**測試卡 `REQ-20261109-agy-lead-live` 的 4 筆通知（07:38:27Z、07:41:34Z、07:41:54Z、07:44:24Z）在卡片流程紀錄都是「Agent 忙碌，通知排隊」。第 1 筆（07:38:27Z 排隊）到 07:50:36Z 才「Agent 通知已送出」，延遲約 12 分鐘；其餘 3 筆截至 07:50:43Z 仍是排隊。`notify` 對象（Claude Code pane `w5D:p1`）在這段時間沒有收到通知，我是在 07:46 主動查詢才知道這張卡已經 merge（07:44:04Z）。據我的對話紀錄，07:38 到 07:46 之間我在等使用者回應、沒有在處理工作，但我沒有保存當時 pane 的實際狀態。

**預期行為：**排隊的通知在對象 Agent 閒置後很快送出。

**對照：**同日其他卡都有送出：`REQ-20261109-claude-reviewer-live` 排隊 0、送出 5；`REQ-20261109-reviewer-hook-final` 排隊 0、送出 4；`REQ-20261109-lead-live-codex` 排隊 5、送出 9（排隊的後來有送出）。

**重現／環境：**2026-11-09，本機 macOS，bridge 為 main `ae356aa` 之後重啟的程序；通知目標 `agent:w5D:p1:…:claude`。

**已確認根因：**未確認。那段時間 `w5D:p1` 的實際狀態我沒有保存；可能是該 pane 被判定為 working 太久，也可能是排隊重送的機制有問題，這些都只是猜測。我排隊的通知確實會補送（07:50:36Z 送出第 1 筆），但延遲很久，且一次只送一筆。

**影響：**使用者依賴通知得知進度時，這張卡的進度通知延遲 12 分鐘以上（整張卡從撿起到 merge 只花約 6 分鐘），卡片本身的紀錄仍完整。

**修正範圍：**無（只記錄）。**未驗證／下一步：**重現（讓目標 Agent 長時間顯示 working）、讀 `src/card-notify.ts` 的排隊與重送邏輯、確認排隊通知的重送時機（為什麼閒置時沒有立刻送、為什麼一次一筆），以及剩下 3 筆最後是否送出。

## ISSUE-135：卡片事件通知的標題把「Lead 不在候選清單」說成「專案政策未滿足」

更新日期：2026-11-09。狀態：已修正、待驗收。先前狀態與觀察保留於下方歷史；根因現已由程式碼確認。

**使用者可見症狀：**測試卡 `REQ-20261109-lead-live-reject`（`lead: pi`，不在 `autopick_lead: claude, codex` 內）被拒絕時，卡片的事件原因正確寫「Lead『pi』不在政策候選清單內，不撿這張卡」，但 `notify` 對象收到的通知標題是「autopick_stopped · 專案政策未滿足」。這不是專案等級或專案選用的問題，標題會誤導使用者去查專案政策。

**預期行為：**標題要對應實際原因（Lead 不在候選清單）。

**重現／環境：**2026-11-09，本機 macOS，bridge 為 main `88e1ce6` 的程序，通知送到 Agent pane（先排隊、Agent 空閒後送達）。

**已確認根因（讀碼，2026-11-09）：**`src/card-notify.ts` 的 `notificationReason` 依序套用分類表，通用 `/政策|L[012]/` 在 Lead 拒絕句中先命中，故回傳「專案政策未滿足」。敏感路徑句同時含 `commit` 時，原 `/head|commit/` 又加上「版本條件」。

**修正範圍（2026-11-09）：**Lead「不在政策候選清單內」及「尚未開放」在分類表前特別回傳「Lead 不可用」；版本分類排除「commit 留在 worktree」，使敏感路徑 fix 停止不被錯加版本條件。新增分類及通知訊息測試。

**驗證（2026-11-09）：**`npm run check` 通過：typecheck、build 成功，測試共 1634 tests／1633 pass／0 fail／1 skipped；`git diff --check` 通過。**沒有實機驗證：**執行中的 bridge 未重啟，Discord／Herdr／CLI 情境待驗收；歷史通知不會重新發送。

**Review 修正（round 3，F2，2026-11-09，Agent 修正）：**reviewer 指出 `src/card-notify.ts` 的敏感路徑提前回傳是全域的，會吃掉其他事件原本的多類別標題（違反「其他事件既有分類不變」）。修正：提前回傳限定在 `failed` 且文字含 `autopick_stopped` 的事件，並把先前被移掉的 `[/敏感|sensitive/, "敏感路徑"]` 放回分類清單，其他事件維持原分類。測試：把敏感路徑樣本改成 `失敗：autopick_stopped；原因：…` 格式，並新增回歸測試（非 autopick_stopped 事件的敏感字樣仍是多類別，例如「敏感路徑、版本條件未滿足」「敏感路徑、CI 條件未滿足」）。`npm run check`（2026-11-09，本機）：1635 tests／1634 pass／0 fail／1 skipped；`npm run lint` 通過。**這個修正沒有經過獨立 review：**bridge 的 review 次數已用完（3 筆 verdict；第 1 輪 `inconclusive` 也算一次，原因沒查到），要由人工 merge。

## ISSUE-134：claude 當 reviewer 時，回覆「不是單一 JSON 物件」，兩輪都 `inconclusive`，review 退回人工

更新日期：2026-11-09。狀態：已驗收（2026-11-09，範圍：claude 當 reviewer 的 `card review` 第 1 輪；`card fix` 與其他情境未驗，見「實機驗收」段）。

**使用者可見症狀／重現環境：**2026-11-09，本機 macOS、bridge main `88e1ce6`，卡片 `REQ-20261109-lead-live-codex`（PR #191，head `a773038`）由 codex 當 Lead，新開 claude reviewer pane。第 1 輪 06:59:54Z–07:00:00Z、第 2 輪 07:00:07Z–07:00:13Z 都回 `inconclusive`，原因「reviewer 的回覆不是單一 JSON 物件」，loop 退回人工。原先因每輪約 6 秒而猜測未審查或格式不符；後續 session 證據已排除該猜測。

**預期行為：**card review／card fix 在 hookTransport 為 auto 時使用本回合完整 Stop 訊息框內的回覆；沒有訊息時保留終端畫面 fallback，parser 模式不查 hook。

**已確認根因與證據（2026-11-09）：**上述兩個 reviewer session 的最後訊息分別為 323 與 317 字元，是合格的 pass JSON，marker nonce 與 prompt 一致。`src/main.ts` 的 card fix 與 card review 的 runTurn 沒有把第 6 個 context 參數傳給 `runTeamTurn`，因此缺少 hookFinal，只能讀終端畫面。Claude Code 依 pane 寬度硬換行切斷 JSON（ISSUE-086），導致 parseReviewReply 失敗；TeamTaskEngine 原本有接 hookFinal。

**修正範圍（2026-11-09）：**新增共用 `createTurnHookFinal` factory，TeamTaskEngine、card fix、card review 共用相同模式、session／pane 與 since 查詢邏輯。兩個 card runTurn 傳入 `{ hookFinal }`。TeamTurnContext 的 taskId／phase 選填，Debug context 省略缺少欄位，不印 undefined。parseReviewReply 與 codex rollout 路徑未改。假 port 測試以完整 framed review JSON 對照硬換行畫面，並覆蓋空 hook、parser 模式與缺少 taskId。

**測試（2026-11-09）：**首次 `npm run check` 因依賴未安裝、`tsc: command not found` 停止（0 個測試執行）；`npm ci` 成功後重跑，1617 tests、1615 pass、1 fail、1 skipped。失敗為新測試的假 Claude 畫面未含訊息圓點／續行縮排，parser 忽略畫面而逾時；已修正 fixture，沒有修改 parser 或驗收標準。最終 `npm run build && node --test dist/test/team-turn.test.js` 通過，18 tests、18 pass、0 fail、0 skipped。最終 `npm run check` 通過（exit 0；typecheck、build 成功；1617 tests、1616 pass、0 fail、1 skipped，71220.75925 ms）。`git diff --check` 通過。

**對照與暫行做法：**同卡改用 codex reviewer 第 3 輪於 07:03:59Z pass，之後人工 merge `1448d51`；此為修正前的對照，不能當作本修正驗收。

**實機驗收（2026-11-09，本機 macOS）：**PR #193（`ae356aa`）由 bridge 全自動 merge 後，授權重啟 bridge（新程序載入 `ae356aa`，`dist/src/turn-hook-final.js` 存在，Gateway 連線正常）。驗證卡 `REQ-20261109-claude-reviewer-live`（`lead: codex`，改一個一行檔案；與修正前失敗的 `REQ-20261109-lead-live-codex` 同一種組合：codex 當 Lead、claude 當 reviewer）：07:29:33Z 開 PR #194（head `7b9eb65`），07:29:41Z `reviewer（第 1 輪）：claude`，07:29:46Z `review_verdict` 為 **`pass`**（約 5 秒，沒有發現），CI 兩平台綠，07:31:27Z bridge 自動 squash merge `c29d84e`，07:32:24Z `cleanup_done`；bridge console 有 `hook Stop … pane=w5Q:p5 chars=320`。修正前同樣的組合兩輪都 `inconclusive`。

**這個驗收沒有證明的：**bridge 沒有紀錄「這次回覆取自 hook」，所以「由 hook 路徑取得」是由 hook 字數紀錄與結果推論，不是直接觀察；只有一次 `pass`，沒有重複，也沒有驗證 claude reviewer 回 `changes_requested` 的情境（有發現時的 JSON 較長，折行風險更高）；`card fix`（作者回覆走同一個修正）從未實機驗證；hookTransport 非 auto 的情境未驗。

**未驗證／下一步：**上述未證明項；ISSUE-133、ISSUE-135 另案。

## ISSUE-133：`autopick_stopped` 的原因只留 loop 輸出的前 200 字，真正的停止原因被截掉，通知因此誤導

更新日期：2026-11-09。狀態：已修正、待驗收。先前重現與根因證據保留於下方歷史。

**使用者可見症狀：**卡片 `REQ-20261109-multi-lead-card-lead`（PR #189）已在 06:41:19Z 通過第 2 輪 review，真正擋住自動 merge 的只有敏感路徑 `src/policy.ts`（設計上要人工 merge）。但 06:41:54Z 寫進卡片的 `failed`／`autopick_stopped` 事件，原因是「loop：review 完成：… PR #189（head e1a3174b2a24）· 第 1 輪 … 判定：changes_requested …」，是**第 1 輪**的結果；bridge 據此通知「review 條件、版本條件未滿足」，與實際狀況（`pass`、head 一致，只剩敏感路徑）不符。

**預期行為：**`autopick_stopped` 的原因要是實際停止的原因（這次是敏感路徑，要人工 merge），至少不能是過期輪次的摘要。

**重現／環境（2026-11-09，本機）：**bridge 為 #187（`b6e507d`）merge 後重啟的程序；卡片流程紀錄與 PR 狀態：第 1 輪 `changes_requested`（06:37:45Z，head `e1a3174`）、fixer 修正（06:39:45Z，head `bdbdb04`）、第 2 輪 `pass`（06:41:19Z，head `bdbdb046553c`），PR head 也是 `bdbdb046553c`；06:41:54Z 的 `merge_blocked`、`loop_stopped` 寫「敏感路徑未滿足」（正確），緊接著的 `failed` 事件原因卻是第 1 輪摘要。

**已確認根因（讀碼，2026-11-09）：**`src/autopick.ts` 在 `!loop.merged` 時以 `report("stopped", "loop", loop.text)` 回報，原因是整段 loop 輸出；`src/main.ts` 的 `report` 寫事件時，原因是 `${result.lastStep}：${result.reason}` 再 `.slice(0, 200)`（約第 2750 行）。loop 輸出以第 1 輪的 review 摘要開頭，所以前 200 字剛好只含第 1 輪的標題與判定，結尾才有的實際停止原因（敏感路徑）被截掉。這個推論由上述實例吻合（事件文字停在「驗收條件： 1. ✓」附近，正是 200 字截斷點）；我沒有執行或重現。

**影響：**使用者從通知會以為 review 或版本沒過，可能多做不必要的處理。實際只有這一次觀察，不知道其他 loop 停止情境是否同樣被截。

**修正範圍（2026-11-09）：**`src/autopick.ts` 新增 `loopStopReason`，取最後 `原因：` 區塊，inconclusive 時附最後一筆底層原因；缺少原因標記則先取最後的 loop 停止區塊（剔除卡片狀態提示），沒有結構化停止標記但有 inconclusive 原因時取最後一筆該原因，兩者皆無才取正規化輸出尾端。結果最多 194 字，讓 main 的 `loop：` 前綴後不超過 200 字。`src/main.ts` 仍以 200 字為事件上限。新增敏感路徑、兩輪 inconclusive 及尾端 fallback 測試，並透過 CardStore 檢查記錄原因與通知分類。

**驗證（2026-11-09）：**`npm run check` 通過：typecheck、build 成功，測試共 1634 tests／1633 pass／0 fail／1 skipped；`git diff --check` 通過。**沒有實機驗證：**執行中的 bridge 未重啟，Discord／Herdr／CLI 情境待驗收；歷史通知不會重新發送。

**第二個實例（2026-11-09，卡片 `REQ-20261109-lead-live-codex`，PR #191）：**claude 當 reviewer 兩輪 `inconclusive` 後，卡片的 `failed`／`autopick_stopped` 原因只顯示「第 1 輪」的標題與「inconclusive 的原因：rev」就被截斷；完整原因「reviewer 的回覆不是單一 JSON 物件」是從 bridge console 才看到的（見 ISSUE-134）。

**暫行做法：**看卡片流程紀錄的 `merge_blocked`／`loop_stopped` 事件與 bridge console 的完整輸出，不要只看 `autopick_stopped` 的原因文字。

**修正前未驗證紀錄（2026-11-09）：**當時沒有測試；是否其他停止原因也被截斷仍待確認。此段已由上方 2026-11-09 修正與自動化驗證更新；目前仍待實機驗收。

**Review 修正（round 3，F2，2026-11-09，Agent 修正）：**reviewer 指出 `src/card-notify.ts` 的敏感路徑提前回傳是全域的，會吃掉其他事件原本的多類別標題（違反「其他事件既有分類不變」）。修正：提前回傳限定在 `failed` 且文字含 `autopick_stopped` 的事件，並把先前被移掉的 `[/敏感|sensitive/, "敏感路徑"]` 放回分類清單，其他事件維持原分類。測試：把敏感路徑樣本改成 `失敗：autopick_stopped；原因：…` 格式，並新增回歸測試（非 autopick_stopped 事件的敏感字樣仍是多類別，例如「敏感路徑、版本條件未滿足」「敏感路徑、CI 條件未滿足」）。`npm run check`（2026-11-09，本機）：1635 tests／1634 pass／0 fail／1 skipped；`npm run lint` 通過。**這個修正沒有經過獨立 review：**bridge 的 review 次數已用完（3 筆 verdict；第 1 輪 `inconclusive` 也算一次，原因沒查到），要由人工 merge。

## ISSUE-132：自動撿卡缺少多候選、卡片指定與 Lead 選擇來源

更新日期：2026-11-09。狀態：已修正、待驗收（卡片指定、拒絕與選擇依據已於 2026-11-09 實機驗收，見「實機驗收」；沒指定時取第一個、起不來就失敗、agy／pi 開放條件未驗）。

症狀／預期：延續 ISSUE-130，政策只能單一 Lead、卡片不能指定、角色帳本缺選擇依據，未開放時 Discord 看不到原因。預期有序候選、卡片指定優先且必須在政策清單內；無指定取首個，失敗不換候選，一次一張卡。

重現／環境：2026-11-09 本機 worktree、假 Herdr port 與自動化測試，未操作 live bridge。已確認根因（讀碼）：policy 純量白名單、Card 無 lead 欄位、pickNext 只讀政策，onRejected 只有 console。

修正範圍：policy 有序陣列解析、重複／空值拒絕；卡片 parser／serializer／check；選卡與專案明確等級守門；agy／pi 共用既有 leadGateFor；拒絕寫 failed/autopick_stopped（沿用 card show 與 notify）；任務 Lead role_assigned 記實際種類與凍結的 leadSelection=card|policy。手動 assign 不改 Lead，舊卡與單值政策行為相容，舊事件 id 不變。

驗證（2026-11-09）：相關測試 `npm run build` 後 `node --test dist/test/autopick.test.js dist/test/card-check.test.js dist/test/card-events.test.js dist/test/policy.test.js`：101 項／101 pass／0 fail；`npm run lint` 通過（192 TypeScript files）。最終 `npm run check`（含 typecheck、build、完整測試）：1613 項／1612 pass／0 fail／1 skipped（既有略過），exit 0。`git diff --check` 通過。`scripts/herdr-card-check docs/card-examples/REQ-*.md docs/card-examples/TKT-*.md`（2026-11-09 補跑）：3 個檔案都 OK、exit 0。3 張範例卡通過（2026-11-09）；先前以 `*.md` 掃入非卡片 README 時得到預期格式拒絕，改為只檢查卡片檔後通過。過程曾發生 card-command 舊角色事件 id 比對失敗（新增可選來源欄位時將空值加入 hash）；已改成只有存在來源時才加入 hash，保留舊事件 id，未降低斷言。初次 typecheck 因尚未安裝依賴找不到 tsc，npm ci --ignore-scripts 後解除；未更動相依版本。

實機驗收（2026-11-09，本機 macOS，bridge 為 main `88e1ce6`（#189）merge 後重啟的程序；`policy.yml` 暫時設為 `autopick_lead: claude, codex`（備份 `policy.yml.bak-live-20261109`，驗收後已改回單一值 `claude`），`config.json` 沒改）：
- **拒絕路徑：**測試卡 `REQ-20261109-lead-live-reject`（`lead: pi`，不在清單內，`notify` 為本 Agent pane）在 06:53:39Z 沒被撿、沒開 workspace，卡片寫入 `failed`／`autopick_stopped`（原因「Lead『pi』不在政策候選清單內，不撿這張卡」），console 有警告，通知先「Agent 忙碌，通知排隊」，空閒後送達。通過。通知標題寫「專案政策未滿足」不精確，見 ISSUE-135。
- **卡片指定：**測試卡 `REQ-20261109-lead-live-codex`（`lead: codex`）在 06:54:39Z 被撿，06:54:50Z 的 `role_assigned` 是 `lead：codex；…；leadSelection=card`，Lead workspace label 為 `autopick-codex-REQ-20261109-lead-live-codex`。通過。
- **未驗：**沒指定 `lead:` 時取清單第一個（`leadSelection=policy`）、Lead 起不來時卡片失敗且不換下一個、agy／pi 的開放條件；測試卡已刪（沒有 task 紀錄），不留殘卡。

使用者決定（2026-11-09）：沒有 `lead:` 的卡取清單第一個，**維持不輪流**；清單其餘種類只是允許被卡片指定的名單。

部署：PR #189（`88e1ce6`）已 merge，2026-11-09 重啟 bridge 載入（build 成功、Gateway 連線、`card policy` 顯示政策載入正常）；`policy.yml` 仍是單一值 `autopick_lead: claude`，所以實際撿卡行為沒變。

未驗證／下一步：未做 Discord／Herdr／CLI 端到端驗收。Lead 應在重啟後驗證卡片指定、拒絕原因顯示及通知、實際 Lead 身分與選擇來源、啟動失敗不換候選；agy／pi 仍須累積 ISSUE-130 的真實 coding 證據。舊任務與訊息不補送。無 commit／push／merge。

## ISSUE-130：自動撿卡的 Lead 只支援 claude、codex，agy、pi 無法選用（REQ-20261109-autopick-four-leads）

更新日期：2026-11-09。狀態：已修正、待驗收（codex 與 agy 當 Lead 已於 2026-11-09 各實機走完一張極簡卡，見「實機驗收」；pi、開放條件擋住的情境、複雜任務沒驗）。

症狀／預期：`autopick_lead` 只接受 claude、codex；Lead 啟動後先是 working 時（codex）會被立刻判為沒就緒。預期四種都能明確選用，agy、pi 要先通過開放條件，Lead 要等到就緒。已確認根因（讀碼）：政策與 ISSUE-129 收尾的白名單只有兩種，autopick 只檢查 `agent.start` 回傳當下的狀態，`prepareCardWorktree` 也只認 idle。

修正：見 SPEC「四種 Lead 與開放條件」。四種共用常數、型別與 label；agy、pi 的開放條件 `leadGateFor`；來源 Lead 與 worktree 第二次啟動共用等待（`doneAsReady`）。不改使用者的 `policy.yml`、`config.json`。

驗證（2026-11-09，本機，假 Herdr port）：`npm run check` 為 1605 tests／1604 pass／0 fail／1 skipped；`npm run lint` 通過。涵蓋四種政策與 label、working → idle／done、blocked／逾時、安全更新跳過、worktree 啟動等待（working 與 blocked）、四種 cleanup label、開放條件不撿且不改用別的 Lead、原因換了會重新通報。

code-review（high，2026-11-09，只當參考，不是 bridge 的 review）：9 項發現，已修 5 項（worktree 的 blocked 也等待、通報以卡片加原因為 key、`leadRejection` 改用 `autopickFor`、等待訊息用 `role` 取代字串替換、還原格式雜訊）。**原審查未修項目（2026-11-09 ISSUE-132 已補卡片拒絕事件，待實機驗收）：**拒絕原因原本只有 console 警告；`doneAsReady` 轉接不帶 port 的選用 trust 方法、去重不與 reviewer 等待共用（Lead 與 reviewer 是不同 pane，影響低）；等待用真實計時而非注入的 `sleep`／`now`；開放條件只看 `implementation`、不看 `review`（刻意，使用者選項 2）；`done` 啟動即算就緒（與原本來源路徑一致）。

實機驗收（2026-11-09，本機 macOS，bridge 為 main `88e1ce6`（#189）merge 後重啟的程序；`policy.yml` 暫時設為 `autopick_lead: claude, codex`（備份 `policy.yml.bak-live-20261109`，驗收後已改回單一值 `claude`），`config.json` 沒改）：測試卡 `REQ-20261109-lead-live-codex`（`lead: codex`，改一個 `docs/card-runs/` 檔案）由 codex 當 Lead 走完：06:54:39Z 撿起，Lead workspace `w5J`（`autopick-codex-<卡片 id>`）與卡片 worktree `w5K`，06:54:50Z task 開始，06:59:31Z `completed`，06:59:40Z commit `a773038`，06:59:47Z 開 PR #191，CI 兩平台綠，squash merge `1448d51`，07:04:40Z 記 `merged` 與 `cleanup_done`，worktree 與 `w5J` 都已關閉。這證明 codex 當 Lead 時，來源 Lead 啟動與 worktree 第二次 Lead 啟動都沒有被「沒就緒」拒絕（我沒有直接觀察到 working 狀態，只看到 `w5J` 閒置、`w5K` 為 unknown 後流程正常往下走），label 與收尾清理在真實 bridge 上有效。**過程中不是全自動：**claude 當 reviewer 兩輪 `inconclusive`（見 ISSUE-134），loop 退回人工；我用 `card review --agent codex` 重試（第 3 輪 `pass`，07:03:59Z）並手動 `card merge`。**未驗：**agy、pi 的開放條件（宣告前不撿、宣告後撿）與當 Lead、claude 當 reviewer。

pi 實機驗收（見 ISSUE-137 的「實機驗收」段）：pi 當 Lead 的第 1 次（`REQ-20261109-pi-lead-live`）因第一個 prompt 被 Herdr 拒收失敗，修正後第 2 次（`REQ-20261109-pi-lead-retest`，PR #200）成功走完 task、review、自動 merge 與收尾；限制同上（一次、極簡任務、pi 只當 Lead）。

agy 實機驗收（2026-11-09，本機 macOS，bridge 為 main `ae356aa` 之後重啟的程序，`policy.yml` 為 `autopick_lead: claude, codex, agy`（使用者決定驗證後保留 agy，備份 `policy.yml.bak-agy-live-20261109` 是加入 agy 之前的版本），`config.json` 沒改（agy profile 本來就宣告 `implementation`））：測試卡 `REQ-20261109-agy-lead-live`（`lead: agy`，新增 `docs/card-runs/` 一個一行檔案）：07:38:22Z 撿起，Lead workspace `w5R`（`autopick-agy-<卡片 id>`）；07:38:33Z `role_assigned` 為 `lead：agy；…；leadSelection=card`，task journal 的 Lead 種類也是 agy；agy 規劃的計畫被 bridge 解析成功（`impl-1` codex 實作、`rev-1` codex review、`ver-1` claude 驗證，全部完成，Team 問題數 0，32 個事件）；07:40:29Z task `completed`；07:41:24Z commit `f64aeb4`；07:41:32Z 開 PR #196（只改一個檔案，內容 `ok`）；07:41:50Z reviewer（codex）第 1 輪 `pass`；07:44:04Z bridge 自動 squash merge `9875e8f`；07:44:24Z `cleanup_done`，worktree、agy 信任項目與 Lead workspace 都已移除；全程沒有手動介入，來源 Lead 啟動沒有停在信任提示。**這個結果能證明的有限：**只有一次、最簡單的任務；agy 只需要產出一個小計畫，沒有檢驗多輪、長 JSON、review 退回修正或 agy 當 reviewer 的情境；來源資料夾沒有被信任提示擋住的原因沒查（可能是先前已被信任，`agyTrustedDirectories` 只列 `/Users/jon/git_wk` 且不含子目錄）；ISSUE-130 記的幾個讀碼缺口（session 回寫、hook fallback、非 codex 長 JSON）這次沒有發作，但沒有被證明不存在；pi 完全沒涵蓋。

過程：本議題原在 REQ-20261109-codex-lead-agy（PR #185、#186，含多個 Lead、卡片指定），3 次 `card review` 用完仍 `changes_requested`，範圍縮小後改由 REQ-20261109-autopick-four-leads 重做；多 Lead 清單、卡片 `lead:`、Lead 選擇依據的紀錄、`card assign` 指定 Lead 都延後，另開卡。

未驗證／已知缺口：pi 當 Lead 的真實啟動；agy 只有一次極簡卡的證據（見上方 agy 實機驗收）、pi 連 Worker 的 coding 證據都沒有（規劃與階段見 `docs/multi-lead-plan.md`）。讀碼確認、尚未重現：`runTeamTask` 沒把第 0 輪新登記的 session 回寫 `input.lead`；`hookFinal` 有 session 時無結果不 fallback `stopForPane`；非 codex 的 terminal fallback 沒有 JSON 硬換行 unwrap。未部署、未重啟；原始碼與 build 不等於執行中 bridge，舊任務不補送。

## ISSUE-129：卡片結束後留下 autopick Lead workspace（REQ-20261109-autopick-lead-cleanup）

更新日期：2026-11-09。狀態：已驗收（2026-11-09，範圍與未驗證項見「實機驗收」段）。

症狀：autopick stopped／failed 後人工接手完成或取消卡片，Lead workspace 留著；bridge 重啟後原有 close handle 遺失。預期：卡片結束或 cleanup 成功後，以持久化身分安全關閉 Lead，不影響其他 workspace 或 cleanup 結果。

重現／環境：2026-11-09 本機 worktree，以假 Herdr port 與實體暫存卡片檔重現；本輪沒有 live 重現。已確認根因（讀碼）：原本只在 reached 使用記憶體 LeadHandle.close，卡片未記錄 workspace id，cleanup 只處理 card worktree。

修正範圍：autopick 開 workspace 後立即寫 frontmatter id／label；CardStore／parser／serializer 支援，外部 import 清除。手動／merge cleanup 與每分鐘終態掃描共用安全關閉函式，僅記錄 id＋現況相同且符合本卡的 autopick label 放行；in_progress 保留，活動中的 autopick 延後掃描，未結束 stopped／failed 保留，reached 不變。缺失、改名、API 錯誤只警告，不影響 cleanup 結果，不尋找其他 workspace。

測試（2026-11-09）：相關 `npm run build && node --test dist/test/card-cleanup.test.js dist/test/autopick-wiring.test.js` 通過，23 tests／23 pass／0 fail。涵蓋建立後持久化與寫入失敗、fresh CardStore 模擬重啟、done／cancelled／ready cleanup／in_progress、只關 Lead、不動 Worker／reviewer／個人 workspace、查詢缺失／標籤不符／查詢或 close 失敗只記 log 且 cleanup recording 不變。首次 build 因未安裝依賴找不到 tsc，`npm ci --ignore-scripts` 後解除。完整檢查（2026-11-09）：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 均通過；完整套件 1538 tests／1537 pass／0 fail／1 skipped（既有略過）。之後補外部匯入 metadata 清除測試及掃描錯誤保護，再跑 `npm run lint && npm run typecheck && npm run build` 與 `node --test dist/test/card-cleanup.test.js dist/test/autopick-wiring.test.js dist/test/card-import.test.js`，39 tests／39 pass／0 fail（2026-11-09）。完整套件數字不包含最後新增的 import 測試；最後版本以相關測試再驗證。`git diff --check` 通過（2026-11-09）。

Review 修正（2026-11-09，f1／f2；保留上述初版驗證歷史）：review 發現 f1，merge cleanup 可先關 Lead，之後 reached 再 close 得到 workspace not found，使成功 merge 被回報 failed。以假 port、實體暫存卡片及真正 `runAutopick`／`closeAutopickLead` 重現交錯。根因已確認：兩條關閉路徑未協調。本項因 review 重新開啟調查後已修正，狀態維持「已修正、待驗收」：close 失敗後查詢 workspace.list，僅在合法清單確認該 id 不存在時記警告並視為成功；workspace 仍在、回應不合法或查詢失敗仍保留原錯誤，其他 reached 行為與 cleanup 結果不變。f2 為 SPEC 舊段落仍寫名稱僅顯示／cleanup 不變／無 autopick 政策即不做事，現已同步為 label 守門、結束卡片 Lead cleanup 與不依政策啟用與否的終態掃描。新增交錯回歸測試及拒絕誤吞 close 錯誤的測試。相關 `npm run build && node --test dist/test/autopick-wiring.test.js`：15 tests／15 pass／0 fail（2026-11-09）。Review 修正後完整檢查（2026-11-09）：`npm run lint`、`npm run typecheck`、`npm run build`、`npm test` 全部 exit 0；完整套件 1543 tests／1542 pass／0 fail／1 skipped（既有略過）；`git diff --check` 通過（2026-11-09）。

Review2 文件修正（2026-11-09，f3）：README 的舊 autopick／merge cleanup／card cleanup 段落未同步，仍宣稱無 autopick 政策就不做事、無條件保留來源 workspace，與 SPEC 及 README 的 Lead 收尾段落矛盾。本項經 review2 重新檢查並修正：明載 done／cancelled 每分鐘掃描不受 autopick 政策區塊有無影響、活動中的 autopick 延後掃描；cleanup 以卡片記錄 id 與本卡 autopick label 核對後關 Lead，其餘來源 workspace 保留；in_progress 與未結束且未成功 cleanup 的 stopped／failed 保留，缺失／不符／失敗只記 log。狀態維持「已修正、待驗收」。本輪只改 README.zh-TW.md 與本紀錄，未改程式碼；已對照 SPEC、以 grep 檢查 README 舊矛盾敘述並執行 `git diff --check`，均通過（2026-11-09）。純文件修正未重跑 build 或測試，上述測試數字為先前執行證據。

Review3 文件修正（2026-11-09，f4）：SPEC 的 PR merge 自動清理段落仍無條件宣稱來源 workspace 不關閉，根因為舊段落漏同步；經 review3 重新檢查後補上 ISSUE-129 的記錄 id／label 核對、失敗只記 log、不改 cleanup 結果及其餘 workspace 保留例外。狀態維持「已修正、待驗收」。已對照 SPEC 命名／Lead 收尾段落與 src/main.ts 的 merge cleanup：只有每分鐘終態掃描在 autopick 執行中延後，merge cleanup 可先關 Lead，reached 以確認已不存在即成功處理；本輪未將尚未實作的「merge cleanup 延後」寫成現況，也未改程式碼。全面搜尋 SPEC.md、README.zh-TW.md、docs/known-issues.md 的 `不關閉|保留.*workspace|workspace.*保留|什麼都不做|不關.*workspace`，逐項檢視：README 已有例外；一般 routing／restart／pane／usage 與拒絕操作敘述無關，保留；舊 ISSUE-062／065／096／119 補現況註記，日期與原驗收證據不變。內容檢查及 `git diff --check` 通過（2026-11-09）。純文件變更未重跑 build／測試；執行中 bridge 未部署／重啟，未端到端驗收。

未驗證／下一步：原始碼已修改；執行中的 bridge 尚未部署／重啟，未做 Discord／Herdr／CLI 端到端驗收。Lead 需重啟後驗證完成／取消、重啟續清、人工改名與其他 workspace 保留。沒有 metadata 的舊卡不回填，不補送舊訊息。（撰寫此紀錄時尚未 commit；commit、PR 與 merge 以 PR 紀錄為準。）

實機驗收（2026-11-09，本機；bridge 以 main `1657138`〔含 #180〕於 10:50 重啟，10:59 為驗證重啟續清再重啟一次）：以三張只新增 `docs/card-runs/` 一個檔案的測試卡驗證（卡片檔在 plugin 狀態目錄、不進 git），結果如下，前面「未驗證／下一步」列的重啟與實機項目已在此處理。

- 卡 A（完成路徑，`REQ-20261109-lead-cleanup-live-a`）：autopick 撿卡後 Lead workspace w57 的 id／label 立即寫進卡片；跑到 PR #181 squash merge 後數秒內 Lead 消失，其他 workspace（bridge、git_wk、本 Agent、colab_llm）不動。merge cleanup 隨後發現 workspace 已不存在，只記 `workspace missing or label mismatch` warning，cleanup 仍回報 removed。**這張卡的 Lead 是被 autopick 自己的 reached 路徑先關掉，不是 cleanup 關的**，所以「done 卡由 cleanup 依持久化 id 關 Lead」沒有被這張卡單獨證明。
- 卡 B（重啟＋取消，`...-live-b`）：Lead w59 開著、卡片 in_progress 時重啟 bridge；重啟後 Lead 仍在，超過一次每分鐘掃描都沒被關（in_progress 保留）。把卡片改成 cancelled 後約 36 秒（11:01:28→11:02:04）Lead 被關，Worker workspace 與其他 workspace 保留。證明 cleanup 靠持久化的卡片紀錄（不靠記憶體 handle）能關 Lead，涵蓋取消與重啟續清。
- 卡 C（人工改名，`...-live-c`）：Lead w5B 被人工改名為「手動改名-lead-c」；卡片終態且 autopick 已停止後，掃描記 `workspace missing or label mismatch`，Lead 保留。卡 C 在改名前已跑到 done，我手動把狀態從 done 改成 cancelled，autopick 因此在 merge 步驟被拒（`card merge` 要求 done）而 stopped，PR #182 留在 open，驗收後手動關閉、未 merge。這是人工改狀態的副作用，不是產品行為。
- 測試後已關閉測試 workspace、worktree、本機與遠端測試分支、PR #182；三張測試卡片檔仍留在狀態目錄。

結論：狀態改為已驗收（2026-11-09，範圍僅限上述）。**未驗證：**done 卡由 cleanup（而非 reached）關 Lead、merge cleanup 自己關 Lead 兩條路徑沒有單獨實機觸發（只有單元測試）；沒有 metadata 的舊 Lead 不回填；Discord 端到端未驗（測試卡 `notify` 為 agent 形式，通知送進本 Agent pane）。**觀察（未開新 issue、待觀察）：**cleanup 對已不存在的 Lead 會重複記 warning（卡 A 在重啟後約 9 分鐘內出現 4 次，頻率與原因未確認），目前只是 log 雜訊，不影響 cleanup 結果。


## ISSUE-131：手動建立 worktree 開的 PR 無法用 `card attach-pr` 登記，也就不能 `card review`／`merge`／`loop`

更新日期：2026-11-09。狀態：待調查（根因已由讀碼確認；要不要修、怎麼修尚未決定，沒有修正、沒有測試）。

**使用者可見症狀：**卡片的分支與 PR 不是由 `card assign --worktree` 建立（例如手動 `git worktree add`）時，`card attach-pr <卡片 id> <PR 編號>` 回覆「卡片 … 沒有 worktree 紀錄，無法判斷它屬於哪個專案（要由 `card assign … --worktree` 建立過）」。結果這張卡不能 `card review`、`card merge`、`card loop`，bridge 也不追蹤它的 CI 與 merge；L2 專案只能人工 merge。

**預期行為：**ISSUE-123 的 `card attach-pr` 目的是讓人工接手的 PR 能登記回卡片。至少在卡片宣告的專案（`project`／`projects`）已被 `policy.yml` 的 `autopick` 選用、有明確 repo 路徑時，不需要 worktree 紀錄也能登記。

**重現／環境（2026-11-09，本機）：**bridge（pid 32824，10:59 啟動）的 console 執行 `card attach-pr REQ-20261109-autopick-four-leads 187`。該卡是 `draft`、`project: local:Herdr_Discord_Bridge`，分支 `card/REQ-20261109-autopick-four-leads` 由手動 `git worktree add` 建立，PR #187 在 GitHub 上正常（CI 綠）。對照：同日對有 worktree 紀錄的 `REQ-20261109-codex-lead-agy` 登記 PR #185 成功。

**已確認根因（讀碼，2026-11-09）：**`src/main.ts` 的 `attachPullRequest` 用 `lazyCardWorktrees().latest(card.id)` 取得 repo 路徑，沒有紀錄就丟錯；`src/card-merge-wiring.ts` 同樣依賴 worktree 紀錄。卡片的 `project`／`projects` 與 `policy.yml` 的 `autopick` repo 路徑沒有被當成 fallback。

**影響：**人工接手或自建 worktree 的卡，沒有 bridge 的獨立 review 與自動 merge 守門。實際發生：`REQ-20261109-autopick-four-leads`（PR #187）無法走 `card review`，改用 code-review 技能審查（只當參考，沒有 `review_verdict`），只能由人手動 merge（截至 2026-11-09 尚未 merge）。

**修正範圍：**無（只記錄）。建議方向：沒有 worktree 紀錄時，改用卡片 `project` 在政策 `autopick` 的 repo 路徑；只能使用政策檔已選用的專案，不能由卡片新增路徑（Agent 能寫卡片）。`card-merge-wiring` 要一併處理。

**暫行做法：**人工 merge；或用 `card assign <id> --worktree` 讓 bridge 建 worktree（會啟動任務，分支名稱已存在時預期會衝突，未實測）。

**相關觀察（2026-11-09，不是本 issue 的修正範圍）：**
- `card review` 只看單一 PR 的 diff（上限 20 個檔案、60000 字元）；程式與文件拆成兩個 PR 時，reviewer 看不到另一個 PR 的文件，`REQ-20261109-codex-lead-agy` 的第 1 到 3 輪 review 重複標出「文件未同步」「缺規劃文件」（第 3 輪用盡次數仍 `changes_requested`）。
- console 的 `team cancel <task-id>` 在 console 路由不在任務所屬 workspace 時回「task belongs to another workspace」；同日改用 `card cleanup` 清理 `blocked` 任務的 worktree（成功，分支保留）。任務本身沒有被取消，卡片仍是 `in_progress`（bridge 只在 task `completed` 才把卡片設為 `done`）。

**未驗證／下一步：**沒有實作與測試；是否採用 fallback 與其安全性要使用者決定。

## ISSUE-128：缺少 Agent usage 唯讀查詢（REQ-20261106-usage-query）

更新：2026-11-08。狀態：重新開啟後再修正、待驗收（PR #172 已 merge、bridge 以 e69828f 重啟後實機查詢發現真實 codex 畫面讀不到用量，已另開 PR 修正）。

**實機發現（2026-11-08，本機，bridge 載入 PR #172 後，`wk use w3` 再 `usage`）：**指令可用，profile 列、遠端機器列與跨 workspace 拒絕都符合設計；但 codex pane `w3:p3` 顯示 `unknown (no readable passive usage for this CLI)`，而它的畫面底部其實有用量。真實底部是 `  GPT-6.1-Sol low · 5h 64% left · weekly 67% left`，其下還有一行 `  ← for agents · ? for shortcuts …` 的快捷鍵提示。**根因（已確認）：**原 `parseUsage` 只看最後一個非空列，且要求整列恰為 `5h N% left · weekly N% left`，但真實畫面用量在倒數第二列且前面有模型名稱，所以真實 codex 永遠讀不到；單元測試用的是合成格式，沒有抓到。**修正：**改成在底部最後 4 個非空列找整列恰為（可帶模型名稱前綴的）用量格式的那一列，只輸出用量字樣、不輸出模型名稱，並新增真實畫面佈局的測試；原本「用量列後面還有其他文字就拒絕」的案例因真實畫面本來就有提示行而移除。測試：`npm run build` 通過、`test/usage.test.ts` 5/5 pass（2026-11-08）；**修正後實機驗證（2026-11-08，本機，bridge 以 main `143ec57`〔含 PR #173〕重啟後，console `wk use w3` 再 `usage`）：**codex pane `w3:p3` 顯示 `5h 64% left · weekly 67% left`，來源 `bottom status line (visible snapshot; CLI freshness unknown)`；claude pane `w3:p1` 顯示 `unknown (no readable passive usage for this CLI)`；`profile:*` 列與 `agy-pod` 列為 `unknown`（附原因）。**尚未驗證：**Discord `/herdr usage`、遠端機器上的 pane、忙碌（working／blocked）codex pane 的讀取；仍待使用者驗收。

症狀／預期：原本只有 quota status 的操作者觀察，無法彙整 CLI usage；應以 console `usage [pane-or-profile-id]`／Discord `/herdr usage [pane-or-profile-id]` 查詢，無資料則 unknown，不干擾 Agent。重現環境：本卡 worktree，假 Herdr／Discord 單元測試；尚未在真實 Discord／Herdr／CLI 驗證。

已確認根因：原本未有 usage command 或 adapter hook，不是 quota status 能量測的資料。修正範圍：共用指令、SHORT_COMMANDS、獨立只讀 usage table、adapter parseUsage、profile exact session 唯讀查找、遠端連線狀態；沿用 quota status 選定 workspace 與 allowlist，跨 workspace／未知／歧義拒絕。每列機器、目標、種類、原 usage 字樣／單位、來源、本次擷取嘗試時間。Codex 僅接受完整最後非空狀態列，其他種類無安全來源時 unknown；解析拋錯與讀取失敗逐列降級，不輸出任意畫面／錯誤內容。不估算、不讀 credentials／帳號／API key／billing，不寫 observations，不觸發 failover。

三項預設決策：①目前選定的授權 workspace＋設定遠端；遠端 pane 仍限該 workspace，不可達機器 unknown，已連線但該 workspace 無 pane 也明示 unknown。②v1 全部只被動讀取，working／blocked／idle／done 都不送 usage 指令或按鍵。③僅純文字表格，無 JSON。

資料限制：fetched-at 是畫面／連線查詢時間，不代表 provider 更新時間；source 明載 CLI freshness unknown，不保證畫面額度即時。沒有 usage 快取；遠端快取只有 pane metadata，不顯示為目前用量。Profile 只有設定未啟動、綁定不確定、session 無法安全核對都 unknown，不按名稱／種類猜綁定；claude／agy／pi 被動解析另案，無主動 /usage 支援。

測試（2026-11-08，本機）：初次 `npm run typecheck` 因缺少 tsc 失敗，`npm ci --ignore-scripts` 後解除。第一輪 `npm run typecheck`、`npm test` 通過（1522 tests，1521 pass、0 fail、1 skipped）；補 profile／remote 測試前的 `npm run build` 與 `node --test dist/test/usage.test.js` 通過（3/3）。最終版本 `npm run typecheck`、`npm run build`、`npm run lint`、`git diff --check` 全部 exit 0；`npm test > /tmp/usage-query-acceptance.log 2>&1`（內含 build）exit 0：1524 tests，1523 pass、0 fail、1 skipped（既有略過），耗時 66.8 秒。usage 專項 4 tests 與 profile session 查找測試均通過。

未驗證／下一步：原始碼已實作；未部署、未重啟，執行中 bridge 版本未核對，舊訊息不補送。Lead 部署後需驗收兩端路由／授權、busy 不送鍵、Codex 真實底列、遠端斷線與 profile session 綁定；尚未實機驗證 Discord／Herdr／CLI，不得視 build／unit test 為端到端驗收。不修改 config.json／policy.yml，不 commit／push。


## ISSUE-127：卡片缺少角色與實際 Agent 的對應（REQ-20261108-role-agents）

更新日期：2026-11-08。狀態：**已驗收**（使用者 2026-11-08 明確表示驗收）。**實機驗證（2026-11-08，本機 macOS，bridge 以 main `35e56cf`〔含 PR #166〕重啟後）：**驗收卡 `REQ-20261108-role-ledger-live`（PR #168，已關閉不 merge）由 autopick 跑完，流程紀錄依序寫入 `role_assigned`：lead＝claude／local、impl＝codex／local／profile `helper`、verify＝claude／local／profile `claude`、review＝codex／local／profile `reviewer`，以及 reviewer 第 1、2 輪＝codex／local；`card show` 的「角色紀錄」列出同樣六筆。該卡的 review 兩輪皆 `inconclusive`，原因是第 3 條驗收條件要看 `card show`，reviewer 只看得到 PR diff（卡片設計問題，非程式缺陷）。舊卡與舊事件不補寫角色。

症狀／預期：原本 `assigned` 只含 Lead 種類，review／fix 事件不含執行者，Team assignment 的 Worker 身分只在 task journal；卡片應能查到每次角色由誰擔任。重現環境：本機 worktree、假 Herdr／Git port，無真實服務。已確認根因：原事件契約與 card show 沒有角色事件或投影，啟動流程沒有接到卡片帳本。

修正範圍：新增固定模板 `role_assigned`，保存 role、CLI 種類、machine、已知 model／profile id、task id 或 review／fix 輪次。CLI 種類經 `agentDisplayName` 共用 `identifyCli`，再用既有 AGENT 格式驗證；Team 使用 Lead 原 assignment id，記錄 acquire 後的實際 Worker，profile 僅取設定中的 id／model。Lead 啟動與 card assign 接線共用穩定 id，避免先後寫入重複；reviewer／fixer 在 Agent 成功啟動後、等待與派工前記錄（包含之後 inconclusive／失敗的輪次）。只投影允許的身分欄位，不保存 session、prompt、輸出、描述或 credentials。

冪等／失敗：id 是 task id、role、round 與執行者（agent、machine、profile id、model）的 SHA-256 截取值，同一個執行者在同卡片同作用域重送／重啟只留第一筆；同 review／fix 輪換另一個執行者重試會另記一筆（原本只以角色與輪次去重，換 agent 的新事件會被丟掉，卡片仍顯示第一次失敗的執行者——bridge 獨立 review 第 2 輪 F1，已修正）。Team 的 assignment id 與 Lead 的 `lead` 同形時，原本兩者事件 id 完全相同、Worker 身分被去重掉（同輪 F2）；現在這類 assignment 的角色名加 `assignment-` 前綴。兩項都先寫會失敗的測試（card-events、team-orchestration 各新增）再修。第 3 輪的 F3（事件 id 缺 model 與啟動次數識別）：model 已納入 id（換 model 另記一筆，先寫紅燈測試）；**已知限制（刻意不做）**：同一個 agent／machine／profile／model 在同一輪重新啟動（新 session）仍被視為同一筆——卡片上顯示的角色、agent、machine、profile、model 完全相同，另記一筆只會重複，不增加資訊；若日後需要區分每次啟動，要另外持久化啟動識別（pane／terminal id），不在本卡範圍。第 4 輪的 F4（`src/main.ts` 的 profile Worker 以設定的 model 覆蓋 `acquired.agent.model`）：**不改程式，已記為限制**——Herdr 的 `AgentRecord` 型別沒有 `model` 欄位，bridge 拿不到 Worker 實際使用的模型，能記的只有 profile 設定、啟動時帶入的 model；因此角色紀錄的 model 是「profile 設定值」，不是即時驗證過的實際模型，新啟動的 Worker 若在啟動後被手動切換模型，紀錄不會跟著變。沒有 profile 的 Worker（直接指定 pane）不記 model。finding 以 `dismissed` 處理並附此理由。**第 5 輪 F5 指出更精確的一點並已修正：**重用或綁定（`AgentPool.bind`）的既有 session，bridge 沒有帶 model 啟動、也沒確認過，卻把 profile 的 model 記成事實；現在只有 `acquire` 回傳 `continuity: new-session`（bridge 用該 profile 啟動新 session，啟動時帶了 model）才採用設定的 model，`same-session`／`unknown` 一律省略；Agent 自己回報的 model 永遠優先。接線抽成 `withProfileIdentity`（`src/card-events.ts`）並有單元測試（先紅後綠）。沿用 CardStore 的旁檔輪替與去重。role ≤64、agent／profile 沿用 AGENT ≤40、model 為單行識別碼 ≤80、整筆仍 ≤300 字，不合法或超限拒絕。寫入拋錯或回傳拒絕只印固定 console error，不改流程結果、不放入通知。`card show` 從完整 readLog 按時間排序，在同一行顯示角色與種類及已知 model；舊卡顯示「沒有角色紀錄」，不從舊 assigned 事件推測角色。

測試（2026-11-08）：先紅後綠；事件／show 新測試先失敗，review／fix 回呼測試先失敗。初始 `npm run build` 因缺少 tsc 失敗，`npm ci --ignore-scripts` 後解除。開發中另修正新增假 port 的 session kind（需 `id`，不是 `session_id`），未放寬產品身分守門。相關五個檔案測試 198/198 pass；**接手後完整檢查（2026-11-08，我接手 Worker 輸出、rebase 到 main `8ac0eb7` 後，在卡片 worktree）：**`npm run build` 通過，完整測試 1510 項、1509 pass、0 fail、1 skipped（原 Worker 因 codex 沙箱與逾時未能跑完整套件）；修正 bridge 獨立 review 第 2 輪的兩個 medium（F1、F2，見冪等／失敗段）後再跑一次：build、lint 通過，完整測試 1512 項、1511 pass、0 fail、1 skipped；F5 修正後再跑一次：1513 項、1512 pass、0 fail、1 skipped。接手時 issue 編號由 Worker 寫的 ISSUE-125 改為 ISSUE-127（main 上 125／126 已被佔用），其餘檔案的引用同步。

未驗證／下一步：原始碼已接線；執行中的 bridge 未部署、未重啟。Lead 應在部署後以新卡驗收 Lead、profile Worker、多輪 review／fix、card show 與重啟去重；舊卡不回填、舊訊息不補送。可選的 card pr／card attach-pr PR 內文角色摘要本輪未加入，PR 內文保持現行行為。權限、review、CI、merge gate、ISSUE-120 通知、config.json、policy.yml 均未變更。接手前 Worker 未 commit、push、merge；PR 與 review 的狀態以卡片流程紀錄為準。

## ISSUE-126：bridge 重啟後進行中的 Discord 串流被靜默丟掉，最後回覆沒有送到 Discord（REQ-20261108-discord-reply-lost）

更新日期：2026-11-08。狀態：已修正、待驗收。**尚未實機驗證**。

**症狀／預期：**使用者在 Discord 驅動的同一回合內重啟 bridge 後，Herdr 看得到最後回覆、Discord 沒收到。預期續傳失敗須記原因，之後受信任的 Stop 最後回覆仍可補貼到原 thread。

**原始證據（2026-11-08）：**重啟後 console 只有 `hook Stop … chars=896`，沒有 `Resuming stream …`；附圖 `.herdr-discord-bridge/attachments/message-xbhkZw/1.png` 的終端文字重疊與 Discord 遺失是否相關仍未確認。

**測試證實的根因（2026-11-08，假 Herdr／Discord port）：**原 resumeStreams 在 fetchMessage 回 undefined 時靜默刪除記錄，後續 Stop 沒有補送路徑；新增重現測試先得到 0 則而非 1 則的預期失敗。adapter 原本吞掉所有 fetch 錯誤，無法區分確定不存在與暫時故障。**真實重啟當下 fetchMessage 實際回傳 undefined 或拋出什麼、其原因仍未確認**；測試只證實此程式路徑可造成遺失，未證實它就是該次實機事件的成因。

**修正範圍：**src/main.ts 記錄所有不續傳分支的 terminal／pane／原因；undefined 與暫時錯誤最多抓取 3 次、間隔 2000ms（匯出常數、可注入 sleep），Unknown Message／404 不重試。src/discord.ts 保留抓取錯誤，補送沿用分段／長度與禁止 mention 的策略。src/hook-events.ts 提供 Stop 訂閱，啟動時已有的事件也查詢；src/stream-resume.ts 在同一 active-streams.json 保留 pending／claimed。放棄續傳後僅對原 terminal／pane、session（或無 session 時的 pane）匹配且通過既有 hookReplyTrusted、auto 模式的非空最後回覆，新貼「bridge 重啟後補送」到原 thread。送前持久化認領，並行、重複事件與再重啟不重送；無回覆／不可信回覆不送，失敗只記 log、不影響其他串流。授權、allowlist、mention 守門、ISSUE-120 通知均未放寬或修改；未修改 config.json、policy.yml。

**測試（2026-11-08，本機，僅假 port）：**首次 build 因未安裝依賴找不到 tsc，以 `npm ci --ignore-scripts` 安裝後解除。先執行 `npm run build && node --test dist/test/stream-resume-lost-reply.test.js` 得預期 red（0 pass／1 fail）；修正後新增測試 8/8 pass。初版相關檢查命令：`npm run build`；`node --test dist/test/stream-resume-lost-reply.test.js dist/test/stream-resume.test.js dist/test/response-delivery.test.js dist/test/response-stream.test.js`，43/43 pass、0 fail。涵蓋重試成功／用盡、undefined、Unknown Message／404 不重試、agent 不見與已有串流 log、信任守門、無最後回覆、重複與再重啟、失敗隔離、分段與 allowedMentions；新測試攔截 console.log／warn／error，既有 response-delivery 測試也攔截，避免應用程式 log 污染 stdout。未跑全套 npm test。

**Review 修正（2026-11-08，f1／f2／f3）：**f1 在 Agent 查詢、fetchMessage（成功或拋錯）、重試 sleep 之後重查 activeStreams 與 store 原紀錄所有權，失去所有權就記 terminal／pane／原因並停止，不覆寫新回合；補送在查詢、信任檢查後同樣重查，防止新 final 貼到舊 thread。f2 補送改用一般 final 的 splitFinalMarkdown，保留標註與禁止 mention，驗證長 code fence 平衡與連續 emoji surrogate pair 完整。f3 清除到期紀錄時記 terminal／pane／「紀錄逾期」，原 24 小時邊界不變。三項均先新增失敗測試：f1 為 43 pass／4 fail，f2 為 47 pass／2 fail，f3 為 49 pass／1 fail；修正後使用上述相同 build 與四檔 node --test 命令，最終 50/50 pass、0 fail（新增檔共 15 項），無應用程式 stdout。過程中一次 build 因所有權檢查誤插位置出現 TS2304／TS1107，已移至正確位置，最終 build 通過。尚未實機驗證，實際 fetchMessage 原因仍未確認。

**第 2 輪 review 修正（2026-11-09，F2，由 Lead 接手，因 fixer 沒有產出）：**根因（已確認）：補送嚴格比對 `sessionKey`，但它只在送出 prompt 時寫入；`streamAgent` 合法接受「回合中首次登記 session」或「同回合新建 session」時沒有同步，重啟後的可信 Stop 會被永久拒絕；沒有該欄位的舊紀錄也會拒絕有 session 的 Agent。修正：`StreamResumeStore.updateSession` 在 `streamAgent` 兩個合法轉移點同步並持久化；回合開始時沒有 session 記成空字串（與「欄位不存在＝舊版紀錄」區分）；舊版紀錄無從比對，維持 #170 之前的行為（只靠 Stop 事件的 session 與 startedAt 篩選）。同回合轉移之外的 session 變更仍拒絕補送。測試（2026-11-09，本機，假 port）：`node --test dist/test/stream-resume-lost-reply.test.js` 20/20 pass；新增 4 項（updateSession 持久化、首次登記補送、舊紀錄、`streamAgent` 實際寫入）；暫時停用同步後 `streamAgent` 那項轉紅、還原後轉綠。全套與實機尚未驗證。

**第 3 輪 review 修正（2026-11-09，F3）：**根因（已確認）：同步只發生在 `streamAgent`；回合開始時沒有 session、停機或抓取重試期間才首次登記 session、且抓取最終失敗時，沒有任何程式會同步，pending 紀錄永遠拒絕可信 Stop。修正：`relayRecoveredStreams` 自己辨識合法轉移——回合開始時無 session 而現在首次登記，或 codex／agy／pi 在回合開始後才建立新 session（與 `streamAgent` 同一套 `sessionCreatedSince` 判斷）——記 log、持久化新 session 後補送；其他 session 變更（例如 claude 換 session）仍拒絕。測試（2026-11-09，本機，假 port）：`node --test dist/test/stream-resume-lost-reply.test.js` 20/20 pass；原「手動 updateSession 後才補送」的測試改成不經 `streamAgent` 同步、直接由補送路徑辨識首次登記並持久化。全套與實機尚未驗證。

**已知限制（2026-11-09，第 5 輪 review F4，使用者決定不在本 PR 處理）：**`relayRecoveredStreams` 查詢 Herdr 拋錯（暫時故障）時該筆直接結束，沒有重試；之後只有 bridge 啟動或別的 Stop 事件才會再觸發補送，所以若那是唯一的最後 Stop 又恰逢查詢故障，pending 回覆不會送出。第 5 輪 review 對 7 項驗收條件皆為通過，F2、F3 已不再被提出。下一步：另開卡為補送加有限次、可注入計時的重試與「無後續 Stop」測試。

**實機結果（2026-11-09，本機，bridge 以 main `367b552`〔含 #170〕重啟後）：**使用者從 Discord 對 `w1:p1` 傳「跑 sleep 60 然後回答 ok」，進度訊息出現後重啟 bridge。console 記 `Resuming stream terminal=… pane=w1:p1`（一般續傳，進度訊息抓得到），回答送出後收到 `hook Stop`、`active-streams.json` 清空，沒有 `Stream not resumed`／`not recovered`；使用者確認 Discord 收到最後回覆、只有一則。這筆紀錄由舊 bridge 寫入、沒有 `sessionKey`，也順帶走過舊版紀錄路徑。**尚未實機驗證：**ISSUE-126 原本的失敗情境（重啟時進度訊息抓不到，走「bridge 重啟後補送」）沒有被製造出來，補送路徑、重試用盡與 session 轉移仍只有假 port 測試；實際 `fetchMessage` 當時的回傳也仍未確認。因此維持「已修正、待驗收」，不標已驗收。下一步：製造進度訊息抓不到的情境（例如回合中刪掉進度訊息再重啟）驗補送路徑。

**限制／下一步：**尚未實機驗證 Discord／Herdr；原始碼與 build 已完成，執行中的 bridge 未部署、未重啟，交 Lead 安排實機重啟續傳／補送驗收。送前認領後若當機或補送失敗（含部分送出），為避免重複不自動再送；寫盤失敗不送。紀錄沿用 24 小時有效期，新回合取代同 terminal 的舊紀錄。bridge 停機期間未收到的 hook 不會憑空恢復；舊版本已刪除的記錄與既有遺失訊息無法追溯補送。未 commit、未 push，未連真實 Discord／GitHub，未執行 herdr 指令。

## ISSUE-125：codex Worker 反覆停在 `npm test` 的權限提示逾時失敗，改為 helper 暫時最大權限（需提醒：目前仍在 VM）

2026-11-08。狀態：已處理（設定，使用者決定）、待驗收；**需要提醒使用者重新評估**。

**症狀：**2026-11-07 至 11-08，codex Worker 在卡片 worktree 內跑完整 `npm test` 時，沙箱擋測試用的 Unix socket（`listen EPERM`），跳權限提示，沒人處理就逾時，整張卡失敗，至少 5 次（`flow-notify`、`agy-worktree-trust`、`role-agents` 等，與 ISSUE-115 同一類）。卡片文字要求「只跑相關測試檔」不可靠。

**已確認根因：**codex 的 workspace-write 沙箱不允許測試用的 Unix socket；每個 Worker 都是新開的 codex，先前「允許一次」的授權不會延續，所以每次都會再問。

**決定（使用者 2026-11-08）：**`agentProfiles` 中 `helper`（codex，實作與驗證的 Worker）的 `args` 設為 `["--dangerously-bypass-approvals-and-sandbox"]`（無沙箱、不問批准）。`reviewer` 這個 codex profile 與 Lead、`agent start`、其他 Agent 種類**都沒有改**。設定在使用者的 `config.json`（備份 `config.json.bak-codexperm-20261108`，旁邊有註解提醒）；沒有改程式。

**追加（使用者 2026-11-08 稍晚）：**`reviewer`（codex，review／verify）也套用同樣參數。再現：卡片 `REQ-20261106-usage-query` 的 verify 被派到 `reviewer` profile，完整 `npm test` 在沙箱下 `listen EPERM`，pane（`w54:p3`）停在「是否允許在 sandbox 外重跑 npm test」的確認提示，Herdr 狀態 `blocked`，等滿 30 分鐘後 verify 逾時，task 失敗。備份 `config.json.bak-reviewerperm-20261108`，旁邊同樣有註解提醒。Lead 目前是 claude（`policy.yml` 的 `autopick_lead`），沒有 codex Lead profile，所以沒有 Lead 需要改。`agent start` 與其他 Agent 種類仍沒有改。**這次追加尚未驗證**：設定改了，但 bridge 尚未重啟載入，也還沒有以新設定跑過 verify。

**實測（2026-11-08，本機，探針 tab，已關閉）：**以該旗標啟動 codex，直接 `idle`、`interactive_ready: true`，沒有多出確認畫面；請它在 `/tmp` 建立並關閉一個 Unix socket 監聽，回報 `listening`，沒有任何權限提示，沒有殘留檔案。

**風險與提醒：**這些 agent 目前還跑在這台 VM 上，最大權限的風險（可任意改檔、刪檔、連網）由這台機器承擔。使用者預期之後 agent 會跑在 pod 內，屆時才合理放寬。**移到 pod 之前與之後都要重新評估；VM 上若不需要就改回 `"args": []`。**Agent 的專案記憶已記下這個提醒。

**未驗證：**設定要重啟 bridge 才會載入（2026-11-08 寫下時尚未重啟）；真實 Team 任務中 `helper` 不再卡在 `npm test` 尚未驗證。

## ISSUE-124：Worker 做完但超過 15 分鐘等待上限，整張卡被判失敗（REQ-20261107-attach-pr）

2026-11-07。狀態：已修正、待驗收。**尚未實機驗證**（沒有在真實 Herdr／Discord 讓 Worker 逾時確認新訊息與通知；bridge 尚未重啟載入）。要放寬 Worker 單一回合上限請改 `config.json` 的 `teamTurnTimeoutMs`，**不要**改 `approvalTimeoutMs`。

**症狀與確認的事實：**`REQ-20261107-attach-pr` 的 claude Worker 做完實作（整套測試 1454／1455 通過），做了約 15 分 30 秒，整張卡仍被判失敗，訊息只有「沒有通過的 review、沒有成功的 verification」，沒說是逾時。`team-tasks/<task id>.json`（2026-11-07）：`impl` 的 `blocker` 是 `herdr agent.prompt: timeout timed out waiting for agent status`（13:52:28Z 到 14:07:34Z，約 15 分 06 秒）；`review`、`verify` 是 `dependency impl did not complete`，連帶失敗。Worker 產出完整留在 worktree。

**根因（讀碼）：**Lead 規劃、每個 Worker、Lead 彙整三種回合的等待上限都傳 `config.approvalTimeoutMs`（預設 900000 毫秒 = 15 分鐘），與「批准提示多久過期」共用一個設定；調高它會連批准有效期一起改。整張卡另有 45 分鐘上限（`src/autopick-wiring.ts`）。

**修正（2026-11-07 至 11-08）：**`src/config.ts` 新增 `teamTurnTimeoutMs`（預設 1800000 = 30 分鐘，驗證沿用 `positiveInt`），`src/main.ts` 的 Team 任務改用它，批准提示仍用 `approvalTimeoutMs`；`src/team-orchestration.ts` 的回合逾時失敗寫明 assignment、等待時間與上限，依賴它的 assignment 註明被誰連累並提示產出可能在 worktree，且逾時摘要排在失敗原因**最前面**（卡片只保留前 200 字元）；`src/card-notify.ts` 把它分類為「等待逾時」，只放一句分類原因。

**獨立 review（`card review` 第 2 至 6 輪，reviewer codex）抓到並修正：**F1 `positiveInt` 遇 `{"toString": null}` 會拋 `TypeError` 使 bridge 無法啟動（所有數值設定共用，`approvalTimeoutMs` 本來就有）；F2 派工前取得 Worker 的 RPC 逾時被誤報為回合逾時；F4 逾時資訊排在最後會被 200 字元截掉；F5 補批准有效期測試（兩個不同設定值驗證 9000 而非 4000）與接線守門（讀 `main.ts` 原始碼，**不是端到端**，已實際改錯接線確認會紅）；F6 彙整失敗或受阻時漏掉 Worker 逾時摘要；F7 只認 `runTeamTurn` 自己的回合期限錯誤（Herdr 端 `agent.prompt／agent.wait: timeout`、`Timed out waiting for current response`），回合內短 RPC 逾時原樣回報；F8 F6 的修正在真實引擎裡沒生效（引擎用向外丟出的錯誤再記錄一次，覆蓋詳情），現在丟出的錯誤也帶摘要，並補經過 `TeamTaskEngine.run()` 的整合測試；F9 舊版 Herdr 的 `promptAgent`（約 5 秒）逾時訊息與 bridge 端 request 逾時相同，無法區分，**不再當成回合逾時**。多數修正都先確認測試紅燈再修。

**測試（2026-11-08，本機非 sandbox，Node 26.12）：**build、lint、prettier 通過，整套 1477 項，1476 pass、0 fail、1 skipped，輸出無多餘 stdout。

**限制／未驗證：**分類靠錯誤訊息格式比對，Herdr 或 `runTeamTurn` 日後改訊息只會少了逾時標記，不會誤報；批准提示沒有用真實 `DiscordAdapter` 的端到端測試；Worker 仍在 `working` 時是否延長等待、是否自動重送（設計取捨）**沒做**，待使用者決定；沒有放寬任何權限、review、CI、`card merge` 守門。這張卡的 Team 任務曾因寫入範圍守門（`config.example.jsonc` 不在 Lead 列的範圍）被判失敗，另有 codex Worker 停在 `npm test` 的權限提示（ISSUE-115），由人工接手。

## ISSUE-123：任務失敗後人工接手開的 PR 無法登記回卡片，bridge 不追蹤 CI／merge、不通知、不能走 card review／merge（REQ-20261107-attach-pr）

2026-11-07。狀態：已修正、待驗收。**尚未實機驗證**（沒有對真實 GitHub／Herdr／Discord 執行過 `card attach-pr`）；bridge 尚未重啟載入。

**症狀：**卡片的 Team 任務失敗（ISSUE-113、ISSUE-115）後停在 `in_progress`，由人或 Agent 接手開 PR。`card pr` 只接受 `done`，所以沒有 `card-prs.json` 登記與 `pr_opened`／`ci_result`／`merged` 事件，ISSUE-120 不通知（使用者 2026-11-07 回報 CI 結束沒有通知），`card review`／`card merge`／`card loop` 也找不到 PR。

**已確認根因（讀碼）：**登記只由 `card pr`（`openCardPullRequest`）寫入且要求 `done`；`checkMergeable` 也要求 `done`；沒有登記「已存在的 PR」的路徑。

**修正（2026-11-07）：**新增 `card attach-pr <卡片 id> <PR 編號或完整網址>`（console 與 Discord `/herdr`）。**這是「任務失敗後人工接手」的補洞，不是讓任意 PR 都能登記。**任何一項不成立就拒絕、列出所有原因、什麼都不寫（條件見 SPEC.md：卡片 `in_progress`／`done` 且無工作在跑、政策至少 L1、PR 開著且非 fork、head 分支 `card/<卡片 id>`、base 為預設分支；重複登記冪等）。寫入只有同一份 `card-prs.json` 的一筆登記、`## 異動專案` 的 PR／head、`pr_opened` 事件（`pr-<編號>-opened`）；只讀 GitHub，不 push／merge／強制／改 PR，不改卡片狀態。放寬的只有「卡片必須 done」：`card merge` 改為 done 或（in_progress 且 PR 已登記），其餘守門（L2、review 通過在目前 head、CI 全綠、PR 乾淨且最新、無敏感路徑）完全不變；`card loop` 的 push 對 in_progress 且已登記開著 PR 的卡可 push。

**測試（2026-11-07，本機）：**先寫 `test/card-attach-pr.test.ts`（假 GitHub、假 port，不輸出 stdout），實作前無法編譯（red）；涵蓋合法登記、各拒絕條件、冪等、登記後 `card merge` 守門不放寬、ISSUE-120 通知、無寫入類呼叫。既有測試未刪：`test/card-merge-wiring.test.ts` 兩處以 `in_progress` 代表「非 done」，改以 `ready`（同樣斷言拒絕）。完整套件結果見本輪回報，不等同端到端驗收。

**接手時補充（2026-11-07）：**Worker 的實作完整，但任務因逾時被判失敗（見 ISSUE-124），由人工接手檢查。檢查發現並修正一處漏洞：Worker 讓 `openCardPullRequest` 對 `in_progress` 卡片只看本機登記的 PR 狀態，登記資料過期（GitHub 上實際沒有開著的 PR）時會走到 `pr create` 開出**新的** PR，等於繞過「只有 done 才能開新 PR」；Worker 自己的測試只斷言「不丟錯」，反而把這個行為當成預期。現在 `in_progress` 的卡片必須在 GitHub 上找得到這個分支開著的 PR 才會 push，否則在 push 與 `pr create` 之前就拒絕。已先確認新增測試在沒有這個檢查時會失敗（red），有檢查時通過。測試（2026-11-07，本機非 sandbox，Node 26.12）：`npm run build`、`npm run lint` 通過；`node --test dist/test/*.test.js` 1458 項，1457 pass、0 fail、1 skipped（既有的略過），輸出沒有多餘 stdout。

**未驗證／限制：**尚未實機驗證、bridge 未重啟、舊事件不補發；需卡片有 worktree 紀錄（同 `card pr`）；卡片沒有 `notify` 仍不通知（ISSUE-121）；動到 `src/github.ts` 等敏感路徑的 PR，`card merge` 仍拒絕，需人處理。下一步：用真實卡片與真實 `card/<id>` PR 驗收登記、通知與 `card merge`。

## ISSUE-122：自動建立的 pane 讓一個 tab 擠進超過 2 個 pane，新 tab 也沒有名稱（REQ-20261107-tab-layout）

2026-11-07。狀態：已修正、待驗收。**尚未在真正的新 tab 退路情境實機驗證**；bridge 尚未重啟載入。

**症狀：**`chooseSplitTarget` 只看尺寸（ISSUE-108），一個 tab 仍可能被連續分割成 3、4 個 pane（2026-11-07 的 `flow-notify` 卡，一個 workspace 同時有 Lead 加 3 個 Worker），Lead 與 Worker 的畫面被擠小；PR #151 的新 tab 退路建出的 tab 標籤是 Herdr 預設的數字（實測 `label: "3"`），從 tab 列看不出是哪個 reviewer／Worker（使用者 2026-11-07 的要求）。

**修正（2026-11-07）：**`createAgentPane`（`src/pane-split.ts`）先數基底 pane 所在 tab 的 pane 總數（含 Lead、使用者的與其他 Agent 的），已有 2 個以上就不分割、直接 `tab.create`；只剩基底時才套用 ISSUE-108 的尺寸規則。只有這次自己建立新 tab 時才回傳 `tabId`，呼叫端（profile Worker、`openReviewerPane`、`agent start`）把它傳給 `nameAgentPane`，以 `tab.rename` 用與 pane 同一個 `agentDisplayName` 結果替新 tab 命名；分割出的 pane 不命名任何 tab，也不命名 Lead 或使用者的 tab。命名失敗只警告；關閉仍只靠 id 與 terminal id。

**測試與實測（2026-11-07，本機非 sandbox，Node 26.12）：**`npm run build`、`npm run lint` 通過；`node --test dist/test/*.test.js` 1446 項，1445 pass、0 fail、1 skipped（既有的略過），輸出沒有多餘 stdout。新增涵蓋：tab 內已有 2 個 pane（含使用者的）即使尺寸夠大也直接開 tab；連續建立 3 個 pane（第 1 個分割、第 2、3 個各開新 tab，沒有任何 tab 超過 2 個 pane）；只有自己建立的 tab 才被命名、分割時不命名、命名失敗不影響；`tabId` 在 workspace 不符或沒有 tab id 時不回傳；關閉流程不依名稱。因規則改變，`test/pane-split.test.ts` 原本「作者的 pane 太小就改從同版面別的 pane 分割」的測試改為「已有 2 個 pane 就開新 tab」，其餘既有測試未刪或弱化。**`tab.rename` 實測（人工，Worker 以外）：**2026-11-07 在真實 Herdr，對自己開的探針 tab 呼叫 socket `tab.rename`，參數 `tab_id`、`label`，回傳 `type: "tab_info"`，`tab.label` 為新名稱，探針已關閉。

**未驗證／限制：**「真正因為 tab 已滿而開新 tab、tab 列上名稱是否正確出現」沒有實機驗證；新 tab 的 root pane 關閉後 Herdr 是否自動移除空 tab 沿用 ISSUE-108 的待驗收；每個溢出的新 tab 只放一個 pane，不重用舊 tab，所以 tab 數會變多；執行中的 bridge 尚未重啟載入。這張卡的 Worker 因要求矛盾（同時禁止並要求 socket 探針實測）而權限提示逾時失敗（ISSUE-115），產出由人工接手完成。

## ISSUE-121：Agent 自己寫的任務卡片沒有 `notify`，進度不會通知任何人

2026-11-07。狀態：已修正、待驗收（規則與警告；尚未實機驗證）。

**症狀：**使用者從 Discord 對話要求的任務，由 Agent 寫成卡片檔後，卡片沒有 `notify` 欄位，bridge 不知道任務來自哪個 Discord thread（自動撿卡沒有原 thread），所以 PR、review、CI、merge、失敗等事件都不會通知（2026-11-07 使用者回報：「我是透過 discord 問的就應該要通知」）。ISSUE-120 的通知功能只對有記錄通知對象的卡有效。

**已確認根因：**`notify` 只有兩個來源：從 Discord 的 `card` 指令建立或指派時 bridge 自動記下 thread，或寫卡的 Agent 自己填。Agent 直接寫檔時沒有任何規則或檢查要求填它，實際上我（Agent）建的 `flow-notify`、`tab-layout` 等卡都漏了。補填也有損失：已經被判定為「沒有通知對象」的事件（例如 `autopick_picked`）不會回頭補發，這是 ISSUE-120 的設計（不猜、不重送）。

**修正（2026-11-07）：**(1) `AGENTS.md` 新增「建立任務卡片」：Agent 寫卡必須填 `notify`（Discord 來源填 `discord:<thread id>`，thread id 取自 `routing.json` 的 `threadRoutes`；其他填 `agent:<pane>:<terminal>:<agent>`），轉 `ready` 之前先填；(2) `herdr-card-check` 對**狀態為 `ready` 且沒有 `notify`** 的卡在 stderr 印 `WARN`，結束碼不變（`draft` 不警告）。

**測試（2026-11-07，本機）：**新增 `test/card-check.test.ts` 案例：ready 沒有 notify → exit 0 且 stderr 有 WARN；有 notify 或 draft → stderr 為空。

**未驗證／限制：**這只是規則加警告，不是強制：Agent 不跑檢查或忽略 WARN，仍然會產生沒有通知對象的卡。曾考慮由 bridge 在撿卡時用「目前選中的 Agent」的 Discord 路由自動補，但那個 Agent 不一定是寫卡的人，可能通知錯對象，所以沒做。


## ISSUE-120：卡片來源通知（REQ-20261107-flow-notify）

2026-11-07。狀態：已修正、待驗收。**尚未實機驗證**。bridge 已於 2026-11-07 重啟並載入此功能（PR #156，`fd5bce0`）。症狀：進度僅在 console；預期通知原 thread／pane。macOS sandbox 假 port 重現；根因為缺來源。修正來源、帳本派送／去重、排隊／身分檢查、有限重試與事件；SPEC.md、README.zh-TW.md 同步。

歷史：初版 red 6 fail，整合 733 項／7 fail 修正後 737 pass。Review 重新開啟 f1–f3（重送、互斥漏紀錄、故障測試缺注入）；本輪 red 126 項／3 fail，已修正並補測試。2026-11-07：Worker 因 codex 權限提示逾時而任務失敗（ISSUE-115），產出存成 WIP commit，由人工接手檢查後修正三處：(1) 沒有通知對象的舊卡，每次掃描會把所有歷史事件都寫一筆「沒有通知對象」進卡片紀錄——改為只處理 notifier 啟動（`startedAt`）之後的事件，並補測試；(2) `card loop` 的 `notify` 被改成只有 console 才回覆 Discord——還原為原行為；(3) PR 監看對所有卡改成只印 console——收窄為只有「卡片有記錄通知對象」才只印 console，沒有記錄的舊卡維持回報到原 thread。另把新增檔案整理成專案的 prettier 格式。測試（2026-11-07，本機非 sandbox，Node 26.12）：`npm run build` 通過，`node --test dist/test/*.test.js` 1442 項，1441 pass、0 fail、1 skipped（既有的略過），輸出沒有多餘 stdout；`herdr-card-check` 實測接受 `notify: discord:123456789`、拒絕 `notify: agent:w4:p2`。

限制：當機寧可漏送、不重送；僅明確 failed 可重試，認領寫失敗不送，同程序最多三次（計數不能在寫盤失敗時跨重啟保存）。無來源舊卡不通知 Agent。Lead 重啟後驗證來源隔離、排隊、身分替換與失敗。未改 config.json／policy.yml。**尚未實機驗證**：Discord 來源與 Agent 來源的真實通知、排隊與身分核對都只用假 port 測過（2026-11-07 當時；bridge 已重啟載入此功能，2026-11-09 的 Agent 來源實機觀察見下）。

**Agent 來源實機觀察（2026-11-09，本機，bridge 為 main `1657138`〔10:50 重啟〕之後的程序；證據來自 ISSUE-129 驗收用的三張測試卡，卡片 `notify` 為 `agent:w1:p1:term_65e82e90eb7da4:claude`，通知對象是跑驗收的 Claude pane）：**

- 卡片流程紀錄每則通知都先記 `notification | agent:… ` 目標，因為當時該 pane 正在工作，再記 `Agent 忙碌，通知排隊`，沒有立刻打斷；該 pane 閒下來後，排隊的通知才依序送進 pane，內容為 `[bridge 通知] <卡片 id> · 標題=… · <事件> · <說明>`，後面附 PR 網址。精確送達時間沒有記錄。
- 實際收到的事件：卡 A 5 則（autopick_picked、pr_opened、review_verdict、ci_result、merged）、卡 B 1 則（autopick_picked；重啟後被取消，沒有 PR）、卡 C 7 則（autopick_picked、pr_opened、review_verdict、ci_result、merge_blocked、loop_stopped、autopick_stopped），共 13 則，沒有重複也沒有遺漏。
- 這證明 Agent 來源的「對象記錄、忙碌排隊、閒置後送達、事件內容與 PR 網址」在真實 Herdr pane 上可運作。
- **觀察（未開新 issue、待觀察）：**卡 C 的 `autopick_stopped` 通知寫「review 條件、版本條件未滿足」，與同一事件的 `merge_blocked` 通知（CI 條件、停止要求、狀態條件未滿足）及卡片紀錄的實際原因（卡片狀態被人工改成 cancelled、PR 分支落後 main）說法不同；兩則是不同步驟的檢查結果，是否為訊息誤導未確認。
- **仍未驗證：**Discord 來源的真實通知、身分被取代時的核對（pane 換成別的 Agent）、通知失敗的有限重試，以及排隊逾時情境；狀態維持「已修正、待驗收」。這次驗證不是專門針對 ISSUE-120 設計，而是 ISSUE-129 驗收的副產品。

維護規則見 [AGENTS.md](../AGENTS.md)。最後整理：2026-11-02（ISSUE-052 到 056 的索引列與 Card-to-Merge 追蹤清單；更早的條目未重新整理）。

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

| ISSUE-021 | Phase 3 Session Handoff Runtime | 重新開啟／待調查 | 2026-10-05 完整套件 222/223，再現並行 verify/cancel ENOENT；未改 handoff，live 未驗收 |
| ISSUE-025 | 本機 Git coding workflow 首版 | 已修正、待驗收 | 2026-10-02 重新開啟後已補 read-only 起迄指紋與 finding id；live 未驗收 |
| ISSUE-026 | Claude 模型／終端擷取與附圖相容性；完成後持續滾動 | 重新開啟／待調查 | 附圖修正待 Discord 驗收；idle 30 秒收尾已改，滾動根因未確認；2026-10-05 targeted 37/37 |

| ISSUE-027 | 頻道（非 thread）mention bot 的一般文字無回應 | 已修正、待驗收 | 重啟後在頻道 `@bot agent use <pane>` 再 `@bot hi` 驗收 |

| ISSUE-028 | Discord「final response delivered」內容停在作業中途，不是 Claude 最後回覆 | 已修正、待驗收 | 重啟後以長工具鏈（>2 分鐘）Claude 任務驗收；根因為推論，未確認 |

| ISSUE-029 | thread 只有 herdr bot 在線時仍需 mention（功能請求） | 已驗收 | 2026-10-12 使用者於 openab/test 確認可用；後續觀察 30 秒快取延遲 |

| ISSUE-030 | blocked 等待選擇／回答時，Discord 打字回覆被 `agent is busy` 擋下 | 已修正、待驗收 | 重啟後在 Claude 選單（AskUserQuestion）卡片過期後仍以文字回答驗收 |

| ISSUE-031 | CLI 互動選擇經 Discord 回答後 CLI 繼續運作，但 Discord 不再更新 | 已修正、待驗收 | 重啟後以 Codex／Claude 互動選擇重現；根因為診斷檔佐證的推論 |

| ISSUE-032 | CLI 內可點擊的超連結（OSC 8）在 Discord 只剩連結文字，URL 遺失 | 已緩解、待驗收（程式未修） | 以 AGENTS.md 回覆格式規範要求 Agent 輸出完整純文字網址；其他專案需自行加入同樣規範 |
| ISSUE-033 | 新增 pi agent 終端畫面 parser adapter | 重新開啟／待調查 | 2026-10-29 pi 最終回答未擷取，Discord 貼較早進度；本機補裝 hook 見 ISSUE-045，parser 邊界限制未修 |
| ISSUE-034 | Agent 檔案回送 Discord（discord-attach 標記） | 已驗收（2026-10-20） | 後備片段修正後 Discord 實機收到附件；範圍僅 Claude／文字檔 |
| ISSUE-035 | coding-workflow 測試在 macOS 有 6 項失敗 | 已驗收（2026-10-29） | 根因：macOS `/var`→`/private/var` realpath 與測試用 `/etc/hostname`；完整測試 0 失敗；見下方 ISSUE-035 |
| ISSUE-040 | Claude 最終回覆在串流中途被截斷，並混入「Update available!」提示 | 已修正、結案（2026-10-29，未實機驗收） | 使用者決定不另測；僅畫面重放與單元測試；根因為推論；再發生則重開 |
| ISSUE-041 | bridge 不支援 Herdr 遠端機器（如 agy-pod）的 Agent | 已驗收（文字對話，2026-10-24） | 關閉遠端面板後重問，Discord 收到正確回覆；斷線重連、附件、Team Worker 等未驗收 |
| ISSUE-042 | 從 Discord 驅動的 Agent 自己重啟 bridge 時，該回合的串流與最終回覆遺失 | 串流續傳與 blocked 補發通知已驗收（2026-10-28） | 2026-10-24、10-28 各發生一次；已改為重啟後依 active-streams.json 接續 |
| ISSUE-043 | 傳入附件沒有保留期限，本機與遠端會一直累積 | 已驗收（2026-10-29） | 本機實測刪除；遠端以 ssh 檢查取得間接證據（過期目錄已消失、父目錄 mtime 吻合）|
| ISSUE-048 | Discord 訊息開頭的 Agent 識別框（agent／WK／pane 三行加框線）佔太多空間，且看不出遠端機器 | 已驗收（2026-10-28） | 使用者在 Discord 確認標頭 OK；手機版未單獨驗證；見下方 ISSUE-048 |
| ISSUE-049 | 對 pi 傳圖片被拒絕「此 Agent 尚未支援本機圖片交付」 | 已修正、待驗收（2026-10-29） | pi 加入圖片白名單；單元測試完成；bridge 尚未重啟；Discord 未驗收；見下方 ISSUE-049 |
| ISSUE-050 | hook 啟用後 Codex 回應期間 TUI 偶爾滾動 | 重新開啟／待調查 | final 優先、工作中 visible；2026-10-29 使用者已重啟，Gateway 連線成功，實機滾動待驗收 |
| ISSUE-051 | `npm start`／`dry-run` 與 bin 指向不存在的 `dist/index.js` | 已驗收（入口路徑） | 2026-10-29 使用者跑 `npm start` 不再 MODULE_NOT_FOUND；因缺 token 未完整啟動，屬啟動方式差異 |
| ISSUE-052 | `main` 沒有 CI 與 branch protection，無法作為自動 merge 閘門 | 修正中 | CI（Ubuntu／macOS）與 ruleset `protect-main` 已在 `main`，直接 push 被拒已實測（2026-10-30）；剩紅燈 PR 被擋實測、Dependabot；`strict` 檢查屬 L2 建議前置；bot 身分已決定不是前置（2026-11-03），CODEOWNERS 需第二個身分才有意義，見 [追蹤清單](card-to-merge-tracker.md) |
| ISSUE-053 | 卡片 `x-` 自訂欄位解析後不保留，序列化後消失 | 已修正、待驗收 | 2026-10-30 使用者決定「禁止」；`parseCard` 已拒絕 `x-` key，已合併（PR #9）；無 live 驗收項目，等使用者決定是否標已驗收 |
| ISSUE-054 | 缺少單檔卡片驗證指令，Agent 轉 Mantis 單後無法自我檢查 | 已修正、待驗收 | 2026-10-30 新增 `herdr-card-check`；自動化測試通過；待使用者用真實 Mantis 單請 Agent 轉卡片並以此指令驗收 |
| ISSUE-055 | 遠端長期存在的 pod 上，開發完成後的 worktree／workspace／分支清理尚未設計 | 待調查（先紀錄，未來處理） | 2026-11-02 使用者要求先紀錄；功能尚未實作，無實際殘留；原則與 3 個問題待使用者決定 |
| ISSUE-056 | 機敏內容遮蔽漏掉多種憑證樣式；兩份遮蔽邏輯重複且不一致；handoff 摘要先截斷再遮蔽 | 已修正、待驗收 | 2026-11-02 已整併為 `src/redact.ts`，自動化測試通過；待實際 session handoff 驗收 |
| ISSUE-047 | Codex 在 Discord 送問後出現「Agent identity changed (session changed); response capture stopped」，擷取在核准通知前中止 | 已修正、待驗收（2026-11-06；Discord 對全新 codex 第一次送問已實機驗證通過，待使用者確認驗收） | 首次登記共用判斷；見 ISSUE-047「2026-11-06 重新開啟」 |
| ISSUE-046 | Discord 輸入權限選項數字（3）後沒有任何反應，之後按 Approve 才有動作 | 已驗收（2026-10-28，數字／allow／deny／按鈕／📨；原 `3` 沒反應根因未確認） | 2026-10-28 重啟後數字 1／2 回覆成功且有 📨；使用者早先的 `3` 沒反應原因仍未確認 |
| ISSUE-045 | 畫面擷取判斷完成與權限不可靠，改用 CLI hook／協定，parser 保留備用 | Claude Stop 與 PermissionRequest 已驗收（2026-10-28，使用者實測）；Codex Stop 與 allow／deny（y／esc 快捷鍵）、hookTransport 設定與 hooks 指令已驗收（2026-10-28）；agy Stop 已驗收（2026-10-28）；pi Linux 缺漏補裝後已驗收（2026-10-29，保留 macOS 驗收歷史）；遠端 machine（agy）已驗收（2026-10-28，修正後重測） | 遠端 Claude／Codex／pi 未涵蓋；見 docs/hook-transport-proposal.md |
| ISSUE-044 | Claude 回覆在 Discord 被重複貼出多則 | 重新開啟→已修正、待驗收 | 2026-10-28 重現，確認根因為回合尾巴後的「※ recap」行擋住完成判斷；原始碼與單元測試完成，已 commit（ccec39b）並於 2026-10-28 重啟（w2:p10），Discord 未驗收 |
| ISSUE-039 | Discord 傳入非圖片檔案（如 chat.json）被拒絕 | 已驗收（2026-10-29） | 使用者於 Discord 傳非圖片檔驗收；邊界案例未逐項記錄 |
| ISSUE-038 | agy 多行 prompt（含附圖）回顯後擷取不到回覆，Discord 只得「capture failure」 | 已修正、結案（2026-10-29，未實機驗收） | 使用者決定不另測；僅畫面重放與單元測試；再發生則重開 |
| ISSUE-037 | 使用者直接在 Herdr 要求 Agent 傳給 Discord，bridge 不代送 | 已驗收（2026-10-20，指令版） | 重啟後使用者確認 Discord 收到；範圍見驗收紀錄 |
| ISSUE-036 | 強制收尾後的 rewatch 在使用者直接於 pane 輸入新內容後仍重複擷取舊 prompt，Discord 被洗版 | 已驗收（2026-10-29） | 使用者於 pane 續問，Discord 未再重送；見下方 ISSUE-036 |
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

更新日期：2026-10-05。狀態：重新開啟／待調查。合併驗證出現並行 verify/cancel 測試 ENOENT，單獨重跑仍失敗；2026-10-05 本輪完整套件再現，詳見本節最新紀錄。以下保留 2026-09-20 的實作與受限環境驗證歷史。

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

### 2026-10-05 提交前完整套件再次重現

Linux、本機 checkout：`npm test`（log `/tmp/lazy-commit-npm-test.log`）build 通過，223 項：222 通過、1 失敗，exit 1，duration_ms 241919.872525。失敗為 `concurrent handoff verification and cancellation cannot race in-flight dispatch`，`HandoffStore.write` 開啟臨時 journal 發生 unhandledRejection／ENOENT，符合既有症狀；精確 async／cleanup 根因仍未確認。本輪只整理 Claude／串流提交與文件，未改 handoff。下一步調查競態並重跑 handoff seam／完整套件，live 驗收未完成。

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

2026-10-05 待調查（使用者回報）：Claude pane「完成後仍持續滾動」。調查時（w1:p1E，Claude idle）以 `herdr pane get`／`pane list` 連續取樣 3–4 次、每次間隔 3 秒：revision 固定 854、scroll offset 為 0、畫面靜止；同時只有本工作階段 pane w2:p8（working 中）的 revision 在增加。bridge（pid 61404，15:22 啟動）未持續讀取該 pane。因此目前無法重現，根因未確認；可能是 Herdr／終端畫面重繪，或僅發生於處理期間的歷史輪詢（`recent_unwrapped` 2000 行），尚未驗證。使用者補充：Discord 回覆完成後 pane 仍持續滾動，使用者送出新訊息後才停止；預期 bridge 回應後應停止。附圖資料夾 `message-XroCNb` 建在本 repo 下，表示該訊息送進了本工作階段 pane（w2:p8）。推測根因（未直接驗證）：`streamAgent` 只在「idle／done 且連續 4 次擷取內容不變」時收尾，若畫面持續重繪或擷取結果一直變動就會每 1.2 秒讀 2000 行直到 24 小時上限。修正（原始碼）：Agent 進入 idle／done 連續 30 秒即強制收尾（`IDLE_FORCE_COMPLETE_MS`，`src/main.ts`）。驗證：`tsc`、lint 通過；`npm test`（2026-10-05，223 項）221 通過、2 失敗（handoff ENOENT 競態，以及重複實例測試一次不穩定、單獨重跑通過）。未驗證：實機重現與重啟後行為；狀態維持待調查，不視為已解決。

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

### 2026-10-05 lazy-commit 提交前驗證

本次整理為附圖交付／卡住輸入、附圖回覆擷取、idle 輪詢上限三個原子提交，同步 SPEC、README 與 CONTEXT。完成後持續滾動子問題保持待調查；圖片相關原始碼已修正、待 Discord 驗收。

- `npm test`：build 通過，223 項：222 通過、1 失敗，exit 1，duration_ms 241919.872525；唯一失敗為 ISSUE-021 handoff ENOENT，已更新該 issue。log：`/tmp/lazy-commit-npm-test.log`。
- `node --test dist/test/claude-image-submit.test.js dist/test/cli-adapter.test.js dist/test/response-stream.test.js dist/test/response-delivery.test.js dist/test/herdr.test.js`：37/37 通過，exit 0，duration_ms 4457.281853。log：`/tmp/lazy-commit-targeted.log`。
- `npm run lint`（53 TypeScript files）、`npm run typecheck`、修改 TypeScript 的 Prettier check 與 `git diff --check` 通過；文件核對差異與本機連結。

既有 response-stream 測試通過不等同於新增 idle 30 秒上限有專用回歸測試；該上限的實機行為仍待驗證。沒有重啟、部署、push 或再次操作 Claude／Herdr pane；執行中 bridge 是否載入新版未確認，舊訊息與舊任務不補送。ISSUE-026 整體因滾動子問題保留重新開啟／待調查，其他修正維持待驗收。

## ISSUE-027：頻道（非 thread）mention bot 的一般文字無回應

更新日期：2026-10-12。狀態：已修正、待驗收。

症狀：使用者在 Discord 頻道（不是 thread）`@herdr agent use w4:p1` 成功，bridge 回報「Subsequent messages in this user route will be sent only to this Agent」；隨後 `@herdr hi`、`@herdr 在嗎` 完全沒有回應。預期：user route 已選取 Agent 時，頻道內 mention 的文字送給該 Agent；沒有 route 時要有提示而不是靜默。

已確認根因（程式閱讀）：`src/discord.ts` `handleMessage` 對非 thread 訊息在未回覆 bot、無附件時直接 return，`parsePrompt` 也要求 `isThread()`；SPEC §5 原寫「只有 mapped thread 才當 direct prompt」，與 `agent use` 回報的 user route 文案矛盾。未用 live Discord 重現當時的 bridge 版本。

修正：非 thread 且訊息明確 mention bot（不論 `requireMention`）時，若 `routing.resolve` 有 user／channel route 則走既有 prompt 流程；無 route 回覆「尚未選取 Agent」提示；未 mention 的頻道閒聊仍忽略。Approval 與附圖仍只在 thread 處理（頻道附圖無 mention 時維持原錯誤提示）。

驗證（2026-10-12，macOS）：`test/inbound.test.ts` 新增 3 項（route 轉送、無 route 提示、未 mention 忽略），該檔 6/6 通過。`npm run check` 為 229 項：222 通過、6 失敗，全為 `coding-workflow.test` 既有失敗（stash 本次變更後同檔仍 9 通過／6 失敗，與本次無關，ISSUE-025 範疇，未修）。

未驗證：執行中 bridge（pid 43529，`dist/src/index.js`）尚未重啟，仍是舊版；未做 live Discord 驗收；舊訊息不補送。

## ISSUE-028：Claude final 在作業中途被判定完成

更新日期：2026-10-12。狀態：已修正、待驗收（根因為推論，未確認）。與 ISSUE-026 的「完成後滾動／idle 收尾」同屬 Claude 擷取，但症狀不同，分開記錄。

症狀：頻道中對 Claude（w1:p1）發問，Discord 顯示「✅ finished — final response delivered · 總耗時 2分50秒」，內容只到作業中途（最後一行「Running grep -n …」），缺少 Claude 在終端機實際給出的最後回覆（原因／修正／驗證／文件／下一步）。預期：Claude 還在作業時不得完成；final 須含最後一則回覆。

證據與推論：`longestOutput` 取歷次解析最長者，最後回覆比已投遞內容長卻沒進去，表示輪詢從未讀到它，即在 Claude 仍作業時就判定 settled。解析器只保留 assistant 訊息，長工具執行期間解析結果不變；若 Herdr 同時回報 idle／done（確切狀態未取得），`Settlement` 4 次不變加 10 秒即完成（commit 3ca695e 後視為正式 final）。尚未取得當時 Herdr 狀態序列，無法證明 Herdr 回報了 idle。

修正：`src/main.ts` 的 `streamAgent` 另比對原始畫面，解析結果或原始畫面任一變動（spinner、計時重繪）都重設穩定計數。原始畫面持續重繪時，完成只剩既有 30 秒 idle 強制收尾（附警告）。風險：若 idle 畫面本身持續重繪，會改走強制收尾而不是正式 final。

驗證（2026-10-12，macOS）：新增 `Claude answer is not final while the raw screen keeps redrawing`，修正前失敗、修正後通過；`node --test dist/test/response-delivery.test.js dist/test/response-stream.test.js dist/test/cli-adapter.test.js` 35/35 通過。未重跑完整套件（先前 6 項 coding-workflow 失敗與本次無關）。

未驗證：執行中 bridge 未重啟；無 live 驗收；已投遞的不完整訊息不補送。下一步：重啟後以長任務重現，若仍截斷需記錄當時 Herdr agent_status 序列。

## ISSUE-029：thread 只有 herdr bot 時免 mention

更新日期：2026-10-12。狀態：已修正、待驗收。

需求：已綁定 Agent 的 thread 中，若成員只有 herdr bot（沒有其他 bot），不需 mention 也能回應。實作：新設定 `discord.soloThreadNoMention`（預設 false，env `HERDR_DISCORD_SOLO_THREAD_NO_MENTION`）；啟用時加入 GuildMembers intent，並對已綁定 Agent 的 thread 取得 thread 成員（30 秒快取），除本 bot 外沒有 bot 成員、且本 bot 在成員內才免 mention。無法取得成員（intent 未開、API 失敗）時退回要求 mention。指令仍需 mention／prefix；頻道（非 thread）仍需 mention。

重要限制：Server Members Intent 是特權 intent，須先在 Discord Developer Portal 開啟，否則啟用設定後 bot 登入會失敗，故預設關閉。

驗證（2026-10-12，macOS）：`test/inbound.test.ts` 新增 2 項（僅本 bot 免 mention、另有 bot 仍需 mention），該檔 8/8；`npm run check` 232 項：225 通過、6 失敗，全為既有 coding-workflow 失敗（見 ISSUE-025）。未驗證：真實 Discord 的 `thread.members.fetch` 行為、bot 加入／離開 thread 後的 30 秒內快取延遲；執行中 bridge 未重啟，未 commit。

### ISSUE-029 重新開啟（2026-10-12）

使用者於 openab/test 討論串（已綁定 w1:p3）重啟新版後傳「hi」仍未回應。以 Discord REST 查該 thread 成員：herdr、兩位使用者，另有 `opencode`、`gcp-hermes` 兩個 bot 為成員（離線）。確認根因：首版以「thread 成員無其他 bot」判斷，但使用者要求的是「沒有其他 bot 在線上」，離線 bot 不應阻擋。

修正：改為其他 bot 成員只要 presence 非 offline／未知才視為在線並要求 mention；需加入 GuildPresences（Presence Intent，特權），與 GuildMembers 一同僅在 `soloThreadNoMention` 啟用時要求。移除「本 bot 必須是 thread 成員」條件。未取得 presence 視為離線。

驗證（2026-10-12）：`test/inbound.test.ts` 9/9（含離線 bot 不阻擋、在線 bot 仍需 mention）。尚未重跑完整套件、未重啟、未 live 驗收；須先在 Developer Portal 開 Presence Intent，否則登入失敗。

### ISSUE-029 第二次重新開啟（2026-10-12）

Presence Intent 開啟並重啟（pid 81540）後，使用者在 openab/test 討論串傳「hi」仍未回應。查 Discord REST：`test` thread id 為 1559030640689545307，不在 `routing.json` 的 threadRoutes（只有 1550807543910105181），即**該 thread 未綁定 Agent**；先前修正要求 thread 已綁定才免 mention，因此被擋下。另外，不 mention 的指令（如 `agent`）原本也不走免 mention 規則。根因已確認為這兩點（前一次「離線 bot 阻擋」修正仍有效，未被推翻）。

修正：solo 判定提前到指令解析前，solo thread 的指令與文字皆視同已 mention，並移除「已綁定」條件；未綁定且無 user／channel route 時由既有 prompt 流程回報錯誤。副作用：solo thread 內的普通對話若以 `agent`、`status`、`help` 等已知指令字開頭，會被當成指令。

驗證（2026-10-12）：`test/inbound.test.ts` 10/10（新增未綁定 thread 的指令與文字）。完整套件與 live 驗收見最終回報／下一輪紀錄。

### ISSUE-029 驗收（2026-10-12）

使用者在重啟後的 bridge（pid 14792，含 Server Members／Presence Intent 與 `soloThreadNoMention: true`）回報「修好了」，環境為 Discord openab/test 未綁定 Agent 的討論串。此為使用者口頭驗收，未提供截圖；ISSUE-027（頻道 mention）、ISSUE-028（final 截斷）尚未收到實測結果，維持已修正、待驗收。

## ISSUE-030：blocked 等待回答時文字回覆被 busy 擋下

更新日期：2026-10-12。狀態：已修正、待驗收。

症狀：Claude 以 TUI 選單（Discord 顯示 blocked 卡片與「Approve / continue」按鈕，該按鈕只送 `continue`）等待使用者選擇時，使用者希望直接在 Discord 打字回答（如選項編號），不需要客製下拉選單。

根因（程式閱讀確認）：打字回答只在 thread 內有「作用中核准卡片」時才走 approval 路徑。卡片過期（預設 15 分鐘）、已關閉或不在同一 thread 時，文字落入一般 prompt 流程，`assertAgentAvailable` 因原發問的串流仍在監看該 terminal（`activeStreams`）而回報 `agent is busy`，即使 Agent 已是 blocked。

修正：`promptMappedAgent` 對「blocked 且串流仍在監看」的 Agent，把文字當作回答經 `sendAgent` 送入並關閉該 terminal 的核准卡片，不經 busy 檢查；handoff 持有、Team task 擁有的 Agent 與附圖仍拒絕。working 狀態仍視為 busy。不新增選項解析或下拉選單 UI（ISSUE-010 的點選 UI 維持待做）。

驗證（2026-10-12，macOS）：新增 `test/blocked-reply.test.ts` 2 項（blocked 時文字送入、working 仍 busy），2/2 通過。未重跑完整套件；未重啟；未 live 驗收。限制：若 Herdr 沒把該 TUI 選單辨識為 blocked（如 agy，見 SPEC），仍會是 working／busy；文字以 `sendAgent` 送出（含 Enter），是否正確選中該 Claude 選單項需 live 確認。

## ISSUE-031：強制收尾後 CLI 繼續運作，Discord 不再更新

更新日期：2026-10-13。狀態：已修正、待驗收（根因為推論）。

症狀：CLI 顯示互動選擇，使用者在 Discord 輸入選擇後 CLI 繼續運作，但 Discord 沒有再更新回覆內容。預期：CLI 後續輸出仍回報到 Discord。

證據：bridge 於 2026-10-13 產生 4 份 capture diagnostic（`~/.local/state/herdr/plugins/herdr-discord-bridge/capture-diagnostics/`）。其中 w5:p2（Codex，`has_transcript: false`）兩份顯示：`agent_status` 為 `done`，elapsed 分別為 49.9 秒與 228 秒，但畫面仍有「Browsing the web」等進行中內容，最終為 capture incomplete。與 `idle/done 連續 30 秒強制收尾`吻合：Herdr 在 CLI 等待選擇或長時間工具等待時回報 `done` 而不是 `blocked`／`working`，bridge 強制結束串流，之後使用者回答、CLI 續跑時已沒有串流。這是推論；尚未取得使用者當次 Discord 畫面與 Herdr 狀態序列，無法證明使用者回報的就是這兩份。

修正：強制收尾（沒有 structured final）後，不佔用 `activeStreams`，改以 5 秒間隔輕量觀察最多 15 分鐘；Agent 回到 working／blocked，或解析後的回覆內容改變時，回覆「▶️ Agent 再度運作，繼續擷取回覆…」並重新擷取，單一發問最多接續 5 次。身分改變、其他串流啟動或逾時即停止。Claude 的畫面持續重繪（ISSUE-026）不會觸發，因為只比對解析後內容與狀態。既有強制收尾與 ISSUE-028 判定不變。

驗證（2026-10-13，macOS）：`test/response-delivery.test.ts` 新增「強制收尾後有新輸出會接續擷取」，該檔 14/14 通過；`npm run check` 為 237 項：230 通過、6 失敗，全為既有 coding-workflow 失敗（ISSUE-025）。未驗證：live 互動選擇、重啟後行為；接續後的 final 會重送整段回答（以原 prompt 為錨），可能與先前已送出的摘錄重複。

## ISSUE-032：CLI 超連結在 Discord 變成無法得知的純文字

更新日期：2026-10-13。狀態：待調查（尚未修正）。

症狀：Codex 回覆中「開啟 Open WebUI」在 Herdr CLI 內是可點擊的 URL，Discord 只顯示該文字，使用者無法得知網址。預期：Discord 能看到實際 URL。

已確認（2026-10-13，Herdr 0.9.1，macOS）：在暫時 pane 輸出 OSC 8 超連結後讀取，`herdr pane read` 的 text／ansi／detection／visible 都只回傳連結文字，**URL 被 Herdr 剝除**（只有 `--raw` 會回傳字面上的 printf 指令，不是終端機內容）；bridge 因此無從從畫面讀回 URL。Herdr 0.9 有 `pane.link.resolve`／`pane.link.activate`（回傳 `{handled, url}`），但實測回 `stale_target: pane is no longer visible`，需要該 pane 正顯示在 Herdr 客戶端視窗，且 activate 可能觸發開啟連結，不適合作為 bridge 的穩定來源。這些為實測結果，不是根因推論。

可行方向（未實作）：Codex rollout jsonl／Claude 的 transcript 含原始 markdown 連結，可讓 final 保留 URL。限制：2026-10-13 的 Codex capture diagnostic（w5:p1／p2）顯示 `has_transcript: false`，原因未確認，因此對該情境不一定有效；Claude 尚無 transcript reader。

未修正、未驗證；本次只做實驗與記錄，沒有改程式。實驗用的暫時 pane 已關閉。

### ISSUE-032 處置決定（2026-10-13）

使用者決定不改程式，改以專案說明檔規範：在 `AGENTS.md` 新增「回覆格式」，要求 Agent 回覆一律附完整純文字 URL。此為緩解，不是修正：bridge 仍無法還原被剝除的超連結；規範只對讀取此 repo `AGENTS.md` 的 Agent 有效。例如 2026-10-13 截圖中的 colab_llm 專案（Codex）屬另一個 repo，需在該專案的 `AGENTS.md` 加入同樣規範，才會生效。尚未驗收：須用新 session 驗證 Agent 實際遵守規範並在 Discord 看到完整網址。

## ISSUE-033：接入 pi agent（終端畫面 parser adapter）

更新日期：2026-10-29。狀態：重新開啟／待調查（最後回覆未擷取，見 ISSUE-045／033 Linux 紀錄；先前實作與測試歷史保留）。

症狀：Herdr 已回報 `agent: "pi"` 與 `agent_session`（kind `path`，指向 `~/.pi/agent/sessions/.../*.jsonl`），但 bridge 無專用 adapter，落入 generic marker adapter，無法辨識 pi 畫面而擷取不到回覆。預期：pi pane 的 Discord／Console 回覆能擷取本次回答。

實作範圍：`src/cli-adapter.ts` 新增 `PiCliAdapter`（Herdr kind 嚴格等於 `pi`，大小寫不敏感）；`/model <name>`；`normalizeTerminalResponse` 支援 pi；`src/main.ts` 的 settled 終端 final 由 Claude 擴及 pi。依 2026-10-19 讀取 pi 1.2.0 實際 pane（w5:p1，Herdr 0.8.0）觀察到的畫面格式：user／assistant 皆無前綴符號、僅縮排一欄（user 靠背景色區分，純文字讀不到）；工具區塊以 ` $ cmd` 開頭、` Took <時間>` 結尾；底部為兩條 `─` 分隔線包住的輸入框與頁尾狀態列。Adapter 因此以「prompt 回顯（容許軟折行）」為邊界取其後文字，去除輸入框／頁尾（含草稿）、spinner 與已完成工具區塊，並與 baseline 的舊回答比對避免重畫重播。

限制（未解決）：

- 沒有 pi structured transcript reader（session 檔為 jsonl，格式見 pi `docs/session-format.md`，未實作）；Discord 仍標示為擷取摘要，不能宣稱 semantic final。
- 工具標題只認 `$ `、`read|write|edit|grep|find|ls <arg>`；僅實際見過 `$` 區塊。其他工具區塊格式與缺少 `Took` 結尾時只丟標題列，其輸出可能混入回覆。
- 模型選單 `modelOptionsFor` 未針對 pi 設定（落入預設清單）；`/model` 指令格式未在實機驗證。pi 以 provider 切換帳號（pi-acc-switcher），名稱需由操作者指定。
- 圖片附件交付 allowlist 未加入 pi（`src/main.ts`），未驗證 pi 讀圖方式。
- Coding reviewer／session handoff 的已知 session gate 未針對 pi 路徑型 session 調整。

驗證（2026-10-19）：`node --test dist/test/cli-adapter.test.js` 22 通過、0 失敗（含 4 個 pi 測試；fixture 為依實機畫面仿製的合成資料，非真實回答）。`npm run check`（typecheck + build + 全部測試）241 通過、0 失敗。尚未驗收：真實 pi pane 經 Discord、Console、Team turn 的端到端回覆；bridge 未重啟，舊訊息無法補送。下一步：重啟 bridge 後在 pi pane 以短回答、含工具呼叫、長回答各驗收一次，並蒐集其他工具區塊格式。

## ISSUE-034：Bridge 無法把 Agent 產生的檔案回送 Discord

更新日期：2026-10-19。狀態：已修正、待驗收（原始碼已改，自動化檢查見下；未重啟 bridge、未做 Discord 端到端驗收）。

症狀：Agent 產生圖片、報告等檔案後，Discord 只能看到文字，無法取得檔案。預期：Agent 可請 bridge 把檔案以 Discord 附件回送。

修正（新功能）：Agent 在最終回覆單獨一行輸出 `[[discord-attach: /絕對路徑]]`。Bridge 於最終回覆送出前解析並移除標記，驗證後以附件送到同一 thread。細節見 SPEC「Agent 檔案回送 Discord」。範圍：`src/outbound-attachments.ts`（新）、`src/discord.ts`（`postFiles`）、`src/main.ts`（最終交付）、`test/outbound-attachments.test.ts`（新）。

驗證（2026-10-19，macOS，Node 本機）：`npm run lint` 通過；`node --test dist/test/outbound-attachments.test.js` 2/2 通過。完整 `npm test`：239 項、232 通過、6 失敗；失敗項為 `test/coding-workflow.test.ts`（coding review／verify drift、artifact reads 等），在未含本次變更的基準（`git stash` 後）也出現相同失敗名稱，判定與本功能無關，但根因未調查，另需追蹤（見 ISSUE-035）。

未驗證：真實 Discord 上傳（含 Discord 伺服器上傳大小上限，程式保守限 8 MiB）、Codex／Claude／agy 是否實際輸出標記、Claude 畫面擷取路徑被換行截斷的情況。標記僅在取得正式 final（transcript 或 Claude 已 settled）時處理；僅有擷取片段的後備訊息不處理。需重啟 bridge 後才生效。

### ISSUE-034 驗收失敗與重新開啟（2026-10-20）

實機（Discord thread → w1:p1 Claude，bridge 重啟後的新版）：Agent 回覆含 `[[discord-attach: …/hello.txt]]`，Discord 沒有附件，標記文字被原樣貼出。已確認根因：該回合 Claude 閒置 30 秒被強制收尾（總耗時 37 秒、「capture incomplete」），沒有正式 final，走「擷取片段」後備路徑，而原實作只在正式 final 處理標記。修正：後備片段同樣解析標記（`src/main.ts`），沙箱規則不變。驗證：lint、build 通過（2026-10-20）；**未重啟 bridge、未重新實機驗收**。另觀察：Claude 為何常拿不到正式 final（無 transcript reader）仍是既有限制。

### ISSUE-034 驗收（2026-10-20）

重啟 bridge（含 commit 85075b0）後，使用者從 Discord thread 請 w1:p1（Claude）傳送 hello.txt（11:14），Discord 成功收到附件。環境：macOS、Claude Code、文字檔。**未驗收**：Codex／agy、圖片／大檔、多檔、被拒路徑的警告訊息、路徑被換行截斷的情況。

## ISSUE-035：coding-workflow 測試在 macOS 有 6 項失敗

更新日期：2026-10-29。狀態：已驗收（使用者於 2026-10-29 回報驗收；bridge 已於同日 commit 6032545 後重啟載入此修正。使用者未說明具體驗收的情境，未記錄是否跑過實際 coding 流程）。

**已確認根因（2026-10-29）：** (1) 正式程式 bug：`writeCodingArtifact`（`src/coding-version.ts`）用未解析的 `path.resolve(root)` 組檔案路徑，卻拿 `realpathSync(root)` 比對；journal 目錄位於 symlink 路徑（macOS 的 `/var`→`/private/var`）時恆判為「artifact path escapes task scope」，導致 implement assignment 失敗，連帶 5 項 coding 測試失敗。(2) 測試問題：「artifact reads…reject escapes」用 `/etc/hostname` 當 symlink 目標，macOS 沒有該檔，變成 ENOENT 而非逃逸。
修正：寫入改用 realpath 後的根目錄組路徑；測試改指向暫存目錄內真實存在的檔案。驗證（2026-10-29，macOS）：lint 通過；完整 `npm test` 283 項、282 通過、0 失敗、1 skipped。**未驗證**：實際 coding 流程的端到端細節未記錄（使用者僅回報驗收）。

原症狀（2026-10-19）：`npm test` 在 macOS（Darwin 25.5.0）有 6 項 `test/coding-workflow.test.ts` 失敗（如「artifact reads stay inside the task directory and reject escapes」）。基準（無 ISSUE-034 變更）重現相同失敗。根因未確認（可能與 macOS `/tmp`／`/private` realpath 或 git 環境有關，僅為推測）。下一步：單獨執行並檢視失敗訊息。

## ISSUE-036：rewatch 對已過時的 prompt 重複擷取並洗版 Discord

更新日期：2026-10-29。狀態：已驗收（2026-10-29，macOS，2026-10-29 重啟後的 bridge：使用者在 Discord 問完後，直接在 pane 繼續提問，Discord 沒有再重送舊回覆或「再度運作」訊息，符合預期）。

症狀：w5:p1（Claude）的 Discord 持續收到「▶️ Agent 再度運作，繼續擷取回覆…」與回覆內容，畫面一直滾動。預期：Agent 回覆一次後不再重複送。

重現／證據（2026-10-20，macOS，bridge pane w2:p1C）：`capture-diagnostics` 在 02:51–03:01Z 為 w5:p1 連續產生 13 份，皆 `prompt: "gemma4呢"`、`has_transcript: false`、每份約 33 秒；`extracted_last` 在回覆的不同片段間跳動。當時使用者已直接在 pane 輸入下一個問題（「開新分支 feat/roleplay…」）。

已確認根因（由 diagnostics 與 `rewatchAfterForcedFinish` 程式推得，尚未以修正後 bridge 實機驗證）：ISSUE-031 的 rewatch 只要 Agent 回到 working，或畫面解析結果與上次不同，就以**舊 prompt** 重新擷取；使用者直接在 pane 操作時 Agent 反覆 working／畫面滾動，每次都被當成「再度運作」而重送。

修正：新增 `conversationMovedPast(prompt, output)`（`src/cli-adapter.ts`）；rewatch 每輪先讀畫面，若 prompt 之後已出現其他使用者輸入列即結束該觀察。範圍：`src/cli-adapter.ts`、`src/main.ts`、`test/cli-adapter.test.ts`。

驗證（2026-10-20）：lint 通過；完整 `npm test` 244 項、237 通過、6 失敗（同 ISSUE-035 的 coding-workflow 既有失敗）；新增單元測試通過。

未驗證／限制：（2026-10-20 的「未重啟」已過期，bridge 已於 2026-10-29 重啟並驗收，驗收只涵蓋一次 pane 續問情境；）已送出的訊息無法收回。若使用者在輸入框打字尚未送出，也會被視為「已前進」而停止觀察（可接受的保守行為）。Claude 無 transcript 時 rewatch 的片段跳動根因（為何 `extracted_last` 在片段間變動）未另行修正。

## ISSUE-037：直接在 Herdr 要求 Agent 傳訊息／檔案給 Discord 時 bridge 不代送

更新日期：2026-10-20。狀態：已修正、待驗收（原始碼已改；執行中的 bridge 為重啟前版本，**未重啟、未實機驗收**）。

症狀：ISSUE-034 的 `[[discord-attach]]` 只在 Discord 發起的回合（`streamAgent`）處理；使用者在 Herdr 直接對 Agent 說「傳給 Discord」時，標記不會被代送。預期：與傳檔相同，由 bridge 代送到該 Agent 對應的 Discord thread。

修正：Agent 輸出 `[[discord-send]]` ⏎ 文字 ⏎ `[[/discord-send]]`（文字）或 `[[discord-attach: /絕對路徑]]`（檔案）。Watcher 偵測 Agent 轉為 idle／done 且無進行中的 Discord stream 時，讀取畫面，**只看最後一次使用者輸入列（`❯`）之後**的標記，送到 `mappingsForAgent` 的第一個對應目的地（無對應則不送）。檔案沿用 ISSUE-034 的路徑沙箱。以 terminal 為單位在記憶體中去重（streamAgent 已送者也登記），避免重複轉換重送。範圍：`src/outbound-attachments.ts`（`extractDirectMarkers`）、`src/discord.ts`（`postDirect`）、`src/main.ts`（`relayDirectMarkers`）、測試。

驗證（2026-10-20）：lint、build 通過；完整 `npm test` 245 項、238 通過、6 失敗（ISSUE-035 既有）；新增 direct marker 單元測試通過。

限制／未驗證：只在狀態轉換時掃描，Agent 持續 working 時不即時送；若使用者在輸入框有未送出的草稿，會被視為最後輸入列而截斷區域；bridge 重啟後記憶體去重清空，但舊標記位於最後輸入列之前不會重送；未實機驗證 Claude／Codex 畫面對標記行的實際呈現（如 ⏺ 前綴、換行縮排）。多個對應目的地時只送第一個。notifyOn 設定不影響此功能。

### ISSUE-037 驗收失敗（2026-10-20）

環境：重啟後的 bridge（commit 61391f5，pane w2:p1F）；使用者在 Herdr 對 w5:p1（Claude，cwd `colab_llm`，另一個 repo）輸入「網址傳給discord」。結果：Agent 只在 Herdr 畫面回覆一行 URL，沒有輸出 `[[discord-send]]` 標記，Discord 沒收到。

已確認原因（由畫面截圖）：Agent 沒輸出標記。`colab_llm` 沒有本 repo `AGENTS.md` 的約定，Agent 無從得知標記格式；bridge 程式本身未被觸發，**不是**掃描邏輯錯誤（該路徑尚未以含標記的真實回合驗證，仍未知）。這是設計限制：bridge 讀畫面，無法理解自然語言「傳給 Discord」，必須有 Agent 端約定或明確的 Agent 可呼叫介面。狀態改為重新開啟，待決定方案（全域 Agent 指示檔，或提供 Agent 可執行的 CLI 指令／IPC）。

### ISSUE-037 處置（2026-10-20）：改為 skill

使用者要求以 skill 提供約定。新增 `skills/discord-send/SKILL.md`（repo 內，隨版本控管），並在本機以 symlink 安裝到 `~/.claude/skills/discord-send`，使各專案的 Claude 皆可載入。Codex／agy 尚未安裝（需另行連結到其 skills 目錄）。更正（2026-10-20）：先前此處寫「python_test 的訊息來自該專案自己的 ComfyUI bot、與 bridge 無關」為未查證的推測，已撤回。python_test 確有自己的 Discord bot 程式（`src/comfyui_bot.py` 印出 tunnel URL），但使用者那次傳 URL 實際走哪條路徑未確認；較可能是從 Discord 對該 Agent 發話、由 bridge 貼回回覆。bridge 本身掛有 Discord bot，故可代送；Herdr 直接輸入沒有 Discord 發起的回合，只能靠 Agent 端標記或 Agent 可呼叫的介面觸發。**未驗收**：須開新的 Claude session（skill 清單在 session 啟動時載入）在 colab_llm 重試「網址傳給 discord」，確認 Agent 輸出標記且 Discord 收到。狀態維持「重新開啟」。

### ISSUE-037 處置（2026-10-20）：新增 `herdr-discord-send` 指令

使用者決定做指令版本。新增：`src/send-ipc.ts`（bridge 的專用 send socket：預設 `~/.config/herdr-discord-bridge/send.sock`，目錄 0700／socket 0600，僅同一 OS 使用者可連；可用 `HERDR_DISCORD_SEND_SOCKET` 覆寫）、`src/send-cli.ts` + `scripts/herdr-discord-send`（以 `HERDR_PANE_ID` 識別 Agent；`--file`、`--stdin`、文字參數）、`src/main.ts` 的 `handleSendRequest`／`deliverToAgentThread`（找 pane、檢查 allowedWorkspaceIds、必須有對應 Discord thread、沿用 ISSUE-034 路徑沙箱；沒有對應時明確回錯誤而非沉默）。標記版本保留為指令不存在時的後備。skill 已改為指令優先。本機安裝：`~/.local/bin/herdr-discord-send` 為 symlink。

驗證（2026-10-20，macOS）：lint、typecheck 通過；完整 `npm test` 247 項、240 通過、6 失敗（ISSUE-035 既有）；新增 IPC 測試（往返、socket 權限 0600、無效請求、bridge 未啟動的錯誤訊息）通過。bridge 未執行時指令回「bridge is not running」exit 1（實測）。

未驗證：**bridge 尚未重啟（執行中仍是舊 build，沒有 send socket）**，Discord 端到端、Claude 在新 session 實際呼叫指令未驗收。限制：同一 OS 使用者的任何程序都能冒用任一 pane ID 發送（與其可直接讀 bot 設定同權，僅在單人本機環境可接受）；Windows named pipe 路徑未實測；僅送到第一個對應目的地；Codex／agy 的 skills 目錄尚未安裝 skill。

### ISSUE-037 驗收（2026-10-20）

環境：macOS，bridge commit 69896ae（pane w2:p1G）重啟後。本 session（w1:p1）執行 `herdr-discord-send "bridge 指令測試"` 回報 sent 1 message(s)；使用者回報「傳送成功」。**範圍說明**：使用者未指明確認的是此測試訊息還是 w5:p1（colab_llm）新 session 以 skill 呼叫指令的情境，後者未另行確認。**未驗收**：`--file` 附件經指令送出、Codex／agy、沒有對應 thread 時的錯誤呈現、標記版本後備路徑（Herdr 直接輸入）。這些保留為後續驗收項目。

### ISSUE-037 附件驗收（2026-10-20）

環境：macOS，bridge commit 69896ae。本 session（w1:p1，Claude）執行 `herdr-discord-send --file .herdr-discord-bridge/outbox/helloworld.txt "helloworld 檔案"`（16:47），使用者確認 Discord 收到文字與附件。已驗收：指令版 `--file` 附件路徑（Claude、文字檔）。仍未驗收：Codex／agy、沒有對應 thread 時的錯誤呈現、Herdr 直接輸入的標記後備路徑、圖片與大檔。

### ISSUE-037 補充（2026-10-21）：沒有對應 thread 的 pane（Discord 私訊對話）

症狀：使用者透過 Discord 私訊與 colab_llm、python_test 專案的 Claude pane 對話時，`herdr-discord-send` 回「this pane has no mapped Discord thread」，Agent 因而回報傳送失敗。使用者指出這是設計不足：沒有對應 thread 的 pane 就是私訊對話，送出邏輯應自行處理，不該靠 Agent 端慣例。

根因：`deliverToAgentThread` 只查 `mappingsForAgent`（thread 對應），完全沒有「這個 Agent 最近是被哪個 Discord 對話派發」的資訊，私訊沒有對應記錄，一律回錯誤。標記後備路徑（`relayDirectMarkers`）同樣在沒有對應時直接略過。

修正（2026-10-21，待驗收）：新增 `src/agent-origin.ts`（記憶體中的 terminal_id → 最近一次 Discord 派發的來源對話，TTL 12 小時）；`dispatchPrompt` 在 Discord 派發時記錄（console 來源不記）；`deliverToAgentThread` 沒有 thread 對應時改用 `DiscordAdapter.postToChannel` 送回來源對話（文字與檔案皆可，沿用 ISSUE-034 路徑沙箱）；`relayDirectMarkers` 同樣接受來源對話。有 thread 對應時行為不變，仍優先。沒有對應也沒有來源時回「this pane has no mapped Discord thread and no recent Discord conversation」。

驗證（2026-10-21，macOS，原始碼）：`npm run typecheck`、`npm run lint` 通過；新增 `test/agent-origin.test.ts` 3 項通過（TTL、無對應時送回來源、有對應時優先 thread）；完整 `node --test dist/test/*.test.js` 250 項、243 通過、6 失敗，失敗項為既有的 coding-workflow／team-task 項目（與此修改無關，修改前同樣失敗）。

未驗證：**bridge 尚未重啟（執行中仍是舊 build）**；私訊實機端到端（含 `--file`）未驗收；bridge 重啟後記憶體中的來源清空，須再由 Discord 發話一次才有來源；同一 Agent 若同時被多個對話使用，只送回最近一個；Herdr 直接輸入（非 Discord 發起）且沒有 thread 對應時仍會失敗，這是預期。狀態：已修正（程式）、待驗收。

### ISSUE-037 重新開啟（2026-10-21）：私訊對話的送回來源未生效，來源路徑未確認

症狀：bridge 重啟（11:33，PID 52843，載入含 `agent-origin` 的 build）後，使用者從 Discord 傳了新訊息給 pane `w5:p3`（colab_llm 的 Claude），隨後在該 pane 執行 `herdr-discord-send` 仍回「no mapped Discord thread and no recent Discord conversation」，表示 `recordAgentOrigin` 沒有被觸發（同一 pane 在約 11:35 至 12:50 多次重試皆同）。

已確認：`src/discord.ts` 的 `handleMessage` 對 `!message.guildId`（私訊）直接 return，因此真正的 Discord 私訊不會進入 `dispatchPrompt`。bridge 的 pane console 在重啟後沒有任何入站紀錄。

### ISSUE-037 驗收進度（2026-10-21，13:2x）

環境：macOS，bridge commit b73e8ad（同一個重啟後的 process，未再重啟），pane `w5:p3`。使用者之後又從 Discord 傳了幾則訊息，約 13:20 在該 pane 執行 `herdr-discord-send "acc2 新網址 …"`，回報 `sent 1 message(s), 0 file(s)`、exit 0。

結論：**送回來源的程式路徑在實機上成功過一次**（`deliverToAgentThread` 走到 `postToChannel` 並送出）。**使用者尚未明確確認 Discord 端有收到**（只有指令回報成功），所以不算已驗收。

仍未釐清：

- 同一個 bridge process 在 11:35 至 12:50 失敗、13:20 成功，中間差異未查明。最可能是「最近一則 Discord 訊息」到 13:20 前才經過 `dispatchPrompt`（先前的訊息走了別的入口或在重啟前送達），但未以 log 證實；bridge 沒有入站 log，要查需先加診斷輸出。
- 訊息來源是私訊、伺服器頻道還是 thread 未確認；`handleMessage` 丟棄私訊的行為仍在，若使用者實際用私訊，這條路徑不會成功，須再釐清。
- `--file` 附件經此路徑送出、12 小時 TTL 到期後的錯誤呈現、bridge 重啟後的再次行為皆未驗收。

狀態：已修正、待驗收（指令回報成功，Discord 端接收未經使用者確認；根因仍有未解疑點）。下一步：請使用者確認 13:20 那則訊息是否出現在 Discord；必要時為入站派發加上診斷 log。

## ISSUE-038：agy 多行 prompt 回顯後擷取不到最終回覆

更新日期：2026-10-29。狀態：已修正、使用者決定不另行實機驗收而結案（2026-10-29）。**並非已驗收**：只有 2026-10-21 的實際畫面重放與單元測試，沒有在 Discord 以 parser 路徑實測；bridge 已於 2026-10-29 重啟載入此修正。agy 現在有 Stop hook（ISSUE-045），一般情況不走此 parser 路徑，只有 hook 沒到或 `hookTransport.agy` 設為 `parser` 時才會用到。若日後 agy 再出現「capture incomplete」，重新開啟此 issue。已送出的失敗訊息無法補送。

症狀：Discord thread「python test repo」對 w4:p5（agy）發出含附圖的 Webui 修圖需求，25 分 10 秒後回報「finished — capture incomplete」與「Agent ended, but Bridge could not capture its final response」。Agent 實際已完成並在畫面輸出完整總結。預期：Discord 收到最終回覆。

證據（2026-10-21 本機）：`capture-diagnostics/2026-10-21T08-07-04-830Z-w4_p5.json`：`prompt` 為多行（第一行需求、空行、「使用者附圖」、路徑、「請使用圖片檢視工具…」），`extracted_last` 空、`extracted_longest_length: 0`、`has_transcript: false`；`raw_screen_tail` 顯示 Agent 已輸出完整回覆。

已確認根因：`MarkerCliAdapter` 以 `> ` + 完整 prompt 字串比對畫面定位回覆。agy 回顯多行 prompt 時把續行縮排兩格，且（本次經 context 壓縮）插入「Conversation compacted」分隔線，整段比對失敗；退回的「基準差異」比對也找不到重疊，結果回傳空字串。以 w4:p5 當時的畫面與該 prompt 重放，修正前為空、修正後擷取 1598 字元（單元測試與重放為 2026-10-21）。

修正：找不到完整比對且 prompt 為多行時，改以第一行定位最後一次回顯，略過縮排後的 prompt 續行、空行與壓縮分隔線，其後內容視為回覆（`src/cli-adapter.ts` 的 `extractAfterEchoedFirstLine`，所有 `MarkerCliAdapter` 共用）。測試：`test/cli-adapter.test.ts` 新增 agy 縮排續行案例。

驗證（2026-10-21）：lint 通過；完整 `npm test` 251 項、244 通過、6 失敗（ISSUE-035 既有）。

限制／未驗證：agy 擷取內容仍含 `○ Thought`／`● Ran …` 等進度列（沿用原行為，未過濾）；單行 prompt 與其他 CLI 不受影響但未逐一實機驗證；未重啟、未在 Discord 重新驗收；為何 25 分鐘期間進度卡預覽也為空未另行調查。

## ISSUE-039：Discord 傳入的非圖片檔案被拒絕

更新日期：2026-10-29。狀態：已驗收（使用者於 2026-10-29 回報在 Discord 傳送非圖片檔已驗收；具體檔案類型與邊界案例（僅檔案無文字、超過 10 MiB）未逐項記錄）。

症狀：使用者在 thread「colab-llm」附上 `chat.json`（35.17 KB）提問，bridge 回「❌ Only PNG, JPEG and WebP image attachments are supported」。預期：一般檔案也能交給 Agent 讀取。

已確認根因：`prepareImages` 對所有附件套用圖片驗證，非 PNG/JPEG/WebP 的 content type 一律丟錯（程式與截圖一致，屬原設計限制，非 bug 回歸）。

修正：新增 `prepareAttachments`（`src/attachments.ts`）。PNG/JPEG/WebP 維持原嚴格檢查（≤ 5 MiB、簽章比對）；其他附件視為檔案：≤ 10 MiB、非空、Discord HTTPS CDN host、禁止 redirect、timeout 與串流上限，存成 `<agent cwd>/.herdr-discord-bridge/attachments/message-*/<序號>-<清理後檔名>`（檔名去除路徑與特殊字元、不允許前導 `.`）。每則最多 4 個附件。prompt 另附「使用者附檔（本機檔案）」路徑並要求用檔案讀取工具開啟、讀不到要明說。純檔案（無圖片）不再受 codex／claude／agy 白名單限制；僅含圖片時維持原限制與 Claude 補送 Enter 行為。只傳檔案、無文字時預設 prompt 為「請讀取附上的檔案並回覆。」。bridge 不執行也不解析檔案內容。`src/main.ts`、`src/discord.ts`、測試同步調整。

驗證（2026-10-21）：lint 通過；完整 `npm test` 252 項、245 通過、6 失敗（ISSUE-035 既有）；新增測試涵蓋檔名清理、路徑逃逸、非 Discord host、超過 10 MiB、宣告為圖片但內容不是圖片仍拒絕。

未驗證／限制：（Discord 端到端已於 2026-10-29 由使用者驗收，邊界案例未記錄；）Agent 是否真的讀取檔案取決於其工具；成功檔案不會自動清理（沿用圖片行為，無 retention）；二進位大檔與壓縮檔只存檔、不處理；blocked 等待回答時仍不接受附件。

## ISSUE-040：Claude 最終回覆被截斷並混入更新提示

更新日期：2026-10-29。狀態：已修正、使用者決定不另行實機驗收而結案（2026-10-29）。**並非已驗收**：只有 2026-10-24 的真實畫面重放與單元測試，沒有在 Discord 以 parser 路徑實測；bridge 已於 2026-10-29 重啟載入此修正。Claude 現在有 Stop hook（ISSUE-045），一般情況不走此 parser 路徑，只有 hook 沒到或 `hookTransport.claude` 設為 `parser` 時才會用到。若日後 Claude 回覆再被截斷或混入更新提示，重新開啟此 issue。已送出的截斷訊息無法補送或編輯。

症狀：thread「Nas討論」（對應 w3:p1，Claude）收到的最終回覆從句中開始（「因此拒絕金鑰…」）、換行與縮排混亂、結尾停在「2.」，最後一行是「Update available! Run: brew upgrade claude-code」；「2.」的內容與其後段落都沒送到。預期：完整、不含 UI 提示的回覆。

證據（2026-10-24 本機）：w3:p1 現在的 `recent_unwrapped` 畫面完整包含第 2 點（「舊的 nas workspace 還是用 ssh … kubectl exec 那個 pane，可以關掉。」）、「還有兩件事沒處理…」與回合尾巴「✻ Cogitated for 10m 56s · done 下午1:04」，其下才是「Update available!」與輸入框；Discord 那份在不同的折行位置（`-E/root/.local/` vs 畫面的 `-E` ⏎ `/root/.local/…`），代表它是更早、不同寬度時的畫面。此次最終回覆成功送出，所以沒有 capture-diagnostic 可佐證。pane 高度只有 25 列（`viewport_rows: 25`）。

已確認：(1) 「Update available!」是右縮排的 UI 列，被 `claudeResponseText` 當成回覆的縮排續行收進去（重放確認）。(2) 回覆確實在尚未完成的畫面被送出（Discord 內容少於畫面最終內容）。
**未確認（推論）**：為何在串流中途就被判定完成。最可能是 Herdr 在回覆串流停頓時暫報 idle／done、畫面連續數次輪詢不變，達成 settled＋10 秒；未取得當時的狀態紀錄，無法證實。折行／縮排混亂疑為較窄或不同寬度下 Claude 自行折行，未另行修正。

修正：(1) `claudeResponseText` 忽略「Update available!」列。(2) 新增 `claudeTurnComplete`（`src/cli-adapter.ts`）：Claude 回合結束會在回覆下方印出「✻ <動詞> for <時間>」；畫面最後一個內容列（略過更新提示與輸入框）不是它時，Claude（無 transcript）不得以 settled 為由收尾，需等到出現尾巴；若始終沒有，仍由既有 30 秒閒置強制收尾（此時只貼擷取片段並標示不完整）。範圍：`src/cli-adapter.ts`、`src/main.ts`、`test/cli-adapter.test.ts`。

驗證（2026-10-24）：lint 通過；完整 `npm test` 253 項、246 通過、6 失敗（ISSUE-035 既有）；新增測試涵蓋串流中／完成的畫面與提示過濾；以 w3:p1 當前真實畫面重放，`claudeTurnComplete` 為 true、輸出不含更新提示。

未驗證／限制：Discord 端到端未驗收；沒有「✻ … for」尾巴的短回合（若存在）會多等至 30 秒強制收尾並改貼「不完整」片段，需實機觀察是否出現；折行混亂未處理；非 Claude Agent 不受影響。

## ISSUE-041：bridge 不支援 Herdr 遠端機器的 Agent

更新日期：2026-10-24。狀態：已驗收（僅限文字對話；bridge 於 2026-10-24 以此 build 重啟為 w2:p1W）。

症狀：已用 `herdr machine add` 加入遠端機器 agy-pod（其 Herdr 有 agy Agent，`w2:p1`），但 Discord 端看不到該 Agent。預期：遠端 Agent 與本機 Agent 一樣可對應 thread、收發訊息。

已確認根因：這是尚未實作的能力，不是 bug。bridge 只連本機 `~/.config/herdr/herdr.sock`；`src/` 沒有任何 machine 處理。遠端 Herdr 只能透過 `herdr --machine`（CLI）存取，本機沒有轉發到遠端的 socket。另 pane／workspace ID（如 `w2:p1`）只在單一 Herdr server 內唯一，遠端與本機會撞號。

設計（使用者決定）：沒帶機器 ID 的一律是本機，帶 `<機器>:` 前綴的才找對應機器。(1) 設定 `machines: [{ id, ssh, socket }]`（`socket` 為遠端 Herdr API socket 的絕對路徑，agy-pod 實測為 `/root/.config/herdr/herdr.sock`）。(2) 對每台機器由 bridge 啟動 `ssh -N -L <本機短路徑 socket>:<遠端 socket> <ssh>`（路徑 `~/.config/herdr-discord-bridge/tunnels/<id>.sock`；`BatchMode`、`ExitOnForwardFailure`、`ServerAliveInterval=15`），斷線以 1→30 秒退避重連。(3) `HerdrHub`（`src/machines.ts`，繼承 `HerdrClient`）攔截所有 request：參數中的 ID 若帶機器前綴，去掉前綴後送到該機器，回傳的 `terminal_id`／`pane_id`／`workspace_id`／`tab_id` 再補上前綴並加 `machine` 欄位、workspace 名稱加 `<機器>:` 前綴；`agent.list`／`workspace.list`／`session.snapshot` 合併本機與所有遠端；混用本機與遠端 ID 的 request 被拒絕。遠端暫時不通時沿用上次的清單（避免 watcher 誤報 Agent 已移除，連帶清掉對應），並只在狀態改變時記錄一次；本機不受影響。機器 ID 須為 `[A-Za-z][A-Za-z0-9_-]{1,31}`，且不可長得像本機 ID（`w1`、`term_*`、`local`）。`allowedWorkspaceIds` 可寫 `agy-pod:w2`。

範圍限制：收發訊息、串流回覆、approve／cancel 等沿用 Herdr API 的操作。Discord → 遠端 Agent 的附件已支援（2026-10-24 後續，見「遠端附件」）；`herdr-discord-send` 與 Agent → Discord 的檔案回送仍不支援遠端（路徑沙箱以本機檔案系統為準，遠端 Agent 上也沒有該指令／skill）。

驗證（2026-10-24）：lint 通過；`npm run check` 型別檢查通過；新增 `test/machines.test.ts`（設定驗證、本機／遠端路由與 ID 前綴、混用拒絕、遠端中斷沿用舊清單）通過；完整 `npm test` 僅剩 ISSUE-035 既有的 6 項失敗。手動確認：`ssh -L` 轉發到 `/root/.config/herdr/herdr.sock` 後送 `agent.list` 可回傳遠端 agy（2026-10-24，經 ~/.ssh/config 的 ProxyCommand＋kubectl）。

未驗證：以 `HerdrHub` 實際啟動 tunnel 的端到端；Discord 端對遠端 Agent 建立 thread 並收發；kubectl 連線中斷後自動重連；`startProfile`（Team Worker 在遠端分割 pane）；`session.snapshot` 的欄位是否全是頂層陣列（目前合併頂層陣列）。下一步：將 `machines` 寫入設定、重啟 bridge 後在 Discord 驗收。

實測（2026-10-24 23:34，Discord thread「Agy-pod」）：bridge 啟動後 `machine agy-pod: connected`；Discord 看得到遠端 agy（WK `agy-pod:w2`、Pane `agy-pod:w2:p1`），建立 thread 並送出「妳是什麼模型」成功抵達遠端（經 tunnel 的 list／prompt／read 皆運作），17 秒後回報「capture incomplete; diagnostic delivered」。診斷檔（`capture-diagnostics/…agy-pod_w2_p1.json`）顯示遠端 agy 畫面停在「Models & Quota」面板（`(1–22 of 38 lines)`、`esc Close`），輸入框空白、畫面中沒有該 prompt，所以沒有可擷取的回覆。**尚未確認**這個面板是 prompt 送出前就已開著（最可能，因遠端畫面至今仍是同一個面板），還是 prompt 觸發的；因此本次失敗不能歸因於遠端傳輸，也不能算驗收通過。下一步：關閉該面板後重送一次，再看回覆能否擷取。

驗收（2026-10-24，Discord thread「Agy-pod」→ 遠端 agy `agy-pod:w2:p1`）：我送 esc 關閉遠端「Models & Quota」面板後，使用者在 thread 重問，Discord 收到正確回覆。這證實上一次失敗是遠端畫面狀態所致，不是傳輸問題。**仍未驗收**：kubectl 連線中斷後自動重連、遠端 Agent 在 Discord 側持續多輪對話、`startProfile`（Team Worker）、遠端 Agent 被關閉時的清理；附件與 `herdr-discord-send` 依設計不支援遠端。

遠端附件（2026-10-24，Discord → 遠端 Agent）：先前遠端 Agent 的 `cwd`（如 `/root`）不在本機，若沿用本機流程會在本機嘗試建立 `/root/...`。現改為：下載與驗證沿用本機流程（Discord CDN host、無 redirect、大小與簽章檢查，圖片 ≤ 5 MiB、檔案 ≤ 10 MiB、最多 4 個）寫到本機暫存目錄；再以 `ssh <target> 'umask 077 && mkdir -p DIR && cat > FILE'` 串流上傳到遠端 `<遠端 cwd>/.herdr-discord-bridge/attachments/message-<隨機>/`（目錄 0700、檔案 0600；檔名僅允許 `[A-Za-z0-9._-]` 且不得以 `.` 開頭；指令參數一律 shell quote）；最後刪除本機暫存，prompt 內放遠端路徑。無遠端 cwd 時明確拒絕。每個檔案各開一次 ssh 連線（經 kubectl ProxyCommand，會多幾秒）；遠端上傳失敗時整則附件失敗並回報錯誤。範圍：`src/machines.ts`（`uploadFiles`、`HerdrHub.uploadTo`）、`src/main.ts`（`prepareRemoteAttachments`）。
驗證（2026-10-24）：lint、`npm run check` 型別檢查通過；`test/machines.test.ts` 新增上傳測試（以 sh 取代 ssh：位元組內容、不安全檔名、非絕對路徑）通過；完整 `npm test` 僅剩 ISSUE-035 既有 6 項失敗。以真實 ssh 上傳測試檔到 agy-pod：檔案落在預期目錄，目錄 `drwx------`、檔案 `-rw-------`，內容正確（測試檔已刪除）。**未驗收**：Discord 端到端（含圖片與一般檔案）、遠端 Agent 是否真的讀得到並回應、大檔（接近 10 MiB）在 kubectl 連線上的耗時、遠端附件不會自動清理（沿用本機行為，無 retention）。狀態：遠端附件已修正、待驗收；bridge 尚未以此 build 重啟。

## ISSUE-042：Agent 在 Discord 驅動的回合中重啟 bridge，該回合的回覆遺失

更新日期：2026-10-28。狀態：串流續傳已驗收（2026-10-28）；重啟時已 blocked 的補發通知單獨路徑尚未驗收。原狀態：待調查（2026-10-25）。

症狀：2026-10-24 23:54，使用者在 thread「git repo Herdr_Discord_Bridge」（對應 w1:p1，Claude）回「好」授權 commit／push／重啟。Discord 上該則進度訊息停在「working · 已耗時 1秒／Running 1 shell command…」，之後沒有任何更新與最終回覆；使用者回報「沒回應」。預期：回合結束後仍收到最終回覆，或至少看到明確的「bridge 已重啟」說明。

已確認：該回合內，Agent 自己執行 `./scripts/run.sh -r`，它關閉舊的 bridge pane 並開新的；負責該回合串流（`streamAgent`）的行程隨舊 bridge 結束，新 bridge 沒有接續進行中的串流（記憶體中的 activeStreams 不持久化），所以最終回覆沒有送出。Agent 端的工作本身完成（commit、push、重啟皆成功）。**未確認**：是否也有其他時機（例如 bridge 崩潰、手動重啟）造成同樣的遺失——推論相同，未另行重現。

限制／暫行作法：由 Discord 驅動的 Agent 要重啟 bridge 時，最後一則回覆不會送達，請在 Herdr 直接看，或重啟後再要求 Agent 重述結果。可能的修正方向（未實作）：重啟前把進行中的串流（terminal、prompt、Discord 訊息 ID）寫入狀態檔，新 bridge 啟動後接續擷取；或在關閉前先送出「bridge 重啟中」並於啟動後補送最終回覆。

驗證：2026-10-25 對照使用者截圖與當時時間線（重啟指令與該則訊息同在 23:54）；未做自動化重現。

遠端圖片附件驗收（2026-10-25，Discord thread「Agy-pod」→ 遠端 agy `agy-pod:w2:p1`）：使用者傳一張圖片，遠端 agy 正確描述圖片內容（bridge 為 2026-10-24 重啟的 w2:p1X）。圖片附件已驗收。**仍未驗收**：一般（非圖片）檔案附件、接近 10 MiB 的大檔耗時、遠端附件無自動清理。

## ISSUE-043：傳入附件沒有保留期限

更新日期：2026-10-29。狀態：已驗收（本機於 2026-10-25 實測刪除；遠端於 2026-10-29 以 ssh 檢查取得間接證據，見「遠端刪除驗證」）。程式已 commit（657bbf2）。

症狀：Discord 傳入的附件存在 `<Agent cwd>/.herdr-discord-bridge/attachments/message-*/`（本機與遠端皆是），沒有清理，會一直累積（ISSUE-039／041 已註記為限制）。使用者要求：超過三天就清理。

修正：`cleanupOldAttachments`（`src/attachments.ts`）：刪除 root 直接子項中名稱符合 `message-<英數>`、為真目錄（`lstat`，不跟隨 symlink）且 mtime 超過 3 天（`ATTACHMENT_RETENTION_MS`）的目錄；其他檔案與目錄一律不動。遠端 `cleanupRemoteAttachments`（`src/machines.ts`）以 ssh 執行 `find <root> -mindepth 1 -maxdepth 1 -type d -name 'message-*' -mmin +4320 -exec rm -rf {} +`（root 以 shell quote、須為絕對路徑）。`startAttachmentCleanup`（`src/main.ts`）於 bridge 啟動時與之後每 6 小時，對 `agent.list` 內每個不重複的（機器, cwd）掃描一次；失敗只記錄、不影響其他項目，結束時停止計時器。

限制：只掃目前仍存在的 Agent 的 cwd；Agent 已關閉或 cwd 不再出現在列表的目錄不會被清理（需要時手動刪）。遠端不通時該輪略過、下一輪再試。以 mtime 判斷，目錄內容被後續修改會延後清理。刪除不可復原。

驗證（2026-10-25）：lint 通過；`npm run check` 型別檢查通過；新增測試通過：本機只刪過期 `message-*`、保留較新者與其他名稱目錄與 symlink 指向的外部目錄；遠端以 sh 取代 ssh 驗證 find 範圍、不存在的目錄與輸入驗證。完整 `npm test` 僅剩 ISSUE-035 既有 6 項失敗。真實 ssh 對 agy-pod 執行清理：成功完成，未過期的目錄仍保留。**未驗收**：重啟後實際刪除過期目錄（含遠端）；6 小時週期；本機現有舊目錄在重啟後會被刪除（符合要求）。

實測（2026-10-25，bridge w2:p1Y 啟動後）：主控台依序出現「Removed 6／11／1／4 expired attachment folder(s)」，即本機各 Agent cwd 底下共 22 個過期 `message-*` 目錄已被刪除；專案目錄的 `.herdr-discord-bridge/attachments/` 只剩 3 個較新的。遠端 agy-pod 的 `attachments/` 只有 1 個（2026-10-25 00:07 上傳的圖片，未滿 3 天），符合預期但**沒有實際刪除過遠端過期目錄**，所以遠端刪除仍只有單元測試與真實 ssh 執行成功（無過期目錄）的證據。

遠端刪除驗證（2026-10-29，ssh agy-pod，pod 時間 CST）：2026-10-25 00:07 上傳的 `message-*` 目錄已不存在；`/root/.herdr-discord-bridge/attachments` 目前是空目錄，其 mtime 為 10-28 03:53，即子目錄被刪除的時間，落在上傳後約 3 天 3 小時 46 分，與「超過 3 天才清理」相符。這是間接證據：沒有取得當次 bridge 的「Removed … expired」log（主控台捲動紀錄已不含），也無法排除該目錄被其他方式刪除，但無其他已知刪除來源。6 小時週期本身沒有單獨驗證。

遠端一般檔案附件驗收（2026-10-25，Discord thread「Agy-pod」→ 遠端 agy `agy-pod:w2:p1`）：使用者傳一個非圖片檔案，遠端 agy 正確讀取內容並回覆（bridge w2:p1Y）。遠端圖片與一般檔案附件皆已驗收。**仍未驗收**：接近 10 MiB 大檔的耗時（遠端過期目錄刪除已於 2026-10-29 取得間接證據，見上）。

## ISSUE-044：同一則 Claude 回覆在 Discord 被重複貼出多則

更新日期：2026-10-26。狀態：已修正、待驗收（原始碼已改；執行中的 bridge 為 w2:p1Y，**未重啟**；已送出的重複訊息無法收回）。

症狀：使用者在「git repo Herdr_Discord_Bridge」thread 問「Openab 是靠 acp…」，同一個回答在 Discord 出現多則。預期：回覆只貼一次。

證據（2026-10-26 本機）：`capture-diagnostics` 在 13:53:30–13:57:55 之間為 w1:p1 連續存了 6 份，間隔約 1 分鐘，prompt 相同，elapsed 35–50 秒。畫面其實早已完整，且回合尾巴「✻ Baked for 16s · done」已出現，`claudeTurnComplete` 對該畫面重放為 true；診斷檔 `agent_status` 為 idle。表示每一輪都是走 30 秒閒置強制收尾（沒有「settled」），收尾又因 rewatch 續傳而重來一輪，每輪都貼一次擷取片段。其中三份的 `extracted_last` 是從句中開始的截短版（895 字，全文為 1187 字），其餘為完整版。畫面最後一行輸入框在 `❯` 與 `❯` + 不換行空白（U+00A0）之間交替，與游標閃爍相符。

已確認：(1) 原始畫面比較把游標閃爍當成「畫面在變」，settled 永遠不成立，只能靠 30 秒強制收尾；(2) 強制收尾後的 rewatch 只要本次擷取與上次不同就續傳並再貼一次，截短版與完整版交替出現就會一直續傳，直到 `MAX_REWATCH_RESUMES`（5 次）。**未確認（推論）**：游標閃爍是畫面不穩定的唯一原因；截短版擷取（895 字）的成因——診斷檔的 `raw_screen_tail` 長度不一，無法用它重放當時的完整畫面，故未重現。

修正：(1) `stableScreen`（`src/cli-adapter.ts`）：比較畫面時忽略行尾空白／U+00A0，Claude 並排除輸入框與其下狀態列，只有回覆內容變動才算畫面改變。(2) rewatch 續傳條件加上「新擷取不得已被上次片段包含」，截短版不再觸發續傳。(3) 強制收尾貼出的片段記錄在 `excerptDelivered`，同一 prompt 若新片段已包含於先前貼過的內容，不再貼出。範圍：`src/cli-adapter.ts`、`src/main.ts`、`test/cli-adapter.test.ts`。

驗證（2026-10-26）：lint 通過；`npm run check` 型別檢查通過；新增 `stableScreen` 測試（游標閃爍與行尾空白視為相同、內容改變視為不同）通過；完整 `npm test` 僅剩 ISSUE-035 既有 6 項失敗。

未驗證：Discord 端到端（回覆應只貼一次、約 10 秒內以「✅ final response delivered」收尾）；截短擷取的根因；排除輸入框後是否有其他會抖動的畫面區域（例如 spinner 以外的狀態列）；先前 ISSUE-036／040 的驗收仍待。

### ISSUE-044 重新開啟（2026-10-28）

更新日期：2026-10-28。狀態：已修正、待驗收（已 commit／push ccec39b，bridge 於 2026-10-28 重啟為 w2:p10 並載入新碼；Discord 端到端尚未驗收；已送出的重複訊息無法收回）。

症狀：使用者回報 Discord「一直滾動停不下來」。2026-10-28 01:47–01:52 UTC，`capture-diagnostics` 為 w1:p1 連續存了 6 份（1 次初始＋`MAX_REWATCH_RESUMES` 5 次續傳），同一 prompt，elapsed 33–56 秒，之後因達上限自行停止。先前 10-26 的 stableScreen／rewatch 包含判斷修正已部署（6d0c53d），仍重現。

已確認根因：Claude 在回合尾巴 `✻ Brewed for 22s · done` 之後，會在輸入框上方多印一行 `※ recap: …`（離開一段時間後的摘要）。`claudeTurnComplete` 要求「最後一個內容列」是回合尾巴，被這行擋住而判定未完成，每次都走 30 秒閒置強制收尾；強制收尾沒有正式 final，rewatch 又因擷取長度在 1496–1498 字之間飄動而判定「有新內容」續傳，每輪貼一次。診斷檔 `raw_screen_tail` 尾端可見該 `※ recap:` 行。**未確認**：擷取長度 1–2 字飄動的來源（可能與 recap 行或游標相關）；目前僅以「讓完成判斷不再受 recap 影響」來消除強制收尾。

修正：`src/cli-adapter.ts` 的 `claudeTurnComplete` 忽略以 `※ ` 開頭的列（`CLAUDE_RECAP`）。新增測試「claude turn footer followed by a recap line still counts as complete」。

驗證（2026-10-28）：`npm run build` 通過；`node --test dist/test/cli-adapter.test.js` 27 項全過。未跑完整 `npm test`。

未驗證：Discord 端到端（應只貼一次、約 10 秒內「✅ final response delivered」）；rewatch 在其他會讓擷取飄動的情境仍可能重複（上限 5 次的洗版保護未加強）。

## ISSUE-045：以 CLI hook／協定取代畫面擷取判斷完成與權限

更新日期：2026-10-28。狀態：Claude 部分已驗收，其餘規劃中。Claude `Stop` 首版原始碼與單元測試完成（`src/hook-events.ts`、`src/hook-cli.ts`、`scripts/herdr-discord-hook`、`streamAgent` 整合）；已 commit／push（47a889a），bridge 於 2026-10-28 重啟為 w2:p21，`~/.claude/settings.json` 已註冊 `Stop` hook（備份 `settings.json.bak-hook`）；**Discord 端到端未驗收**，其餘（權限、其他 CLI）規劃中。

動機：ISSUE-036／040／044 都源於從畫面猜「是否完成」「回覆內容」；權限請求同樣只能靠畫面。使用者要求 TUI 留在 Herdr，同時 bridge 走結構化事件。

已查（文件／字串，未實測）：Claude 有 `Stop`（含 `last_assistant_message`）與可回傳決定的 `PermissionRequest`；Codex 二進位含同名事件字串，另有 app-server 共用 thread（spike 已實測 `turn/start` 與 TUI 同步）。agy／pi 等未查。細節與待驗證清單見 [hook-transport-proposal.md](hook-transport-proposal.md)。

約束：**parser 路徑永遠保留為備用**；hook 事件缺失、逾時或 CLI 不支援時退回 parser，不得移除或降級。

已驗證（2026-10-28，Claude 臨時 pane）：`Stop` 帶 `last_assistant_message`；`PermissionRequest` 可等待外部決定且 TUI 同時顯示提示，回傳 allow 後 TUI 自動執行；TUI 先決定時 hook 行程不會被取消。細節見提案文件。

未驗證：deny、bridge 端接收與關聯、Codex／agy／pi 能力、遠端 machine、事件遺失的退回流程。bridge 程式尚未動。下一步：做 bridge 的 hook 事件入口與 Claude 最小版（`transport: auto`，逾時退回 parser）。

首版驗證（2026-10-28）：lint 通過、`npm run build` 通過；新增 `test/hook-events.test.ts` 4 項（事件解析、store 時間門檻、socket 傳遞、Claude Stop 使無 footer 的串流直接收尾）通過；完整 `npm test` 265 項、僅剩 ISSUE-035 既有 6 項失敗（258 通過）。`format:check` 的 2 個警告（`test/session-handoff.test.ts`、`config.example.jsonc`）為既有檔案，非本次變更。

首版未驗證：真實 Claude 透過已註冊的 hook 送出 `Stop` 到執行中的 bridge；Discord 端到端只貼一次；hook 未註冊或 bridge 重啟時退回 parser；Stop 與使用者直接在 pane 輸入的回合混淆的情況（目前以 session id 與回合開始時間過濾）。

### ISSUE-045 PermissionRequest 轉 Discord（2026-10-28，已部署並驗收；allow／deny／數字／按鈕／恢復通知皆經使用者實測）

部署：commit 2516a60；bridge 於 2026-10-28 重啟為 w2:p22；`~/.claude/settings.json` 已註冊 `PermissionRequest` hook（timeout 300 秒）。

範圍：`src/hook-events.ts`（`PermissionBroker`、server 保持連線、`requestPermission`）、`src/hook-cli.ts`、`src/main.ts`（`deliverApproval` 先嘗試把 allow／deny 回給 hook；`handleTransition` 離開 blocked 與 `handleRemoved` 取消等待）。

驗證（2026-10-28）：lint 通過；新增 2 項測試（決定文字對應、broker 的 decide／cancel／連線中斷／無 pane id）通過；完整 `npm test` 267 項、260 通過，失敗的 6 項為 ISSUE-035 既有項目。**真實 Claude 端到端（不含 Discord；Discord 端見 ISSUE-046 驗證）**：以暫時 pane 搭配獨立的 hook server 與真正的 `herdr-discord-hook`，allow 後工具執行；deny 後 Claude 回報「Denied by PermissionRequest hook」且檔案未建立；cancel 後 TUI 提示仍在，使用者按 Enter 後工具照常執行。測試檔已清除。

未驗證：Discord 端（按鈕與文字回覆實際到 hook）；正在跑的 bridge 內 Herdr 的 `blocked` 轉換與 hook 事件的時序（hook 先於 blocked 通知，approval 紀錄在通知時才建立）；TUI 先決定後 Discord 補貼的恢復通知；auto mode 不會觸發，需用 default／manual 權限模式驗收。

## ISSUE-046：在 Discord 回覆權限選項數字沒有反應

更新日期：2026-10-28。狀態：已驗收（使用者實測；📨 回饋與診斷 log 已部署於 bridge w2:p23 並於本次 commit）。原本 `3` 沒反應的根因未確認，若再發生改為重新開啟。

症狀：使用者（default 權限模式的 Claude，PermissionRequest hook 已部署）在 Discord 輸入選項數字 `3` 後，沒有看到任何反應；之後按「Approve / continue」才有動作（當時 bridge 重啟為 w2:p22，log 出現 interaction `ephemeral` 警告，表示按鈕回了過期或失敗訊息）。預期：回答送進 TUI，Discord 有明確回饋。

已確認：(1) 文字回答成功時 bridge 原本**完全沒有回饋**（只有按鈕有「✅ delivered」），使用者無法分辨已送出或沒收到。(2) 同一個 API 呼叫（`pane.send_input` 文字加 Enter）在暫時的 default-mode Claude pane 對權限選單送 `1` 有效，Herdr 狀態在提示出現時為 `blocked`。(3) 按鈕送的是文字 `continue`，只有 PermissionRequest hook 正在等待時才會變成允許；否則對 Claude 的編號選單無作用。(4) 選項 3 是「Yes, and switch to auto mode」，成功時會改變該 session 的權限模式。**未確認**：使用者那次數字是在哪個 thread、是否有被 bridge 收到、當時 Herdr 狀態是否仍為 `blocked`、按鈕錯誤的實際文字。

已做（原始碼）：文字回答成功後在使用者訊息加 📨 反應；`deliverApproval` 記錄 `approval reply pane=… text=… hookPending=… decision=…` 到 bridge console。

未驗證：重啟後重現並用 log 判斷是未收到、狀態已非 blocked，或送出後 TUI 沒反應。

驗證（2026-10-28，使用者在 Discord 實測，bridge w2:p23 的 console log 為證）：(1) colab_llm（`w5:p3`）回覆 `2`：`hookPending=true decision=none`，數字送進 TUI，agent 繼續執行。(2) 本 session（`w1:p1`）回覆 `1` 兩次、`allow`、`deny`、`allow`：`allow` 與 `deny` 皆 `decision=…` 並由 hook 回傳——`allow` 後指令執行，`deny` 後 Claude 收到「Permission denied by hook」且測試檔未被刪除，再次 `allow` 後刪除成功。(3) 使用者確認文字回答後出現 📨 反應。

使用者回報（2026-10-28）：「Approve / continue」按鈕、TUI 先決定後的恢復通知，以及 Claude `Stop` hook 的 Discord 端到端（回覆只貼一次、很快收尾）皆正常（以使用者口頭回報為證，無額外 log 擷取）。未驗證：早先 `3`（switch to auto mode）沒反應的原因，可能是重啟前舊版或當時狀態，無 log 佐證。

### ISSUE-045 Codex 接入（2026-10-28，原始碼完成，待使用者信任 hook 與驗收）

已做：`~/.codex/hooks.json` 加入 `Stop`（10 秒）與 `PermissionRequest`（300 秒）指向 `scripts/herdr-discord-hook`（備份 `hooks.json.bak-hook`）；`streamAgent` 的 hook 收尾條件由 Claude 擴及 Codex（agent_session kind `id`）；`PermissionRequest` 的 broker／Discord 回覆路徑本來就以 pane 為單位，不分 CLI。新增 1 項測試（Codex 的 Stop 使串流直接收尾）；完整 `npm test` 268 項、261 通過，失敗的 6 項為 ISSUE-035 既有項目；lint 通過（2026-10-28）。

**尚未生效的條件**：Codex 要求新 hook 先在 `/hooks` 審查並信任，信任前會被略過。嘗試以 `--dangerously-bypass-hook-trust` 做暫時實測被安全機制拒絕，故沒有繞過、**Codex 的 hook 輸入輸出格式與等待行為未實測**，目前只依官方文件。

未驗證：全部 Codex 實測（Stop 觸發與 `last_assistant_message`、PermissionRequest 等待與 TUI 同時顯示提示、cancel 後回到原核准流程、與現有 Codex transcript 收尾的先後）；Discord 端到端。

### ISSUE-045 通道設定、hooks 指令與說明（2026-10-28，原始碼完成，待驗收）

新增 `hookTransport` 設定（`auto`／`parser`，預設 `auto`）、`hooks` 狀態指令（Discord 與 console）、help 文字與 README（中英）安裝說明及設定範例；`parser` 模式下 `streamAgent` 忽略 Stop 事件、`deliverApproval` 不走 hook 決定。測試（2026-10-28）：新增 2 項（設定驗證／模式查詢／狀態文字、parser 模式忽略 Stop 事件）；完整 `npm test` 270 項、263 通過，失敗的 6 項為 ISSUE-035 既有項目；lint 通過。未驗證：Discord 上實際執行 `hooks` 指令與 help 顯示；`parser` 模式在真實 Claude／Codex 的行為；Codex hook 實測（待使用者在 Codex `/hooks` 信任後驗收）。

### ISSUE-045 Codex 實測結果與撤回 PermissionRequest（2026-10-28）

實測（本機，Codex v0.162.1，暫時 pane 與暫時專案，`-a on-request -s read-only`，hook 已在 `/hooks` 信任）發現兩個問題，故**撤回 Codex 的 `PermissionRequest` hook 註冊**（`~/.codex/hooks.json` 現僅剩 Herdr 的 `SessionStart` 與 `Stop`；備份 `hooks.json.bak-hook`）：

1. **Codex 在 PermissionRequest hook 執行期間不顯示核准提示**，畫面是 `Working … · herdr-discord-hook: relay to Discord bridge`，Herdr 狀態為 `working` 而非 `blocked`。與 Claude 不同（Claude 提示與 hook 同時顯示）。因此不會產生 Discord 的 blocked 核准通知，使用者在 TUI 也無法回答，直到 hook 逾時或結束（我們的指令最長等 290 秒）。結束 hook 後才出現一般核准提示（畫面顯示 `hook exited without a status code`）。
2. **hook 的環境變數不可信**：hook 行程的 `HERDR_PANE_ID` 是 `w4:p1`（另一個 Codex pane），也沒有繼承測試用的 `HERDR_DISCORD_HOOK_SOCKET`。推測 hook 由共用的 Codex app-server daemon 執行，繼承的是 daemon 啟動時的環境（**未確認**）。因此以 `HERDR_PANE_ID` 對應 pane 對 Codex 不可靠，必須改用 session id 對應。

影響與狀態：Codex 的權限 hook 暫不可用；Codex `Stop` 仍註冊，但**未取得實測證據**（測試中事件未送到測試用 socket，原因同第 2 點；未驗證是否送到正式 bridge）。Claude 不受影響。我曾因測試在 `~/.codex/config.toml` 暫時加入 `/private/tmp/cx2/proj` 的 trusted 專案紀錄，已移除。

下一步（未做）：Codex `Stop` 的 pane 對應改用 session id（`hookEvents` 已以 session id 查詢，應不受影響，待實測確認）；Codex 權限改走 app-server 協定，或在 Codex 提示出現前不阻塞（例如 hook 立即回傳不決定並由 bridge 另行通知）。

後續（2026-10-28）：`hooks` 指令對 Codex 的 `PermissionRequest` 改顯示「未註冊（Codex 不建議開啟）」，若已註冊則警告；README／SPEC 同步改為 Codex 只開 `Stop`；bridge 在收到 hook 事件時於 console 印出 `hook <事件> session=… pane=… chars=…` 供驗收對照（bridge 已重啟為 w2:p26）。完整 `npm test` 270 項、263 通過，失敗的 6 項為 ISSUE-035 既有項目（2026-10-28）。待驗收：Codex `Stop` 實際送達 bridge 並使串流提前收尾。

使用者回報（2026-10-28）：在 Discord 問 Codex agent 後 bridge console 有出現 `hook Stop …` 並正常收尾，Codex `Stop` 視為已驗收（以使用者口頭回報為證）。Codex 權限仍不可用（見上）。

### ISSUE-045 Codex 權限：allow／deny 轉快捷鍵（2026-10-28，已實作、待 Discord 驗收）

評估：(a) app-server 協定的核准是 server→client 請求（schema 有 `CommandExecutionRequestApprovalParams`、`FileChangeRequestApprovalParams`、`PermissionsRequestApprovalParams`），但要讓 Codex TUI 改連共用 app-server（`codex --remote`），且第二個 client 是否能收到並回應 TUI 那條 thread 的核准請求**未驗證**，改動大；(b) 不阻塞的 hook 對 Codex 無益——parser 路徑本來就能偵測 `blocked`。採用較小的做法：Codex 的核准提示有快捷鍵 `y`（核准）與 `esc`（拒絕），Discord 的 `allow`／`deny`（含核准按鈕的 `continue`）在 Codex 改送這兩個按鍵，其他文字（含數字）照舊打進 TUI。

實測（2026-10-28，本機 Codex v0.162.1，暫時 pane，`-a on-request -s read-only`，經 Herdr API `pane.send_keys`）：`y` 後指令執行（檔案建立、Codex 回報 DONE）；`esc` 後指令未執行，Codex 顯示 `You canceled the request` 並**中斷該回合**（`Conversation interrupted`），即拒絕等同於「No，並告訴 Codex 怎麼做」的 esc。測試 pane 與暫存檔已清除。

原始碼：`HerdrClient.sendKeys`（`pane.send_keys`）、`deliverApproval`（已匯出以便測試）；新增 1 項測試（allow→`y`、deny→`esc`、數字→文字、非 Codex 不轉換）。完整 `npm test` 271 項、264 通過，失敗的 6 項為 ISSUE-035 既有項目，lint 通過（2026-10-28）。

驗收（2026-10-28）：使用者在 Discord 對 Codex 回覆 `allow`／`deny` 後回報「都ok了」（本機 Codex 0.165.0，w4:p1；未逐項記錄 📨 與檔案結果）。

限制：快捷鍵是 Codex 目前版本畫面上標示的 `(y)`／`(esc)`，版本改動可能失效；deny 會中斷整個回合；其他核准類型（檔案變更、MCP 詢問）的快捷鍵未逐一測。

## ISSUE-047：Codex 送問後擷取因 session changed 中止，核准通知與 allow 驗收無法進行

更新日期：2026-11-06　狀態：已修正、待驗收（本次僅原始碼與自動化檢查；尚未在 Discord 對全新 Agent 實機驗證。2026-10-28 的驗收歷史保留，不代表本次已驗收。）

使用者症狀：在 Discord 對 Codex（w4:p1，python_test）送出「建立 hook_test_allow.txt」的 ISSUE-045 驗收提示後，回應卡片只顯示 `Agent identity changed (session changed); response capture stopped.`。Codex 實際停在核准提示（Herdr 狀態 blocked、標題 Action Required），但 Discord 上沒有走到 allow 的流程，因此 Codex 的 allow／deny 驗收尚未進行。

預期行為：有效 prompt 送達後持續等待本次回覆；核准時 Discord 出現核准通知並可回覆 allow／deny。

環境與已知事實：bridge 為 2026-10-28 重啟的 w2:p29，`streamAgent` 於 `src/main.ts` 比較 `initial.agent_session` 與當前值（`sameAgentSession`，kind＋value 完全相同才算同一個）。bridge log 顯示同一個 pane w4:p1 當天的 Codex session id 先後為 `01a18079`、`01a180eb`，驗收時 Herdr 回報 `01a180fe-d4a8-7bd1-9701-2155cdc999e6`，log 出現 `Response capture stopped: session changed (pane=w4:p1)` 兩次。與 ISSUE-008 相同症狀。

已確認：中止是 identity 比較不相等所致（不是 hook 或 y／esc 邏輯）。
使用者確認（2026-10-28）：送問前沒有 `/new`。
新證據（2026-10-28，讀 `~/.codex/sessions/2026/10/28/`）：`rollout-…13-32-27-01a180fe-…jsonl` 的建立時間（台北 13:32:27）與 Discord 送問時間（下午 1:32）吻合，session_meta 為 Codex 0.165.0、cwd `python_test`；前一個 session `01a180eb` 建立於 13:11:35。也就是說，Codex 在這個 prompt 到達時才建立新 session（檔案在第一個 prompt 才產生），Herdr 的 `agent_session` 在串流期間由舊 id 換成新 id。
推測（未驗證）：該 Codex 為重新啟動或新執行緒，session 於第一個 prompt 才實體化，因此 bridge 記下的 `initial.agent_session` 仍是舊值。尚無送問當下 `initial.agent_session` 的紀錄，無法證明舊值就是 `01a180eb`。
修正：`sessionCreatedSince`（`src/response-stream.ts`）判斷 UUIDv7 session id 是否建立於送問時間（容忍 5 秒）之後；`streamAgent` 對 Codex 在同 pane／terminal／workspace 下遇到這種新 id 時改追蹤新 id（log：`<agent> session created during turn pane=…`，codex／agy／pi 通用），其餘 id 變動仍停止擷取。新增 1 項測試。2026-10-28：lint 通過；完整 `npm test` 272 項、265 通過、6 失敗（ISSUE-035 既有項目）。注意：`CodexTranscript` 仍綁定舊 session 檔，換 session 後完成判斷靠 Stop hook 或畫面 parser。
下一步：使用者重新送問驗收；另記錄送問當下與換 id 當下的 `agent_session`以確認觸發原因。修正做法是在同一 pane／terminal／cwd 下，若新 session id（UUIDv7 內含毫秒時間）的時間不早於本次送問時間，視為同一回合的 session 實體化而改採新 id，其餘情況仍停止擷取，避免轉發其他對話。

### 2026-11-06 重新開啟：`agent start` 開的 codex pane，第一次從 Discord 送問就中止（已修正、待驗收）

使用者症狀（附圖 `.herdr-discord-bridge/attachments/message-mlpENO/1.jpg`，已以圖片工具讀取）：使用者在專案的 Discord thread 下 `agent use w1:p9`（bridge 回「目前對話 Agent：hdb-start-286cc66b」），再送「你看得到這thread剛剛有回應的嗎」（9:37 PM，台北時間；約 13:37Z）。bridge 的回應卡片標題為 codex／`w1:p9`，內容只有 `Agent identity changed (session changed); response capture stopped.`。codex 本身有回答（pane 畫面可見回答與 `Worked for 11s`），但答案沒有送回 Discord。使用者隨後下 `Agent use w1:p1` 切回 Claude。

環境：2026-11-06，本機 macOS，bridge 載入 main `27aa532`（含 `agent start`）；`w1:p9` 是 `agent start :codex:gpt-6.1-sol:medium` 開的新 pane，codex v0.166.0。bridge console log：`Response capture stopped: session changed (pane=w1:p9).`，之後 `hook Stop session=01a1b0fb pane=w1:p9`。

與 2026-10-28 的差異（舊修正沒有涵蓋）：目前 `w1:p9` 的 session id 是 `01a1b0fb-9774-77a3-9161-2351eac06ada`，UUIDv7 內含時間為 **13:10:40Z**（建立於 codex 啟動時），使用者送問約在 13:37Z，**早了約 27 分鐘**。`sessionCreatedSince`（`src/response-stream.ts`）要求 session id 時間 `>= 送問時間 - 5 秒` 才改追蹤新 id，因此不成立；於是走到 `!sameAgentSession(candidate.agent_session, trackedSession)` 而停止擷取。也就是 2026-10-28 的假設（session 在第一個 prompt 才建立）不適用這個情境。

已確認：(1) 中止來自 `streamAgent` 的 identity 比較（`src/main.ts` 的 `session changed` 分支）；(2) 事後 pane list 的 `agent_session` 與 Stop hook 的 session 都是 `01a1b0fb`，其 UUIDv7 時間早於送問；**送問當下與送問前**的 session 值沒有紀錄，不能說它「從頭到尾沒變」。
**當時根因未確認（保留原始調查紀錄）**：送問當下 bridge 記下的 `initial.agent_session` 是什麼（沒有保留）。比較合理的推測是 `agent start` 回傳的 Agent 記錄在 codex 還沒回報 session 時就被 bridge 保存（沒有 session 或是舊值），第一次送問期間 Herdr 才補上 session，造成「前後不一致」；但這沒有驗證。與 ISSUE-107 第 2 部分（agy 第一個回合後才登記的 session，`AgentPool.refreshSession`）同類，但那裡修的是 Worker 池，不是 Discord 回應串流。

**2026-11-06 重現（同日，bridge 載入 main `27aa532`）：**
- 前提：新開的 codex（`agent start :codex:gpt-6.1-sol:medium`）在送第一個 prompt 之前，Herdr 回報的 `agent_session` 是 `null`（`w1:pD`、`w1:pE` 都在啟動後等 20 秒仍是 `null`），第一次送問後才出現；該 session id 的 UUIDv7 時間是 **codex 啟動時**（`pD`：13:43:24Z，送問約 13:44:00Z，早約 36 秒；`pE`：13:45:25Z，送問約 13:47Z）。
- **Discord 路徑：連續 2 次在新 codex 的第一次送問都中止**：`w1:p9`（使用者截圖）與 `w1:pE`（使用者第二次試，bridge log `Response capture stopped: session changed (pane=w1:pE)`）；兩次 codex 都回答了（`Worked for 3s`），答案沒送回 Discord。
- **console 路徑：1 次未中止**：`agent use w1:pD` 後送「回答 ok 兩個字就好」，正常收到 `ok`。
- 程式差異（讀碼，未以實驗證明）：`ConsoleAgent`（`src/console-agent.ts`）有 ISSUE-069 的 `firstSession`，把「session 從沒有變成有」（pane／terminal／種類不變）視為第一次登記而不是被換掉；`streamAgent`（`src/main.ts`）對 `trackedSession` 為空、候選 session 有值時，只有在 `sessionCreatedSince`（session id 時間不早於送問時間 5 秒前）成立才改追蹤，否則判 `session changed`。新 codex 的 session 在啟動時就建立，所以不成立。
- 因此**目前較可信的根因**：`streamAgent` 沒有 ISSUE-069 的「第一次登記」處理，而 2026-10-28 的 `sessionCreatedSince` 假設 session 在送問時才建立，對 `agent start`（啟動後過一陣子才第一次送問）不成立。**仍不是已證明**：沒有紀錄送問當下 `initial.agent_session` 的值，也沒有解釋 console 那一次為什麼沒中止（可能與 Herdr 回報 session 的時間點有關，競態未排除）。

影響：用 `agent start` 開出來的 Agent，第一次從 Discord 對話收不到回答（要再問一次或看 pane）。再問第二次是否正常**尚未驗證**；console 路徑為什麼沒中止也未解釋。

修正與自行確認（2026-11-06）：讀碼確認 Discord 的 `streamAgent` 原本只靠 `sessionCreatedSince` 接受不同 session，空值首次變成啟動時已建立的舊 UUIDv7 會被拒絕；Console 的 ISSUE-069 已有首次登記例外。假 runtime 以空 session → 早於送問約 49 分鐘的 UUIDv7 重現：修正前答案漏送，6 個新增案例中 1 fail、5 pass。這確認了此判斷缺口，不補稱已取得當時缺少的 initial 實機記錄。

修正範圍：`src/response-stream.ts` 匯出純函式 `isFirstSessionRegistration`，只有 pinned／initial 無可辨識 session、候選有 session、pane／terminal／workspace／種類完全相同才成立；Discord 與 Console 共用。`streamAgent` 額外要求目前 trackedSession 仍無 session，避免首次登記後再次接受不同舊 session；登記後追蹤新值並 log 一行。原有 codex／agy／pi 回合中新建 session 的 `sessionCreatedSince` 路徑、session changed 停止分支與身份暫時不可用處理保留。`SPEC.md` 同步身份規則。

測試紀錄（2026-11-06，本機 macOS，非 CI）：初次 `npm run build` 因缺少 tsc exit 127；`npm ci` exit 0 後，新增串流案例紅燈 5 pass／1 fail（exit 1）。純函式測試先因尚未匯出函式 build exit 2；實作後補齊 fixture 的 agent_status。最終 `npm run build` exit 0；`node --test dist/test/response-delivery.test.js dist/test/response-stream.test.js dist/test/console-agent.test.js` 33/33 pass、0 fail（exit 0；此 checkout 無 console-agent.test.ts，實際執行前兩個檔案）。首次執行既有診斷寫入設定目錄被 sandbox 拒絕（EPERM，不影響斷言），改以 `HERDR_PLUGIN_STATE_DIR=/private/tmp/issue047-capture-tests` 重跑同一命令仍 33/33 pass、exit 0，診斷成功保存，無需 sandbox 外執行。`npm run lint` exit 0（177 TypeScript 檔），`git diff --check` exit 0。本次新增涵蓋首次登記送出答案、舊 session A → B 拒絕、pane／terminal／workspace／種類改變拒絕、純函式拒絕候選消失／空 session，並補回合中新建 session 的串流回歸案例；原有 `sessionCreatedSince` 的 codex／agy／pi 測試未刪除或弱化。

部署／驗收限制：**尚未在 Discord 對全新 Agent 實機驗證**；未重啟、未部署 bridge，執行中的 bridge 未載入本次修改，舊訊息不會因此補送。下一步由 Lead 交付後安排 Discord 對全新 Agent 的第一次送問驗收，另驗證 Console 與既有 session 替換守門。claude／agy／pi 新 pane 實機情境仍未驗證。

**2026-11-06 部署與 Discord 實機驗證（使用者操作，本機 macOS）：**PR #149 以 `c4201c9` merge 後，bridge 於 22:19（台北）重啟，`dist/src/response-stream.js` 與 `dist/src/main.js` 含 `isFirstSessionRegistration`。我用 `agent start :codex:gpt-6.1-sol:medium` 開全新的 codex `w1:pG`（送問前 `agent_session` 為 `null`），使用者在 Discord 下 `agent use w1:pG`，第一次送「你在什麼專案」（22:36，附圖 `.herdr-discord-bridge/attachments/message-LaQNrR/1.jpg`，已以圖片工具讀取）：回應卡片顯示 `finished — final response delivered · 總耗時 5秒`，答案「目前在 Herdr_Discord_Bridge 專案」有送回 Discord，沒有 `session changed`。bridge log 同時出現 `codex session first registered during turn pane=w1:pG; following new session`（修正新增的那一行，證明走的是這條路徑）與 `hook Stop session=01a1b13b pane=w1:pG`，沒有 `capture stopped`。修正前同樣情境在 `w1:p9`、`w1:pE` 連續 2 次中止。

**驗證範圍與限制：**這證明「`agent start` 開的全新 codex 第一次從 Discord 送問」已修好；console 的 `ask w1:pF …`（不經 `ConsoleAgent`）在修正前後都沒中止，也沒有走到新分支（log 沒有該行），所以它不能鑑別修正有沒有效，只算回歸檢查（回答 `ok` 正常）。**仍未驗證：**第二次送問、claude／agy／pi 的新 pane、既有 session 被換成別的 session 的守門（只有單元測試）。狀態維持「已修正、待驗收」，是否標已驗收由使用者決定。

### ISSUE-042 修正（2026-10-28，已實作、待驗收）

2026-10-28 重現：使用者回「好」授權後，Agent 執行 commit／push／`run.sh` 重啟，Discord 卡片停在 `working · Waiting for CLI output…`，最終回覆遺失（與 2026-10-24 相同）。

修正：`src/stream-resume.ts` 的 `StreamResumeStore` 把進行中的 Discord 回合（terminalId、paneId、channelId、進度訊息 ID、prompt、baselineOutput、startedAt）寫入 `~/.config/.../active-streams.json`（`stateDirectory()` 下）；`dispatchPrompt` 送出 prompt 後登記，串流結束後移除。bridge 啟動、Discord 就緒後 `resumeStreams` 依 terminal ID 找 live Agent、以 `DiscordAdapter.fetchMessage` 取回進度訊息，並以原 `startedAt` 重新呼叫 `streamAgent`（log：`Resuming stream pane=…`）。Agent 或訊息已不存在、超過 24 小時的記錄會被丟棄。

限制：Stop hook 事件只存在記憶體，重啟期間送出的 Stop 不會補回，這種情況由畫面 parser 判斷完成；進行中的 Codex 逐字稿以 `CodexTranscript.connect` 重新連線；team／console 路徑與強制收尾後的輕量觀察（`rewatchAfterForcedFinish`）不在此範圍。
驗證（2026-10-28）：lint 通過；新增 2 項 store 測試；完整 `npm test` 274 項、267 通過、6 失敗（ISSUE-035 既有項目）。**未驗證**：真實重啟中的回合是否接續並送出最終回覆。

2026-10-28 13:45 使用者回報：Codex deny 驗收提示送出後卡片停在 `working · 已耗時 1秒`、沒有出現核准選項（Codex w4:p1 實際已 blocked，畫面有 `Yes, proceed (y)`／`No (esc)` 提示）。核對：bridge 行程啟動時間為 13:45:38，與該則送問同一分鐘；舊 bridge 尚無續傳記錄，新 bridge log 沒有 w4:p1 的任何紀錄，`active-streams.json` 只有之後才送出的回合。判斷為該回合串流隨 13:45 的重啟中斷（ISSUE-042 在續傳功能部署前的最後一次發生），**不是** Codex y／esc 或核准路徑的缺陷；此判斷依時間吻合推得，沒有舊 bridge 的 log 可直接證明。另發現限制：重啟時已處於 blocked 的 Agent 不會有 working→blocked 轉換，新 bridge 不會補發核准通知。Codex allow／deny 的 Discord 端驗收仍未完成。

### ISSUE-042 補發 blocked 通知（2026-10-28，已實作、待驗收）

修正：`AgentWatcher` 首輪輪詢時，對已在 `blocked` 的 Agent 補發一次 `unknown → blocked` 轉換，走原本的 `handleTransition`（先收掉該 terminal 的舊核准，再送新的核准通知；`notifyOn` 未含 blocked 時不送）。限制：重啟前登記的 PermissionRequest hook 連線已斷，hook 行程靜默結束，該提示改由 TUI 流程處理，回覆以文字輸入（Codex 為 y／esc 快捷鍵）；每次重啟都會對仍 blocked 的 Agent 重送一次通知，舊通知的按鈕失效。
驗證（2026-10-28）：lint 通過；新增 1 項 watcher 測試（首輪補發、第二輪不重發、之後正常轉換）；完整 `npm test` 275 項、268 通過、6 失敗（ISSUE-035 既有項目）。**未驗證**：真實重啟時 Discord 收到補發通知。

### ISSUE-042 續傳驗收（2026-10-28）

環境：本機，bridge 版本 8b6532b，Codex 0.165.0 w4:p1。重啟時 w4:p1 有進行中的 Discord 回合（deny 測試，13:58 開始），新 bridge log 出現 `Resuming stream pane=w4:p1`；使用者在 Discord 回報「成功」（卡片接續更新並可回覆 deny；未逐項記錄畫面細節）。該 Agent 重啟時已 blocked，是由續傳的串流顯示，不是 watcher 補發的通知，所以「補發 blocked 通知」的獨立路徑（沒有進行中串流時）仍未驗收。

### ISSUE-045 agy Stop hook（2026-10-28，已驗收）

調查（本機 agy 1.4.7）：agy 有 hooks（`~/.gemini/config/hooks.json`，結構 `{群組: {事件: [{command,timeout,type}]}}`；工作區可用 `<workspace>/.agents/hooks.json`）。事件為 `SessionStart`、`PreInvocation`、`PostInvocation`、`PreToolUse`、`PostToolUse`、`Stop`（契約來自 agy 二進位內嵌文件）。**實測**（暫時工作區 hooks.json、`agy -p`）：`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop` 都會觸發。`Stop` 輸入含 `conversationId`、`terminationReason`（正常為 `NO_TOOL_CALL`）、`fullyIdle`、`transcriptPath`、`lastUserInput`，**沒有最終回覆**；最終回覆在 transcript JSONL 的最後一個沒有 `tool_calls` 的 `PLANNER_RESPONSE.content`（實測為 `DONE`）。hook 必須在 stdout 輸出 JSON 物件，否則違反契約。`conversationId` 與 Herdr 的 `agent_session`（kind `id`）相同。`PreToolUse` 在 `agy -p` 加 matcher 後**沒有觸發**（原因未查，可能是 print 模式不走權限流程）；文件上它可回 `allow`／`deny`／`ask`／`force_ask`，但每次工具呼叫都會觸發、無法分辨是否需要核准，所以**不採用**，agy 權限仍走畫面 parser。

實作：`src/hook-agy.ts`（`agyFinalMessage`、`isAgyStopInput`）；`src/hook-cli.ts` 辨識 agy 輸入（有 `conversationId`＋`terminationReason`、無 `hook_event_name`），先輸出 `{}`，只在 `NO_TOOL_CALL` 且 `fullyIdle` 不為 false 時讀 transcript（最多重試 4 次、每次 250ms）並以 `conversationId` 轉給 bridge；`hookTransport.agy`（預設 `auto`）與 `hooks` 指令支援 agy。已備份並寫入 `~/.gemini/config/hooks.json`（群組 `herdr-discord-bridge`，`Stop`、timeout 10；備份 `hooks.json.bak-hook`），README／README.zh-TW／設定範例／提案文件同步（並更正 README 中 Codex 列：只開 `Stop`）。
驗證（2026-10-28）：lint 通過；新增 1 項 transcript 解析測試並更新 hookTransport 測試；完整 `npm test` 276 項、269 通過、6 失敗（ISSUE-035 既有項目）；以暫時工作區的真實 Stop 輸入餵給 `herdr-discord-hook`，輸出 `{}` 且 exit 0。驗收（2026-10-28）：使用者從 Discord 問 agy w4:p5，確認卡片很快收尾且 bridge log 有 `hook Stop session=… pane=w4:p5`（回報 1、2 項都有）；先前的「response capture stopped」由 ISSUE-047 擴及 agy 修正後，使用者回報「ok了」。已開啟的 agy 是否重載全域 hooks 未另行確認。

### ISSUE-047 擴及 agy（2026-10-28，已驗收）

重現：部署 agy Stop hook 後，使用者從 Discord 問 agy（w4:p5）：Stop hook 有觸發（log `hook Stop session=db1c4b58 pane=w4:p5 chars=26`），但卡片顯示 response capture stopped；bridge log 為 `Response capture stopped: session changed (pane=w4:p5)`。Herdr 的 agy session 由先前的 `201d48fa…` 換成 `db1c4b58-690b-4f4a-93e7-fcc260852613`；後者的對話目錄 `~/.gemini/antigravity-cli/brain/db1c4b58…` 建立於 14:10:17，與送問時間吻合（與 Codex 相同形態：新對話在送問時才建立；觸發原因同樣未確認）。agy 的 id 是 UUIDv4，不含時間。
修正：`sessionCreatedSince` 新增 `createdAt` 查詢參數；`streamAgent` 對 agy（本機）以對話目錄的 birthtime 判斷是否為送問後建立，是則追蹤新 id，其餘仍停止。遠端 agy 無法查目錄，仍維持停止。
驗證（2026-10-28）：lint 通過；新增 1 項測試；完整 `npm test` 277 項、270 通過、6 失敗（ISSUE-035 既有項目）。驗收（2026-10-28）：重啟 bridge（a505bfb）後使用者從 Discord 問 agy，回報「ok了」（未逐項記錄 log 與耗時）。

### ISSUE-045 pi 擴充（2026-10-28 歷史驗收；2026-10-29 Linux 缺漏修正後已驗收）

調查（本機 pi 1.3.0，讀內建 docs 與型別）：pi 沒有 hooks.json，而是 TypeScript 擴充（`~/.pi/agent/extensions/`，與 Herdr 的 `herdr-agent-state.ts` 同目錄）。事件有 `agent_start`、`agent_end`（含 messages）、`agent_settled`（含 `aborted`，最終且僅通知）、`tool_call`（可 block）；pi 沒有內建權限提示，權限只存在於使用者自己安裝的擴充，所以 pi 只做完成通知，不做權限。
實作：`scripts/pi/herdr-discord-bridge.ts`（複製到擴充目錄；`HERDR_ENV=1` 才啟用；`agent_end` 取最後一則 `stopReason=stop` 的 assistant 文字，`agent_settled` 且未中止、TUI、已 idle 時以 session 檔路徑為 sessionId 傳到 hook socket，失敗靜默）；bridge 的 hook 比對由 `kind=id` 擴及 `kind=path`（pi 的 Herdr `agent_session` 是檔案路徑）；`hookTransport.pi`（預設 `auto`）與 `hooks` 指令支援 pi。ISSUE-047 的 session 切換追蹤也擴及 pi：以 session 檔名內的 ISO 時間判斷是否為送問後建立。已複製到 `~/.pi/agent/extensions/herdr-discord-bridge.ts`。
驗證（2026-10-28）：lint 通過；新增 1 項 session 檔名時間測試並更新 hookTransport 測試；完整 `npm test` 278 項、271 通過、6 失敗（ISSUE-035 既有項目）。驗收（2026-10-28）：重啟 bridge（f12892e 之後）、pi 載入擴充後，使用者從 Discord 問 pi（w4:p4），回報 bridge 有收到 hook 且「ok」（未逐項記錄 log 與耗時，也未另測送問後新 session 的追蹤路徑是否被觸發）。擴充與 Herdr 擴充互不影響屬觀察到無異常，未另行驗證。

### ISSUE-045 Linux Codex／Claude completion 註冊查核（2026-10-29，待調查）

使用者詢問 Codex／Claude 是否也需要安裝 completion hook。本機以 `registeredEvents()` 檢查 `~/.codex/hooks.json` 與 `~/.claude/settings.json`：兩個檔案都存在，但 bridge 的 `Stop`、`PermissionRequest` 皆未註冊；正式 `loadConfig()` 確認兩者模式均為 `auto`。這是設定缺漏的唯讀查核，不是新的 Discord 回覆失敗重現；過去其他環境的驗收不能代表此台 Linux 已部署。

預期／範圍：要透過 hook 取得正式 final，各 CLI 須各自註冊指向本專案 `scripts/herdr-discord-hook` 的 `Stop`；Codex 尚需在 `/hooks` 審查信任，Claude 的 `PermissionRequest` 屬權限整合、不是完成通知的必要條件。未註冊時仍會 fallback，Codex 可另有 native transcript 路徑，因此不表示所有回覆必然失敗。尚未修改兩者設定、未重啟或部署；本輪沒有為此執行模型回合或端到端驗收。下一步：使用者若要求安裝，保留既有 hooks，完成各自的註冊、載入／信任與 Discord 回合驗證。文件 `git diff --check` 通過。

### ISSUE-045 Linux Codex／Claude Stop 安裝（2026-10-29）

狀態：Codex、Claude 已驗收（2026-10-29，本機 Discord 回覆）。Codex 信任已於 2026-10-29 完成（使用者回報並核對信任紀錄）。此紀錄接續上方唯讀查核，保留未安裝時的歷史。

使用者授權「幫我處理」後，已在 `~/.codex/hooks.json` 與 `~/.claude/settings.json` 的 `hooks.Stop` 各追加一筆 command：`/home/jones/wk/Herdr_Discord_Bridge/scripts/herdr-discord-hook`，timeout 10 秒。各檔旁備份為 `hooks.json.bak-bridge-stop-20261029T132121`、`settings.json.bak-bridge-stop-20261029T132121`。合併時以 assertions 核對原有非 hooks 設定、所有其他事件及舊 Stop entries 完整保留；Herdr SessionStart 未變更。沒有安裝 PermissionRequest（本次只處理完成通知）。

環境／啟用狀態：正式設定載入器確認兩者 `hookTransport=auto`；`registeredEvents()` 確認兩者 `Stop=true`、`PermissionRequest=false`。Codex `features.hooks=true`，目前信任紀錄只有舊 SessionStart，未替新 Stop 寫入 trusted_hash、未繞過信任。唯一正在執行的 Codex 是本工作回合，無法在工作中向自身 TUI 注入 `/hooks` 並完成審查；解除方式為本回合完成後由使用者在 Codex 輸入 `/hooks`，確認路徑後信任 Stop。查核時無 Claude live pane，因此沒有可重載的 Claude 程序；下次啟動將讀取設定，實際觸發仍待驗收。未重啟任何 Agent 或 bridge，未變更原始碼或 build，未 commit／push。

驗證（2026-10-29）：以 Python 臨時 Unix socket 分別執行從兩份實際設定擷取的 command（先斷言為專案腳本絕對路徑），輸入合成 Stop payload；兩者均 exit 0、stdout 空白，接收內容與多行 final、sessionId、event 精確一致。此測試沒有經過 CLI hook 信任／載入流程，沒有對 Discord 發訊息，不等同實機成功。`node --test dist/test/hook-events.test.js` 13/13 通過、0 失敗，輸出 `/tmp/bridge-stop-tests-20261029.tap`；`git diff --check` 通過。只有設定與文件更新，未跑完整套件或重建。

補充驗證（2026-10-29）：使用者回報已在 Codex trust hooks；唯讀核對 `~/.codex/config.toml`，新增 `/home/jones/.codex/hooks.json:stop:0:0` 的 `trusted_hash` 存在，`enabled` 未顯式設定。本輪未修改信任紀錄，先前「只有 SessionStart」為安裝當時的歷史。信任步驟已解除，不代表已觀察到真實 Stop 觸發。

驗收（2026-10-29）：Codex 信任後，使用者從本對話詢問「現在台北天氣如何」，收到天氣回覆後確認「看起來ok」。唯讀 `herdr pane read w4:p2P --source recent-unwrapped --lines 35` 查到兩筆 `hook Stop session=01a185b1 pane=w2:p6`（chars=102、139），與目前 Codex session／pane 相符，證明真實 Stop 已抵達 bridge；日誌未帶 prompt id／時間，未逐筆斷言哪筆為天氣回合。Codex 本機短問答列為已驗收，未將此結果擴大到長工具回合、Claude 或 pi。

未驗證／下一步：Claude 啟動後與 pi 各以 Discord 回合核對 final；Codex 長工具回合、重複回貼次數及確切耗時未另行驗證。舊片段不補送，其他電腦設定未處理。文件 `git diff --check` 通過；本輪僅更新驗收紀錄，未重跑程式測試。

### ISSUE-045／033 pi Linux 最後回覆與 Discord 不一致（2026-10-29）

狀態：ISSUE-045 本機擴充部署缺漏修正後已驗收（2026-10-29，見下方最終確認）；ISSUE-033 parser 邊界問題重新開啟／待調查。保留 2026-10-28 另一環境的驗收歷史。

症狀／預期：使用者回報 Discord 顯示 `Final response unavailable; captured CLI excerpt`，內含 diff、`Planning quota cache regression test`、先前計畫與 Working 行；CLI 實際已完成，最終回答以「已修正，並確認讀取到兩張附圖」開頭，列出變更與 79 通過／3 跳過／0 失敗（這是 pi 對另一專案的回報，不是 bridge 本輪測試）。預期 Discord 收到同回合的最終 assistant 文字。

環境／重現證據：Linux pi 1.4.0、pane `w6:p1`、session 路徑 `~/.pi/agent/sessions/--home-jones-wk-pi-acc-switcher--/2026-10-27T09-08-23-704Z_01a17c9e-2e16-7101-9147-10dd024b5ebf.jsonl`；診斷檔 `/home/jones/.local/state/herdr/plugins/herdr-discord-bridge/capture-diagnostics/2026-10-29T03-59-01-926Z-w6_p1.json`：耗時 125148 ms、idle、無 transcript、`extracted_last` 為空、最長片段 917 字元；`raw_screen_tail` 與目前 pane 都包含正確 final。檢查時 bridge 位於 `w4:p2P`，Gateway 已連線。

已確認根因／限制：本機 `~/.pi/agent/extensions/` 只有 Herdr state 擴充，缺少 `herdr-discord-bridge.ts`；正式 `loadConfig()` 確認 `hookTransport.pi=auto`，因此無 completion hook 可用，只走畫面後備。`streamAgent` 未取得 final 時會送先前保存的 `longestOutput`；它可以是較早的工具／進度，並非 CLI 最後回答。真實診斷的尾端畫面已看不到 prompt，且未保存當時 baseline；以空 baseline 重放 `latestAgentResponse('pi', prompt, raw_screen_tail, '')` 結果為空，符合既有 fail-closed 契約，但不能把這次重放當成原 baseline 的完整重現。最後一輪 parser 為何無法從原 baseline 擷取，仍待調查；不放寬回答邊界以猜測 final。

修正／啟用：將 repo 既有 `scripts/pi/herdr-discord-bridge.ts` 複製到本機 `~/.pi/agent/extensions/`（原先不存在，未覆寫 Herdr 擴充）。確認 pi idle 後以 `herdr pane run w6:p1 /reload` 載入；畫面回報 `Reloaded keybindings, extensions, skills, prompts, themes, and context files`，原有對話保留。未修改產品程式、未重新 build、未重啟 pi 或 bridge、未 commit／push。這只處理此台機器，不代表其他電腦已安裝。

驗證（2026-10-29）：臨時腳本 `node /tmp/check-pi-bridge-hook.mjs` 先因已安裝擴充不存在而 assertion 失敗；安裝後通過：以實際安裝檔註冊 `agent_start`／`agent_end`／`agent_settled`，在隔離 Unix socket 斷言 Stop 的 session 路徑及完整 final，排除 thinking 與工具進度。此測試未對 Discord 發送訊息，完成後移除臨時腳本。`node --test dist/test/hook-events.test.js dist/test/cli-adapter.test.js` 40/40 通過、0 失敗；`git diff --check` 通過。本輪僅環境與文件修改，未跑全套或重新 build。

未驗證／下一步：已送出的舊 Discord 片段不會自動更新；reload 不會重發上一回合 Stop。仍需使用者在同一 Discord thread 對 pi 再提問，核對 bridge 收到同 session 的 Stop 且 Discord 與 CLI final 一致，長工具回合亦待驗收。不宣稱已端到端解決，也未自動補送舊回答。parser 在 hook 缺失時仍可能回傳不完整片段；需另以帶原 baseline 的 trace 建立完整重現。

### ISSUE-045 遠端 machine hook（2026-10-28，已驗收；中途撤回後經修正重新驗收，見下方「遠端 hook 事件到了但沒被採用」）

做法：machine 設定新增選填 `hookSocket`（遠端絕對路徑；驗證不可含空白、`:`、引號、`..`）。bridge 為該 machine 另開 `HookReverseTunnel`：先 `ssh host mkdir -p -m 700 <目錄>`，再 `ssh -N -R <hookSocket>:<本機 hook socket>`（`StreamLocalBindUnlink=yes`、`ExitOnForwardFailure=yes`，斷線退避重連）；獨立於 `-L`，轉發失敗不影響遠端控制。遠端用 `scripts/remote/herdr-discord-hook.py`（Python 3，無 Node；agy 版與本機相同邏輯，並接受 Claude／Codex 格式 Stop）把事件寫到遠端 hook socket，經 `-R` 回到本機 hook server；比對靠 session id（UUID），不需要 pane 前綴。權限事件不支援遠端（沒有要求等待回應的路徑）。
部署（2026-10-28）：agy-pod 為 Linux（agy 1.4.7、Python 3.14，無 Node；scp 不可用，改以 `ssh cat` 上傳）；已安裝 `/root/.local/bin/herdr-discord-hook.py`、建立 `/root/.gemini/config/hooks.json`（`Stop`，timeout 10）並在本機 config.json 的 agy-pod 加 `hookSocket`（備份 config.json.bak-hook）。
驗證（2026-10-28）：lint 通過；新增 1 項測試（hookSocket 驗證與 `-R` 參數）；完整 `npm test` 279 項、272 通過、6 失敗（ISSUE-035 既有項目）；遠端腳本以真實 agy Stop 輸入在本機執行，輸出 `{}`、socket 不存在時 exit 0。部署後實測：`ssh -R` 建立、遠端產生 `hooks.sock`（0600）；在遠端以腳本送假 Stop，bridge log 出現 `hook Stop session=remote-e pane=? chars=4`。驗收（2026-10-28）：使用者在 Discord 問遠端 agy（agy-pod），回報「收尾正常」（未逐項記錄 log 與耗時，也未確認是否需重開遠端 agy）。遠端 Claude／Codex／pi 未安裝，未涵蓋。

### ISSUE-045 遠端 hook tunnel 重啟後無法重建（2026-10-28，已修正、待驗收）

重現：部署遠端 hook 後第一次啟動正常；再重啟 bridge 時 log 反覆出現 `machine agy-pod: hook tunnel closed (exit 255) Error: remote port forwarding failed for listen path /root/.config/herdr-discord-bridge/hooks.sock; retry in …`，遠端 hook 事件無法抵達（以遠端腳本送假 Stop，bridge 未收到）。遠端上一次留下的 `hooks.sock` 檔仍在。
根因（依現象與 OpenSSH 行為判斷，未對 pod 的 sshd 做進一步查證）：`StreamLocalBindUnlink` 是 **sshd 端**選項，client 端 `-o` 對 `-R` 無效，所以遠端遺留的 socket 檔使綁定失敗；第一次因檔案不存在而成功。
修正：啟動前的遠端準備指令改為 `mkdir -p -m 700 <目錄> && rm -f <socket>`，移除無效的 `StreamLocalBindUnlink` 參數。驗證（2026-10-28）：lint 通過；完整 `npm test` 279 項、272 通過、6 失敗（ISSUE-035 既有項目）。**未驗證**：修正後重啟能重建 tunnel 並收到遠端事件。

### ISSUE-042 補發 blocked 通知驗收（2026-10-28）

環境：Codex 0.165.0 w4:p1，由使用者在終端機直接輸入（非 Discord）使其停在核准提示；重啟時 `active-streams.json` 為 `[]`，無續傳串流。重啟後 bridge log 出現 `approval reply pane=w4:p1 text="1"`（使用者在 Discord 回覆選項 1，代表補發的核准通知已送達並被路由），隨後 Codex 完成、`hook Stop session=01a1813b pane=w4:p1`，`hook_test_blocked.txt` 已建立。結論：補發 blocked 通知已驗收（以 log 與結果推得；未逐項記錄 Discord 畫面）。

### ISSUE-042 核准後沒有收到 Agent 回覆、Discord 顯示 agent is busy（2026-10-28，第一項已驗收；第二項判斷為設計上的忙碌拒絕）

使用者回報（補發 blocked 通知驗收後）：重啟後有收到核准請求，回覆 `1` 後 Codex 執行了，但 Discord 沒收到 Agent 的回覆；之後從 Discord 對 w1:p1 傳訊息顯示 `agent is busy (w1:p1)`。
1. 沒有回覆：根因已確認——該回合由終端機發問，沒有 Discord 串流（`streamAgent`），bridge 只送狀態通知（`is idle/done`），不會轉發回覆內容；補發的核准通知本身不會建立串流。**修正**：`onApproval` 在沒有串流時記下核准（`approvalFollowups`，1 小時內有效）；Agent 回到 idle／done 且仍無串流時，`relayApprovalFollowup` 以 hook 的 Stop 訊息（`hookTransport` 為 `auto` 且有該 session 的 Stop 事件，最多等 3 秒）貼回核准所在的 thread，每筆只貼一次。沒有 hook 事件時維持原本只送狀態通知。
2. `agent is busy (w1:p1)`：`assertAgentAvailable` 在 Agent 狀態為 `working` 或該 terminal 在 `activeStreams` 時拒絕。w1:p1 是正在執行本專案工作的 Claude，回報當下狀態為 working（本輪查核時也是 working，`active-streams.json` 為空），依此判斷是設計上的忙碌拒絕；但**無法排除**記憶體中 `activeStreams` 殘留舊項目（尚無對應證據，Agent 閒置時再試仍 busy 才需調查）。
驗證（2026-10-28）：lint 通過；新增 1 項測試；完整 `npm test` 280 項、273 通過、6 失敗（ISSUE-035 既有項目）。驗收（2026-10-28）：以 Herdr API 對 Codex w4:p1 直接輸入需核准的指令（無 Discord 串流），Discord 收到核准通知，使用者回覆後 Codex 完成，核准 thread 補貼了最終回覆（`FOLLOWUP-OK`），使用者回報「有補貼了，ok」（未逐項記錄是否只貼一次）。

### ISSUE-045 遠端 hook 事件到了但沒被採用（2026-10-28，已驗收）

重現：修正 tunnel 後遠端 agy 從 Discord 問「今天東京氣溫」，bridge log 有 `hook Stop session=2d61b30e pane=w2:p1 chars=116`，但同回合的 `capture-diagnostics/…agy-pod_w2_p1.json` 顯示 `agent_session = None`、耗時 44959 ms，表示這回合仍由畫面 parser 收尾，hook 沒被用到——先前「收尾正常」的驗收其實是 parser 的結果，遠端 hook 驗收需重做。
根因（已確認）：遠端 Herdr 沒有 session 回報（遠端 agy 的 hooks.json 沒有 Herdr 自己的 session hook），`agent_session` 為空；bridge 只用 session id 比對 Stop 事件，所以事件被忽略。另外 log 的 `pane=w2:p1` 沒有 machine 前綴，與 bridge 看到的 `agy-pod:w2:p1` 不同。
修正：遠端腳本新增 `--machine <id>` 參數，事件的 paneId 帶 `<id>:` 前綴；`HookEventStore.stopForPane` 以 pane ID 保存最近的 Stop；`streamAgent` 與核准後補貼在 **沒有 `agent_session`** 時改用 pane ID 比對（有 session 的仍嚴格比對 session）。遠端 hooks.json 的 command 改為 `/root/.local/bin/herdr-discord-hook.py --machine agy-pod`，腳本已重新上傳。
驗證（2026-10-28）：lint 通過；新增 1 項 pane 比對測試；完整 `npm test` 281 項、274 通過、6 失敗（ISSUE-035 既有項目）。**未驗證**：修正後遠端 agy 在 Discord 以 hook 收尾（應在 log 看到 `hook Stop … pane=agy-pod:w2:p1`，耗時遠小於 parser 的約 45 秒）。ISSUE-045 遠端 machine 的「已驗收」狀態因此撤回，改為待驗收。

重測（2026-10-28，bridge 32d4e0a）：使用者對遠端 agy 從 Discord 提問；bridge log 出現 `hook Stop session=2d61b30e pane=agy-pod:w2:p1 chars=178`（帶機器前綴），且 `capture-diagnostics` 沒有新增該 pane 的診斷檔（上一回合走 parser 時會產生），顯示這次由 hook 收尾。使用者隨後確認「卡片很快收尾，回覆正常」（未記錄確切耗時）。已驗收。

## ISSUE-048：Discord 訊息標頭佔空間、遠端機器不明顯

更新日期：2026-10-28　狀態：已驗收（使用者於 2026-10-28 在 Discord 看到最新標頭後回覆「標頭 OK」；手機版橫向捲動未另行驗證）

症狀：使用者附圖（`.herdr-discord-bridge/attachments/message-cTlPrg/1.png`，已以圖片工具讀取）顯示每則訊息開頭有 `┌─┐` 方框內三行（`agy`、`WK: agy-pod:w2 · agy-pod:~`、`Pane: agy-pod:w2:p1`），Discord 的程式碼區塊本身已有底色，方框多餘且佔高；遠端機器名在 WK 與 Pane 重複出現。使用者希望 agent、wk、pane 合成一行並在多 machine 時看得出機器。我對「在多 machine」的理解是遠端時顯示機器名（未向使用者再確認）。
修正：`agentHeader`（`src/format.ts`）改為單行、不畫框：本機 `🤖 codex · backend │ WK: w1 · review │ Pane: w1:p2`；遠端 `🤖 agy │ WK: w2 · ~ │ Pane: agy-pod:w2:p1`（機器名只由 Pane 的 `<machine>:` 前綴呈現，WK 去掉重複前綴，Pane 保留完整 ID 方便複製；初版曾在 agent 後面加 `@機器`，使用者表示 Pane 顯示即可，已移除）。每個欄位各自限長（名稱 24、WK 名 20、Pane 60 字元，以字元截斷不切壞 emoji），`│` 換成 `|`，先清理再比較 kind，長名稱不會把 Pane 擠掉。
協作方式（使用者要求試驗與 agy-pod 協作）：我實作初版，經 Herdr API 把需求、實作與預期輸出送給遠端 agy（agy-pod w2:p1，只做審查、不改檔），約 22 秒回覆。採用：先清理再比較 kind、各欄位限長且以字元截斷、反引號與 `│` 防護、前綴碰撞測試；未採用：移除 `WK:`／`Pane:` 標籤（保持可讀性）、把 Pane 移到最前（維持使用者要求的順序），並指出其 IPv6 疑慮不適用（pane ID 不是網址）。遠端 agy 沒有 repo，沒有改任何檔案；它的測試預期值我逐一核對後才寫入。
驗證（2026-10-28）：lint 通過；新增／更新 2 項標頭測試（含協作建議的邊界案例）；完整 `npm test` 283 項、276 通過、6 失敗（ISSUE-035 既有項目）。驗收：2026-10-28 使用者在 Discord 確認標頭 OK。**未驗證**：手機版橫向捲動。

## ISSUE-049：對 pi 傳圖片被拒絕

更新日期：2026-10-29。狀態：已修正、待驗收（原始碼與單元測試完成；bridge **尚未重啟**載入此修正；Discord 尚未驗收）。延伸自 ISSUE-039（其圖片白名單限制為當時明列的設計限制，非回歸，故新開此 issue 而不重開 039）。

症狀：使用者在另一台電腦的 Herdr 對 pi agent 附圖提問，bridge 回「❌ 此 Agent 尚未支援本機圖片交付。」（使用者附圖，已以圖片工具讀取）。預期：pi 能收到圖片並回答。

已確認根因：`src/main.ts` 的本機圖片白名單只有 codex／claude／agy／antigravity，pi 不在其中（程式與截圖一致）。

調查（2026-10-29，本機 pi 1.3.0）：`pi --help` 範例含 `pi @prompt.md @image.png`；以 `pi -p --no-session` 請它用 read 工具讀一張本機 PNG，pi 正確描述了圖片內容。bridge 的交付方式（prompt 附本機路徑並要求用工具讀取）對 pi 可行。能否看圖取決於 pi 當下的模型是否支援視覺（此次實測的模型可以）；不支援時 prompt 已要求明說讀不到。

修正：新增 `agentSupportsLocalImages`（`src/attachments.ts`），`src/main.ts` 改用它；pi 以**完全相等**比對（不用子字串，避免 copilot 等名稱誤中），其餘維持原子字串比對。範圍：`src/attachments.ts`、`src/main.ts`、`test/attachments.test.ts`、`SPEC.md`。

驗證（2026-10-29）：lint 通過；完整 `npm test` 284 項、283 通過、0 失敗、1 skipped（含新增的白名單測試）。**未驗證**：Discord 對 pi 傳圖端到端；pi 在不支援視覺的模型下的行為；遠端 pi（遠端目前沒有 pi）。下一步：重啟 bridge 後由使用者從 Discord 對 pi 傳圖驗收。

### ISSUE-045 Claude／pi 測試回報與收件查核（2026-10-29）

使用者回報「兩個都試了」（接續 Claude、pi 待驗收說明）。唯讀 `herdr pane read w4:p2P --source recent-unwrapped --lines 30` 查到 `hook Stop session=18258fcd pane=w2:pA chars=294` 與 pi `hook Stop session=/home/jo pane=w6:p1 chars=248`、`chars=138`；證明這些 pane 的真實 Stop 已抵達 bridge。Claude pane 身分尚未在本次查核另取 live metadata，session 日誌僅顯示前綴，未做逐回合 prompt 關聯。

狀態維持已修正、待驗收：使用者尚未明說兩者 Discord 最終回覆是否完整且與 CLI 一致，已詢問確認，不把「試過」直接當成通過。無程式、設定、build、重啟或部署變更；本輪僅紀錄測試回報及收件證據，`git diff --check` 通過，未重跑測試。下一步：收到使用者具體結果後更新各自驗收狀態；若有差異，保留本次收件證據並重新調查。

### ISSUE-045 Claude／pi Linux 最終驗收確認（2026-10-29，已驗收）

使用者在被明確詢問「Claude、pi 在 Discord 的最後回覆，是否都完整且與 CLI 一致？」後回覆「兩個都正常」。結合上方真實 Stop 收件紀錄，本機 Claude Stop 安裝與 pi 擴充補裝／reload 均列為已驗收；前項「結果待確認」狀態已解除，保留為歷史。Codex 前一輪短問答也已驗收。

範圍：這台 Linux、使用者本次實際測試的 Discord 回合。未記錄精確延遲或逐一重複次數；不涵蓋其他電腦、斷線／重啟恢復或所有長工具回合。ISSUE-033 在 hook 缺失時的 parser 邊界與較早片段限制仍待調查，不因 hook 路徑通過而結案。未改程式或設定、未 build／重啟／部署／commit／push；本輪僅更新驗收文件，`git diff --check` 通過，未重跑程式測試。

## ISSUE-050：hook 啟用後 Codex 回應期間 TUI 偶爾滾動

更新日期：2026-10-29。狀態：重新開啟／待調查（2026-10-29 使用者重啟後回報仍滾動）。

症狀：使用者已完成 Codex Stop 信任及 Discord 短問答驗收後，回報「codex cli 回應時就會看到 tui 有時會滾動」。預期 hook 回合能取得 final，且進度觀察不干擾本機閱讀位置。環境為本機 Linux、Codex，未提供確切發生時間或 scroll trace；不能把正常 CLI 新輸出自動跟隨與 bridge 觸發的歷史捲動混為一談。

已確認程式行為：`src/main.ts` 的 `streamAgent` 每輪先呼叫 `agent.read` 的 `recent_unwrapped`、至少 2000 行，遇 `agent_not_idle` 才退回 `visible`；完成這次讀取與 progress 更新後才取 matching Stop。預設 `streamIntervalMs=1200`。即使 hook／Codex transcript 可提供 final，這條歷史讀取路徑仍會執行。原始碼註解明載 alternate-screen history 可能需 idle scrolling；但本輪沒有在使用者畫面重現或取得 Herdr 底層捲動 trace，因此實際滾動根因未確認。hook 最終回覆內容正確與「完全不讀 TUI」為不同驗收範圍；ISSUE-045 final 驗收仍有效。

處理／驗證：本輪僅唯讀核對 `streamAgent`、`HerdrClient.readAgent` 與設定預設值，沒有修改產品程式、設定或 runtime，未 build／重啟／部署／commit／push。文件 `git diff --check` 通過，沒有執行新的程式測試，未宣稱修正視覺滾動。

下一步：以可記錄 read source 及 scroll 狀態的回放建立重現，驗證先檢查 Stop／transcript final、進度只讀 visible、必要時才啟動歷史 fallback 的策略；在保留 hook 遺失備援下驗證不干擾本機畫面。以上策略尚未實作。

### ISSUE-050 串流讀取修正（2026-10-29）

原先回歸命令 `node --test --test-name-pattern 'Codex Stop hook also' dist/test/hook-events.test.js` 失敗（0/1）：Stop 已抵達仍呼叫一次 terminal read，預期為 0。修正 `streamAgent` 先 poll transcript／檢查相符 Stop，再決定是否讀 terminal；未完成時 working／blocked／unknown 改讀 visible，idle／done 保留歷史備援。另加入讀取期間 Stop 抵達的測試，驗證 working 只讀 visible 且同輪送出 hook final。

範圍為串流讀取策略；不改 hook 註冊或信任。實際畫面滾動與該讀取的因果尚未取得 live trace；此修正移除已確認的不必要歷史讀取，不宣稱所有 Herdr 滾動已消失。送問前 baseline、idle fallback 與其他操作仍可能讀歷史。尚未重啟／部署，執行中 bridge 未載入本次程式，需新 Discord 回合實機驗收；未 commit／push。

### ISSUE-050 驗證與使用者重啟（2026-10-29）

原始碼與 build：lint、typecheck、build 通過。`npm test` 完整 285 項，284 通過、1 失敗；失敗為 ISSUE-007 既有重複程序入口測試（`null !== 1`，約 10.9 秒，疑似負載／逾時，根因未重新確認）。單獨重測 `node --test --test-name-pattern 'real entrypoint rejects' dist/test/instance-lock.test.js` 1/1 通過，不能將完整套件改記為全綠；ISSUE-007 保留重新開啟／待調查。`node --test dist/test/hook-events.test.js` 14/14 通過，包括原失敗的 final 跳過 TUI 讀取與 working 僅 visible／讀取途中 Stop 抵達測試。完整紀錄 `/tmp/issue050-tests.tap`、hook 紀錄 `/tmp/issue050-hook.tap`；`git diff --check` 通過。

使用者回報 bridge 已重啟；查核新 pane `w4:p2Q`、PID 48594，2026-10-29 13:52:33 啟動，cwd 為本 checkout；dist/src/main.js 同時段更新且包含 `readHookFinal` 與 visible 策略，pane 顯示 `Discord Gateway connected, Herdr watcher started`。已載入本次 build，取代前述未部署狀態；本輪沒有再次重啟。其他 Console 舊選取 Agent 已退出警告仍在，與 Gateway 連線無關。

驗收待辦：在新 Discord Codex 回合觀察工作中 TUI 是否仍跳動，並核對 final 完整且只送一次；其他 CLI 及 idle／done 歷史備援仍需實機觀察。沒有宣稱完全消除所有滾動。未 commit／push。

### ISSUE-050 重啟後再次滾動（2026-10-29，重新開啟）

使用者在確認新版 bridge 已重啟後回報「剛剛 tui 又滾動了」，第一版未通過實機驗收。保留先前自動測試與部署歷史，不能沿用已修正狀態。查核剩餘自動歷史讀取包括送問前 baseline、idle／done 串流備援、forced-finish rewatch，以及無 active stream 時的 direct marker 掃描。尚無此次實際 read／scroll trace，未確認是哪個路徑觸發；已詢問發生時點。

### ISSUE-050 第二次修正：完成後自動讀取（2026-10-29）

使用者補充發生在「回答完」。除 idle／done 串流仍讀歷史外，`relayDirectMarkers` 在沒有 active stream 的 idle／done transition 會掃描 500 行歷史，屬第一版未涵蓋路徑；另有 baseline 與 rewatch。這是已確認的自動讀取缺口，尚未取得本次滾動對應哪一筆 API 的 trace。

回歸：`node --test --test-name-pattern 'idle Codex reads' dist/test/hook-events.test.js` 修正前 0/1，實際 source 為 recent_unwrapped、預期 visible。第二次修正將 Discord 單 Agent baseline、所有狀態的串流讀取、rewatch、direct marker 掃描改為 visible；已有 final 仍跳過串流讀取。明確 read／handoff 不變。Parser 保留，但只能處理目前可見範圍；畫面外的標記請用 `herdr-discord-send`，無 hook／transcript 的長回答可能不完整，不能為避免滾動猜測隱藏內容。

原始碼已變更，驗證進行中；使用者先前重啟的是第一版，本次尚未重啟部署。狀態仍重新開啟／待調查，保留第一次驗收失敗。

### ISSUE-050 第二次修正驗證結果（2026-10-29）

lint、typecheck、build 通過。`node --test dist/test/hook-events.test.js dist/test/response-delivery.test.js` 29/29 通過（`/tmp/issue050b-targeted.tap`）。`npm test` 286 項、283 通過、3 失敗（`/tmp/issue050b-tests.tap`）：ISSUE-007 duplicate entrypoint 為 `null !== 1`；ISSUE-021 handoff verify/cancel 為 ENOENT；ISSUE-012 changed questions 回合應 completed 卻 blocked。三項單獨以 `node --test --test-name-pattern 'real entrypoint rejects|concurrent handoff verification|changed questions supersede' dist/test/instance-lock.test.js dist/test/session-handoff.test.js dist/test/team-questions.test.js` 重測 3/3 通過（`/tmp/issue050b-retry.tap`）。仍保留完整測試失敗歷史，這三個 issue 維持重新開啟／待調查；疑似併行／負載影響，未證實根因，不修改其驗收標準。

`git diff --check` 通過。第二版原始碼與 build 完成，但尚未重啟部署／實機驗收；ISSUE-050 維持重新開啟，等待第二版 runtime 驗證。未 commit／push。

### ISSUE-050 轉交 Claude（2026-10-29）

使用者要求轉交 Claude；接手目標為同 repo 的 Claude pane `w2:pA`（session `18258fcd-40d4-40fc-b7ee-cfe352c4325f`）。Codex 停止後續實作，保留未提交檔案與第二版 build；請接手者先確認實際 runtime 版本，再調查回答完成後滾動。第二版尚未取得部署與驗收證據，完整測試失敗與重測歷史如上。

### ISSUE-050 Claude 接手審查（2026-10-29）

審查第二版 diff（`src/main.ts`、`test/hook-events.test.ts`）與全部 `readAgent` 呼叫點。`src/main.ts` 的自動路徑（單 Agent baseline、`streamAgent`、`rewatchAfterForcedFinish`、`relayDirectMarkers`）均已改為 `visible`；`recent_unwrapped` 只剩使用者明確觸發的 handoff 摘要（約 1758 行）與 `/read`（約 2109 行）。`team-task-engine.ts`、`console-agent.ts` 讀 `visible`；`team-turn.ts` 讀取來源由團隊回合呼叫端決定，屬使用者發起的團隊流程，不在單 Agent 完成後路徑。未發現其他完成後自動讀歷史的路徑。

範圍與契約評估：合理。hook／transcript／`herdr-discord-send` 為正常交付來源，visible parser 僅為備援；代價是無 hook 且回答超出畫面時備援可能不完整，已於前節載明，不為避免滾動而猜測內容。尚無 live read／scroll trace，無法確認滾動是否來自 `agent.read`；仍可能是 Herdr 自身重繪或 Codex TUI 正常的新輸出跟隨，這兩項未排除。

驗證（2026-10-29 重新 `npm run build` 通過；`node --test dist/test/hook-events.test.js dist/test/response-delivery.test.js` 29/29 通過）。dist 時間（13:59）晚於 src 修改（13:58），build 為最新。此刻未找到執行中的 bridge 程序，不能確認 runtime 載入的版本。本輪未重啟、未 commit／push；ISSUE-050 維持重新開啟，須經使用者授權重啟並在新 Discord 回合觀察完成後是否仍滾動；若仍滾動，下一步為記錄 Herdr `agent.read` 呼叫時間與 TUI 滾動時間對照。

### ISSUE-050 第二版重啟（2026-10-29）

使用者回報已重啟 bridge。核對：Herdr pane `w4:p2R`（label「Discord bridge」）顯示 `Discord Gateway connected, Herdr watcher started`；`dist/src/main.js` 修改時間 14:43:49，晚於第二版 src。沙箱內 `ps` 看不到該程序，無法確認 PID 與啟動時間，因此「已載入第二版」僅有 pane 輸出與 dist 時間的間接證據。實機驗收（新 Discord Codex 回合完成後 TUI 是否滾動、final 完整只送一次）尚未進行，ISSUE-050 維持重新開啟／待調查。未 commit／push。

### ISSUE-050 第三版：依來源決定可否讀歷史（2026-10-29）

依使用者指示：Discord 來源或明確要求送 Discord 的備援情況可以讀歷史（可能捲動），本機直接操作不得干擾。實作：`streamAgent`（僅服務 Discord 發起回合）在已有 hook／transcript final 時完全不讀畫面；無 final 的備援中，working／blocked／unknown 讀 `visible`，idle／done 讀 `recent_unwrapped`（`agent_not_idle` 退回 `visible`）；Discord 單 Agent baseline 與 forced-finish rewatch 恢復讀歷史，維持與串流讀取一致的比對基準。`relayDirectMarkers`（本機回合完成後的掃描，不知道回合是否 Discord 來源）維持只讀 `visible`。Hook 事件不含 prompt 文字，故無法偵測本機回合是否「明確要求送 Discord」，該情況請用 `herdr-discord-send`（本機目前 `which herdr-discord-send` 找不到，標記僅掃可見畫面，畫面外標記可能漏送）。

驗證（2026-10-29）：lint、build 通過；`node --test dist/test/hook-events.test.js dist/test/response-delivery.test.js` 29/29 通過（idle 備援測試改為預期 `recent_unwrapped`，已有 Stop 時 0 次讀取與 working 僅 visible 測試保留）。未跑完整 `npm test`。第三版未重啟，目前執行中為第二版；使用者先前重啟的是第二版。ISSUE-050 維持重新開啟，須重啟後實機驗收：本機回合完成後不滾動、Discord 回合 final 完整。未 commit／push。

## ISSUE-051：`npm start` 找不到入口

更新日期：2026-10-29。狀態：已修正、待驗收。

症狀：`npm start` 回報 `MODULE_NOT_FOUND`。預期：能啟動 bridge。根因（已確認）：`package.json` 的 `bin`、`start`、`dry-run` 指向 `dist/index.js`，但 build 輸出為 `dist/src/index.js`（`dist/index.js` 不存在）。修正：三處改為 `dist/src/index.js`。

驗證：確認 `package.json` 內容與 `dist/src/index.js` 存在；`npm run dry-run` 啟動後 120 秒內未結束（未確認是否為預期的常駐行為），未視為通過。`npm start` 實際啟動（含 Discord token 載入）尚未驗收，需使用者啟動確認。未 commit／push。

### ISSUE-050 第三版重啟（2026-10-29）

使用者重啟 bridge。核對：Herdr pane `w4:p2T`（label「Discord bridge」），`node dist/src/index.js`，PID 63205，啟動時間 2026-10-29 14:58:18，晚於 `dist/src/main.js` 的最後 build（14:58:17），故執行中為第三版（commit `fa0320e` 的程式）；pane 顯示 `Discord Gateway connected, Herdr watcher started`。使用者實際以 `scripts/run.sh`（Herdr plugin 機制）啟動，未使用 `npm start`，因此 ISSUE-051 尚未被驗證。實機驗收（本機回合完成後不滾動、Discord 回合 final 完整只送一次）尚未進行，ISSUE-050 維持重新開啟，依使用者決定後續觀察。未 commit。

### ISSUE-051 驗收範圍更正（2026-10-29）

先前紀錄曾暗示使用者重啟時已走過修正後的入口，此說法錯誤：使用者以 `scripts/run.sh` 啟動，該腳本走 Herdr plugin，不使用 `npm start`。直接執行 `node dist/src/index.js` 會因缺少 plugin 設定而報 token 遺失，這是啟動方式不同，不是 token 本身遺失。`package.json` 的 `bin`／`start`／`dry-run` 修正仍待驗收，需實際跑 `npm start` 確認；是否仍需要由 `npm start` 啟動由使用者決定。

### ISSUE-051 驗收（2026-10-29）

使用者在本機執行 `npm start`，輸出 `node dist/src/index.js` 後為 `Discord is disabled or its bot token is missing in plugin config/env`，不再出現 `MODULE_NOT_FOUND`。入口路徑修正已驗收。程式在 token 檢查處結束，原因為 `npm start` 不經 Herdr plugin 載入設定（正式啟動為 `scripts/run.sh`），不是本 issue 的缺陷；未驗證 `npm start` 完整啟動。已同時更新 `bin`、`start`、`dry-run`，其中 `bin` 與 `dry-run` 未另行執行驗證。

### ISSUE-045 本機 agy Stop hook 安裝（2026-10-29）

查核：本機 `~/.gemini/config/hooks.json` 原先只有 Herdr 的 `PreInvocation`，沒有 `herdr-discord-hook`，agy 走畫面 parser。使用者要求安裝後，於 `hooks.json` 新增群組 `herdr-discord-bridge` → `Stop`（10 秒）指向 `/home/jones/wk/Herdr_Discord_Bridge/scripts/herdr-discord-hook`，保留既有 `herdr` 群組；備份 `~/.gemini/config/hooks.json.bak-hook`。以 `echo '{}'` 餵入該指令確認可執行且 exit 0。

未驗證：agy 是否重載 hooks（可能需重啟 agy session）、agy 實際完成回合時 Stop 事件是否到達 bridge、Discord final 是否完整只送一次。本機 agy 版本未在此輪確認。狀態：已安裝、待驗收；2026-10-28 的 agy 已驗收是另一環境結果，不代表本機。未 commit。

### ISSUE-045 本機 agy Stop hook 驗收（2026-10-29）

使用者回報本機 agy 安裝 `Stop` hook 後的 Discord 測試「ok」（使用者口頭回報，未提供事件紀錄或畫面；未逐項確認 final 是否只送一次、是否重啟過 agy session）。依此將本機 agy hook 由「已安裝、待驗收」改為已驗收；證據等級為使用者實測回報。未 commit。

## ISSUE-052：`main` 沒有 CI 與 branch protection

更新日期：2026-10-30。狀態：修正中。

症狀：要讓 Agent 走到自動 merge（規劃中，見[卡片](cards/REQ-20261030-card-to-merge.md)），`main` 需要可信的自動閘門，但現況沒有。預期：`main` 有每次 PR 都會執行的 CI，並由 branch protection 要求通過。

查核（2026-10-30，以 `gh` 唯讀查詢）：repo 為公開，帳號權限 ADMIN；`main` 無 branch protection、無 ruleset；`main` 無 `.github/workflows/ci.yml`。CI 僅存在於未合併分支 `followup-team-question-ui-ci`（PR #1，OPEN，base 為舊的 `phase4-quota-failover-manager`，比 `main` 落後 120 個 commit，且混有約 940 行 Team 答覆介面功能與 macOS Bash 修正）。該分支 2026-09-20 的 run 兩個平台通過，但不是 `main` 的結果。

根因（已確認）：CI 與一項功能綁在同一個長期未合併的 PR，從未進入 `main`。另確認該 workflow 的 `paths-ignore: **/*.md` 若設為必要檢查，會使純文件 PR 永遠等待檢查。

修正範圍（原寫「工作樹，未 commit／push」，已於 PR #2 合併，`175981c`）：新增 `.github/workflows/ci.yml`（取自 PR #1，移除 `paths-ignore`）、重寫 `docs/ci.md`。不合併 PR #1 的功能與腳本變更。

驗證（2026-10-30，macOS，Node v26.12.0，本機，非 CI）：`npm ci`、`typecheck`、`lint` 通過；`npm test` 286 項，285 通過、0 失敗、1 略過。

GitHub 驗證（2026-10-30，PR #2 https://github.com/jon888465/Herdr_Discord_Bridge/pull/2 ，run 41019013179）：Ubuntu（Node v22.23.4）286 項全通過；macOS（Node v22.23.3）286 項，285 通過、0 失敗、1 略過；兩者 typecheck、lint 皆通過。這是 PR 分支結果，尚未合併，`main` 尚無 CI run。

未驗證／下一步：
1. ~~推送後確認 GitHub 上 Ubuntu 與 macOS 實際結果~~ 已於 PR #2 通過；PR #2 於 2026-10-30 合併（`175981c`），`main` push run 41019618373 兩平台通過（Ubuntu 286/286；macOS 285 通過、1 略過、0 失敗）。
2. ~~設定 branch protection／ruleset，將 CI 設為必要檢查。~~ 使用者於 2026-10-30 建立 ruleset `protect-main`（id 26191256），已用 `gh api` 唯讀核對設定：enforcement `active`，目標為預設分支，bypass 清單為空；規則為禁止刪除、禁止 force push（non_fast_forward）、必須經 PR（核准數 0，其餘審查選項皆未開）、必要檢查 `Full tests (ubuntu-latest, Node 22)` 與 `Full tests (macos-latest, Node 22)`。`strict_required_status_checks_policy` 為 false（不要求分支與 `main` 同步後才可合併）。**當時僅核對設定；其後的直接 push 測試見下方（已被拒絕）。** 合併紅燈 PR 的行為仍未測試，因此「規則實際擋得住」只部分驗證。
3. ~~處理 PR #1~~ 2026-10-30 已關閉並留言說明；分支 `followup-team-question-ui-ci` 保留未刪，其中 Team 答覆介面功能未合併，需要時另開 PR 並 rebase。
4. ~~action 釘住 commit SHA~~ 已於分支 `ci/pin-actions` 修改（`actions/checkout` v7.0.1、`actions/setup-node` v7.1.0，細節見 `docs/ci.md`）；已於 PR #4 合併（2026-10-30，`cf7f734`），`main` push run 41023426861 兩平台通過（Ubuntu 286/286；macOS 285 通過、1 略過、0 失敗）。Dependabot 尚未啟用。

PR 閘門觀察（2026-10-30）：PR #4、#5 在 CI 執行期間觀察到 `mergeStateStatus` 為 `BLOCKED`，兩個必要檢查通過後變為 `CLEAN`；PR #6 只記錄到通過後的 `CLEAN`，未觀察到執行期間的狀態；PR #2 建立於 ruleset 之前，不適用。`main` 的 push run 在 PR #2、#4、#6 合併後皆通過（#4：run 41023426861，Ubuntu 286/286、macOS 285 通過加 1 略過）。紅燈 PR 是否被擋仍未實測。

ruleset 行為測試（2026-10-30）：由 ADMIN 帳號經 SSH 直接 push 一個空 commit（`255c726`，parent `1a65de4`）到 `main`，被 GitHub 拒絕（`push declined due to repository rule violations`；`Changes must be made through a pull request`；`2 of 2 required status checks are expected`），`origin/main` 維持 `1a65de4`。證明 bypass 清單為空時規則對管理員也生效。**未測試**：合併 CI 未過的 PR 是否被擋、force push、刪除 `main`（後兩者不實測，以設定核對為準）。
5. 此 issue 不涵蓋自動 merge 的權限與政策，那屬於卡片規劃。

剩餘（2026-11-02 盤點）：紅燈 PR 被擋的實測（直接 push 被拒已測）、Dependabot（`strict_required_status_checks_policy` 已於 2026-11-03 由使用者開啟，`gh api` 確認為 `true`）；CODEOWNERS 需要第二個身分才有意義；2026-11-03 使用者決定 L2 用現有登入，bot 身分不是前置。逐項追蹤見 [Card-to-Merge 追蹤清單](card-to-merge-tracker.md) 的 G 節。

附註：舊分支的 `docs/ci.md` 曾引用 `ISSUE-021` 追蹤 CI；該編號在 `main` 已用於 Phase 3 Session Handoff Runtime，本 issue 以 ISSUE-052 取代，不沿用舊編號。

## ISSUE-053：卡片 `x-` 自訂欄位解析後不保留

更新日期：2026-10-30。狀態：已修正、待驗收。

症狀：ADR-0001 寫「未知頂層 key 拒絕（可用 `x-` 前綴自訂）」。`parseCard` 接受 `x-` 開頭的 key，但 `Card` 型別沒有欄位可放，解析後直接丟棄；`serializeCard` 因此不會寫回。預期：使用者自訂的 `x-` 欄位在讀寫往返後仍存在，或明確禁止。

重現（2026-10-30，本機 macOS、Node v26.12.0）：對含 `x-note: 自訂` 的合法卡片執行 `parseCard`，回傳的卡片鍵為 `id,type,status,title,version,created,updated,body`，不含 `x-note`；`serializeCard` 輸出不含 `x-note`。

根因（已確認）：`parseFields` 只做「是否允許」檢查，`buildCard` 只挑已知欄位組成 `Card`，沒有保留 `x-` 欄位的結構。

影響範圍：目前沒有檔案讀寫層與呼叫端，尚未造成實際損失。日後 bridge 若改寫卡片（例如寫回 `status`），會悄悄刪掉使用者的 `x-` 欄位。

修正（2026-10-30）：使用者決定選項 (b)「禁止」。`parseCard` 不再允許 `x-` 前綴，與其他未知 key 一樣回傳 `unknown key "x-..."`；ADR-0001 同步修正。未採用 (a)（保留於 `extensions`），因為需要新增型別與序列化規則，而內容本來就能寫在內文。

測試（2026-10-30，本機 macOS、Node v26.12.0，非 CI）：`test/card.test.ts` 的未知 key 測試改為 `owner` 與 `x-note` 都必須被拒絕並回報 `unknown key`（修改前紅燈）；「超過 8 KiB」測試原本用 `x-note` 灌大小，改用合法的 `source` 欄位並檢查錯誤訊息，避免因別的原因碰巧通過。卡片相關測試 119 項通過。全套結果見 PR。

未驗證：沒有 live 驗收項目（函式尚無呼叫端）。CI 結果以 PR 的 check 為準。

文件：[卡片範例與轉換指引](card-examples/README.md)已說明 `x-` 欄位會被拒絕。

## ISSUE-054：缺少單檔卡片驗證指令

更新日期：2026-10-30。狀態：已修正、待驗收。

症狀：使用者要請 Agent 把 Mantis 單轉成卡片，但沒有任何指令能檢查產出的檔案是否合格，只能靠人看或臨時跑測試。預期：Agent 轉完可自行執行一個指令，得到明確的 OK／FAIL 與原因。

根因（已確認）：只有 `parseCard` 函式，沒有對外的指令入口。

修正：新增 `scripts/herdr-card-check FILE...`（`src/card-check-cli.ts`；核心 `runCardCheck` 為純函式，讀檔由外部注入）。逐檔輸出 `OK`（id、類型、狀態、標題）或 `FAIL`（原因）；結束碼 0 全部合格、1 有不合格或讀不到、2 用法錯誤；超過 256 KiB 不讀取。只檢查格式，不判斷內容。

測試（2026-10-30，本機 macOS、Node v26.12.0，非 CI）：`test/card-check.test.ts` 7 項（純函式）與 `test/card-check-cli.test.ts` 4 項（端到端：實際執行編譯後 CLI 與 bash 包裝檔，涵蓋範例卡、無效檔、目錄、超大檔、無參數），皆先看失敗再實作。手動執行：四張卡 OK；`README.md` 被判不合格（缺 frontmatter，符合預期）；`external: { mantis: 0001234 }`（未加引號）被判 `"external.mantis" must be a string or null`。

未驗證：使用者尚未用真實 Mantis 單實際走完「請 Agent 轉卡片、跑驗證」流程；Agent 是否會確實執行此指令取決於指引遵守度，未驗證。沒有 PATH 連結以外的安裝步驟（`npm run build` 後可用）。

文件：[轉換指引](card-examples/README.md)含用法與限制。

變更（2026-11-02）：整檔上限由 256 KiB 改為 512 KiB（使用者決定），新增 `--ledger` 旗標改用 1 MiB（ADR-0002 決定 10）。上方「超過 256 KiB 不讀取」為當時的敘述。測試：全套 459 項，458 通過、0 失敗、1 略過（本機，非 CI）。ISSUE-054 的驗收項目（真實 Mantis 單流程）不變。

## ISSUE-055：遠端長期存在的 pod 上，worktree 的清理與殘留尚未設計

更新日期：2026-11-02。狀態：待調查（先紀錄，未來處理）。**這是設計缺口與風險，不是已發生的缺陷**：bridge 目前完全沒有 worktree 建立或清理的程式，所以現在不會產生任何殘留。

使用者可見症狀（預期會發生，功能實作後）：卡片分配到遠端機器開發或 review，任務結束後，該機器上的 worktree 目錄、worktree workspace、分支與依賴（例如各自的 `node_modules`）若沒有被移除，會在長期存在的機器上持續累積。使用者提問（2026-11-02）：完成或 review 後，遠端機器的 workspace 會在關閉前被移除嗎？目前遠端機器就是 pod，不是每個任務新開 pod。

預期行為：任務結束後依明確規則清理；清理不使用 `--force`；有未提交修改時保留並通知；pod 連不上或清理失敗時可延後重試，且不使任務失敗或無法結束。

重現方式／環境：無法重現（未實作）。依據是 2026-11-02 在本機 Herdr 0.9.1、拋棄式 git repo 上的實測，以及官方文件 v0.9.5：
- `herdr workspace close` 只關閉 Herdr 狀態，不刪除目錄。
- `herdr worktree remove` 刪除 worktree 目錄並關閉該 worktree 的 workspace，**不刪分支**；工作樹有未提交修改（含未追蹤檔）時拒絕（`dirty_worktree_requires_force`）；`--force` 會永久丟失未提交修改。
- `create` 會順便開「來源 repo」的 workspace，`remove` 不會關它。
- 任務結束、卡片標為完成時，Herdr 與 bridge 都不會自動清理。
- **遠端 `herdr --machine <名稱> worktree ...` 尚未實測**（需使用者同意才能在遠端機器執行）。

已確認根因：不適用。缺口來自尚未設計與實作；未確認任何程式缺陷。

預期的風險（Agent 依實測與程式閱讀整理，尚未在遠端驗證）：
1. 清理時 pod 連不上（tunnel 斷線或 pod 暫時不可用）；應延後重試，不能判定任務失敗。
2. bridge 在清理前當機；重啟後需能找出孤兒 worktree，這要求 worktree 路徑或標籤帶卡片 id 以便對照 journal 與卡片。
3. 有未提交修改的 worktree 因「永不使用 `--force`」而永遠保留，需通知使用者並在卡片標示「清理待處理」。
4. 分支只會累積（Herdr 不刪分支）；每個 worktree 各自安裝依賴會占用 pod 磁碟。
5. 移除前必須先關閉該 workspace 內仍在執行的 Agent 與 pane。
6. 專案政策為 L0（不 push）時，分支只存在於該 pod；pod 若被重建，未推送的分支會消失。`remove` 不刪分支只代表 pod 還在時安全。

Agent 提議的清理順序（**使用者尚未決定**）：(1) 結果已寫進卡片；(2) 工作已保全（已推送，或已通知「只存在於 pod」）；(3) 關閉該 workspace 的 Agent 與 pane；(4) `worktree remove`，永不 `--force`；(5) 成功則卡片記「已清理」，失敗或連不上則記「清理待處理」並重試。關鍵是清理不阻擋任務完成。

待使用者決定：
1. 是否同意「清理不阻擋完成、失敗可重試、髒的保留並通知」的原則。
2. L0（不 push）的遠端任務，清理前是否一定要先推送，還是只通知。
3. 是否需要定期掃描並提醒殘留的 worktree，還是先只在任務結束時清理一次。

修正範圍：無，尚未開始。

測試：無。尚未有可測試的程式。

未驗證：遠端 `herdr --machine ... worktree` 的實際行為；pod 上依賴占用的磁碟量；清理與 tunnel 重連、bridge 重啟的互動；孤兒 worktree 的偵測。

下一步：待使用者決定上述三題後，把結論寫進 [REQ-20261101-worktree-isolation](cards/REQ-20261101-worktree-isolation.md) 的待確認第 5 項；實作 worktree 時一併設計清理、重試與孤兒偵測，並以真實 git repository 的自動化測試涵蓋；遠端行為需另行取得使用者同意後才實測。

預定用途（使用者，2026-11-02）：等「開單 → 開發 → 結束 → merge」的自動化流程完成後，**用本 issue 作為端到端測試案例**，實際跑一次整條流程。這是未來的計畫，目前沒有任何自動化可用。

作為測試案例前，Agent 整理的前提（尚未滿足）：
1. 上方「待使用者決定」三題已有結論，且轉成有明確驗收條件的卡片；目前這是設計缺口，Agent 無法在缺少決定時自行開發。
2. worktree 的建立已實作；清理依賴建立，不能先做。
3. 若要涵蓋遠端 pod 的行為，需另行取得使用者同意在遠端機器實測。
4. 本 issue 的內容是**刪除檢出**的邏輯，風險高於一般變更。Agent 建議第一次端到端試跑以 L1（開 PR、由人 merge）進行，不要直接用 L2 自動 merge；也建議先用較小、較低風險的 issue 驗證流程本身。

相關：REQ-20261101-worktree-isolation、ADR-0002（`docs/adr/0002-operational-cards-in-plugin-state.md`，見 PR #15）決定 10 與未決、ISSUE-041（遠端 Herdr 機器）、ISSUE-043（遠端附件保留期限，已有「定期用 ssh 清理」的先例）。

## ISSUE-056：機敏內容遮蔽漏掉多種憑證樣式，且 handoff 摘要先截斷再遮蔽

更新日期：2026-11-02。狀態：已修正、待驗收。

來源：2026-11-02 為 ADR-0002 決定 11 查核現有遮蔽邏輯時發現，不是使用者回報的問題。

症狀（查核結果）：bridge 有兩份重複且不一致的遮蔽邏輯，`src/handoff-evidence.ts` 的 `publicText` 與 `src/main.ts` 的 `redactHandoffSecrets`。以 15 個明顯假造的機敏樣本實測，**只遮蔽 7 個、漏掉 8 個**：`github_pat_…`（細粒度 token）、AWS access key、JWT、單獨的 `Bearer …`、`API_KEY=`、`secret_key:`、含帳密的網址、資料庫連線字串。針對遮蔽規則本身沒有專門測試。

預期行為：已知的憑證樣式在 handoff 文字與摘要中被遮蔽；遮蔽邏輯只有一份；一般文字（commit SHA、不含帳密的網址、一般句子）不被誤改。

重現（2026-11-02，本機 macOS、Node v26.12.0）：
1. 以舊 `publicText` 規則對測試用樣本表逐項比對：16 項中漏掉 8 項（細粒度 GitHub token、AWS access key、JWT、單獨 Bearer、`API_KEY=`、`secret_key:`、含帳密網址、連線字串）。
2. 以舊 `boundedHandoffSummary`（先截斷再遮蔽）處理「前面 40 行填充文字加一段私鑰區塊加一行結尾」、上限 100 字：輸出含有 `BODYLINETWO`、`BODYLINETHREE` 與 `-----END PRIVATE KEY-----`，**私鑰內容漏出**。上限 70 字時只剩 `REE` 這類碎片，所以漏出與否取決於截斷點。

根因（已確認）：
1. 規則只列了少數前綴與少數名稱關鍵字（`token|password|secret`），沒有涵蓋其他常見樣式。
2. 兩份邏輯是複製後各自演化：`redactHandoffSecrets` 沒有私鑰區塊規則，標記文字也不同（`[redacted-token]` 對 `[redacted token]`）。
3. `boundedHandoffSummary` 先截斷再遮蔽；截斷點落在金鑰中間時，`BEGIN` 行被切掉，規則就比對不到剩下的內容。

修正範圍：
- 新增 `src/redact.ts` 的 `redactSecrets`，涵蓋：私鑰區塊（含被截斷、沒有 END 行的）、`sk-`／`ghp_`等／`github_pat_`／Slack／AWS access key、JWT、`Authorization: Bearer`、單獨的 `Bearer`、`name=value`／`name: value`／`"name": "value"`（名稱含 token、password、passwd、secret、api_key、access_key、private_key）、網址中的 `user:pass@` 與名稱像憑證的查詢參數。沒有密碼的 `ssh://git@host`、`git@host:path`、一般網址、commit SHA、`Bearer of bad news` 這類句子不被改動。
- `publicText` 改為委派給 `redactSecrets`。
- `boundedHandoffSummary` 從 `main.ts` 抽到 `src/handoff-summary.ts`，順序改為先遮蔽、再去空行、再截斷。
- 行為差異：handoff 摘要的標記文字由 `[redacted-token]` 改為 `[redacted token]`；handoff 摘要現在也會遮蔽私鑰區塊與上述新樣式。沒有測試依賴舊標記文字。

測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：新增 `test/redact.test.ts`（27 項：16 類機敏樣本、被截斷的私鑰、網址查詢參數、8 項不得誤改的正常文字、冪等）與 `test/handoff-redaction.test.ts`（5 項，含「截斷會切到私鑰中間」）。全套 511 項，510 通過、0 失敗、1 略過（原 479 項）。以舊規則跑新的樣本表確認它能抓出 8 項漏洞，以舊的先截斷流程重現漏出後，才把測試的上限調到能區分新舊。

未驗證：實際 session handoff（Discord／Herdr）的端到端；遮蔽是黑名單式，**不保證完整**，新的憑證格式出現就可能漏掉。`redactSecrets` 只用在 handoff 的公開文字與摘要，**一般 Agent 回覆轉送到 Discord 的路徑沒有套用**（本 issue 未改變這一點）；營運卡片尚未使用它（ADR-0002 決定 11，尚未實作）。

下一步：待使用者在實際 handoff 驗收；營運卡片寫入時套用 ADR-0002 決定 11（結構化事件優先、短自由文字遇疑似機敏整筆省略）。

## ISSUE-057：營運卡片指令（`card list/show/import`）

更新日期：2026-11-02。狀態：已驗收（第一次 live 驗收失敗後重新開啟並修正；修正版 PR #26 合併後重啟，console 與 Discord 皆通過，見下方「live 驗收紀錄」）。

來源：card-to-merge 階段 2a（ADR-0002 階段 2 決定 Q1–Q7）。不是 bug，而是第一個讓 bridge 讀寫營運卡片的入口，因此列為驗收項目。

使用者可見行為：Discord（`allowedUserIds`）與 console 新增 `card list [status]`、`card show <id>`、`card import`。`card assign` 只回「尚未實作」。不啟動 Agent、不改卡片狀態、不寫流程紀錄。

預期行為：見 SPEC「營運卡片指令」。重點：Discord 不能指定伺服器路徑；匯入一律 `draft`、清空 `external`、不覆蓋；既存目錄他人可讀時拒絕並提示 `chmod 700`；輸出先遮蔽機敏內容。

根因／修正範圍：不適用（新功能）。新增 `src/card-directory.ts`、`src/card-command.ts`、`downloadDiscordText`（`src/attachments.ts`）、`src/main.ts` 的 `case "card"` 與 help。

測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：`npm run typecheck`、`npm run lint` 通過；新增 `test/card-directory.test.ts`（5）、`test/card-command.test.ts`（18）、`test/card-command-main.test.ts`（2，經 `handleCommand`）、`test/attachments.test.ts`（+4）；全套 618 項，617 通過、0 失敗、1 略過（原 589 項）。目錄權限檢查做過變異測試（移除檢查會讓測試失敗）。

（以下為首次撰寫時的驗收清單，已於 2026-11-02 全部完成，結果見「live 驗收紀錄」。）
1. 重啟 bridge 後，在 Discord 實際執行 `card list`（空目錄）。
2. 附上一個真實 `.md`（例如 Mantis 轉出的卡片）執行 `card import`，確認回覆、檔案權限 0600／目錄 0700。
3. `card show <id>`，確認內容與遮蔽。
4. 把檔案改成 `status: ready` 後 `card list ready`。
5. 把 `cards/` 權限改成 755，確認被拒絕並提示 `chmod 700`（再改回）。
6. 在 Discord 嘗試 `card import /etc/hosts.md`，確認被拒絕。
7. Windows 未測（權限檢查在 Windows 略過）。

下一步：使用者重啟並驗收後改為「已驗收」；再進入 2b。

### live 驗收紀錄

**2026-11-02 第一次 live 驗收：失敗（PR #25 版本）。** 環境：本機 macOS，`scripts/run.sh -r` 編譯並重啟 bridge（main `7f06ea2`），Gateway 與 `agy-pod` 連線正常。在 bridge console 輸入 `card list`、`card import <路徑>`、`card show …`、`card assign x`、`card bogus`，**全部**回 `no live Agent target; specify an Agent name/pane id or set one with /herdr use`，沒有進入 `card` 指令。

根因（已確認）：`src/discord.ts` 的 `SHORT_COMMANDS` 沒有 `card`。console 的 `parseConsoleCommand` 與 Discord 的簡寫（`@bot card …`）都以這份清單判斷「是不是指令」，不在清單內就當成要轉給 Agent 的 prompt。自動化測試漏掉的原因：整合測試直接呼叫 `handleCommand("card", …)`，繞過了指令解析。影響：console 當時沒有 live Agent 所以只是報錯、沒有東西被送出；若有選取 Agent，`card import /path` 會被當成 prompt 送給該 Agent。

修正（2026-11-02，worktree `card-short-command`）：`SHORT_COMMANDS` 加入 `card`；`test/console.test.ts` 新增解析測試（console 與 Discord 簡寫），修正前紅、修正後綠。

修正版驗證狀態：全套測試見 PR；**merge 並重新編譯重啟後，需重做上述 7 項 live 驗收**，之前的失敗不算通過。

**2026-11-02 第二次 live 驗收：通過（PR #26 版本）。** 環境：本機 macOS，main `460b4b1`，`scripts/run.sh -r` 重新編譯並重啟 bridge，Gateway 與 `agy-pod` 連線正常。

console（由 Agent 在 bridge pane 輸入，親自觀察輸出）：
- `card list`（空目錄）→「目前沒有卡片」，未建立目錄。
- `card import <本機 .md>` → 已匯入（draft），註明「status ready -> draft」；卡片目錄權限 700、卡片檔 600（`stat` 實測）。
- `card list ready`（此時卡片為 draft）→「沒有狀態為 ready 的卡片」；`card show <id>` → 摘要、內文、「尚無紀錄」。
- `card import /etc/hosts` → 拒絕（路徑必須是 .md）；重複匯入 → 「卡片已存在，不會覆蓋」。
- `card assign x` →「尚未實作（階段 2b）」；`card bogus` → 用法說明。
- 目錄改為 755 後 `card list` → 拒絕並提示 `chmod 700 <路徑>`，目錄未被修改；已改回 700。

Discord（由使用者操作並回報，Agent 未看到原始回覆）：使用者回報 `@bot card list`、附 `.md` 的 `card import`、重複匯入、`card import /etc/hosts.md`、把卡片改為 `ready` 後的 `card list ready`皆符合預期，`card show REQ-20261102-accept-test` 成功。Agent 另從卡片目錄確認 `REQ-20261102-accept-test.md` 存在、權限 600。使用者第一次輸入 `card show` 時用錯 id（`accept-2b`，實際匯入的是 `accept-test`），回報「找不到卡片」是正確行為，不是 bug。

未驗證／已知限制：Windows 未測（權限檢查在 Windows 略過）；Discord 端 `card import` 的逐步回覆文字依使用者回報，未逐字留存；驗收用卡片 `REQ-20261102-accept-2a`、`REQ-20261102-accept-test` 仍留在使用者的卡片目錄，可刪除。

下一步：階段 2b（`card assign`、journal 同步、`completed` 事件模板、`tasks` 欄位、內容交接），由使用者決定何時開始。

## ISSUE-058：`card assign` 把 ready 卡片交給 Team 任務

更新日期：2026-11-02。狀態：已驗收（主流程；Discord 回覆文字與缺描述卡片經 Discord 的路徑見「live 驗收紀錄」中的未驗證項目）。

來源：card-to-merge 階段 2b 第二步（ADR-0002 階段 2 決定 Q1、Q3）。這是第一個會由卡片啟動 Agent 的指令，因此列為驗收項目。

使用者可見行為：`card assign <id> [--coding]`（Discord `@bot card assign …` 與 console）。見 SPEC「營運卡片指令」。`team ask` 的啟動邏輯被抽成共用函式，`team ask` 行為應與之前完全相同。

預期行為：只有 `ready` 且有 `## 描述` 的卡片可指派；Agent 只收到標題／描述／驗收條件（遮蔽、截斷、分隔）；成功後卡片 `in_progress`、記下 `tasks` 與 `assigned`／`started` 紀錄；回條與結果和 `team ask` 一樣；任務完成後卡片**不會**自動 `done`（第三步）。

根因／修正範圍：不適用（新功能）。新增 `src/card-handoff.ts`；`src/card-command.ts` 的 `assign`；`src/main.ts` 抽出 `startTeamTask`／`reportTeamTask` 並接線。

測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-handoff.test.ts`（6）與 `test/card-command.test.ts` 的 assign 測試（9，含並行指派保護，已做變異測試：移除保護會讓測試卡住失敗）；全套 646 項，645 通過、0 失敗、1 略過（原 631 項）；`lint` 通過。**沒有**經由 `handleCommand` 的 `card assign` 自動化整合測試（需要完整 Team runtime）；`team ask` 的既有測試（含 `--coding`）全數通過，作為抽出共用函式的回歸依據。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 在已 `wk use` 並選好 active Agent 的 thread，匯入一張卡、改成 `ready`，`@bot card assign <id>`：確認回覆、Team 回條、Agent 實際收到的 prompt（含分隔線與資料聲明）。
2. 任務結束後 `card show <id>`：狀態 `in_progress`、`tasks` 有 task id、紀錄有 `assigned`／`started`。
3. 對 `draft` 卡片與缺少 `## 描述` 的卡片 `card assign`：確認被拒絕、沒有任務啟動。
4. 沒有選 workspace／Agent 時 `card assign`：確認錯誤訊息且卡片仍是 `ready`。
5. 一般 `team ask`（含 `--coding`）仍正常，確認抽出共用函式沒有改變行為。
6. 已知限制：prompt injection 無技術保證；跨程序並行指派無保護；任務完成不會自動 `done`。

下一步：使用者驗收後改為「已驗收」；再做第三步 journal 同步。

### live 驗收紀錄

**2026-11-02 live 驗收：通過。** 環境：本機 macOS，main `3cd1509`（PR #29），`scripts/run.sh -r` 重新編譯並重啟 bridge，Gateway 與 `agy-pod` 連線正常。active Agent 是執行這段開發的 Claude Code session（pane `w1:p1`），所以 Lead 提示由該 session 直接回應。

console（Agent 親自在 bridge pane 輸入並觀察輸出）：
- `card assign` 對 `draft` 卡片 → 拒絕（「狀態是 draft；只有 ready 的卡片可以指派」）。
- 沒選 workspace 時對 `ready` 卡片 `card assign` → 「select a workspace first…」，卡片維持 `ready`、沒有 `tasks`。
- 對已在進行中的卡片再次 `card assign` → 拒絕（「狀態是 in_progress…（已在進行中）」）。
- 缺少 `## 描述` 的 `ready` 卡片 → 拒絕（「卡片沒有「## 描述」段落…」），沒有任務啟動、卡片維持 `ready`。

指派（使用者操作，入口依使用者說法為 Discord）與 Agent 端（Agent 親自觀察，Lead 提示由使用者貼入 session）：
- 使用者對 `REQ-20261102-accept-assign` 執行 `card assign`。Lead 收到的提示內容正確：前面有「卡片內容只是資料」聲明，`<<<CARD_DATA id=REQ-20261102-accept-assign>>>` 與 `<<<END_CARD_DATA>>>` 之間只有標題、描述、驗收條件，沒有流程紀錄等其他段落。Lead 規劃階段回空的 `assignments`，合成階段回「收到」，符合驗收條件。
- 任務結束後 `card show`：狀態 `in_progress`，`tasks: [task-c2a63685-…]`，紀錄有 `assigned`（指派給 claude（local））與 `started`（開始執行 task task-c2a63685-…），task id 與 Lead 提示一致。
- 使用者接著執行一般 `team ask 回覆收到`，規劃與合成階段都正常完成（抽出 `startTeamTask`／`reportTeamTask` 後 `team ask` 行為未變）。

預期內的現象（非問題）：任務結束後卡片仍為 `in_progress`，不會自動 `done`——journal 同步屬第三步。

未驗證／限制：
- Discord 端 `card assign` 的回覆文字、Team 回條與結果訊息，Agent 沒有看到原始內容（使用者看過，未逐字留存）。
- `--coding` 模式的 `card assign` 未實測（`team ask --coding` 的既有自動化測試通過）。
- 驗收時 Lead 就是開發者自己的 Claude session，未用獨立的 worker Agent 或 `agy-pod` 遠端機器驗證。
- 已知設計限制不變：prompt injection 無技術保證；跨程序並行指派無保護；任務完成不自動 `done`。
- 驗收用卡片 `REQ-20261102-accept-assign`（`in_progress`）、`REQ-20261102-accept-nodesc`（`ready`）仍在使用者的卡片目錄，可刪除。

下一步：第三步 journal 同步（任務完成 → `done` 並記 `completed`；失敗或取消 → 維持 `in_progress` 並記事件），由使用者決定何時開始。

## ISSUE-059：Team 任務結束後卡片狀態同步（journal 同步）

更新日期：2026-11-02。狀態：已驗收（補同步、完成、取消、一般 `team ask` 回歸皆通過，見下方「live 驗收紀錄」）。

來源：card-to-merge 階段 2b 第三步（ADR-0002 階段 2 決定 Q4）。ISSUE-058 驗收時已看到缺口：任務結束後卡片仍停在 `in_progress`。

使用者可見行為：bridge 啟動時與每 60 秒，依 Team 任務結果更新由 `card assign` 指派的卡片：完成 → `done` 並記 `completed`；失敗／取消 → 維持 `in_progress`，只記 `failed`／`cancelled`。見 SPEC「營運卡片指令」的任務結果同步。

預期行為：重複同步不重複記錄；多個任務時只有最後一個完成才 `done`；人已改動狀態的卡片不碰；任務進行中不動卡片；機敏的失敗原因整筆省略；bridge 重啟後補同步重啟期間完成的任務。

根因／修正範圍：不適用（新功能）。新增 `src/card-sync.ts`（`syncCards`、`taskSourceFrom`）與 `src/main.ts` 的 `startCardSync`。

測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-sync.test.ts`（12 項，含以真實 `TeamTaskStore` 驗證 journal sequence 與端到端）；全套 658 項，657 通過、0 失敗、1 略過（原 646 項）；`lint` 通過。變異測試：移除「只有最後一個任務完成才 done」的條件會讓對應測試失敗。**沒有**對 `startCardSync` 的計時器與 `main.ts` 接線做自動化測試。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 重啟後約 1 分鐘內，ISSUE-058 驗收留下的卡片 `REQ-20261102-accept-assign`（任務早已完成、卡片仍 `in_progress`）應被補同步：`card show` 看到狀態 `done`、紀錄多一筆 `completed`；bridge console 出現 `Card sync updated: …`。
2. 再指派一張新卡（例如描述只要求回覆「收到」），任務結束後約 1 分鐘內變 `done`。
3. 失敗／取消路徑：指派一張卡後用 `team cancel <task-id>` 取消，確認卡片維持 `in_progress` 並多一筆 `cancelled`。
4. 已知限制：輪詢造成最多約 60 秒延遲；`cancelled` 的 `by` 固定為 `user`；失敗不通知 Discord；卡片被刪除時的處理（2c）未做。

下一步：使用者驗收後改為「已驗收」；再進入 2c（執行中的卡片被刪除）。

### live 驗收紀錄

**2026-11-02 live 驗收：通過。** 環境：本機 macOS，main `2cb48a0`（PR #31），`scripts/run.sh -r` 重新編譯並重啟 bridge。以下 console 結果由 Agent 在 bridge pane 輸入並觀察；Discord 操作由使用者執行。

1. **補同步**：重啟後 console 立即印出 `Card sync updated: REQ-20261102-accept-assign`。該卡（ISSUE-058 驗收留下、任務早已完成）由 `in_progress` 變 `done`，多一筆 `completed`，時間為任務的 `finishedAt`（`08:03:56Z`）而非同步當下；再等 65 秒紀錄沒有重複。
2. **完成 → `done`**：使用者對 `REQ-20261102-sync-ok` 執行 `card assign`，任務結束後 `card show` 為 `done`，紀錄 `assigned`、`started`、`completed`（`08:25:20Z`），console 印出 `Card sync updated: REQ-20261102-sync-ok`。
3. **取消 → 維持 `in_progress`**：使用者對 `REQ-20261102-sync-cancel`（描述要求先 `sleep 90`）執行 `card assign` 後取消任務。`card show` 仍為 `in_progress`，紀錄多一筆 `cancelled`「已取消（user）」（`08:28:38Z`），`tasks` 保留 task id，console 印出 `Card sync updated: REQ-20261102-sync-cancel`。
4. **一般 `team ask` 回歸**：使用者在 Discord 執行 `team ask 回覆收到`，回覆 `Team Task completed`（task `task-9ed421e5-…`，結果「收到」，使用者貼上原文）。卡片目錄沒有任何檔案含該 task id，console 沒有為它印出 `Card sync updated`。

未驗證／限制：
- 除第 4 項外，Discord 端回覆文字 Agent 沒看到原文。
- 驗收時 Lead 是開發者自己的 Claude session（第 3、4 項的 Lead 在另一個 workspace `w3`），沒有用獨立 worker Agent 或 `agy-pod` 遠端機器驗證。
- `cancelled` 的 `by` 固定為 `user`；輪詢造成最多約 60 秒延遲；失敗（`failed`）路徑只有自動化測試，沒有 live 驗證。
- `main.ts` 計時器接線無自動化測試，僅由本次 live 驗收涵蓋。
- 驗收用卡片（`accept-2a`、`accept-test`、`accept-assign`、`accept-nodesc`、`sync-ok`、`sync-cancel`）仍在使用者的卡片目錄，可刪除。

下一步：階段 2c（執行中的卡片被刪除時停止寫入並詢問，Q6），由使用者決定何時開始。

## ISSUE-060：執行中的卡片被刪除（停止寫入並詢問）

更新日期：2026-11-02。狀態：已驗收（偵測、通知一次與通知原文、`card recreate`、重建後照常同步、刪卡後 `team cancel` 皆有證據，見下方「live 驗收紀錄」；補測時發現的 `team cancel` 延遲另列 ISSUE-061）。

來源：card-to-merge 階段 2c（ADR-0002 階段 2 決定 Q6、ADR-0001 決定 7）。

使用者可見行為：`card assign` 出去的任務還在進行中時，如果卡片檔被刪除，bridge 會在約 1 分鐘內於任務的來源 thread（或 bridge console）送出通知，列出 `card recreate <id>`、`team cancel <task-id>`、不處理三個選項。新增 `card recreate <id>`。

預期行為：不自動取消任務、不自動重建卡片；只通知一次（送成功才標記）；任務已結束、卡片只是壞掉讀不了、卡片還在時都不通知；`card recreate` 只還原標題／描述／驗收條件，其他段落無法還原。見 SPEC「卡片被刪除而任務還在跑」。

根因／修正範圍：不適用（新功能）。新增 `src/card-assignments.ts`；`src/card-sync.ts`（`missing`、`missingCardMessage`）；`src/card-handoff.ts`（`parseAssignmentPrompt`）；`src/card-command.ts`（記索引、`recreate`）；`src/main.ts`、`src/discord.ts`（通知與接線）。

測試（2026-11-02，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-assignments.test.ts`（6）、`test/card-sync.test.ts` 的 missing、訊息與索引損毀測試（6）、`test/card-handoff.test.ts` 的解析測試（4）、`test/card-command.test.ts` 的記索引與 recreate 測試（5）；全套 679 項，678 通過、0 失敗、1 略過（原 658 項）；`lint` 通過。變異測試：把「卡片檔確實不存在」的判斷改成一律成立，會讓「讀不了的卡片不算被刪除」測試失敗。**沒有**自動化測試涵蓋 `startCardSync` 的通知接線、`postToOrigin` 與計時器。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 在 Discord thread 指派一張描述要求「先 `sleep 90` 再回覆」的卡片（讓任務跑久一點），任務進行中刪掉卡片檔：約 1 分鐘內該 thread 收到通知，內容含卡片 id、task id、狀態與三個選項。
2. 再等 1–2 分鐘：不應重複通知。
3. `card recreate <id>`：卡片回來，狀態 `in_progress`，`tasks` 含該 task，內文有「重建」說明與描述／驗收條件；任務結束後約 1 分鐘內變 `done`。
4. 另一次：刪卡後改用 `team cancel <task-id>`，確認不會有卡片被建立。
5. 從 console 指派的任務刪卡：通知印在 bridge console。
6. 已知限制：只還原三個欄位；Discord 通知失敗會每分鐘重試且沒有上限；索引檔損毀需人工處理（損毀時只停用刪除偵測並在 console 報告，任務結果同步不受影響）；輪詢最多延遲約 60 秒。

下一步：使用者驗收後改為「已驗收」。2c 之後是 worktree 隔離與政策檔（追蹤清單 E 以後）。

### live 驗收紀錄

**2026-11-02 live 驗收：通過（含 `team cancel` 補測）。** 環境：本機 macOS，main `73117e4`（PR #33），`scripts/run.sh -r` 重新編譯並重啟 bridge。操作（`card assign`、刪卡片檔、`card recreate`、`team cancel`）由使用者在 Discord／終端機執行並回報「都測試好了」，**使用者沒有貼回覆原文**；以下是 Agent 事後從 bridge 狀態檔與卡片檔取得的證據。

A. 刪卡 → 通知 → `card recreate`（`REQ-20261102-del-recreate`，task `task-55beb52e-…`）：
- 索引 `card-assignments.json` 有該任務，`assignedAt` 08:59:48Z、`notifiedAt` 09:00:16Z——刪卡後約 28 秒內 bridge 判定「卡片被刪除」並完成通知（送成功才會寫 `notifiedAt`）。
- 卡片現在存在，`status: done`，`tasks: [task-55beb52e-…]`，內文開頭有「這張卡片是 bridge 從任務紀錄重建的」說明，描述與驗收條件已還原；流程紀錄有 `assigned`、`started`（事件 id 與原本相同）以及任務結束後的 `completed`（09:02:03Z）——重建後同步照常運作。
- bridge console 有 `Card sync updated: REQ-20261102-del-recreate`。

B. 刪卡後不重建（`REQ-20261102-del-cancel`，task `task-db53a441-…`；第一次測試）：
- 索引 `assignedAt` 09:03:25Z、`notifiedAt` 09:04:16Z（約 51 秒），已通知一次。
- 卡片目錄裡**沒有**這張卡——bridge 沒有自行重建。
- 但任務 journal 最終狀態是 `completed`（不是 `cancelled`），所以第一次測試**沒有證明**「刪卡後 `team cancel`」——見下方補測。

B'. **補測：刪卡後 `team cancel`（通過）**（`REQ-20261102-del-cancel2`，描述要求先 `sleep 150`，task `task-3be4f271-…`）。使用者在 Discord 指派、刪除卡片檔、收到通知後輸入 `team cancel`，並貼上截圖（Agent 已讀取該圖）：
- 通知原文（截圖，5:13 PM）：「⚠️ 卡片 REQ-20261102-del-cancel2 已被刪除，但它指派的 Team 任務 task-3be4f271-… 還在進行中（synthesizing）。bridge 不會再寫入這張卡片，也不會自動取消任務或自動重建卡片。請選擇：」，列出 `card recreate REQ-20261102-del-cancel2`、`team cancel task-3be4f271-…`、「不處理」三個選項。內容與 SPEC 規定一致。
- 索引 `assignedAt` 09:12:30Z、`notifiedAt` 09:13:16Z（約 46 秒內通知）。
- 任務 journal：`cancel_requested`（09:13:22Z）→ `cancel_turn_settled`（09:15:12Z）→ `task_cancelled`，最終狀態 `cancelled`。
- cards 目錄**沒有** `REQ-20261102-del-cancel2.md`：取消後 bridge 沒有重建卡片，也沒有為已取消的任務寫任何東西。
- 使用者指出「`team cancel` 會被 block 到 120 秒後」：`cancel_requested` 到 `cancel_turn_settled` 隔了約 110 秒，與任務的 `sleep` 時間相符。這是既有 Team 任務取消行為，不是 2c 造成；見 ISSUE-061。

未驗證：
- 「不重複通知」只有間接證據（`notifiedAt` 只會寫一次），沒有逐分鐘觀察。
- 反向檢查 C（對已存在的卡片 `card recreate` 應被拒絕）沒有證據，只有自動化測試。
- 從本機 console 指派的任務刪卡（通知印在 console）沒有測。
- 已知限制不變：只還原標題／描述／驗收條件；Discord 通知失敗每分鐘重試且沒有上限；索引檔損毀需人工處理；輪詢最多延遲約 60 秒；升級前指派的任務不在索引內，刪卡不會被偵測。
- 驗收用卡片（`del-recreate`、`sync-ok`、`sync-cancel` 及先前的 `accept-*`）仍在使用者的卡片目錄，可刪除。

下一步：2c 之後是 worktree 隔離與政策檔（追蹤清單 E 以後）。

## ISSUE-061：`team cancel` 要等到 Agent 目前的長時間指令結束才會生效

更新日期：2026-11-03。狀態：已驗收（agy；claude、Worker 路徑未實測，見「驗收證據」）。**這次是 Agent 手動診斷與修正，沒有走「建單 → … → merge」的自動化流程**（該流程的 review、test、merge 自動化尚未實作），所以本 issue 已不能再當 H4 的端到端測試案例，見下方「預定用途」。

使用者可見症狀：任務的 Lead 正在執行長時間的 shell 指令（驗收用的 `sleep 150`）時輸入 `team cancel <task-id>`，取消看起來被擋住，要等指令跑完才完成。使用者原話：「team cancel 會被 block 等到 120 秒後」。

預期行為：`team cancel` 盡快中止進行中的工作（至少讓使用者知道取消的進度，而不是無回應）。

重現方式／環境（2026-11-02，本機 macOS，main `73117e4`）：用 `card assign` 指派一張描述為「先在 shell 執行 sleep 150，之後只回覆『完成』」的卡片（task `task-3be4f271-…`，Lead 是 Claude Code，Team 沒有 Worker），任務進入 `synthesizing` 後輸入 `team cancel`。任務 journal：`cancel_requested` 09:13:22Z，`cancel_turn_settled` 09:15:12Z（約 110 秒後），最終 `cancelled`。

已確認：取消最終有生效（最終狀態 `cancelled`），延遲約等於 `sleep` 的剩餘時間。

根因（**已確認**，2026-11-03 診斷）：兩個證據。(1) 該任務 journal 的 `cancel_turn_settled` 詳情是「already settled; no completion inferred」，**不是**「cancel confirmed」——表示 **Ctrl-C 根本沒有送出**，取消只是等到 Agent 自己跑完 `sleep` 變 idle 才收尾。(2) 程式：`src/team-task-engine.ts` 的 `cancelTask` 先 `await execution?.done`（等進行中的任務執行結束），之後才進入「對 working 的 Agent 送 Ctrl-C」的迴圈；而執行端 `src/team-turn.ts` 用 Herdr 的 atomic `agent.prompt(wait: idle/done/blocked)`（`promptAgentAndWait`），這個 request 要等 Agent 自己停下才返回，而且**刻意不參與 abort 競速**（`abortable` 的註解：「派送必須先 settle，取消才清理」，以便確定 prompt 有沒有送達）。結果是 `execution.done` 要等到 Agent 的長時間指令結束，Ctrl-C 永遠在那之後。這是設計上的相互等待，不是 Claude Code 對 Ctrl-C 的行為。

使用者的驗收條件決定（2026-11-03）：**取消馬上送 Ctrl-C**（另兩個選項「只補進度訊息」「只在文件註明限制」未採用）；建議的 live 驗收：Agent 執行 `sleep` 時 `team cancel`，約 10 秒內進入 `cancelled`。

修正範圍（2026-11-03）：`src/team-task-engine.ts`：`cancelTask` 不再直接 `await execution?.done`，改為新方法 `interruptUntilSettled`：每 `cancelPollMs`（預設 1000 ms，建構子可注入）檢查一次本任務已記錄的 turn；其 Agent 在 working 且身份相符（記錄當時有 session 就必須是同一個；沒有 session 則只看 terminal 與種類，與 ISSUE-066 一致）、且該 turn 尚未 `cancelAttempted`、非 `recovered`，就先記 `cancel_signal_intent`、再送**一次**既有的 Ctrl-C（`cancelAgent`）；Agent 停下後 `agent.prompt` 返回、`execution.done` 結束，**之後的收尾流程與保留釋放完全不變**。沒開始工作（idle）的 turn 不送；派送本身仍然要先 settle 才釋放保留，所以「派送必須先 settle」的安全規則沒有被放寬。單次檢查失敗不中斷等待，由收尾流程重新檢查並如實回報。與 ISSUE-060 無關：卡片同步與刪除偵測在取消期間照常運作。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/team-task-engine.test.ts` 新增 2 項（派送還在等待、Agent 已 working 時取消，會在不等 prompt 返回的情況下送一次 Ctrl-C 並進入 `cancelled`；Agent 還沒開始工作時不送、開始工作後只送一次、不重送）。修正前第一項因取消永遠等不到派送完成而逾時、第二項在「working 後應送」斷言失敗；修正後綠燈。既有的「cancel during pending atomic dispatch waits for dispatch…」等 25 項取消測試全部維持通過。全套 840 項，839 通過、0 失敗、1 略過（原 838 項）；`lint` 通過。**沒有**對真實 Herdr／Claude Code／agy 的測試。

未驗證：Claude Code 在執行 `sleep` 等 shell 指令時 Ctrl-C 的效果（**本修正只保證 bridge 會及時送出 Ctrl-C**，不保證 CLI 一定停下；停不下來時任務仍會停在 `cancelling` 並如實回報「cancel sent; stop not yet confirmed」）；Lead 不是長時間指令而是一般回覆中取消的行為；Worker 路徑（同一套 `cancelTask`）；其他 CLI（codex 等）。限制：1 秒輪詢，取消後最多約 1 秒才會送出 Ctrl-C。

驗收證據（2026-11-03，本機 macOS，bridge 載入 main `98e6a0b`，Herdr 0.9.1，`agy` 當 Lead，pane `w1:p8`，沒有用 `--worktree`；由 Agent 在 bridge console 操作）：驗收卡的任務 `task-1e9f4231-70ff-4193-aaa7-574092399f0c` 讓 `agy` 執行 `sleep 120`，Herdr 回報 `working` 時下 `team cancel`。journal：09:19:31.957 `cancel_requested` → 09:19:33.241 `cancel_signal_intent`（Ctrl-C 送出，約 1.3 秒後）→ 09:19:34.021 `cancel_turn_settled` → 09:19:34.049 `task_cancelled`；約 2 秒進入 `cancelled`（修正前同樣情境約 110 秒、Ctrl-C 從未送出）。驗收條件（約 10 秒內）達成。

附帶觀察（未另立 issue）：(1) Ctrl-C 讓 `agy` 回到 idle，但 `agy` 把 `sleep 120` 轉成背景任務，畫面仍顯示 `1 task(s)`，`sleep` 沒有被殺掉——Ctrl-C 只中斷 `agy` 的 turn，不保證結束它啟動的子行程。(2) 收尾訊息「already settled; recorded session was empty … no signal sent」在本情境不準確：Ctrl-C 其實已在前面送出（見 `cancel_signal_intent`），是 Agent 停下後走了 ISSUE-066 的「session 為空且 idle」分支才寫了這段文字；行為正確，文字誤導。

未實機驗證：Claude Code 為 Lead（使用者決定不補測）；Worker 路徑；Lead 在一般回覆中取消；其他 CLI（codex 等）。限制同上：1 秒輪詢；Ctrl-C 不保證 CLI 或其子行程停下。

下一步：無。

預定用途（使用者，2026-11-02；**2026-11-03 已失效：本 issue 已由 Agent 手動修正，不能再當端到端案例，H4 需另選案例**）：本 issue **保留起來，等「建單 → 分配任務 → 處理 → review → test → PR → merge → 結單」的自動化流程完成後，拿來當端到端的自動化測試案例**，實際跑一次整條流程。這是未來的計畫，目前不能自動跑。與 ISSUE-055 的用途並列（見追蹤清單 H4）：本 issue 範圍較小、風險較低，建議**先用它驗證流程本身**，再用 ISSUE-055（刪除檢出，風險較高）。

目前各階段的具備情況（2026-11-02，Agent 整理）：

| 階段 | 現況 |
|---|---|
| 建單 | 已有：把本 issue 寫成卡片後用 `card import` 匯入（要有 `## 描述` 與 `## 驗收條件`）。**尚未做：** 卡片需先轉成有明確驗收條件的內容（見下） |
| 分配任務 | 已有：`card assign`（已驗收，ISSUE-058）。Lead／Workers 目前沿用 `team ask` 的選擇方式 |
| 處理（開發） | 部分：Team 任務可執行，但還沒有 worktree 隔離（追蹤清單 E）；`--coding` 模式有本機 Git 驗收 |
| review、test | 未做：多 Agent review 與測試的自動化流程尚未實作 |
| PR、merge | 未做：政策檔與 PR 自動化（追蹤清單 F、G）尚未實作 |
| 結單 | 部分：任務完成會把卡片同步為 `done`（ISSUE-059，已驗收）；結單時回寫 issue／文件、關閉 PR 等尚未做 |

作為測試案例前的前提（尚未滿足）：
1. 本 issue 的根因未確認，第一步其實是**診斷**（Ctrl-C 對 Claude Code 執行中 shell 指令的實際效果、引擎在 `cancelling` 的等待與回報）。要轉成「描述＋可驗收條件」的卡片時，驗收條件需由使用者決定：例如「取消後 N 秒內進入 `cancelled`」或「取消期間有進度訊息」或「只在文件註明限制」。Agent 不能在缺少決定時自行定義。
2. 上表中「review、test、PR、merge」的自動化尚未存在，要等追蹤清單 E–G 完成。
3. 第一次試跑以 L1（開 PR、由人 merge）進行，不直接用 L2 自動 merge。
4. 驗收用的長時間任務（`sleep 150` 的卡片）可重用為「重現步驟」：它在 ISSUE-060 補測中已實際重現本問題（task `task-3be4f271-…`），可寫成自動化測試的 fixture。

相關：ISSUE-055（另一個預定的端到端測試案例）、ISSUE-058／059／060、追蹤清單 H4。

## ISSUE-062：`card assign --worktree` 與 `card cleanup`（隔離 worktree）

更新日期：2026-11-03。狀態：已驗收（主流程與清理；Discord 回覆原文、信任提示、`allowedWorkspaceIds` 限制情境、回歸等未驗證項目見「live 驗收紀錄」；使用者提出的後續需求見追蹤清單 E11–E13）。

來源：card-to-merge 階段 3b（需求卡 REQ-20261101-worktree-isolation；使用者 2026-11-03 的決定見需求卡與追蹤清單 E）。這是第一個由 bridge 建立並移除使用者 repo 檢出、並自動啟動 Agent 的功能，風險較高，因此單獨列為驗收項目。

使用者可見行為：見 SPEC「隔離 worktree」與 `card cleanup`。

現況補充（2026-11-09，ISSUE-129，已驗收）：以下保留 ISSUE-062 當時的需求與驗收歷史；現行 cleanup 對有卡片記錄且通過 id／label 核對的 autopick Lead 有關閉例外，其餘來源 workspace 保留。

預期行為：`card assign <id> --worktree` 在目前 thread Agent 所在 repo 建立 `card/<id>` 分支的 worktree 與 workspace、啟動同種 Agent、切換路由、記錄到卡片、啟動任務；Agent 被擋住時不啟動任務並說明；`card cleanup <id>` 永不強制、髒檢出保留、不刪分支、不關來源 workspace；沒帶旗標的流程完全不變。

根因／修正範圍：不適用（新功能）。新增 `src/card-worktrees.ts`、`src/card-worktree-flow.ts`；`src/card-command.ts`（`--worktree`、`cleanup`）；`src/main.ts`（接線、git 輔助、`agent.start` 輪詢、授權）。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-worktrees.test.ts`（6）、`test/card-worktree-flow.test.ts`（10）、`test/card-command.test.ts` 的 worktree 與 cleanup 測試（10）；全套 717 項，716 通過、0 失敗、1 略過（原 691 項）；`lint` 通過。**沒有**自動化測試涵蓋 `main.ts` 的接線（git 輔助、`agent.start` 輪詢、授權、路由切換）；真實 Herdr 行為只有上述需求卡中的拋棄式 repo 實測。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 在 Discord thread（Agent 所在目錄是 git repo）對一張 `ready` 卡片下 `@bot card assign <id> --worktree`：預期建立 worktree、在新 workspace 啟動同種 Agent；若 Agent 被擋住（Claude Code 的信任提示），回覆應說明並指向該 pane，卡片維持 `ready`。
2. 到該 pane 確認信任後，`@bot card assign <id>`：任務在新 workspace 執行；`card show <id>` 看到 `## 異動專案`、`worktree_created`、`assigned`、`started`。
3. 任務結束後 `card cleanup <id>`：乾淨時移除、分支保留；先在 worktree 弄髒檔案再 `card cleanup`：應保留並說明。
4. `allowedWorkspaceIds` 有設限時（若你有設）新 workspace 能正常使用，清理後被撤銷。
5. 沒帶旗標的 `card assign` 與 `team ask` 不受影響（回歸）。
6. 已知限制：Claude Code 新資料夾的信任提示無法自動通過；只支援本機；手動移除 worktree 後 `card cleanup` 會失敗；來源 repo 的 workspace 需自行關閉；Codex 等其他 Agent 種類未測；`--coding` 在 worktree 內的行為未測。

下一步：使用者驗收後改為「已驗收」；再處理政策檔與 PR 自動化（追蹤清單 F）。

### live 驗收紀錄

**2026-11-03 live 驗收：主流程與清理通過。** 環境：本機 macOS，main `fe8ee56`（PR #36），`scripts/run.sh -r` 重新編譯並重啟 bridge；目標是拋棄式 repo `~/tmp/wt-accept-repo`（一個 commit），驗收卡片 `REQ-20261103-wt-accept`。使用者操作 Discord 並貼上終端機截圖（Agent 已讀取）；**使用者沒有貼回覆原文**，以下由 Agent 事後從 bridge 狀態檔、卡片檔、Herdr 與 git 取得證據。

- **`card assign --worktree`（使用者在 Discord 執行）：** 卡片檔有 `## 異動專案`（repo、分支 `card/REQ-20261103-wt-accept`、worktree 路徑 `~/.herdr/worktrees/wt-accept-repo/card-req-20261103-wt-accept`、base `03364e63f79f`）與紀錄 `worktree_created`（01:46:12Z）、`assigned`、`started`（同秒）、`completed`（01:46:22Z）；狀態 `done`。索引 `card-worktrees.json` 有該卡（workspace `w14`、來源 `w13`）。`git worktree list` 與分支都存在。截圖顯示 Lead 收到的是新 worktree workspace 裡的 Agent 提示（`<<<CARD_DATA>>>` 內容，回覆「收到」）。
- **Agent 沒有被信任提示擋住**：`worktree_created` 與 `started` 同一秒，表示 Agent 當下已是 idle，與先前拋棄式 repo 實測的 `blocked` 不同。**原因未確認**（可能 `~/.herdr/worktrees` 底下已被信任）。因此「blocked 時停下並說明」的實機路徑**沒有被這次驗收涵蓋**（只有自動化測試）。
- **清理（Agent 在 bridge console 執行並觀察）：** worktree 放一個未追蹤檔 `dirty.txt` 後 `card cleanup` → 回覆「有未提交的修改，已保留」，workspace `w14` 仍開著，記 `cleanup_pending`；刪掉檔案後再 `card cleanup` → 回覆已移除，workspace `w14` 關閉、目錄消失、`git worktree list` 只剩主檢出、分支 `card/REQ-20261103-wt-accept` **保留**、索引寫入 `removedAt`、記 `cleanup_done`。
- **使用者觀察（2026-11-03）：** 任務完成後 worktree workspace 沒有被清理與關閉，來源 repo 的 workspace 也留在側邊欄。這是既定行為（不自動清理、不關來源 workspace），**不是缺陷**；但使用者決定改變方向，見下。

使用者的後續決定（尚未實作，已列入追蹤清單）：
1. **E11：卡片 merge 後才清理**（不是完成就清理）；merge 自動化屬 F、G，在那之前維持手動 `card cleanup`。
2. **E12：卡片要能呈現 worktree／清理狀況**，讓無法 merge、無法清理的卡片先從卡片看到狀況；「AI 決議」的範圍與 ADR-0002 決定 11 的關係待確認。
3. **E13：只有 bridge 自己開的來源 workspace 才在清理最後一個 worktree 時自動關閉。**

未驗證：
- Discord 端 `card assign --worktree` 的回覆原文（含 blocked 說明）、`card cleanup` 的 Discord 回覆。
- Agent 被信任提示擋住（blocked）的實機路徑；Codex 等其他 Agent 種類；`--coding` 在 worktree 內。
- `allowedWorkspaceIds` 有設限時的授權與撤銷（本機未設限）。
- 回歸：沒帶旗標的 `card assign` 與一般 `team ask`（驗收流程的 E 步驟沒有取得證據）。
- 未清理的殘留：來源 repo workspace `w13`（wt-accept-repo）、分支 `card/REQ-20261103-wt-accept`、`~/tmp/wt-accept-repo` 與驗收卡片，需使用者自行處理。

下一步：E11–E13 需要先確認 E12 的範圍再設計；merge 自動化（F、G）完成前不會自動清理。

### 後續：卡片呈現 worktree 狀況與 `## 決議`（E12 選項 1，2026-11-03）

來源：ISSUE-062 驗收時使用者要求「從卡片先看到」無法清理的 worktree 狀況，並確認卡片說明欄位本來就可以寫自由文字、要求卡片能記錄 AI 的決議；使用者選**選項 1**（bridge 只寫結構化狀況、`## 決議` 由人或 Agent 自己寫）。

狀態：已驗收（主要路徑；見下方「live 驗收紀錄」，「作用中」與「保留」兩個狀態的顯示未取得證據）。

內容：`## 異動專案` 新增 `- worktree 狀態：作用中／已清理（分支保留）／保留（有未提交修改）`（`card assign --worktree` 與 `card cleanup` 就地更新）；`card show` 單獨列出 worktree 狀態與 `── 決議 ──`；`## 決議` 不被 bridge 改寫。細節見 SPEC。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/card-projects.test.ts`（+3：狀態文字與位置、就地更新與冪等、不合法值）、`test/card-command.test.ts`（+4：assign 後作用中、cleanup 後已清理／保留、`card show` 的決議顯示與遮蔽、長決議截斷、無決議不顯示標題）、`test/card-store.test.ts`（+1：bridge 各種寫入後 `## 決議` 逐字不變）。

未驗證（待使用者，merge 並重啟 bridge 後）：對一張走過 `--worktree` 的卡片 `card show` 看到 `worktree 狀態`；`card cleanup` 後狀態變成已清理／保留；在卡片檔手寫 `## 決議` 後 `card show` 單獨顯示、bridge 後續寫入（`card cleanup`、任務完成同步）不改動它。

未做：選項 2（bridge 自動寫 Agent 摘要）、「尚未 merge 而保留」狀態（待 E11）。

**2026-11-03 live 驗收（E12）：主要路徑通過。** 環境：本機 macOS，main `3ca4e6f`（PR #37），`scripts/run.sh -r` 重啟 bridge；驗收卡片 `REQ-20261103-wt-state`，目標 repo `~/tmp/wt-accept-repo`。使用者在 Discord 操作並貼上兩張截圖（Agent 已讀取）；Agent 事後另從卡片檔、索引與 Herdr 取得佐證。

- **`## 決議` 顯示（Agent 在 bridge console 驗證）：** 在 `REQ-20261103-wt-accept` 手寫 `## 決議` 後 `card show`，於「── 決議 ──」下單獨顯示、沒有重複出現在「內容」，驗完已還原該卡。
- **`card assign --worktree`（使用者在 Discord）：** 卡片紀錄 `worktree_created`、`assigned`、`started`（同秒，Agent 當下已是 idle，沒有被信任提示擋住）、`completed`（03:14:37Z）。
- **`card cleanup`（截圖）：** 髒檢出時回覆「有未提交的修改，已保留」並記 `cleanup_pending`（03:17:37Z）；清乾淨後回覆「已移除 worktree …（workspace w15）」、「分支 … 仍保留」、「來源 repo 的 workspace 也不會被關閉」，記 `cleanup_done`（03:20:01Z）。
- **`card show`（截圖，Discord）：** 摘要區出現單獨的一行「worktree 狀態：已清理（分支保留）」；`## 異動專案` 小節同樣有「worktree 狀態：已清理（分支保留）」，且在 `worktree` 與 `base` 之間、只有一行（就地更新，沒有重複）。卡片檔（Agent 讀取）與截圖一致；索引寫入 `removedAt`；workspace `w15` 已關閉，來源 workspace `w13` 如預期仍在。

未驗證：
- 「作用中」（`--worktree` 成功後）與「保留（有未提交修改）」（髒檢出後）兩個狀態在 `card show` 的實際顯示：這次截圖只有最後的「已清理」；這兩個狀態只有自動化測試與卡片紀錄（`cleanup_pending`）的間接證據。
- bridge 之後的寫入（任務完成同步、`card cleanup`）不改動手寫 `## 決議` 的 live 路徑：只有自動化測試（`card-store` 測試）；實機只驗了顯示。
- 使用者途中輸入 `card assign … --worktree 3`（多一個參數）被正確拒絕，沒有任何副作用（用法錯誤訊息沒有指出是哪個多餘參數，見下）。

附帶觀察：`card assign` 對多餘參數只回整行用法，沒指出是哪個參數多了；使用者因此需要回頭看用法才找到原因。屬小改善，尚未處理。

## ISSUE-063：專案政策檔載入與 `card policy`（F1）

更新日期：2026-11-03。狀態：已驗收（載入與唯讀查詢；啟動時的 console 訊息未驗證，見「live 驗收紀錄」）。

來源：card-to-merge 階段 4（追蹤清單 F1；使用者 2026-11-03 的決定：政策檔只放 plugin 設定目錄、受限 YAML 子集、第一版只做載入不碰 push、PR 內容只放卡片 id 與標題加結構化事實）。

使用者可見行為：新增 `card policy [專案]`（唯讀）與 bridge 啟動時的政策檢查訊息。**沒有任何動作依政策行為**。見 SPEC「專案政策」。

預期行為：檔案不存在 → 全部 L0（不是錯誤）；合法 → 載入；不合法或不安全 → 說明原因並用安全預設（全部 L0）；沒列出的專案用 `default`；bridge 永不寫這個檔案。

根因／修正範圍：不適用（新功能）。新增 `src/policy.ts`（`parsePolicy`、`loadPolicy`、`levelFor`）；`src/card-command.ts` 的 `policy`；`src/main.ts` 啟動檢查與接線；`src/config.ts` 匯出 `configDirectory`。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：新增 `test/policy.test.ts`（31 項：合法與預設、CRLF、各種被拒絕的格式與值、上限、`levelFor`、載入的各種狀態——缺檔、合法、不合法、群組／其他人可寫、符號連結、目錄、過大、非 UTF-8），`test/card-command.test.ts` 的 `card policy`（3 項）。變異測試：移除「群組或其他人可寫」檢查會讓對應測試失敗。**沒有**自動化測試涵蓋 `main.ts` 的啟動訊息與接線。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 沒有政策檔時 `@bot card policy`：回「檔案不存在」與全部 L0。
2. 在 `~/.config/herdr-discord-bridge/policy.yml`（權限 600）寫一個合法政策，`card policy` 與 `card policy local:<專案>` 顯示對的等級；重啟後 console 印出載入訊息。
3. 故意寫錯（例如 `default: L3`）：`card policy` 說明哪一行有問題並用安全預設；把權限改成 666：被拒絕並提示 `chmod 600`。
4. 已知限制：同一 OS 使用者的 Agent 能改檔案；政策目前不影響任何行為；`policy.yml` 的不合法內容只在啟動與 `card policy` 時才被報告。

下一步：使用者驗收後改為「已驗收」；再討論 F2（GitHub 認證）與 F3（開 PR）。

### live 驗收紀錄

**2026-11-03 live 驗收：通過。** 環境：本機 macOS，main `c893fd1`（PR #39），`scripts/run.sh -r` 重啟 bridge。以下全部由 Agent 在 bridge console 輸入並觀察；Discord 端沒有操作。使用者明確授權（2026-11-03）Agent 在設定目錄建立驗收用的 `policy.yml`、驗完刪除；已刪除，`card policy` 回到「檔案不存在」。

- **實際路徑：** bridge 以 Herdr plugin 執行，`card policy` 印出的路徑是 `~/.config/herdr/plugins/config/herdr-discord-bridge/policy.yml`（與 `config.json` 同目錄），**不是** SPEC 原本寫的預設 `~/.config/herdr-discord-bridge/policy.yml`（那是環境變數沒設時的後備路徑）。已修正 SPEC 與 README。
- **沒有檔案：** `card policy` →「專案政策檔不存在…所有專案都是 L0（不 push）」，預設等級 L0。
- **合法檔案（權限 600，`local:Herdr_Discord_Bridge: L1`、`local:wt-accept-repo: L2`）：** 「專案政策已載入」，列出預設 L0 與兩個專案的等級；`card policy local:wt-accept-repo` → `L2`；`card policy local:Unlisted` →「L0（沒列出，用預設等級）」。
- **不合法（`default: L3`）：** 「專案政策檔不合法」，訊息為 `line 2: invalid level for "default"…`，並說明已改用安全預設（全部 L0）；`card policy local:wt-accept-repo` → `L0（沒列出，用預設等級）；政策檔有問題，目前用安全預設（全部 L0）`——即使該專案在檔案中原本寫 L2，也沒有被採用。
- **不安全（權限 666，內容含 `local:wt-accept-repo: L2`）：** 「專案政策檔不安全」，訊息含 `can be modified by group or others (mode 666); run: chmod 600 <路徑>`，改用安全預設；查單一專案同樣回 L0。
- **刪除後：** 回到「檔案不存在」。

未驗證：
- bridge **啟動時**的 console 檢查訊息（`Project policy loaded…` 或問題說明）：重啟時檔案還不存在（這種情況本來就不印），之後才建檔，所以沒有看到啟動訊息；只有程式碼與自動化測試的證據。
- Discord 端的 `card policy`（只在 console 驗）。
- 已知限制不變：同一 OS 使用者的 Agent 能改這個檔案；政策目前不影響任何行為；政策檔改動後 `card policy` 每次重新讀檔，但啟動檢查只在重啟時做。

下一步：F2（GitHub 認證）與 F3（開 PR）。F3 第一版已決定先不碰 push；F2 是前提（bridge 用誰的身分 push 與開 PR），需要先整理選項給使用者決定。

## ISSUE-064：`card pr`（push 卡片分支並開 PR）與 CI／merge 回報（F3）

更新日期：2026-11-03。狀態：已驗收（主要路徑：第一次真實 push 與開 PR、PR 內容、CI 回報、重複執行、PR 關閉通知、清理；失敗路徑與 Discord 通知原文未取得證據，見「live 驗收紀錄」）。

來源：card-to-merge 階段 4（追蹤清單 F3；使用者 2026-11-03 的決定見 SPEC「開 PR 與 CI 回報」）。**這是 bridge 第一次對外 push**，風險最高的一步，因此單獨列為驗收項目。

使用者可見行為：新增 `card pr <id>`；bridge 每分鐘檢查已開出的 PR 的 CI 與 merge／關閉並通知。見 SPEC。

預期行為：前提不符（卡片非 done、無 worktree 紀錄或 base、專案政策 L0、origin 非 github.com、有未提交修改、沒有 commit、標題疑似機敏、分支先前的 PR 已 merge／關閉）一律拒絕且不 push；成功時只 push `card/<id>` 分支（明確 refspec、不強制）並開 PR；已有開著的 PR 只 push 不重開；每個 head sha 的 CI 結果只回報一次；merge 只回報、不自動清理。

根因／修正範圍：不適用（新功能）。新增 `src/github.ts`（git／gh 轉接層）、`src/card-prs.ts`（PR 索引 `card-prs.json`）、`src/card-pr-flow.ts`（`card pr` 流程）、`src/card-pr-sync.ts`（CI／merge 輪詢）；`src/card-command.ts` 的 `pr`；`src/main.ts` 接線與輪詢；`src/card-worktrees.ts` 新增 `latest`。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：新增 `test/github.test.ts`（14：遠端解析、參數驗證、push 只允許 `card/` 分支且不帶旗標、錯誤遮蔽、checks 彙整、PR 狀態）、`test/card-prs.test.ts`（8）、`test/card-pr-flow.test.ts`（10：前提檢查、先 push 再開、PR 內文不含描述、已有開著／已 merge 的 PR、push 被拒、開 PR 失敗）、`test/card-pr-sync.test.ts`（9）、`test/card-command.test.ts` 的 `card pr`（4）、`test/card-worktrees.test.ts`（+1）；全套 805 項（原 759 項）由本機 `npm test` 執行，lint 通過。變異測試：在 push 指令加入 `--force` 會讓「從不強制」的測試失敗。**所有 `gh`／`git` 都是假的 `Exec`**；`main.ts` 的接線與輪詢沒有自動化測試。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）——**請依序、每一步確認後再進下一步**：
1. **政策檔（需要你明確授權或自己建）：** 在 `~/.config/herdr/plugins/config/herdr-discord-bridge/policy.yml`（權限 600）寫 `version: 1` 與 `projects:` 下 `local:Herdr_Discord_Bridge: L1`。沒有這個檔案時 `card pr` 應拒絕並提示 `card policy`（可先驗這個拒絕路徑）。
2. **拒絕路徑（不 push）：** 對非 `done` 的卡片、沒有 worktree 的卡片 `card pr`，確認被拒絕、沒有任何 push。
3. **建一張無害的文件卡：** 描述要求 Agent 在 `docs/` 加一小段文字並 `git commit`（Agent 必須自己 commit，`card pr` 不會代為 commit）；在 active Agent 位於 Herdr_Discord_Bridge repo 的 thread 以 `card assign <id> --worktree` 指派，任務完成、卡片變 `done`。
4. **第一次真實 push：** `card pr <id>`，預期回覆含完整 PR 網址；到 GitHub 確認 PR 標題是卡片標題、內文**沒有**卡片描述；`card show` 看到 `PR` 與 `pr_opened`。
5. **CI 回報：** 約 1–2 分鐘內原 thread 收到 CI 通過（或失敗）的通知，卡片多一筆 `ci_result`；再等幾分鐘不重複通知。
6. **重複執行：** 再下一次 `card pr <id>`：應回報已有 PR、沒有新開。
7. **收尾（由你操作）：** 在 GitHub 關閉這個 PR（不 merge）並刪除遠端分支 `card/<id>`；確認 bridge 通知「已關閉」；`card cleanup <id>` 清理 worktree。
8. 已知限制：用你現有的 `gh`／ssh 登入（PR 顯示是你開的）；只支援本機與 github.com；merge 後自動清理與 `merged` 事件尚未做（E11）；`gh` 需要已登入。

下一步：使用者驗收後改為「已驗收」；E11（merge 後清理）、E13，以及 ISSUE-061 診斷。

### live 驗收紀錄

**2026-11-03 live 驗收：主要路徑通過（bridge 第一次對外 push）。** 環境：本機 macOS，main `b8e1445`（PR #42），`scripts/run.sh -r` 重啟 bridge；目標 repo 是公開的 `jon888465/Herdr_Discord_Bridge` 本身；政策檔（使用者授權 Agent 建立）已把 `local:Herdr_Discord_Bridge` 設為 L1。使用者在 Discord 指派並明確同意「push、commit 作者保留」後，Agent 在 bridge console 執行 `card pr`；其餘由 Agent 用 `git`、`gh`、卡片檔與索引核對。

- **拒絕路徑（不碰網路）：** 對沒有 worktree 的卡片 `card pr` → 「沒有 worktree（用 `card assign … --worktree` 建立），沒有分支可以 push」，沒有任何 push。（註：worktree 檢查在主程式先於「卡片非 done」檢查，所以這一步只驗到前者。）
- **準備：** 驗收卡片 `REQ-20261103-pr-accept`（要求 Agent 在 `docs/` 新增 `pr-accept-note.md` 一行並自己 `git commit`、不要 push）以 `--worktree` 指派；任務完成、卡片 `done`。Agent 實測核對 worktree：`git log` 基準..HEAD 只有 `f3e1252 docs: card pr 驗收用`、`git show --stat` 只動 `docs/pr-accept-note.md`、`git status --short` 無輸出；`git ls-remote` 顯示遠端當時沒有任何 `card/*` 分支。
- **第一次真實 push 與開 PR（使用者同意後）：** `card pr REQ-20261103-pr-accept` →「已開 PR #43」，完整網址 `https://github.com/jon888465/Herdr_Discord_Bridge/pull/43`，分支已 push（head `f3e1252965cd`）、目標 `main`。GitHub 核對（`gh pr view`）：標題「card pr 驗收（文件）」、狀態 OPEN、base `main`、作者 `jon888465`、只改 `docs/pr-accept-note.md`（+1/-0）；**內文只有**卡片 id、分支、基準、head、task id 與政策等級，**沒有卡片描述**；`git ls-remote` 遠端 `card/*` 只有這一個分支。
- **卡片與索引：** `## 異動專案` 有 `PR` 網址與 `head`；流程紀錄 `pr_opened`（`pr-43-opened`）；`card-prs.json` 有該 PR 與來源 thread。
- **CI 回報：** GitHub 上兩個平台的 CI 通過；約 1 分鐘後輪詢寫入卡片 `ci_result`（`CI success …/actions/runs/41586013177/job/125751548146`，事件 id `ci-43-f3e1252965cd`，05:49:12Z），索引 `ciReportedSha` 設為該 head；bridge console 沒有出現 PR 通知失敗訊息。
- **重複執行：** 再下 `card pr` →「這個分支已有 PR #43 … 沒有另外開新的 PR」；GitHub 上該分支只有 #43；卡片仍各只有 1 筆 `pr_opened`、`ci_result`。
- **PR 關閉（使用者操作）：** 使用者在 GitHub 關閉 PR #43（不 merge）並刪除遠端分支；使用者貼上 bridge 在原 thread 發出的通知「PR #43 已關閉、沒有 merge（卡片 REQ-20261103-pr-accept）：<網址>」；索引 PR 狀態 `CLOSED`（`endedAt` 05:51:11Z）。
- **清理：** 確認 PR `CLOSED`、遠端無 `card/*`、worktree 乾淨後，`card cleanup` 移除 worktree（workspace `w16` 關閉）；使用者授權後 Agent 刪除本機分支（`git branch -D card/REQ-20261103-pr-accept`，was `f3e1252`）與兩張驗收卡（`pr-accept`、`pr-reject`）。政策檔依使用者決定**保留** `local:Herdr_Discord_Bridge: L1`。

未驗證：
- **失敗路徑只有自動化測試：** CI 失敗的通知與 `ci_result`、push 被拒（遠端歷史不同）、開 PR 失敗、「卡片非 done」「政策 L0」「origin 非 github.com」「有未提交修改」的實機拒絕。
- Discord 端 CI 通過通知的原文（使用者只貼了「已關閉」通知；console 沒有失敗訊息作為間接證據）。
- PR 被 **merge** 時的通知與輪詢停止（這次只驗了關閉）；`merged` 事件與 merge 後自動清理（E11）尚未實作。
- 通知送不出去（thread 被刪、權限）的情況。
- 已知限制不變：用使用者現有的 `gh`／ssh 登入，PR 顯示是使用者開的；commit 作者是本機 git 設定（`c <jon@cdexunijiqi.local>`，使用者決定保留，會公開在 GitHub 上）；只支援本機與 github.com。
- 與先前政策檔提醒一致：政策檔保留 L1 表示這個 repo 的任何 `done` 卡片現在都能用 `card pr` 開 PR。

下一步：E11（merge 後清理，需偵測 merge 方式以寫 `merged` 事件）、E13（只關 bridge 自己開的來源 workspace）、ISSUE-061 診斷；L2 用現有登入（使用者 2026-11-03 選 A，見需求卡「L2 的身分選擇」；獨立身分 G2 不是前提）。

## ISSUE-065：PR 被 merge 後記 `merged` 並自動清理 worktree（E11）

更新日期：2026-11-03。狀態：已驗收（主要路徑：真實 PR 被 merge 後記 `merged` 並自動清理；髒檢出保留、squash／rebase 推斷、清理失敗通知與 Discord 通知原文未取得證據，見「live 驗收紀錄」）。

來源：追蹤清單 E11（使用者 2026-11-03：「如果卡片有 merge 了那就應該清理」）。接在 ISSUE-064（`card pr`）之後，補上「PR 被 merge」這條 live 尚未驗證的路徑。

使用者可見行為：bridge 開出的 PR 被 merge 後（輪詢最多延遲約 60 秒），卡片寫入 `merged`、自動清理 worktree，並在原 thread 通知。見 SPEC「PR merge 後自動清理」。

現況補充（2026-11-09，ISSUE-129，已驗收）：以下保留 ISSUE-065 的原需求與實機證據；現行 merge cleanup 可關閉卡片記錄且通過 id／label 核對的 autopick Lead，其餘來源 workspace 保留。

預期行為：只有 merge 觸發（關閉不清理）；`merged` 事件含 merge commit 與推斷的方式（merge／squash／rebase）；清理永不強制、髒檢出保留並寫 `cleanup_pending`、分支與來源 workspace 保留；清理失敗只說明並提示手動 `card cleanup`；merge 方式取得失敗只回報問題。

根因／修正範圍：不適用（新功能）。新增 `mergeMethod`（`src/github.ts`）；`src/card-pr-sync.ts` 的 merge 處理與 `onMerged` 掛鉤；抽出 `src/card-cleanup.ts`（`card cleanup` 與自動清理共用的卡片記錄）；`src/main.ts` 的 `cleanupAfterMerge`。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/github.test.ts`（+2：三種 merge 方式的推斷、參數驗證）、`test/card-pr-sync.test.ts`（+5：`merged` 事件與方式、清理掛鉤的結果併入通知、掛鉤失敗不丟通知、方式取得失敗仍回報並結束追蹤、關閉不觸發）、`test/card-cleanup.test.ts`（3）；全套 815 項，814 通過、0 失敗、1 略過（原 805 項）；`lint` 通過。`card cleanup` 抽出共用函式後既有測試全數通過（回歸依據）。**`main.ts` 的 `cleanupAfterMerge` 沒有自動化測試**；所有 `gh` 都是假的。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：
1. 讓一張卡走完 `card assign --worktree` → `card pr`，由使用者在 GitHub **merge** 那個 PR（**這會讓 PR 內容進入目標分支**；驗收目標需要使用者決定，見下）。
2. 約 1 分鐘內：原 thread 收到「PR #N 已 merge（<方式>）…已自動清理 worktree」；`card show` 看到 `merged`、`cleanup_done`、`worktree 狀態：已清理（分支保留）`；worktree 與其 workspace 已移除、本機分支仍在。
3. merge 方式推斷：用「merge commit」與「squash」各驗一次（rebase 若要驗再議）。
4. 髒檢出：merge 前先在 worktree 放一個未追蹤檔，確認被保留、卡片顯示「保留（有未提交修改）」、通知說明。
5. 已知限制：merge 方式是推斷；清理失敗不自動重試；不更新本機 `main`、不刪分支；通知送不出去時不重送。

**驗收目標（使用者 2026-11-03 選定）：用 Herdr_Discord_Bridge 本身。** merge 會真的把變更帶進 `main`：驗收用的文件（例如 `docs/pr-accept-note.md`）會進入 `main` 與其 git 歷史，**之後要再開一個 PR 把它移除**（歷史裡仍會留下這兩次提交）。Agent 先前建議較乾淨的做法是私人 scratch repo，使用者選了前者。**merge 由使用者在 GitHub 網頁上按**，Agent 不會替使用者 merge。

下一步：本 PR merge 並重啟 bridge 後，依上述步驟驗收；驗收後開一個 PR 移除驗收用文件；全部完成後改為「已驗收」。

### live 驗收紀錄

**2026-11-03 live 驗收：主要路徑通過（第一次有真實的 PR 被 merge）。** 環境：本機 macOS，main `ffa1e47`（PR #46），`scripts/run.sh -r` 重啟 bridge；目標 repo 是 Herdr_Discord_Bridge 本身（使用者選定）；政策 L1。驗收卡片 `REQ-20261103-merge-accept`（要求 Agent 在 `docs/` 新增 `merge-accept-note.md` 一行並自己 `git commit`）。使用者在 Discord 指派、明確同意 push（含 commit 作者保留），Agent 在 bridge console 執行 `card pr`，使用者在 GitHub 用 **merge commit** 按 merge；其餘由 Agent 用 `git`、`gh`、卡片檔、索引與 Herdr 核對。

- **push 與 PR（使用者同意後）：** `card pr` → PR #47，https://github.com/jon888465/Herdr_Discord_Bridge/pull/47；GitHub 核對：標題「merge 後清理驗收（文件）」、base `main`、只改 `docs/merge-accept-note.md`（+1/-0）、head `b97829e93c67`；內文只有卡片 id、分支、基準、head、task id 與政策等級（無卡片描述）；遠端 `card/*` 只有這一個分支。CI 通過（06:53:04Z 寫入卡片 `ci_result`）。
- **merge 與自動清理：** 使用者於 06:53:10Z merge（merge commit `a28a7f5aa5a3`）。bridge 在約 53 秒後（06:54:03Z）處理：索引 PR #47 `MERGED`（`endedAt` 06:54:03Z）；卡片流程紀錄 `merged：已合併 a28a7f5aa5a3（merge）`（事件 id `pr-47-merged`，**方式推斷為 `merge`，與 GitHub 的 `Merge pull request #47 …` 一致**）與 `06:54:04Z cleanup_done：清理完成：removed`（事件 id `w1A-cleanup-removed`）；卡片 `worktree 狀態` 變「已清理（分支保留）」（只有一行、就地更新）；worktree 與 workspace `w1A` 已移除（Herdr 回到 w1–w5，`git worktree list` 只剩主檢出）；本機分支 `card/REQ-20261103-merge-accept` 保留。**沒有任何手動清理，全部由 bridge 自動完成。**
- **收尾：** `docs/merge-accept-note.md` 已隨本 PR 從 `main` 移除（`git` 歷史仍保留這兩次提交）；本機分支 `card/REQ-20261103-merge-accept` 與驗收卡片仍在，待使用者處理。

未驗證：
- **Discord 通知原文：** 使用者尚未貼上「PR #47 已 merge（merge）…已自動清理 worktree」通知；只有索引與卡片狀態的間接證據。
- squash 與 rebase 的推斷（只有自動化測試）；merge 前 worktree 有未提交修改而被保留的實機路徑；清理失敗（例如 Herdr 連不上）的通知。
- 已知限制不變：merge 方式是推斷；清理失敗不自動重試；不更新本機 `main`、不刪分支；通知送不出去不重送。


## ISSUE-066：剛啟動、還沒有 session 的 Agent 被誤判為「Agent identity changed」，且 `team cancel` 無法收尾

更新日期：2026-11-03。狀態：已驗收（使用者 2026-11-03 選定標已驗收；`working` 分支僅有單元測試、未實機驗證，見「驗收證據」）。

來源：ISSUE-065 的 live 驗收途中發現，不是 E11 的缺陷。

使用者可見症狀：`card assign … --worktree` 在新 workspace 啟動 `agy`（Antigravity CLI）當 Lead；之後再 `card assign` 時，任務在 8 秒後變 `blocked`，訊息「Agent identity changed while waiting for w17:p1」。但 w17 的 pane 顯示 `agy` 其實已正確回覆規劃階段的結果（`{"assignments": []}`）。接著 `team cancel` 讓任務停在 `cancelling`：「Recovery: unknown · Unsettled dispatch; inspect before cancelling. No automatic replay.」「w17:p1: session identity unknown; no signal sent」，任務永遠無法進入 `cancelled`，並可能佔著該 Agent 的保留。

預期行為：一個剛啟動的 Agent（處理第一個 prompt 之前沒有 session）接第一個任務時不應被判為「身份改變」；`team cancel` 在能夠確認 pane 仍是同一個 Agent 時應能收尾。

重現方式／環境（2026-11-03，本機 macOS，main `ffa1e47`，Herdr 0.9.1）：用 `agy` 當 thread 的 active Agent，`card assign <id> --worktree` 建立 worktree 與 `agy`；等 `agy` 閒置後（此時 Herdr 尚未登記它的 session）`card assign <id>`。任務 `task-efb29d5c-3597-469a-8769-172f805a57de`：journal `task_started` → `turn_dispatched`（06:30:43Z）→ `task_failed`（06:30:51Z），任務 `lead.agent_session` 為 `null`；事後 `herdr agent list` 顯示該 Agent 的 session 是 `0dec81d7-19b3-4b4a-ae0d-7f7cec0cac36`（`herdr:antigravity_cli`）。先前用 `claude` 的所有驗收都沒有發生（claude 一啟動就有 session）。

根因（**已確認**）：`src/team-turn.ts` 在等 Agent 回應時比對 pane、terminal、workspace、Agent 種類與 session；session 用 `sameAgentSession(left, right)`（`src/response-stream.ts`），其第一行 `if (left == null || right == null) return left == null && right == null;`——派工時 session 是 `null`、回應時變成有值，就回傳 `false`，被判為身份改變。`team cancel` 因為任務記錄的 session 是 `null`、現在的 Agent 有 session，永遠無法確認身份而拒絕送 Ctrl-C。

修正範圍（2026-11-03，使用者選定兩個決定：等待時「第一次出現」、cancel「pane 身份相符且 idle／done 就收尾」）：
1. `src/team-turn.ts`：等待回應的迴圈改為記住「預期的 session」；派工時 Agent **完全沒有 session**、而目前這筆回應有可辨識的 session，且 pane／terminal／workspace／Agent 種類都沒變時，採用並記住第一次看到的 session；之後換成別的值或消失仍丟「Agent identity changed」。派工時就有 session 的 Agent 規則不變。新增 `hasAgentSession`（`src/response-stream.ts`）。
2. `src/team-task-engine.ts` 的 `cancel`：任務記錄的 turn session 是空的，而 pane／terminal／workspace／Agent 種類都相符且目前 `idle`／`done` → **不送任何訊號**直接收尾並釋放保留；`working`／`blocked` 且身份不明、或其他欄位不符，仍照舊拒絕送訊號並保留 `cancelling`。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：新增 `test/team-turn.test.ts`（6 項：派工時沒有 session 可在回應中第一次出現、到結束仍沒有也可、第一次出現後換成別的 session 或消失都算身份改變、派工時有 session 就必須完全一致、pane／terminal／workspace／種類不符一律拒絕）與 `test/team-task-engine.test.ts` 的取消測試（4 項：idle／done 且記錄的 session 為空會收尾且不送訊號、working 仍拒絕送訊號、terminal 或 Agent 種類不符不收尾、記錄的 session 已知時舊規則不變）。修正前「第一次出現」與「idle 收尾」兩項測試為紅、修正後為綠。全套 831 項，830 通過、0 失敗、1 略過（原 821 項）；`lint` 通過。**沒有**對真實 Herdr 的測試。

未驗證（待使用者，需先 merge 並重啟 bridge）：用 `agy` 當 Lead 做一次 `card assign --worktree` 與指派，確認不再被判為身份改變；對剛啟動的 `agy` 在任務中 `team cancel` 能收尾；其他種類的 Agent（codex 等）是否有相同的「第一個任務前沒有 session」行為；Worker 路徑（同樣經過 `runTeamTurn`，已涵蓋但未實機驗證）。殘留的孤兒任務 `task-efb29d5c-…`（`cancelling`）：它的 pane 已不存在，現在的 cancel 規則會以「original session absent」收尾，但 `team cancel` 需要選到該任務所屬的 workspace，w17 已不存在，**可能無法從 console 或 Discord 觸及**，仍留在使用者的任務 journal。

已知限制：「第一次出現」的放寬只看 pane／terminal／workspace／種類沒變，**無法分辨「同一個 Agent 第一次登記 session」與「在這之間被換成另一個同種 Agent」**（兩者的 terminal 通常也會不同，但這是依 Herdr 欄位的假設）；對 working／blocked 且身份不明的 Agent，`team cancel` 仍不會送訊號，任務會停在 `cancelling`。

驗收證據（2026-11-03，本機 macOS，main `5d389c7` 載入修正後的 bridge，Herdr 0.9.1，`agy` 當 Lead，worktree workspace w1D）：
- A：`card assign REQ-20261103-agy-accept --worktree` 後再指派，任務正常完成，沒有出現「Agent identity changed」。
- B：任務 `task-fa640c3e-50ed-4f6f-b13d-6ab9e9033e20`：journal `turn_dispatched`（07:39:28Z，`agent_session` 為 `null`）→ `cancel_requested`（07:40:32.368Z，session 仍為 `null`、狀態 `idle`）→ `cancel_turn_settled`（07:40:32.922Z）→ `task_cancelled`，沒有停在 `cancelling`；Discord 回覆「All task turns settled; no CLI session was closed.」。規劃階段回應也沒有被誤判為身份改變。這走的是「記錄的 session 為空、pane 身份相符、idle／done → 不送訊號收尾」分支。
- **未實機驗證：** 取消當下 `agy` 在 Herdr 裡是 `idle`（沒有被標成 `working`，原因不明），所以「`working`／`blocked` 且身份不明 → 拒絕送訊號、保持 `cancelling`」只有單元測試覆蓋。其他種類 Agent（codex 等）與 Worker 路徑也未實機驗證。

下一步：無（上述未驗證項目若日後出現，再另開 issue 或重新開啟）。


## ISSUE-067：`--worktree` 偶發失敗：`agent.start: agent_pane_busy … is not an available shell`

更新日期：2026-11-03。狀態：已修正、待驗收（**根因仍是推測**；原始碼與自動化測試完成，執行中的 bridge 尚未載入修正，因為是偶發競爭，**無法穩定重現，只能靠之後是否再出現來觀察**）。

來源：ISSUE-065 的 live 驗收途中，使用者貼 Discord 截圖發現（Agent 已讀取）。

使用者可見症狀：`card assign REQ-20261103-merge-accept --worktree` 回覆「❌ worktree 已建立（workspace w19，…）但 Agent 沒有啟動：herdr agent.start: agent_pane_busy agent target pane w19:p1 is not an available shell。任務沒有啟動；可 `card cleanup REQ-20261103-merge-accept` 清掉」。重下一次就成功。

預期行為：新建的 worktree workspace 的 shell 稍晚才就緒時，bridge 應稍等或重試，不因一次 `agent_pane_busy` 就放棄。

重現方式／環境（2026-11-03，本機 macOS，Herdr 0.9.1）：偶發，不是每次。先前三次 `--worktree`（claude）都成功；這次失敗後立刻查 `w19:p1`，已是正常的 zsh 提示（`jon@cdexunijiqi card-req-… %`），Agent 欄位為 null。同一輪使用者還有一次 `w18` 的嘗試（建立後約 22 秒被 `card cleanup`），結果未知。重下後成功（`w1A`，`worktree_created` 與 `started` 相差 1 秒）。

根因（**推測，未確認**）：`createWorktree` 一回傳 `root_pane`，`prepareCardWorktree` 就立刻呼叫 `agent.start`；此時 pane 裡的 shell 可能還在初始化，Herdr 回報 `agent_pane_busy`。證據：錯誤訊息文字、事後 pane 已就緒、偶發。`startAgentInPane`（`src/main.ts`）對 `agent.start` 沒有任何重試。Herdr 沒有（我查得到的）保證 pane 一建好就能用的文件。

修正範圍（2026-11-03）：把 `startAgentInPane` 從 `src/main.ts` 抽到新模組 `src/agent-start.ts`（依賴注入，時鐘可替換）：`agent.start` 遇到 **`agent_pane_busy`** 時每 0.5 秒重試、最多約 15 秒，逾時才拋出原本的錯誤；**其他任何錯誤（`agent_start_failed`、`unsupported_agent_kind`、socket 錯誤等）仍立刻失敗、不重試**；啟動成功後等 Agent 被偵測到的輪詢（最多 30 秒）行為不變。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：新增 `test/agent-start.test.ts`（6 項，用假 port 與假時鐘，不會真的等：shell 就緒時只啟動一次且參數不變、先忙兩次再成功（兩次 500 ms 間隔）、一直忙會在重試視窗後以原本錯誤失敗且嘗試次數有上限、其他錯誤不重試、啟動後等偵測與逾時回傳最後紀錄、一直看不到 Agent 的錯誤）。變異測試：移除重試會讓兩項重試測試失敗。全套 821 項，820 通過、0 失敗、1 略過（原 815 項）；`lint` 通過。**沒有**對真實 Herdr 的測試，`main.ts` 接線沒有自動化測試。

未驗證（待使用者，需先 merge 並用 `scripts/run.sh -r` 重啟 bridge）：之後的 `card assign --worktree` 不再因 `agent_pane_busy` 失敗（偶發，只能累積觀察；若再出現同樣的錯誤，表示重試視窗不夠或根因不是 shell 初始化）；其他 Herdr 錯誤碼是否也需要重試。

下一步：觀察；若根因被證實不是 shell 初始化，重新開啟本 issue。


## ISSUE-069：`card assign --worktree` 的新 Agent 在 console 上變成「selected Agent session changed」，選取失效

更新日期：2026-11-03。狀態：已驗收（console 路徑，agy；Discord thread 路由未測，見「驗收證據」）。**標題與症狀在調查後修正**：原先登記為「路由 `active:null`」，那是 console 的設計（console 路由只記 workspace，選取的 Agent 存在 workspace 層），不是缺陷。

來源：ISSUE-066 的 live 驗收。

使用者可見症狀：`agy`／`claude` 在新 worktree 第一次啟動會問「是否信任此資料夾」，bridge 不會自動確認，Agent 停在提示（blocked）。bridge 回報 Agent 未就緒後，該 thread 的路由 `routing.json` 的 `active` 為 `null`；使用者按信任後 Agent 進入但沒有事做，也無法直接 `card assign` 該任務，需要再 `use <pane>`。

預期行為：回覆要明確告訴使用者「按信任後請 `use <pane>`」，或在 Agent 未就緒時保留／還原原本的路由。

調查結果（2026-11-03）：`prepareCardWorktree` 無論 Agent 是否就緒都會切換路由（程式與回覆文字皆如此），所以「Agent 未就緒就不切路由」的推測**不成立**。2026-11-03 在 console 實測 `use w1E:p1` 後再 `card assign`，console 出現「⚠️ Console Agent: selected Agent session changed; use agent use <pane> again」。

根因（**已確認**）：`src/console-agent.ts` 的 `target()` 用 `sameIdentity(pinned, live)` 比對，其中 session 用 `sameAgentSession`；剛啟動的 `agy` 選取當時沒有 session，處理完第一個 prompt 後 Herdr 才登記，`null → 有值` 被判為替換，console 就丟出這個錯誤並要求重新 `use`。與 ISSUE-066 同一類（那次在 team-turn）。

修正範圍（2026-11-03）：`target()` 在選取當時沒有 session、現在有、且 pane／workspace／terminal／種類都沒變時，接受並記住第一次出現的 session；之後換成別的值或消失、或其他欄位改變，仍丟「session changed」。Discord 單 Agent 回覆觀察（`main.ts` 的 response capture）不在範圍內，規則不變。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/local-agent.test.ts` 新增 3 項（沒有 session 的 Agent 第一次出現 session 可繼續傳送；adopt 後換成別的 session 或消失仍拒絕；第一次出現 session 同時 terminal 被換掉仍拒絕）。修正前第一項為紅、修正後為綠。全套 836 項，835 通過、0 失敗、1 略過（原 833 項）；`lint` 通過。**沒有**對真實 Herdr 的測試。

驗收證據（2026-11-03，本機 macOS，bridge 載入 main `d7c292f`，Herdr 0.9.1，`agy`，worktree workspace w1F；由 Agent 在 bridge console 操作，信任提示經使用者同意後由 Agent 對 `w1F:p1` 送 Enter）：`use w1:p8` → `card assign REQ-20261103-console-accept --worktree` → 信任提示 → `use w1F:p1` → `card assign`，任務 `task-eaea033f-f278-49b9-969b-c1db052e3704` 完成；整段 console 輸出沒有「Console Agent: selected Agent session changed」（唯一含該字樣的是 `agy` 回覆引用卡片文字的那一行）。事後 `herdr agent list` 該 pane 的 session 為 `7cf72cb0-ec35-4544-9801-dba0c0942576`，確認選取當時沒有 session、之後才登記。上次（修正前）同樣流程會在「Team Task accepted」後出現該警告。

未驗證：Discord thread 路由（本次只驗 console）；其他種類 Agent；信任提示本身 bridge 仍不會替你確認（設計如此）。限制同 ISSUE-066：無法分辨「同一 Agent 第一次登記 session」與「期間被換成同種 Agent」。

下一步：無。

## ISSUE-070：`card cleanup` 在卡片的任務仍在執行時仍會移除 worktree

更新日期：2026-11-03。狀態：已驗收（見「驗收證據」；`cancelling` 等其他非終態只有單元測試）。

來源：ISSUE-066 的 live 驗收：上一輪 B 步驟在 `agy` 還在跑任務時下了 `card cleanup`，worktree 與 `agy` 的 pane 一起被移除，無法驗證取消分支。

預期行為：卡片關聯的任務還沒到終態（running／cancelling 等）時，`card cleanup` 應拒絕並說明，直到任務完成或取消。

根因（已確認）：`cleanupCard`（`src/card-command.ts`）只檢查 worktree 本身（未提交修改、branch 等），不查卡片的 task 狀態。

修正範圍（2026-11-03）：`src/card-command.ts` 的 `cleanupCard` 先用 `assignments.forCard` 取卡片最新任務、`taskInfo` 查狀態；狀態不是 `completed`／`failed`／`cancelled`／`blocked` 就丟錯，說明任務 id 與狀態，並提示等它完成或先 `team cancel` 後再清理，**不呼叫** `cleanupWorktree`。`blocked`（在等人處理）刻意放行，避免永遠無法清理；卡片沒有指派過任務、或任務紀錄已不存在時不擋。PR merge 後的自動清理直接走 `cleanupCardWorktree`，不經過這個檢查（merge 代表工作已結束）。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/card-command.test.ts` 新增 2 項（`planning`／`running`／`synthesizing`／`cancelling` 都拒絕且不碰 worktree，且以最新任務為準；`completed`／`failed`／`cancelled`／`blocked` 可清理）。修正前拒絕那項為紅、修正後為綠。全套 833 項，832 通過、0 失敗、1 略過（原 831 項）；`lint` 通過。**沒有**對真實 Herdr 的測試。

驗收證據（2026-11-03，本機 macOS，bridge 載入 main `085d785`，Herdr 0.9.1，`agy` 當 Lead，worktree workspace w1E；由 Agent 在 bridge console 操作）：`card assign REQ-20261103-cleanup-accept --worktree` 後再 `card assign`，任務 `task-814cc300-e5c6-4bb2-9c9b-c21f1c7ab78b` 在 `planning` 時下 `card cleanup`，回覆「任務 task-814cc300-…（planning）尚未結束，不清理 worktree；請等它完成，或先 `team cancel …`」，worktree 未被移除；任務完成（`agy` 回報「sleep 完成」，卡片同步為 `done`）後再下 `card cleanup`，worktree 移除，流程紀錄有 `cleanup_done`。

未實機驗證：`synthesizing`／`cancelling` 等其他非終態只有單元測試；`blocked` 放行的路徑只有單元測試。限制：只看最新一個任務；`blocked` 任務清理後 Agent 的 pane 會被移除。

附帶觀察（未調查、未另立 issue）：驗收時 `use <新 pane>` 後 console 出現「selected Agent session changed; use agent use <pane> again」警告，與 ISSUE-066 修正的 team-turn 路徑不同。

下一步：無。


## ISSUE-068：`card pr` 的 PR 內文列出卡住的舊 task id

更新日期：2026-11-03。狀態：已修正、待驗收（原始碼與自動化測試完成；執行中的 bridge 尚未載入修正，尚未 live 驗收）。

來源：ISSUE-065 的 live 驗收，核對公開 PR #47 內文時發現。

使用者可見症狀：PR #47 內文的 task 欄列了兩個 task id，其中 `task-efb29d5c-…` 是因 ISSUE-066 而卡住（`cancelling`）的舊任務，新任務才是真正完成這張卡的。

預期行為：使用者 2026-11-03 決定——PR 內文只列最新的 task；先前失敗或卡住的嘗試留在卡片的流程紀錄供稽核。

根因（已確認）：`src/card-pr-flow.ts` 的 `prBody` 取卡片 `tasks` 的前 3 個；卡片的 `tasks` 保留所有指派過的 task（包含失敗、卡住的）。

風險評估：task id 只是一個隨機 id，不含機敏內容；但它把一個「卡住的內部任務」暴露在公開 PR 內文，沒有實質價值。

修正範圍（2026-11-03）：`src/card-pr-flow.ts` 的 `prBody` 由 `slice(0, 3)` 改為 `slice(-1)`，只列卡片 `tasks`（依指派順序附加）的最後一個；沒有 task 時不輸出 task 行。已開出的 PR #47 內文不會被改（不回頭編輯）。

測試（2026-11-03，本機 macOS、Node v26.12.0，非 CI）：`test/card-pr-flow.test.ts` 新增／修改 3 項（只列最新 task 且不含先前的；沒有 task 時沒有 task 行；既有內文測試改為斷言只含最新 task）。修正前前兩項為紅（既有測試與新增的「只列最新」）、修正後為綠。全套 838 項，837 通過、0 失敗、1 略過（原 836 項）；`lint` 通過。**沒有**對真實 GitHub 的測試。

未驗證（待使用者，需先 merge 並重啟 bridge）：下一次真實 `card pr` 開出的 PR 內文只有最新 task id。

下一步：使用者驗收後改為「已驗收」。


## ISSUE-071：`card pr` 回覆 PR 動到的敏感路徑（F6 階段 1）

更新日期：2026-11-04。狀態：已驗收（核心路徑；改名原路徑、降級路徑未實機驗證，見「驗收證據」）。這是新功能的第一階段，不是缺陷。

來源：使用者 2026-11-04 決定「敏感路徑一律不自動 merge」（追蹤清單 F6）並同意清單；實作順序的階段 1。

使用者可見行為：`card pr <id>` 開出 PR 或對既有 PR 推新 commit 後，回覆多一行警告「⚠️ 這個 PR 動到敏感路徑：…」，列出命中的檔案；查不到時回報「⚠️ 無法確認這個 PR 動到哪些檔案」。沒有命中就不多說。**目前只是提醒，不阻擋任何事，也還沒有自動 merge。**

預期行為：PR 動到 `.github/`、`AGENTS.md`、`package.json`、`scripts/`、`SPEC.md`、`src/policy.ts`、`src/github.ts`、`src/sensitive-paths.ts` 時，使用者能在開 PR 當下就看到；將來 L2 對這類 PR 一律退回人工。

實作範圍（2026-11-04）：新增 `src/sensitive-paths.ts`（清單與 `sensitivePathsIn`，清單檔自己在清單內）；`src/github.ts` 新增 `pullRequestFiles`（`gh api --paginate …/pulls/<n>/files`，含改名的原路徑，3000 筆上限視為不完整）；`src/card-pr-flow.ts` 在 PR 存在後呼叫（失敗或不完整回傳 null，不讓 `card pr` 失敗）、`PrOutcome` 新增 `sensitivePaths: string[] | null`；`src/card-command.ts` 的回覆加警告。順手修正 `src/github.ts` 檔頭過時的註解（「L2 前必須改成獨立身分」，實際決定是 L1 與 L2 都用現有登入）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/sensitive-paths.test.ts`（8 項：一般檔案不命中、每個受保護路徑與清單檔自己命中、不分大小寫與開頭 `./`、只認根目錄 `package.json` 與精確檔案不誤判相似名稱、`..` 視為敏感、去重保序、空清單）、`test/github.test.ts` 3 項（含改名原路徑、3000 筆上限、驗證編號與 gh 失敗）、`test/card-pr-flow.test.ts` 5 項（命中、沒命中、查不到為 null 且 PR 仍記錄、不完整為 null、既有 PR 推新 commit 也重查）、`test/card-command.test.ts` 4 項（警告列出路徑並說明目前不阻擋、沒命中不提、無法確認、既有 PR 也顯示）。以空桩先跑：會命中、會列出、查不到為 null 等 15 項為紅（`test/sensitive-paths.test.ts` 5 項、`test/github.test.ts` 3 項、`test/card-pr-flow.test.ts` 4 項與 `test/card-command.test.ts` 3 項），「不命中」類本來就通過；實作後全綠。全套 860 項，859 通過、0 失敗、1 略過（原 840 項）；`lint` 通過。**沒有**對真實 GitHub 的測試。

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `f883956`，Herdr 0.9.1，`agy`，政策 L1；由 Agent 在 bridge console 操作，使用者明確同意信任提示、push 與開測試 PR）：驗收卡 `REQ-20261104-sens-accept`（`--worktree`，worktree `w1H`）讓 agy 在分支上做一個 commit（`594c24c`，只動 `SPEC.md` 與 `docs/tmp-sensitive-accept.md`），卡片 `done` 後 `card pr`，開出測試 PR #62（https://github.com/jon888465/Herdr_Discord_Bridge/pull/62）。回覆含「⚠️ 這個 PR 動到敏感路徑：SPEC.md」，**沒有**列出 `docs/tmp-sensitive-accept.md`。另以同一條 `gh api --paginate repos/jon888465/Herdr_Discord_Bridge/pulls/62/files --jq '.[] | .filename, (.previous_filename // empty)'` 直接核對，真實輸出為 `SPEC.md`、`docs/tmp-sensitive-accept.md` 兩行，`--jq` 格式正確。PR 內文只有卡片 id、分支、基準、head、task id 與政策等級 L1，沒有描述與驗收條件。

收尾（使用者同意）：PR #62 以 `gh pr close` 關閉（沒有 merge）；`gh` 的 token 無法刪遠端分支（HTTP 403），改用 `git push origin --delete card/REQ-20261104-sens-accept`（單一分支、非強制）刪除；清掉 worktree、本機分支與驗收卡，路由切回 `w1`。順帶觀察：PR 被關閉時 bridge 在 console 回報「PR #62 已關閉、沒有 merge」（ISSUE-064 的關閉通知路徑）。

未實機驗證：改名檔案的原路徑（`previous_filename`）是否出現（這個 PR 沒有改名）；查不到與到 3000 筆上限的降級路徑（只有單元測試）；Discord thread 的顯示（本次在 console）。遠端還留有 `card/REQ-20261103-merge-accept`（PR #47 時留下，非本次產生，未動）。

限制：只認路徑，不看內容；檢查發生在開 PR／推 commit 當下，之後 PR 被改動不會重查，**將來 merge 前必須再查一次**；清單由使用者要求調整、經人工 merge（它本身在清單內，所以修改它的 PR 會被標為敏感）。

下一步：無；階段 2（卡片 findings 欄位，F8）。


## ISSUE-072：`card assign --worktree` 的 agent 名稱超過 Herdr 的 32 字元上限，卡片 id 較長時失敗

更新日期：2026-11-04。狀態：已驗收（agy；worktree 目錄名與分支名的長度限制未另外驗證，見「驗收證據」）。

來源：ISSUE-071 的 live 驗收途中發現，不是 ISSUE-071 的缺陷。

使用者可見症狀：`card assign REQ-20261104-sensitive-accept --worktree` 回覆「❌ worktree 已建立（workspace w1G，…）但 Agent 沒有啟動：herdr agent.start: invalid_agent_name agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)。任務沒有啟動；可 `card cleanup …` 清掉」。

預期行為：不論卡片 id 多長，worktree 的 Agent 都能啟動。

重現方式／環境（2026-11-04，本機 macOS，main `f883956`，Herdr 0.9.1）：卡片 id `REQ-20261104-sensitive-accept` 會組成名稱 `card-req-20261104-sensitive-accept`（34 字元）。換成較短的 `REQ-20261104-sens-accept`（名稱 29 字元）就成功。先前驗收用的卡片 id 剛好都夠短（最長約 28 字元的名稱），所以沒踩到。**約略的界線：** `card-` 加小寫卡片 id 超過 32 字元就會失敗，也就是卡片 id 超過 27 字元。

根因（**已確認**）：`src/card-worktree-flow.ts` 以 `` `card-${cardId.toLowerCase()}`.slice(0, 40) `` 組 Agent 名稱，截斷上限用 40，但 Herdr 的 `agent.start` 只接受 1 到 32 字元。卡片 id 本身最長可到多長沒有在這裡限制。

修正範圍（2026-11-04，使用者同意：截斷到 32 字元，並附加 4 碼雜湊）：`src/card-worktree-flow.ts` 新增並匯出 `agentNameForCard(cardId)`：`card-<小寫 id>` 不超過 32 字元就維持原樣（既有名稱不變）；超過時截成 27 字元、去掉結尾的 `-`／`_`，再接 `-` 與 4 碼雜湊（`sha256(完整卡片 id)` 的前 4 個十六進位字元），總長最多 32 字元。同一個 id 永遠得到同一個名稱、前綴相同的長 id 名稱不同。目前失敗時 worktree 已建立、`card cleanup` 可清掉，不會留下壞狀態（本次實測確認），這一點沒有改變。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：`test/card-worktree-flow.test.ts` 新增 7 項（短 id 名稱不變、剛好 32 字元不截斷、長 id 截成 32 字元且符合 Herdr 的字元規則、最長的合法卡片 id 仍有效、前綴相同的長 id 名稱不同且同 id 名稱固定、截斷處是 `-` 時不出現 `--`、`prepareCardWorktree` 對長 id 送出符合規則的名稱）。先以舊行為（`slice(0, 40)`）跑，長 id、最長 id、`-` 結尾與 `prepareCardWorktree` 共 4 項為紅，其餘本來就通過；實作後全綠。全套 867 項，866 通過、0 失敗、1 略過（原 860 項）；`lint` 通過。**沒有**對真實 Herdr 的測試。

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `ef2df66`，Herdr 0.9.1，`agy`；由 Agent 在 bridge console 操作，使用者同意信任提示）：用先前失敗的卡片 id `REQ-20261104-sensitive-accept`（29 字元）`card assign … --worktree`，這次沒有 `invalid_agent_name`，worktree `w1J` 建立、agy 啟動；`herdr agent list` 顯示名稱 `card-req-20261104-sensitive-72fe`（32 字元，即截斷前綴加 4 碼雜湊 `72fe`）。接著 `use w1J:p1` 與 `card assign`，任務 `task-485ff5de-64f5-4229-bd6d-57c560af1c84` 完成（agy 回報 `sleep 5` 已執行、未改檔），console 沒有「Console Agent」警告（也間接再確認 ISSUE-069 的修正在長 id 下仍正常），worktree 乾淨。事後 `card cleanup`、刪本機分支與驗收卡、路由切回 `w1`。

未驗證：worktree 目錄名與分支名 `card/<id>` 在更長的 id（41 字元的 slug，卡片 id 的上限）下是否也被接受——本次 id 只有 29 字元，agent 名稱被截斷，但 worktree 與分支沒有遇到限制；最長 id 的情況只有單元測試（名稱有效、不超過 32 字元）。Claude Code 當 Lead 沒測。

下一步：無。


## ISSUE-073：卡片的 `## Review 發現` 段落（F8，階段 2）

更新日期：2026-11-04。狀態：已驗收（2026-11-04，隨 `card review` 的 live 驗收：真實 reviewer 的 findings 寫入卡片的 `## Review 發現`，`card show` 顯示各狀態數量與 open 的 finding；`fixed`／`resolved`／`dismissed` 狀態轉換、超過 10 筆的上限顯示、機敏摘要省略只有單元測試，沒有呼叫者會改狀態，見 ISSUE-080 的驗收證據）。

來源：使用者 2026-11-04 決定 review 閘的 findings 寫在卡片的新欄位、不貼 PR 留言，並同意設計（形式、狀態與嚴重度集合、200 字摘要加機敏整段省略、上限 100／30）。

使用者可見行為：`card show` 在卡片有 findings 時多一個區塊「── Review 發現（共 N 筆：open …、fixed …、resolved …、dismissed …）──」，列最多 10 筆 `open` 的 finding（編號、嚴重度、位置、摘要、第幾輪），超過時說明還有幾筆；內文的 `## Review 發現` 不再重複出現在「內容」區塊。**目前沒有任何程式會寫入 findings**（reviewer 派工與回覆解析屬 F5 的後續階段），要看到畫面只能手動在卡片檔寫入該段落。

預期行為與格式：見 ADR-0002 決定 12。重點：只收結構化欄位加一行最多 200 字的摘要（疑似機敏整段改成固定訊息）；狀態只能往前；同一輪同一範圍冪等；每卡 100 筆、每批 30 筆，超過整批拒絕、不輪替；不收程式碼片段與長篇說明。

實作範圍（2026-11-04）：新增 `src/card-findings.ts`（`recordFindingBatch`、`setFindingStatus`、`parseFindings`、`summarizeFindings`，純函式）；`src/card-store.ts` 新增 `recordFindings`、`setFindingStatus`（沿用 `mutate` 的雜湊比對與重試，內容沒變不重寫檔案）；`src/card-command.ts` 的 `card show` 加顯示並把該段落排除在「內容」之外。ADR-0002 新增決定 12 並補 bridge 區域表；SPEC、追蹤清單 F8 同步。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-findings.test.ts` 17 項（建立區塊與編號、區塊放在流程紀錄之前且其他內文不變、整體與單一 commit 範圍、編號跨批延續不重用、同批冪等、疑似機敏摘要整段省略、17 種不合格輸入整批拒絕、200 字邊界、總數上限、人加的行保留、狀態只能往前與終態、同狀態 no-op 與未知編號、解析、摘要統計、store 寫入與冪等不重寫、store 拒絕不動卡片）與 `test/card-command.test.ts` 3 項（`card show` 顯示統計與 open 清單且不在內容裡重複、超過 10 筆的上限與「還有 N 筆」、沒有 findings 就沒有區塊）。先以「未實作」的桩跑：`card-findings` 17 項、`card show` 2 項為紅（沒有 findings 的那項本來就通過）；實作後全綠。全套 887 項，886 通過、0 失敗、1 略過（原 867 項）；`lint` 通過。**沒有**對真實卡片檔與 bridge 的測試。

未驗證（待使用者，需先 merge 並重啟 bridge）：手動在一張卡片檔寫入符合格式的 `## Review 發現` 後，`card show` 的實際畫面（Discord 與 console）；`card show` 輸出是否再經機敏遮蔽（沿用既有行為，未針對 findings 另外確認）。

限制：沒有呼叫者；findings 摘要是 reviewer 的文字，是決定 9／11 的有界例外，機敏檢查是黑名單式、不完整；reviewer 輸出是不可信資料，之後回傳給作者 Agent 時必須放進資料區（本階段不處理）；人手動改壞格式的行會被解析略過。

下一步：使用者驗收後改為「已驗收」；階段 3（reviewer 派工與回覆解析，F5）。


## ISSUE-074：reviewer 的提示組裝與回覆解析（F5 階段 3a）

更新日期：2026-11-04。狀態：已修正、待驗收（這是新功能的第一步，不是缺陷；原始碼與自動化測試完成，**沒有任何呼叫者**，所以無法 live 驗收，要等 3d 的 `card review` 一起驗）。

來源：使用者 2026-11-04 決定開始 review 閘的階段 3，第一版：手動觸發、reviewer 由使用者指定 pane、diff 上限 20 個檔案與約 60 KB、唯讀靠提示約束加工作樹指紋檢查（不是作業系統層隔離）。3a 是其中的純函式部分。

行為（尚無使用者可見的入口）：`src/card-review.ts` 提供 `acceptanceCriteria`（讀 `## 驗收條件` 的條列）、`buildReviewPrompt`（組提示並檢查前提）、`parseReviewReply`（驗證並解析回覆）、`inconclusiveBatch`。細節見 SPEC「Review 提示與回覆解析」。

實作重點（2026-11-04）：提示只含卡片的標題、描述、驗收條件（先遮蔽再截斷）與 PR 的檔案清單、diff，放進帶分隔線的資料區、分隔字樣被改寫；沒有驗收條件、條件超過 20 條、檔案超過 20 個、diff 超過 60,000 字元或為空、路徑含無法記錄的字元，都拒絕並說明該怎麼做。回覆必須是單一 JSON 物件，欄位逐一驗證（沿用 `card-findings` 的驗證），任何不合格就整份拒絕；`pass` 有證據才成立，否則降級並回報原因。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-review.test.ts` 18 項（條列讀取與機敏條目、提示內容與資料區、不含決議與專案段落、唯讀與資料聲明、分隔字樣無法提早結束資料區、卡片文字遮蔽、8 種拒絕前提、乾淨 pass、json 區塊、finding 帶入、17 種不合格回覆、pass 降級四種、只有 low 的 pass、changes_requested 無 finding、inconclusive、機敏摘要與備註、`inconclusiveBatch`）。先以「未實作」的桩跑，18 項全紅；實作後全綠。全套 905 項，904 通過、0 失敗、1 略過（原 887 項）；`lint` 通過。**沒有**對真實 reviewer 的測試。

未驗證／尚未做：reviewer 真的能照提示回出合格的 JSON（要等 3d）；工作樹指紋檢查（唯讀的另一半，3c／3d）；3b 取得 PR diff 與檔案清單；3c 選 reviewer（獨立 session 檢查）；3d `card review` 指令與寫入卡片的 findings 與 `review_verdict`。**Agent 的取捨（使用者未明說，可調整）：** finding 的路徑必須在 PR 動到的檔案內，否則整份拒絕（防止憑空捏造路徑，但 reviewer 無法引用未改動的相關檔案）。

限制：reviewer 輸出是不可信資料，分隔線、遮蔽與嚴格解析只是降低風險；各條件的判定結果目前只回傳給呼叫者、沒有地方存進卡片（卡片只有 findings 與 `review_verdict`）；路徑含英數與 `._/@+-` 以外字元的 PR 目前無法 review。

下一步：3b（取得 PR 的 diff 與檔案清單，唯讀 `gh`，含大小上限）。


## ISSUE-075：取得 review 用的 PR 材料（F5 階段 3b）

更新日期：2026-11-04。狀態：已修正、待驗收（這是新功能的第二步，不是缺陷；原始碼、自動化測試與對真實 PR 的唯讀核對完成，**沒有任何呼叫者**，使用者可見的入口是 3d 的 `card review`）。

來源：使用者 2026-11-04 決定開始階段 3 並同意 3b 的做法：唯讀 `gh`、檔案數上限 20、diff 上限約 60 KB、超過就拒絕並要求 Lead 重新切分。

行為（尚無使用者可見的入口）：`fetchReviewMaterial` 回傳 `{ headSha, files, diff }`。保證：PR 開著；head 在讀取前後相同；diff 標頭的路徑與檔案清單完全一致；大小在上限內。任何一項不成立都丟 `GithubError("invalid", …)` 並說明原因與該怎麼做。細節見 SPEC「取得 review 用的 PR 材料」。`src/github.ts` 新增 `pullRequestDiff`（`gh pr diff <n> --repo <slug> --color=never`），並把檔頭的「只做哪些 gh 動作」註解更新。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-review-fetch.test.ts` 12 項（成功與讀取順序 view→files→diff→view、所有呼叫都只讀且針對同一個 PR、非開著的 PR、讀取期間 head 變動、檔案過多時在取 diff 之前就拒絕、diff 過大與 `maxBuffer`、空 diff 與無檔案、diff 與清單對不上並指出差異、改名新舊路徑、無法解析的標頭、gh 失敗、PR 編號驗證）與 `test/github.test.ts` 2 項（`pullRequestDiff` 的參數與錯誤）。先以桩跑：13 項為紅；另有一項我自己寫得太粗的「所有呼叫只讀」測試（把 `--json` 欄位裡的 `mergedAt` 當成 merge 指令）在實作後失敗，已改成檢查子指令與有無寫入旗標。全套 919 項，918 通過、0 失敗、1 略過（原 905 項）；`lint` 通過（一個測試標題含 any 字樣被 lint 擋下，已改標題）。

**對真實 PR 的唯讀核對（2026-11-04，只讀取、沒有寫入）：** 對 PR #64、#63、#52、#66、#67、#61、#58、#54、#47、#43 執行同樣的 `pullRequestFiles` 與 `pullRequestDiff` 並比對標頭，全部：清單完整、無法解析的標頭為 0、diff 與檔案清單完全一致、沒有 ANSI 顏色。這些 PR 的大小：最大是 #66（9 個檔案、44,479 字元），其餘都在 33,942 字元與 13 個檔案以內，**都在上限內**。所以現行上限對這個專案常見的 PR 夠用；若需求卡包含大量 ADR／SPEC 文字，可能逼近 60,000 字元。

未驗證：`fetchReviewMaterial` 本身沒有對真實開著的 PR 跑過（上面的核對是對已 merge 的 PR 直接呼叫底層函式，因為它只 review 開著的 PR）；含空白或引號的路徑、改名、二進位檔案在真實 `gh pr diff` 的輸出；超過 2 MiB 的真實 diff；單一 commit 範圍。

限制：只支援整個 PR 的 diff；標頭含引號的路徑無法解析而被拒絕。

下一步：3c（選 reviewer，含獨立 session 檢查）。


## ISSUE-076：reviewer 新 pane 的開啟與關閉（F5 階段 3c-1）

更新日期：2026-11-04。狀態：已驗收（2026-11-04，隨 ISSUE-078 的 live 驗收：`pane.split` 回傳含 `terminal_id`、新 pane 能啟動 codex、三輪 review 的 reviewer pane 都有被關閉；`pane.close` 對有 Agent 在跑的 pane 的行為由此驗到；關閉失敗的路徑與 terminal 被換掉的路徑只有單元測試）。

來源：使用者 2026-11-04 決定 review 與 coding 的 Agent 一律新開 pane、用完關閉，第一版先做本機（跨機器是 F9）。3c 拆成兩步：3c-1（這個 issue）是 pane 的生命週期與種類選擇；3c-2 是用它們串起來的 review 流程。

行為（尚無使用者可見的入口）：`src/review-pane.ts` 提供 `chooseReviewerKind`、`openReviewerPane`、`closeReviewerPane`。細節見 SPEC「reviewer 的新 pane」。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/review-pane.test.ts` 12 項（預設選與作者不同的種類、作者種類未知、指定種類照用並回報同種、不合法的種類、從作者 pane 分割且不搶焦點、不夠寬往下分割、太小就在分割之前拒絕、split 結果缺 terminal id 或在別的 workspace 就拒絕、關閉前核對 terminal 再關同一個 pane、terminal 不同不關、pane 已不在算已關閉、關閉永不丟錯誤、空的 id 不關）。先以桩跑：10 項為紅；實作後全綠。全套 931 項，930 通過、0 失敗、1 略過（原 919 項）；`lint` 通過。另外對真實 Herdr 只做了一個唯讀查詢：`herdr pane get w99:p99` 回 `pane_not_found`，與程式判斷「pane 已不在」的錯誤碼一致。

未驗證（待 3d）：`pane.split` 的實際回傳是否含 `terminal_id`（程式在沒有時會拒絕，所以不會誤關，但會讓 review 無法進行）；`pane.close` 在真實 Herdr 的行為（關閉有 Agent 在跑的 pane 是否需要確認或會留下殘留）；從作者 pane 分割出來的新 pane 在作者的 workspace 裡的版面；種類偏好順序（`claude`、`codex`、`agy`）是否符合你的環境。

限制：只處理本機（跨機器是 F9）；種類偏好順序是 Agent 的暫定值、寫死在程式裡，之後可改成設定；關閉失敗只回報、不重試，殘留的 pane 要使用者手動關。

下一步：3c-2（review 流程：組提示、開 pane、啟動 Agent、送出、解析、工作樹指紋檢查、一定關閉），再接 3d（`card review` 指令與 live 驗收）。


## ISSUE-077：review 流程（F5 階段 3c-2）

更新日期：2026-11-04。狀態：已驗收（2026-11-04，隨 ISSUE-078 的 live 驗收：reviewer 啟動、等就緒、送出、解析、工作樹指紋前後一致、一定關閉 pane 都在真實環境走過，含 `blocked` 的 inconclusive 路徑與 `pass` 路徑；工作樹被改動、逾時、同種類 reviewer、讀取清單失敗等路徑只有單元測試）。

來源：使用者 2026-11-04 決定開始 3c-2，並接受工作樹指紋用「`git rev-parse HEAD` 加 `git status --porcelain`」（限制：抓不到只改了被 gitignore 的檔案）。

行為（尚無使用者可見的入口）：`runCardReview(deps, input)` 把 3a（提示與解析）、3b 取得的材料、3c-1（新 pane）串成一次 review，回傳批次、各條件判定、reviewer 種類與是否同種、關閉狀況、降級或 inconclusive 的原因；**不寫卡片**（3d 負責）。細節與分類見 SPEC「review 流程」。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-review-flow.test.ts` 13 項（乾淨的 review 的完整順序、Agent 名稱、指定種類與同種回報、提示組不出來時什麼都不開、種類不合法或指紋讀不到時在開 pane 之前停下、pane 開不起來、Agent 啟動失敗時關 pane 且不換種類、reviewer 沒就緒（blocked）、4 種回覆問題、工作樹被改動的 pass 變 inconclusive 且丟掉 findings、事後指紋讀不到、關閉失敗只回報、findings 與降級與各條件判定的帶入）。先以桩跑：13 項全紅；實作後全綠。全套 944 項，943 通過、0 失敗、1 略過（原 931 項）；`lint` 通過（一個測試標題含 any 字樣被 lint 擋下，已改標題）。**全部使用假的 Herdr、假的 Agent、假的指紋，沒有對真實的 Herdr、Agent 或 git 驗證。**

未驗證（待 3d）：真實的 `pane.split` 回傳與 `pane.close` 行為（ISSUE-076 同一項）；真實 reviewer 能否照提示回出合格 JSON；`runTeamTurn` 對一個剛啟動、尚無 session 的 reviewer 的行為（ISSUE-066 已讓第一次出現的 session 被接受，但這條路徑沒有在 review 情境實測）；指紋實作（尚未寫，3d 提供）；逾時值 10 分鐘是否合適；reviewer 在卡片 worktree 啟動時，不同種類 Agent 第一次進該目錄會遇到信任提示，bridge 不會替人按，所以 review 會停在 `inconclusive`，要由人先按。

限制：reviewer 唯讀不是作業系統層隔離；指紋抓不到只改了被 gitignore 的檔案；只處理本機（F9）；findings 與各條件的判定結果由呼叫端決定怎麼存（卡片目前沒有存各條件判定的地方）；單一 commit 範圍（每個 commit 審一次）尚未支援（3b 只取整個 PR 的 diff）。

下一步：3d（`card review <id> [--agent <種類>]` 指令：取 PR 材料、呼叫 `runCardReview`、寫入 findings 與 `review_verdict`、指紋實作、接上 Herdr 與 `runTeamTurn`、live 驗收）。


## ISSUE-078：`card review` 指令與接線（F5 階段 3d）

更新日期：2026-11-04。狀態：已驗收（核心路徑，2026-11-04：codex 當 reviewer 對真實 PR 回出合格 JSON，逐條驗收條件判定與 `pass` 都寫入卡片；`changes_requested` 與有 findings 的真實畫面、未達成條件的逐條顯示、工作樹被改動、逾時、Claude 當 reviewer、跨機器都未實機驗證，見「live 驗收證據」）。

來源：使用者 2026-11-04 決定 review 與 coding 的 Agent 一律新開 pane、用完關閉，第一版先做本機；並在 3d 開始前回答驗收時用 **codex** 當 reviewer（「用 codex 當 reviewer」）。

使用者可見行為：`card review <卡片 id> [--agent <種類>]`（Discord 與 console）。對卡片開著的 PR 做一次獨立 review：新開 pane、新 Agent，唯讀審 PR，結果寫進卡片的 `## Review 發現` 與一筆 `review_verdict`，最後關閉 pane。細節、前提與限制見 SPEC「`card review`」。`help` 也補了說明。

實作範圍（2026-11-04）：`src/worktree-fingerprint.ts`（`git rev-parse HEAD` 加 `git status --porcelain`）；`src/card-review-command.ts`（下一輪的輪次與回覆文字）；`src/card-review-wiring.ts`（前提檢查與組裝：worktree、政策、PR、作者、GitHub 材料，接 `runCardReview`）；`src/card-command.ts`（`review` 子指令、同卡一次只一個 review、寫入卡片）；`src/main.ts`（接上真實的 Herdr、`startAgentInPane`、`runTeamTurn`、`fetchReviewMaterial`、指紋）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/worktree-fingerprint.test.ts` 5 項、`test/card-review-command.test.ts` 10 項、`test/card-review-wiring.test.ts` 7 項、`test/card-command.test.ts` 8 項（參數與卡片 id 驗證、成功時寫入 findings 與 verdict 並回覆 PR 網址、`--agent` 與輪次遞增、inconclusive 也記錄、沒開始的 review 不動卡片、前提拒絕透傳且卡片不動、同卡一次只一個 review、findings 寫不進時仍記 verdict 並說明）。先以桩跑：指紋 4 項、純函式 10 項、指令 8 項、接線 7 項為紅；實作後全綠。全套 974 項，973 通過、0 失敗、1 略過（原 944 項）；`lint` 通過（兩個測試標題含 any 字樣被 lint 擋下，已改標題；一個 help 文字的反引號沒跳脫造成編譯錯誤，已修正）。**全部使用假的 Herdr、假的 Agent、假的指紋與假的 GitHub，沒有對真實環境驗證。**

live 驗收證據（2026-11-04，本機 macOS，bridge 載入 main `f77c77e`，Herdr 0.9.1；使用者同意重啟、信任提示、push 與開測試 PR）：驗收卡 `REQ-20261104-rev-accept`，`--worktree` 啟動的 claude 在分支做一個 commit（`03caac3`，只新增 `docs/tmp-review-accept.md`），`card pr` 開出測試 PR #73（https://github.com/jon888465/Herdr_Discord_Bridge/pull/73，CI 兩項通過）。`card review REQ-20261104-rev-accept --agent codex` 兩次：**真實驗到的：** `pane.split` 的回傳含 `terminal_id`（不被拒絕）；分割出的新 pane 能啟動 codex、能被偵測狀態；**兩輪的 reviewer pane 都有被關閉**（核對時 `w1K` 只剩作者的 pane）；`## Review 發現` 的批次（第 1 輪、第 2 輪，整體、head `03caac306d19`、`inconclusive`）與 `review_verdict` 事件（`review-73-r1-03caac306d19`、`review-73-r2-03caac306d19`）都寫入卡片；worktree 兩輪之後都是乾淨的、HEAD 沒變；回覆含 PR 完整網址。**沒驗到的：** 兩輪都是 `inconclusive`：第 1 輪 codex 啟動時彈出「有新版本」的更新提示（`blocked`）；第 2 輪（更新提示已在 worktree 手動選「Skip until next version」處理掉，沒有執行 `brew upgrade`）codex 啟動後狀態是 `working`（初始化中），程式一看到不是 `idle` 就放棄。這是 ISSUE-079。

live 驗收（2026-11-04，第 3 輪，bridge 載入 main `57a90d9`，codex-cli 0.165.0，測試 PR #73）：ISSUE-079 修正合併並重啟後，同一個測試 PR #73 重跑 `card review REQ-20261104-rev-accept --agent codex`，回覆「判定：pass；reviewer：codex（與作者不同種類）」，三條驗收條件逐條為 ✓，reviewer 的 pane 已關閉；卡片新增「第 3 輪 · 整體 · head 03caac306d19 · pass」批次（沒有 findings）與事件 `review-73-r3-03caac306d19`（`review reviewer 第 3 輪：pass`），`card show` 的最近紀錄顯示三筆 `review_verdict`（inconclusive、inconclusive、pass）；worktree 乾淨、HEAD 仍是 `03caac3`；`w1K` 只剩作者的 pane。這驗到：真實 codex 能照提示回出合格的 JSON、`runTeamTurn` 對剛啟動的 reviewer 這條路徑可用（codex 啟動當下有沒有 session 沒有另外核對）、指紋前後一致。收尾（使用者同意）：關閉測試 PR #73、以 `git push origin --delete` 刪遠端分支 `card/REQ-20261104-rev-accept`、`card cleanup`、刪本機分支與驗收卡、路由切回 `w1`；codex 的更新提示是用 `herdr` 在 worktree 手動選「Skip until next version」處理的（沒有執行 `brew upgrade`）。

**這次驗收的限制：** 測試 PR 只動一個新檔案、reviewer 判 `pass`，所以 `changes_requested`、有 findings 的真實輸出、未達成條件的逐條顯示、`card show` 對真實 findings 的顯示都沒有在真實環境看過；Claude 當 reviewer 沒測；信任提示沒有出現（codex 在新 worktree 沒有彈出，原因不明，所以信任提示是否每次都會出現仍未確認）。

仍未驗證：真實 reviewer 回出 `changes_requested` 與 findings 時卡片與回覆的實際畫面；`runTeamTurn` 對剛啟動、尚無 session 的 reviewer；工作樹指紋在 review 有改動時的行為；10 分鐘逾時；`card show` 對真實 findings 的顯示；以下為原先列的項目，其中 `pane.split` 與 `pane.close` 已驗到：真實的 `pane.split` 回傳是否含 `terminal_id`、`pane.close` 的行為；真實 codex 能否照提示回出合格 JSON；`runTeamTurn` 對剛啟動、尚無 session 的 reviewer 的行為；codex 第一次進卡片 worktree 的信任提示（bridge 不會替人按，review 會停在 inconclusive）；工作樹指紋在真實 worktree 的行為；10 分鐘逾時；`fetchReviewMaterial` 對真實開著的 PR；`help` 的顯示。驗收需要一個會 push 的測試 PR（和 ISSUE-071 那次一樣，驗完關閉並刪遠端分支），每一項 push、開 PR、啟動 reviewer、按信任提示都要使用者當下明確同意。

限制：各條驗收條件的逐條結果只顯示在回覆裡、卡片沒有地方存；只支援本機（F9）；只審整個 PR（單一 commit 範圍尚未支援）；reviewer 唯讀是提示約束加工作樹指紋，不是作業系統層隔離，指紋抓不到只改了被 gitignore 的檔案；種類偏好順序（`claude`、`codex`、`agy`）預設選第一個與作者不同的，驗收用 `--agent codex` 指定；coding Agent 在任務完成後也關閉 pane 的部分（E13 擴大）尚未實作。

下一步：merge、重啟 bridge 後 live 驗收；之後是每個 commit 審一次、loop 與總上限 5 次、quota 的 handoff（F7）、E13 的關閉 coding pane、跨機器（F9）、最後才是 merge 的實作。


## ISSUE-079：reviewer 剛啟動時狀態是 `working` 就被判為沒就緒，且原因文字誤導

更新日期：2026-11-04。狀態：已驗收（2026-11-04，第 3 輪 review：codex 啟動後 `working` 等到 `idle`，review 正常進行並判 `pass`；`blocked` 立即放棄的路徑在第 1 輪真實驗到（當時原因文字仍是舊版）；逾時 30 秒、等待中 pane 消失、讀取清單失敗只有單元測試）。

來源：ISSUE-078 的 live 驗收。

使用者可見症狀：`card review REQ-20261104-rev-accept --agent codex` 回「判定：inconclusive；inconclusive 的原因：reviewer 沒有就緒（狀態 working；常見原因：新資料夾的信任提示，bridge 不會替人確認）」。reviewer 其實只是還在初始化，並沒有任何信任提示；上一輪（第 1 輪）的 `blocked` 則是 codex 的更新提示，原因文字同樣說成信任提示。

當時預期行為（2026-11-04，ISSUE-118 前）：Agent 啟動後短暫是 `working`（初始化中）要等它變成 `idle` 再送提示；真的 `blocked`（在等人，例如更新或信任提示）才立刻放棄；原因文字要依實際狀態說明，不要一律推測是信任提示。

重現方式／環境（2026-11-04，本機 macOS，main `f77c77e`，codex-cli 0.165.0，Herdr 0.9.1）：`card review <id> --agent codex`；第 1 輪 codex 彈出更新提示（`blocked`），在 worktree 手動處理掉後第 2 輪重現「`working` 就放棄」。

根因（**已確認**）：`src/card-review-flow.ts` 的 `reviewInPane` 在 `startAgent` 回來之後只檢查一次 `agent.agent_status !== "idle"`。`startAgentInPane` 只等狀態離開 `unknown`，codex 啟動後是 `working`，所以第一次檢查就失敗。

修正範圍（2026-11-04）：`src/card-review-flow.ts` 新增 `waitUntilReady`：已經 `idle` 就直接用（不輪詢）；`blocked` 立刻放棄，原因改為「卡在啟動提示（blocked）。常見原因：Agent 自己的更新提示或新資料夾的信任提示；bridge 不會替人確認，請先在要用的種類上處理一次」；其他狀態（`working`、`unknown`…）每 `readyPollMs`（預設 1 秒）重讀 Agent 清單，直到 `idle`、`blocked`、pane 或 terminal 消失、讀取清單失敗或 `readyTimeoutMs`（預設 30 秒）逾時；逾時的原因文字寫出實際狀態與秒數，不再猜信任提示。所有放棄的情況仍是 `inconclusive`、pane 仍會關閉。`ReviewFlowDeps` 新增選填的 `readyTimeoutMs`、`readyPollMs`（測試用）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：`test/card-review-flow.test.ts` 新增 7 項（`working` 等到 `idle` 後繼續並用新的紀錄、`unknown` 同樣等待、已經 `idle` 不輪詢、等待中變 `blocked` 立刻放棄並說明啟動提示、逾時並寫出實際狀態而不是信任提示、等待中 pane 消失、讀取清單失敗仍關閉 pane）。先寫測試：6 項為紅（「已經 idle 不輪詢」本來就通過）；修正後全綠。全套 981 項，980 通過、0 失敗、1 略過（原 974 項）；`lint` 通過。**沒有**對真實 codex 的測試。

當時未驗證（2026-11-04，ISSUE-118 前的歷史限制與待重跑 live 驗收紀錄，需先 merge 並重啟 bridge）：真實 codex 啟動後 `working` 到 `idle` 的實際時間（30 秒夠不夠）；Agent 自己的更新提示或信任提示仍會讓 review 停在 `inconclusive`（bridge 不會替人按，這是設計），所以**每種要當 reviewer 的 Agent 都要先在目標 worktree 的路徑處理過一次這些提示**；因為每張卡的 worktree 路徑都是新的，**新路徑的信任提示是否每次都會出現尚未確認**（這次 codex 在新 worktree 沒有出現信任提示，原因不明）。

當時限制（ISSUE-118 前）：等待上限 30 秒是暫定值；更新提示與信任提示只能由人處理。

現行例外（2026-11-07，ISSUE-118，狀態「已修正、待驗收」，尚未實機驗證）：上述 blocked 立即放棄、更新提示必須人工處理與關閉 pane 的描述保留為 ISSUE-079 的歷史行為／驗證紀錄，不代表現行已知更新提示的契約。共用 `waitUntilReady` 在 blocked 時，只有成功讀取 pane 畫面、種類與 `src/update-prompts.ts` 清單相符且無信任／權限／approval／登入字樣，才自動送跳過鍵。目前清單僅 codex：同時含 `Update available` 與 `Skip until next version`，按 `3`；每個 bridge port 下的同一 pane 最多嘗試一次，並記錄含 CLI、pane、按鍵的 log，再讀畫面、繼續等待就緒。信任、權限／approval、登入及未知畫面絕不自動確認，仍交由人處理；讀取失敗、混有上述敏感字樣或送一次後同一提示仍在時，沿用 `BLOCKED_AT_START` 失敗並保留 pane，不再送鍵。claude、agy 與其他 CLI 更新提示未涵蓋，不能沿用此例外。ISSUE-079 原驗收狀態及以下歷史下一步不變；ISSUE-118 的部署與實機驗收仍待完成。

下一步：merge、重啟 bridge 後，用同一個測試 PR #73 重跑 `card review`（第 3 輪）。


## ISSUE-080：reviewer 回覆的 JSON 字串被窄 pane 折行，解析失敗而判 inconclusive

更新日期：2026-11-04。狀態：已驗收（2026-11-04，重跑後 `changes_requested` 與 findings 在真實 codex 上走完；Claude 當 reviewer 與其他種類的折行方式未驗證）。

來源：補驗 `changes_requested` 與 findings 的 live 驗收（ISSUE-078 的後續，使用者 2026-11-04 決定「先做 1」）。

使用者可見症狀：`card review REQ-20261104-rev-fail --agent codex`（測試 PR #76，作者故意把檔案第二行寫錯）回「判定：inconclusive；inconclusive 的原因：reviewer 的回覆不是單一 JSON 物件」，reviewer 的 pane 已關閉、卡片記了一個空的 inconclusive 批次。

預期行為：reviewer 回出了合格的 `changes_requested`（第 3 條驗收條件 `unmet`，一筆 `medium` finding 指在 `docs/tmp-review-fail.md` 第 2 行）就要被採用。

重現方式／環境（2026-11-04，本機 macOS，main `3fb7caf`，bridge 載入 `57a90d9`，codex-cli 0.165.0）：測試 PR #76。核對 codex 的 transcript（`~/.codex/sessions/2026/11/04/rollout-…01a1a51c…jsonl`）：回覆是 `BRIDGE_BEGIN_… {合格的 JSON，340 字元} BRIDGE_END_…`，內層 JSON 單獨 `JSON.parse` 成功；bridge console 的 `hook Stop … chars=430` 是含框線標記的全文。

根因（**已確認**）：reviewer 是剛啟動的新 session，`runTeamTurn` 派送前沒有 transcript 可以接（transcript 在第一個 prompt 之後才存在），改從終端畫面讀回覆；reviewer 的 pane 是從作者 pane 分割出來的、很窄，較長的中文字串被終端自動換行，換行落在 JSON 字串裡面（Codex 的續行縮排兩格），`JSON.parse` 遇到字串裡的換行失敗。第 3 輪 `pass` 的回覆沒有備註、沒有 findings，字串都很短，剛好沒被折斷，所以前一次驗收沒遇到。Team 計畫的解析早就有處理同一個現象的 `unwrapCodexJson`，review 的解析沒有用上。

修正範圍（2026-11-04）：`src/card-review.ts` 的 `parseReviewReply`：嚴格 `JSON.parse` 失敗時，才用 `src/team-orchestration.ts` 的 `unwrapCodexJson`（本次改成匯出，邏輯不變）把字串內的折行接回去再解析一次；合格的回覆不會被改動；字串內沒有續行縮排的換行仍然拒絕（不過度修復）；解析後的所有驗證（欄位、路徑須在 PR 檔案內、筆數、pass 降級規則）完全不變。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：`test/card-review.test.ts` 新增 2 項（折行的長字串回覆被接受，備註與 finding 摘要被接回；合格回覆不被改動、無續行縮排的字串內換行仍被拒絕）。先寫測試：第一項為紅（第二項是防護，本來就通過）；修正後全綠。全套 983 項，982 通過、0 失敗、1 略過（原 981 項）；`lint` 通過。**沒有**對真實 codex 的測試。

驗收證據（2026-11-04，本機 macOS，ISSUE-080 修正合併並重啟後，bridge 載入 main `1fb56d5`，codex-cli 0.165.0，Herdr 0.9.1）：對同一個測試 PR #76 重跑 `card review REQ-20261104-rev-fail --agent codex`（第 2 輪），回覆「判定：changes_requested；reviewer：codex（與作者不同種類）」，四條驗收條件逐條顯示（第 1、2、4 條 ✓，第 3 條 ✗ 並附備註），「Findings（共 1 筆）：F1 · medium · docs/tmp-review-fail.md:2-2 · 第二行未使用驗收條件指定的文字…」，「已寫入卡片」，reviewer 的 pane 已關閉。卡片：新增「第 2 輪 · 整體 · head d8ed6be75501 · changes_requested」批次與 `- F1 | medium | open | docs/tmp-review-fail.md:2-2 | …`，事件 `review reviewer 第 2 輪：changes_requested`；`card show` 多出「── Review 發現（共 1 筆：open 1、fixed 0、resolved 0、dismissed 0）──」並列出 F1（第 2 輪），最近紀錄含兩筆 `review_verdict`（inconclusive、changes_requested）。worktree 乾淨、HEAD 沒變，只剩作者的 pane。這同時驗到 F8（卡片 `## Review 發現` 的寫入與 `card show` 顯示）在真實卡片上可用。收尾（使用者同意）：關閉測試 PR #76、`git push origin --delete` 刪遠端分支、`card cleanup`、刪本機分支與驗收卡、路由切回 `w1`。

附帶觀察（未另立 issue，純外觀）：行號起訖相同時顯示成「:2-2」，不如「:2」；`card show` 與 `card review` 回覆都是這樣。

未驗證：Claude 當 reviewer 的終端畫面格式；其他種類的 Agent 若折行方式不同仍會判 inconclusive；工作樹被改動、逾時等路徑仍只有單元測試。

限制：只處理 Codex 風格的折行（續行縮排兩格）；其他種類的 Agent 若折行方式不同仍會判 inconclusive。**除錯上的不便（建議後續處理，未做）：** 回覆解析失敗時，bridge 沒有保留 reviewer 的原始回覆，這次是去翻 codex 的 transcript 才看到；建議之後在 inconclusive 的原因文字附上回覆的前一小段（先遮蔽、單行、限長）。

下一步：merge、重啟 bridge 後重跑；之後清理測試 PR #76。


## ISSUE-081：`card fix`（review 的 loop 手動版）

更新日期：2026-11-04。狀態：已驗收（核心路徑，2026-11-04：完整的一圈 review → fix → pr → review 在真實的 claude 與 codex 上走完；部分修正、失敗的一圈、作者改到範圍外的檔案、第 3 輪上限、Discord thread、跨機器未實機驗證，見「驗收證據」）。

來源：使用者 2026-11-04 決定開始 loop，並回答 Agent 的設計提案：「照建議，先做手動版 card fix。1. 照你建議每圈開新的，作者就看最後 pane 是誰 2. 好 3. 對的，總共先從 5 改 3」。

使用者可見行為：`card fix <卡片 id> [--agent <種類>]`（Discord 與 console）。把卡片 open 的 findings 交給新開 pane 的新作者修一圈：作者在卡片的 worktree 修正並建立一個 commit；被修好的 finding 標為 `fixed`、記一筆 `fix_applied`；**不 push**。回覆列出 fixed 與略過的 finding、新舊 head、改動的檔案、敏感路徑警告與下一步（`card pr` 再 `card review`）。`card review` 通過時，先前標為 `fixed` 的 finding 自動標為 `resolved`。`help` 也補了說明。細節、前提與限制見 SPEC「`card fix`」。

實作範圍（2026-11-04）：`src/card-fix.ts`（能不能修、提示、回覆解析；`MAX_LOOP_ROUNDS = 3`）；`src/card-fix-flow.ts`（一圈的流程）；`src/card-fix-wiring.ts`（前提檢查與組裝，作者取自最後一個任務的 Lead）；`src/card-fix-command.ts`（回覆文字）；`src/agent-ready.ts`（從 review 流程抽出的「等 Agent 就緒」，兩者共用，行為不變）；`src/worktree-fingerprint.ts`（新增 `worktreeState`、`changedFilesBetween`，只用唯讀 git）；`src/card-events.ts`（新事件 `fix_applied`）；`src/card-command.ts`（`fix` 子指令、review 與 fix 共用的「一次只一個」保護、review 通過時 `fixed` → `resolved`）；`src/main.ts`（接線）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-fix.test.ts` 15 項、`test/card-fix-flow.test.ts` 13 項、`test/card-fix-wiring.test.ts` 4 項、`test/card-fix-command.test.ts` 8 項、`test/worktree-fingerprint.test.ts` 3 項、`test/card-command.test.ts` 12 項（參數與卡片 id、沒有可修的就拒絕且不呼叫流程、交出 open findings 並標 fixed 與記事件、`--agent`、部分修正只標修好的、失敗的一圈不動卡片、沒開始的修正不動卡片、前提拒絕透傳、第 3 輪後停止、與 review 互斥、review 通過把 fixed 標為 resolved、仍要求修改時不動 fixed）與 `test/card-events.test.ts`（`fix_applied` 的格式與 3 種拒絕）。先寫測試、看到紅再實作。全套 1039 項，1038 通過、0 失敗、1 略過（原 983 項）；`lint` 通過。**全部使用假的 Herdr、假的 Agent、假的 git 與假的 GitHub，沒有對真實環境驗證。**

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `d132fdb`，claude 當作者、codex-cli 0.165.0 當 reviewer，Herdr 0.9.1；使用者同意重啟、信任提示、三次 push 與開測試 PR、啟動 Agent 並修改 worktree）：驗收卡 `REQ-20261104-fix-accept`，`--worktree` 啟動的 claude 在分支做一個故意把檔案第二行寫錯的 commit（`0a968ac`，只新增 `docs/tmp-fix-accept.md`），`card pr` 開出測試 PR #80（https://github.com/jon888465/Herdr_Discord_Bridge/pull/80）。
1. `card review … --agent codex`（第 1 輪）：`changes_requested`，第 3 條驗收條件 ✗，`F1 · medium · docs/tmp-fix-accept.md:2-2`；
2. `card fix REQ-20261104-fix-accept`：回覆「修正完成 … 新作者（新開的 pane）：claude … 已標為 fixed：F1 … 新 commit：0a968ac4bc7b → e408bd46517c … 改動的檔案：docs/tmp-fix-accept.md … 作者的 pane 已關閉」。核對 worktree：恰好一個新 commit（`fix: REQ-20261104-fix-accept review round 1`，作者 `c <jon@cdexunijiqi.local>`），只改了 `docs/tmp-fix-accept.md`，第二行已改成驗收條件要求的文字，工作樹乾淨，`w1N` 只剩原本的作者 pane；卡片 `F1` 變 `fixed`、新增事件 `fix_applied`（`修正 第 1 圈：1 筆標為 fixed、0 筆略過，head e408bd46517c`）；
3. `card pr`：「這個分支已有 PR #80 … 已把新的 commit push 上去（head e408bd46517c）」，PR 現有 2 個 commit，CI 兩項通過；
4. `card review … --agent codex`（第 2 輪）：`pass`，四條驗收條件都 ✓，並回覆「先前標為 fixed 的 finding 已確認：已標為 resolved：F1」；卡片 F1 變 `resolved`，`review_verdict` 事件依序為 changes_requested（第 1 輪）、pass（第 2 輪），與 `fix_applied` 在紀錄裡順序正確。
收尾（使用者同意）：關閉測試 PR #80、`git push origin --delete` 刪遠端分支、`card cleanup`、刪本機分支與驗收卡、路由切回 `w1`。這同時驗到：新開 pane 的新作者（種類沿用最後一個作者）、`fixed` → `resolved` 的狀態機在真實卡片上、review 與 fix 的 pane 都有關閉、`runTeamTurn` 對剛啟動的作者可用。

未驗證：部分修正（有 skipped 的 finding）的真實畫面；失敗的一圈（沒有新 commit、回覆不合格、留下未提交修改）在真實 Agent 上的表現；作者改到 findings 以外的檔案或建立不只一個 commit 時的行為（bridge 目前只列出改動的檔案）；動到敏感路徑的警告在真實修正上的畫面；review 輪次到第 3 輪被拒絕；Discord thread 的顯示（本次在 console）；其他種類 Agent 當作者或 reviewer；跨機器。

仍未驗證（原先列的其餘項目）：真實作者 Agent 能否照提示只修列出的 findings、建立一個 commit、回出合格的 JSON 已驗到；新 pane 啟動的真實 Agent 在 worktree 裡的行為；`git status` 與 `git diff` 的真實輸出；作者動到 findings 以外的檔案時（bridge 只列出、不判斷）；完整的一圈流程（`card review` → `card fix` → `card pr` → `card review` 通過）；`fixed` → `resolved` 在真實卡片上的樣子。

限制：只支援本機（F9）；只處理整個 PR 的 findings；**沒有自動 loop**，每一圈都要人下指令；「每次審查最多 2 輪」沒有實作；inconclusive 的 review 也算一次，所以最多 3 次 review 的額度可能被 inconclusive 吃掉；作者的限制只靠提示與事後檢查（只修列出的 findings、一個 commit、乾淨的工作樹），不是作業系統層隔離；動到敏感路徑只警告、不阻擋；作者失敗留下未提交修改時，bridge 只回報、不清理，要人到 worktree 檢查。

下一步：merge、重啟 bridge 後 live 驗收（用一個故意不符合驗收條件的測試 PR 走完整的一圈）；之後才是自動 loop、每個 commit 審一次、E13、F7、F9、merge 的實作。


## ISSUE-082：`card loop`（review 的自動 loop）

更新日期：2026-11-04。狀態：已驗收（核心路徑，2026-11-04：bridge 自己 push 的完整自動一圈、`card loop stop`、從 fix 接著跑、修正動到敏感路徑時不 push，都在真實 claude 與 codex 上走完；review 到第 3 輪被拒絕、兩次 inconclusive 停下、失敗的修正、push 被拒、Discord thread 未實機驗證，見「驗收證據」）。

來源：使用者 2026-11-04 決定做自動 loop，並回答 Agent 的設計提案：「照建議，1.自動 2.對 3.只做手動 card loop」（push 自動；同一個 head 的 review 最多試 2 次；只做手動觸發）。

使用者可見行為：`card loop <卡片 id> [--agent <種類>] [--fix-agent <種類>]`（Discord 與 console）。一個指令跑 review → fix → push → review，直到 `pass` 或需要人。每一步完成就回報一則，結束時回覆通過或停下的原因。`card loop stop <id>` 要求停止（步驟之間生效）。`help` 也補了說明。細節、停止條件與限制見 SPEC「`card loop`」。**push 是 bridge 自己做的**：只 push 這張卡的 `card/<id>` 分支到既有的 PR（沿用 `card pr`）；修正動到敏感路徑時不 push。

實作範圍（2026-11-04）：新增 `src/card-loop.ts`（狀態機 `runLoop`：停止條件、同 head 的重試額度、push 之後一定先 review、停止要求、回報失敗不中斷、步驟數安全閥）；`src/card-command.ts` 把 `card pr`、`card review`、`card fix` 的核心拆成 `pushStep`、`reviewStep`、`fixStep`（原指令行為不變，既有測試全過）並新增 `loop` 子指令（一次只一個、讀卡片算輪次與判定、`--agent`／`--fix-agent`、`card loop stop`）；`CardCommandDeps` 新增選填的 `notify`；`src/main.ts`（把進度回報接到 Discord／console 的回覆、`help`）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/card-loop.test.ts` 17 項（一次 pass、fix 與 push 後再 review、每一步都回報、到第 3 輪停止且不開第 4 輪、輪次上限可設且用完的卡片不再 review、inconclusive 重試一次後停止、重試額度以 head 計、已經 inconclusive 算第一次、已通過不用跑、已有 changes_requested 時從 fix 接著跑、push 後新 head 一定先 review、修正失敗不 push、敏感路徑不 push 並指出路徑、review／fix／push 的錯誤都停下並說明、停止要求在步驟之間生效、開始前就停止、回報失敗不中斷）與 `test/card-command.test.ts` 11 項（參數與卡片 id、一次 pass、完整的一圈與卡片更新、`--agent` 與 `--fix-agent` 的去向、到上限停下、兩次 inconclusive 停下、敏感路徑不 push、失敗的修正、步驟拒絕時停下並說明、停止與互斥、沒有在跑時 stop 的錯誤）。先寫測試、看到紅再實作。全套 1067 項，1066 通過、0 失敗、1 略過（原 1039 項）；`lint` 通過。**全部使用假的 Herdr、Agent、git 與 GitHub，沒有對真實環境驗證。**

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `8c5bc9d`，claude 當作者、codex-cli 0.165.0 當 reviewer，Herdr 0.9.1；使用者「都同意，重啟並開始」：重啟、信任提示、手動 push、**bridge 自己 push 這張卡的分支到測試 PR**、啟動 Agent、開兩個測試 PR）：
**一、完整的自動一圈（驗收卡 `REQ-20261104-loop-ok`，測試 PR #83）：** 作者 claude 做一個故意把檔案第二行寫錯的 commit（`c888b55`），**手動** `card pr` 開 PR（遠端 head `c888b55`）。之後只下一次 `card loop REQ-20261104-loop-ok --agent codex`，bridge 自己跑完：review 第 1 輪 `changes_requested`（`F1 · medium · docs/tmp-loop-ok.md:2-2`）→ `card fix`（新 claude，新 commit `c888b55 → 5754920`，F1 標 fixed）→ **bridge 自己 push**（「這個分支已有 PR #83 … 已把新的 commit push 上去（head 57549204d490）」）→ review 第 2 輪 `pass`（四條驗收條件都 ✓，F1 自動 `resolved`）→「loop 結束：… review 已通過（共 4 個步驟）。CI 的結果由 bridge 另行通知；merge 由你決定」。每一步完成都即時出現一則回報。**核對 bridge 自己的 push：** 遠端 `card/REQ-20261104-loop-ok` 是 `5754920`，舊 head `c888b55` 是它的祖先（只前進了一個 fast-forward，沒有 force）；PR #83 共 2 個 commit（`c888b55`、`5754920`），CI 兩項通過；`main` 仍是 `8c5bc9d`，完全沒動；worktree 乾淨，`w1P` 只剩作者的 pane；卡片 F1 `resolved`，`review_verdict`／`fix_applied`／`review_verdict` 三筆事件順序正確。
**二、`card loop stop`（驗收卡 `REQ-20261104-loop-sens`，測試 PR #84，第一個 commit 只改 `SPEC.md` 並故意寫錯一行，`card pr` 時回覆有敏感路徑警告）：** 下 `card loop … --agent codex` 後 6 秒在同一個 console 下 `card loop stop REQ-20261104-loop-sens`，回「已要求停止…進行中的步驟會先做完，之後不再往下」（console 同時處理了兩個指令）；第一個步驟（review，`changes_requested`、`F1 · medium · SPEC.md:694-694`）做完後 loop 停下：「共 1 個步驟，停在 cancel。原因：使用者要求停止（在步驟之間生效）」；遠端分支沒動（`ce7d465`）。
**三、從 fix 接著跑與敏感路徑不 push（同一張卡）：** 再下 `card loop … --agent codex`：因為最新一輪是 `changes_requested` 且有 open finding，**直接從 fix 開始**（「共 1 個步驟」）；新 claude 修正並 commit（`ce7d465 → dfddce6`，只改 `SPEC.md`，F1 標 fixed），回覆「⚠️ 這次修正動到敏感路徑：SPEC.md。請特別審查」；loop 停下：「停在 sensitive。原因：修正動到敏感路徑：SPEC.md。新 commit 留在 worktree、沒有 push，請人檢查後再 `card pr`」。**核對：遠端分支仍是 `ce7d465`（沒有 push）**，修正 commit `dfddce6` 只在 worktree，工作樹乾淨，`main` 沒動。
收尾（使用者同意）：關閉測試 PR #83 與 #84、`git push origin --delete` 刪兩個遠端分支、`card cleanup` 兩個 worktree、刪本機分支與驗收卡、路由切回 `w1`。

驗收過程中的一個觀察（不是 loop 的缺陷，未另立 issue）：第二張卡的 `card assign --worktree` 一度失敗，「herdr worktree.create: linked_worktree_source New and open worktree actions start from the repo parent workspace」——因為上一張卡的 `--worktree` 把路由切到它的 worktree workspace，Herdr 不允許從 linked worktree 再建 worktree；先 `wk use w1` 再重試即可。連續建立多張 `--worktree` 卡片時要先把路由切回原 workspace。

未驗證：review 輪次到第 3 輪被拒絕；同一個 head 連續兩次 `inconclusive` 停下；失敗的一圈（沒有新 commit、回覆不合格）與 push 被拒時 loop 的表現；PR 被關閉或 merge 時 loop 停下；Discord thread 的進度回報；loop 跑很久時 bridge 其他指令的影響（本次 console 同時處理了 `card loop stop`，其他指令沒有試）；其他種類的 Agent；跨機器。

與提案的偏離（已寫進需求卡）：**「CI 紅」沒有當成停止條件、loop 也不等 CI**；「使用者再下別的指令」只實作了 `card loop stop`。

限制：只支援本機；只審整個 PR；不會自動 merge；停止要求只在步驟之間生效；`pass` 只代表 review 通過、不代表 CI 綠；停止要求只對 `card loop` 有效（對單獨的 `card review` 或 `card fix` 沒有效果，下次 loop 開始前會被清掉）；每次 `card review` 都算一次輪次，所以 inconclusive 會吃掉 3 次的額度。

下一步：merge、重啟 bridge 後 live 驗收；之後是 CI 紅作為停止條件（需使用者決定）、每個 commit 審一次、E13、F7、F9、merge 的實作。


## ISSUE-083：`card merge`（L2 的手動 merge）

更新日期：2026-11-04。狀態：已驗收（核心路徑，2026-11-04：真實 PR #87 上拒絕路徑與一次真的 squash merge 進公開 repo 的 main 都走完，之後既有輪詢記 `merged` 並自動清理 worktree；**發現並記錄：`gh` 的 fine-grained token 一開始沒有 Contents 寫入權限，合併被 GitHub 拒絕，由使用者提高權限後才成功**；其餘拒絕條件的真實表現、merge／rebase 方式、Discord thread 未實機驗證，見「驗收證據」）。

來源：使用者 2026-11-04 決定做 L2 的 merge，並回答 Agent 的設計提案：「照建議，先做手動 card merge」（先只做手動、預設 squash、驗收接受用公開 repo 的 main、政策由使用者自己改）。

使用者可見行為：`card merge <卡片 id> [--method squash|merge|rebase]`（Discord 與 console）。前提全部成立才會合併卡片開著的 PR；不成立時回覆「不 merge PR #N（k 項條件不成立）」並列出**所有**原因，什麼都不做。成功時回覆 PR 完整網址、方式、合併的 head，並說明 bridge 約一分鐘內會偵測到、記 `merged` 並清理 worktree（沿用 E11），不部署、不重啟、不刪遠端分支。`help` 也補了說明。條件與限制見 SPEC「`card merge`」。**需要使用者先把政策檔裡這個專案改成 L2**（政策檔由人手寫，bridge 不改）。

實作範圍（2026-11-04）：`src/github.ts` 新增 `pullRequestMergeState`、`allowedMergeMethods`、`mergePullRequest`（**唯一的寫入例外**：`gh pr merge … --match-head-commit <head>`，永不帶 `--admin`／`--auto`／`--delete-branch`；檔頭的白名單註解已更新）；`src/card-merge.ts`（`checkMergeable`：所有拒絕條件一次列出；`pickMergeMethod`）；`src/card-merge-wiring.ts`（前提檢查、重新讀取事實、合併永遠是最後一步且只做一次）；`src/card-command.ts`（`merge` 子指令、與 review／fix／loop 互斥）；`src/main.ts`（接線、`help`）。

測試（2026-11-04，本機 macOS、Node v26.12.0，非 CI）：新增 `test/github.test.ts` 5 項（讀 PR 的合併狀態、拒絕不合預期的輸出、允許的合併方式、合併只帶指定的 head 與方式且永不帶 `--admin`／`--auto`／`--delete-branch`、輸入驗證與失敗包裝）、`test/card-merge.test.ts` 13 項（全部成立可合併、低於 L2、卡片未 done、沒有或沒通過的 review、review 通過的是舊 head、open finding、5 種 CI 狀態、PR 已 merge／關閉／草稿、衝突／落後／被擋住／計算中／UNSTABLE、敏感路徑與查不到、一次列出所有原因、合併方式的預設與限制）、`test/card-merge-wiring.test.ts` 8 項（合併一次、最後、用剛讀的 head 與 squash、不信索引的 head、指定方式、沒有 worktree 紀錄或沒有開著的 PR、10 種不成立的情況各自拒絕且不呼叫 merge、多項原因全部列出、不允許的方式在合併之前拒絕、GitHub 失敗的透傳）、`test/card-command.test.ts` 5 項（參數、回覆內容、`--method`、拒絕時卡片原封不動、與其他步驟互斥）。先寫測試、看到紅再實作。全套 1098 項，1097 通過、0 失敗、1 略過（原 1067 項）；`lint` 通過。**全部使用假的 GitHub，沒有對真實 repo 驗證。**

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `4cfae59`，claude 當作者、codex-cli 0.165.0 當 reviewer，Herdr 0.9.1；使用者同意重啟、信任提示、push、開測試 PR、政策由使用者改成 L2、**真的合併進公開 repo 的 main 一次**）。驗收卡 `REQ-20261104-merge-ok`，測試 PR #87（只新增無害的 `docs/tmp-merge-accept.md`）：
**第一段（政策 L1，沒有合併任何東西）：** (1) review 第 1 輪 `pass`、CI 兩項全綠後下 `card merge`：「不 merge PR #87（1 項條件不成立）：專案政策是 L1…」——**只有一條原因**，也就是 review 的 head 一致、CI 全綠、沒有敏感路徑、GitHub 回報可合併這些條件在真實環境都判成立；(2) 在 PR 上再推一個新 commit 後下 `card merge`：**一次列出 4 項原因**——政策是 L1、review 通過的是 head `45a3c93` 但 PR 現在是 `8ce198e`、CI 還在跑、GitHub 回報被 branch protection 擋住（都是真實值）。`main` 沒動（`4cfae59`）。
**第二段（政策由使用者改成 L2，`card policy` 確認）：** (3) 重審 review（第 2 輪）：codex 正確指出我在 review 之後加的第三行違反卡片「兩行」的要求，判 `changes_requested`、`F1`；此時下 `card merge`：「2 項條件不成立：最新一輪 review（第 2 輪）是 changes_requested…、還有 1 筆 open 的 finding」——**政策已是 L2 也照樣拒絕**；(4) `card loop` 自動跑完（review → fix 由新作者去掉第三行 → bridge 自己 push → review 第 3 輪 `pass`，F1 `resolved`），CI 對新 head（`05a3189`）兩項全綠、PR `CLEAN` 且 `MERGEABLE`；(5) **第一次 `card merge`：失敗，「GraphQL: Resource not accessible by personal access token (mergePullRequest)」**——`gh` 的 fine-grained token 沒有合併權限（推測是 Contents 寫入；先前刪遠端分支同樣 403）；PR 仍 OPEN、`main` 沒動、沒有任何副作用；使用者在 GitHub 提高該 token 對這個 repo 的權限（Contents 讀寫）；(6) **重試 `card merge`：成功**，「已 merge：REQ-20261104-merge-ok · PR #87（squash，head 05a3189e576d）」；GitHub 上是 squash commit `15bf554`（單一 parent，標題「card merge 驗收：無害文件的測試卡 (#87)」），合併者是 `jon888465`（使用者的 `gh` 登入），合併的就是檢查過的 head；
**合併之後：** 約一分鐘內既有輪詢（E11）在卡片記 `merged`（「已合併 15bf55442a8b（squash）」，方式推斷正確）、自動清理 worktree（`cleanup_done`，`worktree 狀態：已清理（分支保留）`），console 收到「已自動清理 worktree …」。收尾（使用者同意）：刪遠端與本機分支 `card/REQ-20261104-merge-ok`、刪驗收卡、路由切回 `w1`；測試文件由 revert 移除（本 PR）；政策由使用者改回 L1。

**重要發現：L2 的 `card merge` 需要 `gh` token 有合併 PR 的權限。** 使用者 2026-11-03 選「L2 用現有登入」，但現有的 fine-grained token 一開始沒有合併權限（Contents 寫入）。這是個有用的安全網：權限不足時 bridge 的判斷即使出錯也合併不了任何東西。要讓 `card merge` 能合併，**由使用者**在 GitHub 把這個 token 對 `Herdr_Discord_Bridge` 這一個 repo 提高到 Pull requests 與 Contents 讀寫；`protect-main`（要 PR、兩個 CI、`strict`、沒有 bypass）仍然擋住直接 push 到 main，所以這個權限只能經過 PR 合併。bridge 不會自己改憑證。

**補驗拒絕條件（2026-11-04，政策已由使用者改回 L1；`card merge` 不論政策都會一次列出所有不成立的條件，所以在 L1 下仍看得到其他條件，也不可能真的合併）：** 驗收卡 `REQ-20261104-merge-red`，測試 PR #89（作者新增一個必敗的測試 `test/tmp-red.test.ts` 並在 `SPEC.md` 最後加一行）。`card pr` 回覆有「⚠️ 這個 PR 動到敏感路徑：SPEC.md」；CI 兩項（ubuntu、macos）都 fail，bridge 通知「❌ PR #89 的 CI 失敗」。(a) 下 `card merge`：**一次列出 5 項原因**——政策是 L1、卡片還沒有 review 結果、CI 有檢查失敗、GitHub 回報被 branch protection 擋住（`mergeStateStatus` 為 `BLOCKED`，也就是 GitHub 自己也不會讓這個紅燈 PR 合併）、動到敏感路徑 `SPEC.md`；(b) 用 `gh pr ready --undo` 轉成草稿後再下：**6 項**，多了「這個 PR 是草稿（draft）」；(c) 關閉 PR 後立刻下：**5 項**，含「這個 PR 已經關閉」（`BLOCKED` 與草稿的原因隨之消失）。PR 全程 OPEN 或 CLOSED、`main` 沒動（`8ebb221`）。這驗到：CI 紅、敏感路徑、草稿、已關閉、branch protection 擋住、沒有 review 在真實環境都被正確判斷並拒絕，且原因一次列齊；也算是紅燈 PR 被擋的一次實測（追蹤清單 G4 的『紅燈 PR 被擋』，擋住的是 GitHub 的 `BLOCKED` 與 bridge 的拒絕，不是 bridge 去嘗試合併而被 GitHub 拒絕）。
**落後 main（`BEHIND`）已補驗（2026-11-04）：** 測試 PR #89 重新打開並轉回 ready 後，使用者 merge 了下一個 PR（#90），`main` 前進到 `dd746dc`；GitHub 先回 `UNKNOWN`、約幾十秒後回 `mergeStateStatus: BEHIND`、`mergeable: MERGEABLE`；此時下 `card merge`：**5 項原因**，含「PR 的分支落後目標分支，要先同步（Update branch）並讓 CI 在最新的 head 上重跑」。PR 仍 OPEN、`main` 沒動（`dd746dc`）。注意：落後的 PR 在 `strict` 已開（G3）的 repo 一定要先同步並重跑 CI 才能 merge，這也是 bridge 拒絕的理由。收尾（使用者同意）：關閉 PR #89、刪遠端與本機分支 `card/REQ-20261104-merge-red`、`card cleanup`、刪驗收卡、路由切回 `w1`；政策已由使用者改回 `L1`。
**至此 `card merge` 的拒絕條件在真實環境都驗過**：政策 L1、卡片沒有 review、review 未通過、review 的 head 與 PR 不一致、open finding（開 PR 前後各情境）、CI 進行中、CI 失敗、branch protection 擋住、草稿、已關閉、落後 main、敏感路徑；真的合併一次（squash）也驗過。**仍待補驗：** `merge` 與 `rebase` 方式；`--method` 被 repo 禁止；PR 衝突（`CONFLICTING`／`DIRTY`）；Discord thread；其他專案；跨機器。

未驗證（已補驗者見上）：政策 L2 下以上拒絕條件的表現（拒絕邏輯不依賴政策，只驗到 L1 與 L2 兩種下的部分）；`merge` 與 `rebase` 方式；`--method` 被 repo 禁止；`card loop` 通過後不會自動 merge 的行為（本來就沒做）；Discord thread；其他專案；跨機器。

仍未驗證（原先列的其餘項目）：（已驗到者見上）：真實 PR 上 `gh pr merge --squash --match-head-commit` 的行為；`mergeStateStatus`／`mergeable` 在真實 PR 上的值（`CLEAN`、`BEHIND`、`BLOCKED`…是否如預期）；`protect-main` 的 branch protection 與我們的條件是否一致（例如 `strict` 要求同步 main）；合併之後既有輪詢偵測 merge、記 `merged`（squash 的方式推斷）並清理 worktree；各拒絕條件在真實環境的表現（政策 L1、review 的 head 與 PR 不一致、CI 紅、敏感路徑）；`card merge` 的 token 權限是否足夠（需要 Pull requests 寫入）。

限制：只有手動指令；`card loop` 通過後不會自動 merge；只支援本機與 github.com；bridge 的檢查不等於人看過程式碼，review 是另一個 Agent 做的、獨立的只有 session；GitHub 的 branch protection 仍是最後一道防線；驗收的 merge 會直接進公開 repo 的 main。

下一步：merge 本 PR、重啟 bridge；使用者把政策改成 L2；用一個無害的測試 PR 驗收（先驗各拒絕條件、最後驗一次真的 merge）；驗完把政策改回 L1。

## ISSUE-084：`card loop --merge`（review 通過後等 CI、全綠自動 merge）

更新日期：2026-11-04。狀態：已驗收（核心路徑，2026-11-04：L1 下 review → 等 CI → `card merge` 拒絕、L2 下一次真的 `--merge` 合併、CI 紅燈時停在 `ci` 都在真實 PR 上走完；等 CI 時 `card loop stop`、逾時、Discord thread 未實機驗證，見「驗收證據」）。

來源：使用者 2026-11-04 要求「做 card loop」，Agent 提案 `card loop --merge`，使用者回答：是做 `--merge`；等 CI 但有逾時；守門全交給 `card merge`（不新增條件）。

使用者可見行為：`card loop <id> [--agent] [--fix-agent] [--merge]`（`--merge` 可放任何位置、只能出現一次）。沒有 `--merge` 時行為與以往完全相同（review 通過就結束，回覆提示可加 `--merge`）。有 `--merge`：review `pass` 之後每 30 秒讀一次 PR 的 CI，最多等 30 分鐘；全部 `success` 才呼叫與 `card merge` 相同的合併步驟（重新讀事實、列出所有不成立的條件、只合併剛檢查的 head）。成功回覆「review 已通過、CI 全綠，已 merge」加 PR 網址；其他情況停下並說明原因：CI 失敗／取消／全部略過、等 CI 逾時、讀 CI 連續 3 次出錯、`card merge` 拒絕（含所有原因，例如政策不是 L2、敏感路徑、落後 main）、`card loop stop`（等 CI 時也生效）。`help` 已補說明。

預期行為與安全性：`--merge` 不新增也不繞過 `card merge` 的任何條件，所以政策仍必須是 L2（使用者手寫 `policy.yml`）、敏感路徑一律由人 merge；merge 是最後一步、只做一次；修正動到敏感路徑時仍不 push（loop 本身就停）。

實作範圍（2026-11-04）：`src/card-ci-wait.ts`（`waitForChecks`：pending／none 繼續等、success／failure 結束、逾時、停止要求、容忍偶發讀取錯誤）；`src/card-loop.ts`（`runLoop` 的 `merge` 選項與 `waitCi`／`merge` 步驟，新停止點 `ci`、`merge`；缺步驟時拒絕啟動）；`src/card-merge-wiring.ts`（`readCardChecks`）；`src/card-command.ts`（`--merge` 旗標、`mergeStep` 與 `card merge` 共用、`waitForCi` 依賴）；`src/main.ts`（接線、help）。

測試（2026-11-04，本機 macOS，非 CI）：新增 `test/card-ci-wait.test.ts` 7 項、`test/card-loop.test.ts` 10 項、`test/card-command.test.ts` 6 項、`test/card-merge-wiring.test.ts` 2 項。`npm run check` → 1123 tests、1122 pass、0 fail（其餘 1 項為既有的 skip）；`npm run lint` ok。`format:check` 本來就有 41 個既有檔案不符，本次不處理。

未驗證：真實 PR 上的整條路徑（push 後 CI 的 `none`→`pending`→`success` 轉換、等 CI 的實際耗時、macOS runner 排隊時是否撐得過 30 分鐘、CI 紅時的停止、`--merge` 真的合併一次）；等 CI 期間 `card loop stop`；Discord thread 的進度回報；L1 下 `--merge` 被 `card merge` 拒絕的真實表現。

限制：逾時 30 分鐘與間隔 30 秒寫死在 `main.ts`；CI 一直沒有登記（`none`）會等到逾時；只支援本機與 github.com；等 CI 期間 bridge 若重啟，loop 就中斷（沒有續跑），卡片維持在 review 通過的狀態，可手動 `card merge`。

驗收證據（2026-11-04，本機 macOS，bridge 載入 main `a1ec18d`，claude 當作者、codex 當 reviewer，Herdr 0.9.1；使用者同意重啟、開測試 PR、政策由使用者改成 L2 再改回）。驗收卡 `REQ-20261104-lm-ok`，測試 PR #93（只新增無害的 `docs/tmp-loop-merge-accept.md`）：
**第一段（政策 L1）：** `card loop REQ-20261104-lm-ok --agent codex --merge`：codex 第 1 輪 review `pass`（3 條驗收條件都對上、reviewer pane 已關閉）→ 等 CI，兩項全綠，回報「CI 全部通過」→ 呼叫 `card merge`，被拒絕，**只有一條原因**「專案政策是 L1，只有 L2 才允許 bridge 自己 merge」；loop 停在 `merge`，PR 與 `main` 沒動。
**第二段（政策由使用者改成 L2，`card policy` 確認）：** 再下同一個指令：review 已是 `pass`，直接等 CI（已全綠）→ `card merge` 的所有條件成立 → **第一次由 loop 真的合併進公開 repo 的 main**（squash，head `379a2858a8e6`，合併後 `main` 為 `7cff072`）；約一分鐘內既有輪詢記 `merged` 並自動清理 worktree（分支保留）。收尾：刪遠端與本機分支 `card/REQ-20261104-lm-ok`、刪驗收卡、測試文件由 revert 移除（本 PR）；政策由使用者改回 L1。
**驗收過程的偏差與發現（與 `--merge` 本身無關）：** `card assign REQ-20261104-lm-ok --coding --worktree` 這次沒有做出 commit：Lead 規劃時沒有可用的 Worker，回了空計畫，task 失敗（「no passing review… no successful verification」）。根因已在 ISSUE-085 查明：先前的驗收卡都是**不帶 `--coding`** 指派的，這兩張帶了 `--coding`，而 `--coding` 在沒有 Worker 時無解（不是偶發，也不是重啟造成）。處理：改成直接對卡片 pane 的 claude 下指令完成並 commit，再手動把卡片 `status` 改成 `done` 才能 `card pr`。若再次出現請開新 issue 調查。（見 ISSUE-085。）
**CI 紅燈停止已補驗（2026-11-04，政策 L1，bridge 載入 main `a1ec18d`，codex 當 reviewer）：** 驗收卡 `REQ-20261104-lm-red`，測試 PR #95（只新增一個必定失敗的 `test/tmp-red.test.ts`）。`card loop REQ-20261104-lm-red --agent codex --merge`：codex 第 1 輪 review `pass`（3 條驗收條件都對上）→ 等 CI → 回報「CI 結果是 failure（不是全部通過）」→ loop 停在 `ci`，原因「CI 沒有全部通過，沒有 merge；review 已通過，請人看 CI」；**沒有呼叫 `card merge`**，PR 與 `main` 沒動。收尾（使用者同意）：關閉 PR #95、刪遠端與本機分支 `card/REQ-20261104-lm-red`、取消卡住的 team task、`card cleanup`、刪驗收卡、路由切回 `w1`；政策維持 L1。驗收期間 `--coding` 又出現空計畫（見 ISSUE-085）。
**未驗證：** 等 CI 期間 `card loop stop`；等 CI 逾時（30 分鐘）；讀 CI 連續出錯；Discord thread 的進度回報；其他專案；跨機器。

下一步：merge 本 PR；視需要在 L1 另開必敗的測試 PR 補驗 CI 紅燈停止；調查 `--coding` 規劃出空計畫的問題（再現時）。

## ISSUE-085：`card assign --coding` 在沒有 Worker 時 Lead 規劃出空計畫，task 失敗或卡在規劃

更新日期：2026-11-05。狀態：已驗收（零 Worker 拒絕、有 Worker 啟動、`--coding` 完整跑完三項都有實機證據；PR #97 已 merge；根因已確認；限制見下，完整流程只在 claude Lead＋兩個 claude Worker 驗到，codex Worker 見 ISSUE-088）。

**2026-11-05 實機嘗試（未得到有效結果）：** 重啟後在 bridge console 於 workspace `w1` 執行 `team ask --coding …`，得到「Team Worker pane w1:p8 is stale or unavailable」——`w1` 的 Team 名單殘留一個失效的 Worker（`w1:p8`），根本沒走到零 Worker 的檢查，所以**不能算驗收**。須改在確實沒有 Worker 的 workspace（例如 `card assign --worktree` 新建的）重試。

**2026-11-05 零 Worker 拒絕實機驗收通過（本機 macOS，政策 L1，bridge 載入 main `ad5d30c`，由 bridge console 操作）：** 匯入驗收卡 `REQ-20261105-roster-ok` 並設為 `ready`，執行 `card assign REQ-20261105-roster-ok --worktree --coding`。結果：worktree 已建立（workspace `w1W`），任務**沒有啟動**，回覆「--coding 任務需要至少一個 Worker…目前沒有任何 Worker。若只是要讓卡片的 Agent 自己做完，請不帶 --coding」，原因與出路都清楚；卡片 `status` 仍是 `ready`。收尾：`card cleanup` 移除 worktree、刪本機分支與驗收卡檔（分支未曾 push）；workspace `w1W` 已不存在。副作用：console 顯示「selected Agent exited」，需重新 `agent use`。**仍未驗：** 有 Worker（同 workspace 其他 Agent pane 或 `team select` 的 profile）時 `--coding` 能正常啟動。

**2026-11-05 有 Worker 時的啟動實機驗收（本機 macOS，政策 L1，bridge 載入 main `ad5d30c`）：** 手動建 worktree workspace `w1X`（claude 當 Lead、codex 當 Worker，`team add w1X:p2`），驗收卡 `REQ-20261105-roster-worker`（只要求新增一個暫存檔、不 commit／push），`card assign REQ-20261105-roster-worker --coding`。結果：回覆「Team Task accepted · Lead: claude · Workers: codex」，沒有被零 Worker 檢查擋下 → **有 Worker 時 `--coding` 可啟動，ISSUE-085 的修正沒有誤擋**。但 task 約 5 秒後失敗：「Lead did not return a JSON Assignment plan」，見 ISSUE-086。收尾：關 workspace `w1X`、移除手動 worktree、刪分支與驗收卡，路由切回 `w1`/`w1:p1`。

**2026-11-05 `--coding` 完整跑完的驗收嘗試（未完成，見 ISSUE-087）：** 建 workspace `w1Z`（claude Lead `w1Z:p1`、codex `w1Z:p2`／`w1Z:p3` 兩個 Worker，`team add` 兩個），驗收卡 `REQ-20261105-full`（新增 `tmp-full-ok.txt`、驗證用 `test -f … && grep -qx ok …`），`card assign REQ-20261105-full --coding`。Lead 在 5 秒內回了合格的三步計畫（`impl-1` 寫入 → `review-1` 依賴 `impl-1` → `verify-1` 依賴 `review-1`），bridge 驗證後判失敗：「read-only coding assignments in a writer round must depend on that writer」，task 在派工前結束，沒有任何 Worker 動作。收尾：關 workspace、移除 worktree、刪分支與驗收卡、路由切回 `w1:p1`。**`--coding` 完整流程（實作 → 獨立 review → 驗證 → 統整）仍未驗到。**

**2026-11-05 `--coding` 完整跑完實機驗收通過（本機 macOS，政策 L1，bridge 載入 main `50daa86`，含 ISSUE-086／087 修正）：** workspace `w21`（新 worktree，claude Lead `w21:p1`＋兩個 claude Worker `w21:p2`／`w21:p3`，`team add`），驗收卡 `REQ-20261105-full3`（新增 `tmp-full-ok.txt`、驗證用 `test -f … && grep -qx ok …`、不跑 npm），`card assign REQ-20261105-full3 --coding`。結果：Lead 規劃 `impl`→`review`→`verify` 通過驗證；`impl`（`w21:p2`）建出檔案、`review`（`w21:p3`）判 pass 且無 finding、`verify`（`w21:p3`）結束碼 0；Lead 第二輪規劃後進入統整；coding evidence 三個 artifact 的版本指紋相同（`fd71017f…`），階段 `ready-to-integrate`；task journal 最後事件 `coding_assessed` → `task_completed`，console「Team Task completed」。這是 `--coding` 第一次實機完整跑完。收尾：關 workspace、刪暫存檔、移除 worktree、刪分支與驗收卡、路由切回 `w1:p1`；沒有 commit／push。

**同一天的前一次嘗試（codex Worker）：** 用 claude Lead＋兩個 codex Worker（`w10`），計畫通過、實作完成，但 `review` 被擋：「unknown reviewer identity is not an independent review」，`verify` 因此沒執行，task 失敗。原因是這些 codex pane 沒有 `agent_session`，見 ISSUE-088。

另發現：Team 名單裡的失效 Worker 會讓任務在啟動前就失敗，屬既有行為，未另開 issue。

使用者可見症狀：`card assign <id> --coding --worktree` 之後，卡片 pane 裡的 claude 回覆「沒有列出任何 Worker target，不能自己動手實作」，回空計畫。第一次（`REQ-20261104-lm-ok`，task `task-e66b125d`）：Lead 回了合格的空計畫 → `plan_validated`、`coding_assessed` → 統整後 task 判 failed（「no passing review for the current version; no successful verification for the current version」），沒有任何 commit。第二次（`REQ-20261104-lm-red`，task `task-f35daaf8`）：Lead 回的是沒有傳輸標記的說明文字，turn 一直沒 settle，task 停在 `planning` 約 6 分鐘直到手動 `team cancel`；`card cleanup` 在那之前因「任務尚未結束」而拒絕（這個保護是對的）。

預期行為：要不要用 `--coding` 由使用者決定；用了就必須有可用的 Worker，否則在**啟動前**就明確拒絕並說明怎麼辦，而不是讓 Lead 去猜。

**已確認根因（2026-11-04，查 team task journal 與 `src/team-orchestration.ts`）：**
1. 先前所有成功的驗收卡（`merge-ok`、`loop-ok`、`fix-accept`…，task journal 的 `coding` 欄位是 `null`）都是**不帶 `--coding`** 指派的；只有這兩張失敗的帶了 `--coding`（`coding` 欄位有內容、`codingMode: true`）。所以這不是回歸，也不是重啟後的偶發，是我（Agent）驗收時多帶了旗標。
2. `--coding` 的規劃提示同時要求「Lead 不可用空計畫自己實作」與「只能指派清單上的 Worker 目標、不可指派自己」（`planningInstruction`），SPEC 也規定 review 必須是與作者不同的 session。`--worktree` 會把路由切到新建的 workspace，那裡只有 Lead 一個 Agent、沒有勾選的 profile，所以 `Workers:` 清單是空的——這個組合**結構上無解**。
3. 第二次卡在 `planning` 是同一個無解情境下的另一種 Lead 反應：回覆沒有傳輸標記，bridge 一直等標記，直到取消。「回覆沒有標記就無限等」是既有行為（不限於 `--coding`），**尚未調查是否該另設逾時**，本次不處理。

修正範圍（2026-11-04）：新增 `src/coding-roster.ts` 的 `assertCodingRoster`；`src/main.ts` 的 `startTeamTask` 在算出 Workers（同 workspace 的 Team pane ＋ 勾選的 profile）後、啟動前呼叫它：`--coding` 且 Worker 為 0 就丟錯誤，說明原因並建議不帶 `--coding` 指派。`card assign --worktree --coding` 因為 worktree 先於任務建立，錯誤走既有路徑（「worktree 已建立…任務沒有啟動，卡片仍是 ready」），可直接改用不帶 `--coding` 的 `card assign <id>` 重試。`team ask --coding` 沒有 Worker 時同樣直接拒絕。

測試（2026-11-04，本機 macOS，非 CI）：新增 `test/coding-roster.test.ts` 3 項（0 個 Worker 的 coding 任務被拒絕且訊息含原因與出路、有 Worker 或 profile 可通過、非 coding 任務不受影響）。`npm run check` → 1126 tests、1125 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：重啟新版 bridge 後，真實的 `card assign <id> --worktree --coding`／`team ask --coding` 在零 Worker 時的錯誤訊息；有 Worker 時 `--coding` 仍能正常啟動；`card assign --coding` 搭配 `--worktree` 在有 profile 時能不能用（結構上沒驗過）。「回覆沒有傳輸標記就無限等」另作評估。

限制：只擋「完全沒有 Worker」；Worker 存在但都忙或不合用的情況由既有流程處理。

下一步：merge 本 PR、重啟 bridge；用 L1 下的一張無害卡，`card assign <id> --worktree --coding` 確認被拒絕、訊息清楚、卡片仍是 ready。

## ISSUE-086：`card assign --coding` 的 Lead 已回合格的 JSON 計畫，bridge 卻判「did not return a JSON Assignment plan」

更新日期：2026-11-05。狀態：已驗收（症狀：窄 pane 下 Lead 規劃被判無計畫；PR #100 已 merge，bridge 於 2026-11-05 用 `./scripts/run.sh -r` 重啟載入 `e0ffc57`，窄 pane 實機驗收通過，見下；根因仍是「高度可能」而非實測——失敗當時 bridge 收到的文字沒有留存，但同樣情境修正後不再失敗）。

使用者可見症狀：有 Worker 的 workspace（Lead claude `w1X:p1`、Worker codex `w1X:p2`）下 `card assign REQ-20261105-roster-worker --coding`，bridge 回「Team Task accepted」，約 5 秒後「Team Task failed：Lead did not return a JSON Assignment plan」。Lead pane 實際輸出了完整的 `BRIDGE_BEGIN_… {"assignments":[{"id":"a1","workerPaneId":"w1X:p2","role":"implement","access":"write","writeScope":["tmp-roster-ok.txt"],…}]} BRIDGE_END_…`。

預期行為：Lead 回合格計畫時 task 進入派工。

重現方式／環境：2026-11-05 本機 macOS，政策 L1，bridge 載入 main `ad5d30c`（以 `./scripts/run.sh -r` 重啟）；task `task-8661b3cc-bc30-49d0-b521-9255c06f9b08`；journal 事件順序 `plan_requested` → `turn_dispatched`（01:17:40）→ `turn_settled`（01:17:44）→ `task_failed`；console 當時有 `hook Stop … chars=482`。只重現一次，**未確認是否穩定**。

已確認：把 pane 上那份計畫原文直接餵給 `dist` 的 `parseAssignmentPlan`（`codingMode=true`）能成功解析，所以不是計畫內容或解析器本身的問題。

**調查（2026-11-05）：**
- 重現迴圈（離線、約 1 秒、可重跑）：把同一份計畫放進模擬的 Claude 畫面，經 `normalizeTerminalResponse("claude", …)` → 取 `BRIDGE_BEGIN…END` 之間 → `parseAssignmentPlan`。不換行（寬畫面）→ 成功；模擬 81 欄 pane 換行 → **失敗，訊息就是「Lead did not return a JSON Assignment plan」**，與症狀一致。
- 機制（程式碼閱讀＋上面的重現）：`runTeamTurn`（`src/team-turn.ts`）對 Claude Lead 只讀終端畫面，`claudeResponseText` 只剝掉續行的 2 格縮排、保留換行；Claude Code 自己會依 pane 寬度硬換行，所以 JSON 的 key 或字串被換行切開（例如 `"acces⏎s"`），`JSON.parse` 失敗。Codex 有 `unwrapCodexJson` 處理，Claude 沒有。實際失敗時 Lead pane 寬度只有約 81 欄（`w1X` 左右對分），而之前成功的任務多半在整欄寬的單 pane。
- **仍未確認：** bridge 當時實際收到的文字（沒有診斷紀錄）；換行也不能無損還原（硬切在 token 中間要直接接起來，在單字之間則原本被吃掉一個空白），所以單靠解析端修補有取捨；`hook Stop` 事件本身帶有完整未換行的回覆（`chars=482`），但 `runTeamTurn` 目前不使用它。

修正範圍（2026-11-05，使用者選定候選 (1)）：`src/team-turn.ts` 的 `TeamTurnContext.hookFinal`——`runTeamTurn` 記下本回合開始時間，Agent 回到 idle／done 後先查 hook 的 Stop 訊息並取框內內容（`terminal: false`，不經畫面解析）；畫面已見到框但 hook 事件未到時最多再等 1.5 秒；沒有 hook 時照舊讀畫面。`src/team-orchestration.ts` 把 `hookFinal` 傳給規劃／統整／Worker 的回合；`src/team-task-engine.ts` 新增建構子參數；`src/main.ts` 以 `hookEvents` 與 `hookTransport` 設定實作（僅 `auto` 模式、依 session id 或 pane ID 比對）。未採用的候選：(2) 在解析端接回換行（空白無法無損還原）、(3) 要求 Lead 輸出單行 JSON（不可靠）。

測試（2026-11-05，本機 macOS，非 CI）：`test/team-turn.test.ts` 新增 3 項（畫面框被換行切斷時採用 hook 完整訊息；沒有 hook 訊息時寬限後仍用畫面；hook 查詢帶本回合開始時間）。`npm run check` → 1129 tests、1128 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：重啟後在窄 pane（約 81 欄）重跑 Claude Lead 的 `card assign --coding`，確認 task 進入派工；Codex／agy／pi 的 hook 訊息是否也帶完整框（只改了共用路徑，未逐一實測）；hook 事件比寬限時間更晚到時仍會退回畫面（此時窄 pane 仍可能失敗）；沒有 hook 的 Claude（未安裝）仍受換行影響。

**2026-11-05 窄 pane 實機驗收通過（本機 macOS，政策 L1，bridge 載入 main `e0ffc57`）：** 手動建 workspace `w1Y`（claude Lead `w1Y:p1`、codex Worker `w1Y:p2` 左右對分，與先前失敗的 `w1X` 相同配置，`team add w1Y:p2`），驗收卡 `REQ-20261105-narrow`（新增暫存檔、不 commit／push），`card assign REQ-20261105-narrow --coding`。結果：console 出現 `hook Stop … pane=w1Y:p1 chars=456`，Lead 的計畫被接受，Assignment `a1` 在 `w1Y:p2` 開始並完成，Worker 實際建出 `tmp-roster-ok.txt`（內容 `ok`），task 進入 coding stage `review`——**先前失敗的「規劃」這一步已通過**。之後我取消任務（`team cancel`）並收尾：關 workspace、刪暫存檔、移除 worktree、刪分支與驗收卡、路由切回 `w1:p1`。

**這次驗收沒有涵蓋：** coding 任務的 review／verification 階段與最終 synthesis（取消前停在 review）；Codex／agy／pi 作為 Lead 時的 hook 訊息；hook 事件晚於 1.5 秒寬限時的退回行為。另觀察到 console 有一筆 `hook Stop session=01a1a968 pane=w4:p1`，在 Worker 完成時出現，pane 不是 `w1Y:p2`（**2026-11-05 先前的結論有誤，已更正：**當時以為 `session=01a1a968` 是使用者自己在 `w4` 的 codex 剛好同時結束回合；後來發現 `~/.codex/sessions` 裡 `01a1a968-…` 的 rollout 工作目錄是 `…/worktrees/Herdr_Discord_Bridge/narrow`，就是驗收用 Worker `w1Y:p2` 的 session。也就是 Worker 的 hook 事件確實被記在 `w4:p1`——hook 帶錯 pane，原因見 ISSUE-088（codex app-server daemon 的環境變數）。對派工配對的影響：Worker 本身沒有 `agent_session`，派工仍靠畫面／transcript 完成；但 hook 事件與獨立 review 的身分判斷受影響，見 ISSUE-088。以下是當時錯誤的舊結論，保留供對照：限制：驗收用的 Worker pane `w1Y:p2` 已關閉，無法再比對它自己的 session，所以「Worker 本身有沒有送 hook」沒有證據；它的 Assignment 仍正常完成，因為 Codex 另有 transcript 與畫面讀取）。

修正範圍：無。測試：無新增。

未驗證：是否與 `hookTransport` 為 `auto` 時 hook 回覆與標記截取有關；用 `hookTransport: parser` 是否可避免；非 `--coding` 的規劃是否也會發生；沒有 `--worktree`、沒有 `team add` 的情境。

下一步：重現並取得 bridge 實際收到的 Lead 回覆文字（capture diagnostics 或加診斷紀錄），再判斷根因；與 ISSUE-085 分開處理，ISSUE-085 的零 Worker 檢查不受影響。

## ISSUE-087：`--coding` 規劃驗證要求每個唯讀指派「直接」依賴 writer，Lead 的合理鏈狀計畫被判失敗，且提示沒說明這條規則

更新日期：2026-11-05。狀態：已驗收（PR #103 已 merge，bridge 於 2026-11-05 重啟載入 `50daa86`；實機驗收 task `task-d429e276…` 的計畫通過驗證，見 ISSUE-085）。

使用者可見症狀：`card assign <id> --coding`，有 Lead 與兩個 Worker 時，約 5 秒後「Team Task failed：read-only coding assignments in a writer round must depend on that writer」，task 在派工前結束，Worker 完全沒動。

預期行為：Lead 依序規劃「實作 → review → 驗證」且後者依賴前者時，計畫應被接受並執行；或在提示中清楚告知必須怎麼寫，失敗時給 Lead 一次修正機會，而不是整個 task 失敗。

重現方式／環境：2026-11-05 本機 macOS，政策 L1，bridge 載入 main `e0ffc57` 之後（含 ISSUE-085／086 修正），task `task-88b36ba2-0380-423f-9f90-695e1a8b72ed`。Lead 的計畫：`impl-1`（write，Worker `w1Z:p2`，`dependsOn: []`）、`review-1`（read，`w1Z:p3`，`dependsOn: ["impl-1"]`）、`verify-1`（read，`w1Z:p3`，`dependsOn: ["review-1"]`）。只重現一次，**未確認 Lead 每次都會這樣排**（但鏈狀依賴是自然的寫法）。

已確認根因（程式閱讀，2026-11-05）：`src/coding-workflow.ts` 的 `validateCodingRound`（約 260 行）要求同一輪內「每個非 writer 的指派」的 `dependsOn` **直接**包含 writer 的 id，不接受經由 review 的傳遞依賴。`codingPlanningAddendum()` 只說「Dependencies still refer only to this round」，**沒有說明必須直接列出 writer**。所以 `verify-1` 只依賴 `review-1` 就違規。這條規則的目的（唯讀指派要等 writer 完成）傳遞依賴同樣滿足，因此是提示與驗證不一致，不是 Lead 亂排。另外驗證失敗直接讓 task 失敗，沒有讓 Lead 重新規劃一次的機會（既有行為）。

修正範圍（2026-11-05，使用者選定候選 (1)）：`src/coding-workflow.ts` 的 `codingPlanningAddendum()` 新增一句，明說「同一輪有 writer 時，其他每個指派（diagnose、review、verify）都必須在自己的 dependsOn 直接列出 writer 的 id；只經由另一個指派間接依賴會被拒絕；可以再加其他依賴，例如 verify 同時依賴 review」。**驗證邏輯沒有放寬。**

測試（2026-11-05，本機 macOS，非 CI）：`test/coding-workflow.test.ts` 新增 1 項（提示文字含該規則；鏈狀計畫 `verify` 只依賴 `review` 仍被拒絕、`verify` 依賴 `["impl","review"]` 被接受）。`npm run check` → 1130 tests、1129 pass、0 fail、1 skip（既有）；`npm run lint` ok。

候選修法（使用者選了 (1)，其餘未採用）：(1) 在 `codingPlanningAddendum` 明說「每個 review／verify／diagnose 指派都必須把 writer 的 id 直接放進 dependsOn（可再加其他依賴）」——不放寬檢查，改動最小；(2) 把檢查改成接受傳遞依賴（放寬驗證，需確認不影響排程順序的保證）；(3) 驗證失敗時把錯誤回給 Lead 重排一次。

未驗證：Lead 是否會照新提示列出 writer（模型行為，只有實機能驗）；Lead 換成其他 Agent 時是否也會這樣排；修正後 `--coding` 能否真的跑完 review／verify／統整（這部分連 ISSUE-085 的「完整跑完」都還沒驗到）。

下一步：merge 後重啟 bridge；重做 `REQ-20261105-full` 型驗收（claude Lead + 兩個 codex Worker），確認 task 走到 `ready-to-integrate` 與最終統整。

## ISSUE-088：新開的 codex pane 沒有 `agent_session`，`--coding` 的獨立 review 被擋（unknown reviewer identity）

更新日期：2026-11-05。狀態：已驗收（身分判定部分在 2026-11-05 先驗收；codex Worker 完整跑完在 ISSUE-089 修好後也已驗收，task `task-f201a376…`）。PR #106 已 merge，bridge 於 2026-11-05 用 `./scripts/run.sh -r` 重啟載入 `bbd05c8`；用兩個新開的 codex Worker 實機驗到 author／reviewer 身分由 rollout 辨識、獨立 review 通過（見下）。**`--coding` 用 codex Worker 完整跑完仍未成功**：verify 階段另有問題，見 ISSUE-089。

使用者可見症狀：`card assign <id> --coding`，Worker 是新開的 codex pane 時，實作完成後 `review` 失敗：「unknown reviewer identity is not an independent review」，`verify` 因依賴 review 沒有執行，task 失敗（`task-2e9a15a0-73ff-4e14-8fcd-dbf8f31069d9`）。

預期行為：能確認 author／reviewer 是不同 session 時，獨立 review 通過；codex 與 claude 一樣能被識別。

重現方式／環境：2026-11-05 本機 macOS，codex v0.166.0，bridge 載入 main `50daa86`。workspace `w10`（新建 worktree `~/.herdr/worktrees/Herdr_Discord_Bridge/full2`），`herdr pane run <pane> codex` 啟動兩個 codex。`herdr pane get` 這兩個 pane **都沒有 `agent_session` 欄位**（`w10:p2` 甚至在完成一個回合之後仍沒有）；同機的 claude pane 啟動後立即有 `agent_session`（`source: herdr:claude`）。使用者自己的 `w3:p3` codex 也沒有，而 `w4:p1` codex 有（`source: herdr:codex`）。

**根因已確認（2026-11-05 調查）：codex 的 hook 是由長駐的 `codex app-server` daemon 執行，繼承的是 daemon 啟動當時的環境變數，不是各 pane 的。**
- 證據 1：`ps eww` 看到 daemon（pid 51075，自 10/28；pid 90269，自 10/30）的環境是 `HERDR_PANE_ID=w4:p1`、`HERDR_WORKSPACE_ID=w4`。Herdr 提供的 `~/.codex/herdr-agent-state.sh session`（SessionStart hook）用 `HERDR_PANE_ID` 回報 session，所以**每個新 codex session 都被回報成 `w4:p1`**，其他 pane 永遠沒有 `agent_session`，`w4:p1` 的 session 則被最後啟動的 codex session 覆蓋。
- 證據 2：先前驗收 Worker（`w1Y:p2`）的 session `01a1a968-…`，其 rollout 的 cwd 是 `…/worktrees/Herdr_Discord_Bridge/narrow`，但當時 `herdr pane get w4:p1` 顯示的就是這個 session；本次調查新開 codex（rollout `01a1a997-…`）後，`w4:p1` 的 session 變成了 `01a1a997-…`，而該 pane 本身（`w22:p1`）沒有 session。
- 證據 3（隔離）：手動把同一個 hook 腳本餵入 `SessionStart` JSON 並指定 `HERDR_PANE_ID=w22:p1`，`herdr pane get w22:p1` 立刻出現 `agent_session`——Herdr 端與腳本本身正常，問題只在 hook 的環境變數。
- `/hooks` 顯示 SessionStart 已安裝且 active（1/1），排除「hook 沒啟用／沒被信任」。
- 連帶影響（**未實測**）：bridge 自己的 `herdr-discord-hook`（Stop）也靠 `HERDR_PANE_ID`，所以 codex 的 Stop 事件都記在 `w4:p1`；以 pane 比對的路徑不會對到其他 pane，但 `w4:p1` 的 session 是「最後啟動的 codex」，使用者在 `w4:p1` 的 codex 若走 hook 路徑，可能拿到別的 codex session 的回覆——尚未重現。

**修法候選（使用者選定 (2)）：**（1）環境：停掉這兩個 daemon，讓它們不是從 Herdr pane 啟動——但沒有 `HERDR_*` 時 hook 腳本直接結束，仍然沒有 session，所以不是完整解法；（2）bridge：不依賴 hook 的 pane 對應，改由 codex 的 rollout（`~/.codex/sessions`，用 cwd＋時間或 prompt 內容）辨識 session——`CodexTranscript` 已在讀 rollout，可能可重用；（3）向 Herdr／Codex 回報：daemon 應該用每個 session 的環境執行 hook；（4）暫行：`--coding` 的 Worker 用 claude。

**修正範圍（2026-11-05，採 (2)）：**
- `src/response-stream.ts` 新增 `findCodexSessionByNonce(nonce, sinceMs)`：掃 `~/.codex/sessions`，只看本回合開始後有寫入的 rollout，檔案內容含本回合 nonce 者的檔名 UUID 即 session；恰好一個才回傳，否則 undefined。
- `src/team-turn.ts`：`TeamTurnContext.observeSession` 為真且 Agent 是 codex 時，回合結果多帶 `session`。`src/team-orchestration.ts`：coding 任務的 Worker 回合開啟它，並把結果傳給 `onAssignmentDone`。
- `src/team-task-engine.ts`：codex 的 author／reviewer 身分只認 rollout 觀察值（不採 Herdr 的 `agent_session`）；codex reviewer 派工前只擋同一個 pane，完整的獨立性檢查移到 review 入帳時（`assertIndependentReview`），不獨立就記 `independentReview: false`＋`independenceFailure`、verdict 改 inconclusive。其他 Agent 維持派工前檢查。`src/coding-workflow.ts` 新增 `independenceFailure` 欄位。
- **刻意的行為變化：** codex reviewer 身分不明時，review 會先跑完才被判不獨立（原本在派工前就拒絕），多花一次 codex 額度；結果仍是 fail closed——沒有通過的 review，task 不能完成。

測試（2026-11-05，本機 macOS，非 CI）：新增 4 項——`test/response-stream.test.ts` 2 項（nonce 對到唯一 rollout 回傳 session；無符合、多個符合、過舊檔案、不合格 nonce、不存在的目錄都回 undefined）；`test/coding-workflow.test.ts` 2 項（codex pane 沒有 agent_session 時仍由 rollout 得到獨立 review 並完成；reviewer 與 author 共用 rollout session 時不獨立、task 失敗）。既有「same-session／unknown reviewers」測試改成新語意（review 會跑完但不算通過）；測試 harness 讓假 codex 寫出 rollout。`npm run check` → 1134 tests、1133 pass、0 fail、1 skip（既有）；`npm run lint` ok。

**2026-11-05 codex Worker 實機驗收（身分部分通過）：** 本機 macOS，政策 L1，bridge 載入 main `bbd05c8`。workspace `w23`（claude Lead `w23:p1`、兩個新開的 codex Worker `w23:p2`／`w23:p3`），驗收卡 `REQ-20261105-full4`，`card assign REQ-20261105-full4 --coding`（task `task-afbaeab7-c24c-4f26-aa12-fd51369abbdf`）。結果：Herdr 對這兩個 codex pane 沒有 `agent_session`，但 task journal 的 artifact 記錄 `implement` 的 `authorSession = 01a1a9c2-…b714eae4ad`、`review` 的 `reviewerSession = 01a1a9c2-…a4858d4bc7`（兩個不同的 session，由 rollout 辨識），`independentReview: true`、`verdict: pass`，coding 階段進到 `verify`——這正是先前被擋住的「unknown reviewer identity」那一步，現在通過。之後 `verify` 失敗，見 ISSUE-089，task 最終 failed（blocked）。收尾：關 workspace、刪暫存檔、移除 worktree、刪分支與驗收卡、路由切回 `w1:p1`。

未驗證：用真的 codex Worker（兩個新開的 codex pane）跑 `--coding` 完整流程；codex 的 rollout 內容是否一定含完整 prompt（nonce）——目前依 rollout 記錄使用者輸入的行為；掃描大量或很大的 rollout 的耗時（單檔上限 64 MiB）；hook 路徑對 `w4:p1` 的連帶影響（未實測，未處理）。

已確認：bridge 的 `assertIndependentReview`（`src/coding-workflow.ts`）要求 reviewer 與 author 都有可辨識的 session，缺任何一個就拒絕——這是設計（不能只靠不同 pane 當作獨立）。`~/.codex/hooks.json` 有 `herdr-agent-state.sh session` 與 `herdr-discord-hook`。（先前猜測的「新工作目錄的 hook 需要信任」已被排除，真正原因見下。）

修正範圍：無。

未驗證：codex 作為 author、claude 作為 reviewer 的混合配置是否可行（author 沒有 session 也會被擋）；上述連帶影響；其他 Herdr 版本／不是從 pane 啟動 daemon 的情況。

暫行做法：驗收 `--coding` 時 Worker 用 claude（有 session）。

下一步：merge 後重啟 bridge；用兩個新開的 codex Worker（claude 或 codex 當 Lead）重做 `--coding` 完整驗收；另可回報 Herdr／Codex 的 daemon 環境問題。

## ISSUE-089：codex Worker 的回合（review、verify）要等滿 timeout 才結算，verify 最後逾時失敗

更新日期：2026-11-05。狀態：已驗收（PR #108 已 merge，bridge 於 2026-11-05 用 `./scripts/run.sh -r` 重啟載入 `fbc2fee`；用 claude Lead＋兩個新開的 codex Worker 在原本失敗的窄 pane 配置下 `--coding` 完整跑完，見下）。

使用者可見症狀：claude Lead＋兩個新開的 codex Worker 跑 `card assign … --coding`，`impl` 約 20 秒完成，但 `review` 從派工到結算整整 300 秒（`turn_dispatched 03:32:12` → `turn_settled 03:37:12`），`verify` 派工後約 10 分鐘才失敗：「Timed out waiting for current response from w23:p3 (last state: done); no verified completion」，task 因「no successful verification for the current version」失敗。Worker 實際早就做完：pane 上有完整的 `BRIDGE_BEGIN … BRIDGE_END` 回覆，codex 顯示 `Worked for 12s`，pane 狀態也是 `done`。

預期行為：Worker 回覆完成後幾秒內結算；verify 結果被入帳。

重現方式／環境：2026-11-05 本機 macOS，bridge 載入 main `bbd05c8`，task `task-afbaeab7-c24c-4f26-aa12-fd51369abbdf`，`w23:p2`／`w23:p3` 為新開的 codex。只重現一次，**未確認是否穩定**。同一天稍早用 claude Worker（`w21`）時 review／verify 都正常，沒有這種延遲。

**根因已確認（2026-11-05 調查）：codex 的回覆比 pane 可視高度長時，Herdr 的終端讀取（visible／recent／recent-unwrapped／detection 四種來源）只剩最後幾列，`BRIDGE_BEGIN` 和前面的內容已經讀不到，`extractFrame` 找不到框，回合只能等到逾時。**
- 重現迴圈（約 10 秒～100 秒，可重跑）：對真的 codex pane 直接呼叫 `runTeamTurn`（腳本在 scratchpad `turn089.mjs`）。新開 codex、13 列高的 pane，prompt「印出 1 到 30，每行一個」→ **97.3 秒逾時**「Timed out waiting for current response … (last state: idle)」；`herdr agent read --source recent --lines 400` 只剩 `29`、`30`、`BRIDGE_END_…` 與輸入框。6 列高的 pane 連短回覆也逾時（兩次 ~98 秒）；把同一個 pane 放大（zoom，29 列）後同一個短回覆 9.2 秒完成；短回覆在 13 列 pane 6～10 秒完成。
- Herdr 這一側正常：`~/.config/herdr/herdr-server.log` 顯示失敗那次實機任務的 `agent.prompt` 在 03:32:12 收到、03:32:32 完成（20 秒）、verify 在 03:37:14～03:37:27（13 秒）完成；bridge 的 turn_settled 卻是 03:37:12，`verify` 則一直讀不到框，所以延遲／逾時是 bridge 讀不到框，不是 Herdr 的 `agent.prompt(wait)` 卡住。**先前「推測 Herdr 沒回報 settled」的說法是錯的，已更正。**
- 仍未解釋：實機 `review` 為何剛好在 300 秒時成功結算（可能是 pane 重繪後框剛好又可見），不影響上面的結論。

修正範圍（2026-11-05）：`src/response-stream.ts` 新增 `findCodexRolloutByNonce`（回傳 session、rollout 路徑與讀取起點），`findCodexSessionByNonce` 改用它，`CodexTranscript.fromRollout`；`src/team-turn.ts`：codex 回合在 idle／done 且還沒有 transcript 時，每秒最多一次用 nonce 找 rollout，找到就讀它的 `final_answer`（`terminal: false`），讀不到才退回終端畫面。rollout 的文字沒有 pane 寬度的硬換行，因此也一併避開下面提到的 codex 硬換行 JSON 問題（僅限找得到 rollout 時）。

測試（2026-11-05，本機 macOS，非 CI）：真實 codex pane 迴圈——修正前 97.3 秒逾時，修正後同一個 13 列 pane、同一個 30 行回覆 **6.7 秒**完成、30 行完整、`terminal=false`、session 由 rollout 取得。新增單元測試 1 項（終端只剩輸入框、框已捲出時從 rollout 取得 41 行完整內容與 session）。`npm run check` → 1135 tests、1134 pass、0 fail、1 skip（既有）；`npm run lint` ok。

**2026-11-05 實機驗收通過（本機 macOS，政策 L1，bridge 載入 main `fbc2fee`）：** workspace `w25`（claude Lead `w25:p1`＋兩個新開的 codex Worker `w25:p2`／`w25:p3`，pane 高度 14／13 列，與先前失敗的 `w23` 同配置），驗收卡 `REQ-20261105-full5`，`card assign REQ-20261105-full5 --coding`（task `task-f201a376-b1fd-4b89-9d34-412477ea4eed`）。結果：每個回合只花 3～30 秒，整個 task 從 05:20:01 到 `task_completed` 05:21:29 共 **88 秒**（先前同配置：review 等滿 300 秒、verify 逾時失敗）；artifact 記錄 `implement` 的 author session `…b642`（`04398e37…`）、`review` 的 reviewer session `…bb65`（`042f2d53…`，不同）、`independentReview: true`、`verdict: pass`、`verify` 的 `verificationPassed: true`、`evidence: recorded`；階段 `ready-to-integrate`，journal 最後事件 `task_completed`。**這是 `--coding` 第一次用 codex Worker 完整跑完，ISSUE-085／088／089 的整條路徑都通過。** 收尾：關 workspace、刪暫存檔、移除 worktree、刪分支與驗收卡、路由切回 `w1:p1`；沒有 commit／push。

未驗證（驗收未涵蓋）：（`parseCodingResult` 對硬換行 JSON 的缺口已補，見下方「後續補強」）；（rollout 很大時的耗時與 codex 當 Lead 的規劃回合已在 2026-11-05 補驗，見下方「補驗」。）

舊的觀察與推測（保留供對照）：
- 時序：`review` 剛好 300 秒、`verify` 約兩個 300 秒，與 `promptAgentAndWait` 的 timeout（`src/herdr.ts`，預設 300000ms）吻合——推測 Herdr 的 `agent.prompt(wait=…)` 沒有回報這次 prompt 的 settled lifecycle，於是被當成 `agent_prompt_stalled`，bridge 之後再多等一輪 deadline 才讀畫面或放棄。這是依時間推測，**尚未驗證**。
- 為什麼 `review` 在 300 秒後能讀到畫面框而 `verify` 不行，**未確認**。pane 畫面上 `verify` 的回覆框是完整的（`BRIDGE_BEGIN` … `BRIDGE_END`）。
- 獨立發現（**程式閱讀，未實測**）：`parseCodingResult`（`src/coding-workflow.ts`）不像 `card review`／`card fix` 那樣先用 `unwrapCodexJson` 還原 codex 的硬換行。codex 在窄 pane 會把 `{"codingResult":{"kind":"verify","commands":[{"command":"test -f tmp-full-⏎  ok.txt && …` 這種字串切斷，JSON 因而無效，`evidence` 會變 `missing`。這與上面的逾時是兩件事，但同樣會讓 codex 的 verify 無法入帳。

修正範圍：無。

未驗證：Herdr `agent.prompt(wait)` 對這些 codex pane 的行為（是否與 codex 狀態偵測有關，因為 codex 的狀態 hook 同樣被 daemon 環境影響，見 ISSUE-088）；逾時後為何讀不到畫面框；`parseCodingResult` 對硬換行 JSON 的實際行為。

**後續補強（2026-11-05，使用者指示「最後 fallback 用 TUI parser」，已修正、待實機驗收）：** 找不到唯一 rollout 而退回終端畫面時，codex 的 `codingResult` JSON 可能被 pane 寬度硬換行切斷。`src/team-task-engine.ts` 的 `onAssignmentDone` 對 codex 先照原文 `parseCodingResult`，失敗才用 `unwrapCodexJson`（codex 的 TUI 解析，只接回 JSON 字串內「換行＋兩格縮排」）再解析一次。測試（2026-11-05，本機）：`test/coding-workflow.test.ts` 新增 1 項（verify 回報的 command 字串被硬換行時仍記為 `evidence: recorded`、`verificationPassed: true`、task 完成）；暫時關掉修正時該測試**失敗**（紅），恢復後通過。`npm run check` → 1136 tests、1135 pass、0 fail、1 skip（既有）；`npm run lint` ok。**未實機驗收：**要找不到 rollout 又遇到硬換行的情境，實機不易刻意製造；只有單元測試證據。

**補驗（2026-11-05，本機 macOS，bridge 載入 main `bb41af8`）：**
- **codex 當 Lead：** workspace `w26`（codex Lead `w26:p1`＋兩個新開的 claude Worker），驗收卡 `REQ-20261105-full6`，`card assign … --coding`（task `task-952bb4db-0b45-4b3a-9306-64f4bdaa300d`）。Lead 的規劃回合走 rollout 路徑取得計畫，`implement-fixture`→`review-fixture`→`verify-fixture` 依序完成，`independentReview: true`、`verdict: pass`、`verificationPassed: true`，階段 `ready-to-integrate`，約 118 秒 `task_completed`。收尾：關 workspace、刪暫存檔與驗收卡、路由切回 `w1:p1`。
- **rollout 掃描耗時（`findCodexRolloutByNonce`，nonce 在檔尾的最壞情況）：** 真實資料 37 個 rollout、最大 2.9 MB：3 MiB 檔 2 ms；5 個 10 MiB 檔 14 ms；1 個 63 MiB 檔 80 ms；3 個 63 MiB 檔 103 ms。掃描一次最多整檔讀入記憶體（單檔上限 64 MiB），且每秒最多一次，可接受。

下一步：無（主路徑已驗收）；後續補強合併後如日後在實機遇到 rollout 找不到的情況再確認。

## ISSUE-090：codex 的 hook 訊息可能被貼到錯的 pane（`w4:p1`），Discord 串流與核准補貼沒有檢查

更新日期：2026-11-05。狀態：已驗收（PR #110 已 merge，bridge 於 2026-11-05 重啟載入 `2e729fb`；在 `w4:p1` 實機重現出「session 被別的 codex 覆蓋」的狀態，並確認貼出的是 `w4:p1` 自己的回覆，見最下方「`w4:p1` 實機驗收」）。

使用者可見症狀（推論，**未實機重現**）：使用者透過 Discord 對 `w4:p1`（codex）送問題時，若另一個 codex session 在同一時間結束回合，bridge 可能把那個 session 的回覆貼成 `w4:p1` 的答案。

預期行為：每個 pane 只貼自己的回覆；對不上就退回畫面 parser。

根因（由 ISSUE-088 的調查延伸）：codex 的 hook 由長駐 `codex app-server` daemon 執行，環境是 `HERDR_PANE_ID=w4:p1`，所以：（1）Herdr 把每個新 codex session 都記到 `w4:p1`，使該 pane 的 `agent_session` 變成「最後啟動的 codex」；（2）bridge 的 Stop hook 事件也都帶 `paneId = w4:p1`。`streamAgent` 與 `relayApprovalFollowup` 用 `stopSince(agent_session)` 或 `stopForPane(pane)` 取 hook 訊息，兩條路對 `w4:p1` 都可能取到別的 codex 的回覆。Team 任務的 `runTeamTurn` 不受影響（訊息必須含本回合 nonce 才算）。另一個副作用（**未處理**）：`w4:p1` 的 `agent_session` 隨別的 codex 啟動而變動，`streamAgent` 會以「session changed」停止擷取，屬 fail-safe。

修正範圍（2026-11-05）：新增 `src/codex-session.ts`：`hookReplyTrusted(agent)`——非 codex 一律放行；codex 必須有 id 型 session，且該 session 的 rollout（`~/.codex/sessions/…/rollout-…-<id>.jsonl` 第一行 `session_meta`）的 `cwd` 等於 pane 的 `cwd` 或 `foreground_cwd`，否則視為不可信。`src/main.ts` 的 `streamAgent`（hook 最終訊息，含 `stopForPane`）與 `relayApprovalFollowup`（核准後補貼）在不可信時改走畫面 parser／不補貼。查不到 rollout 時一律不採用 hook（fail closed，結果是較慢、不是貼錯）。

測試（2026-11-05，本機 macOS，非 CI）：新增 3 項——`test/codex-session.test.ts` 2 項（rollout cwd 對得上才信任；別人的 session、沒有 session、查不到 rollout、cwd 不同都不信任；claude／agy／pi 不受影響）；`test/hook-events.test.ts` 1 項（別的工作目錄的 codex 回覆不會貼到這個 pane；暫時讓檢查一律放行時該測試**失敗**，恢復後通過）。既有 4 個 codex hook 測試改用真正的 UUID session 與 rollout。`node --test --test-timeout=60000 dist/test/*.test.js` → 1139 tests、1138 pass、0 fail、1 skip（既有）；`npm run lint` ok。

意外發現（記錄）：第一次修改後，既有的「Codex Stop hook also completes the stream」測試因假 session id 被判不可信而永遠等不到完成，`npm run check` 卡了約 19 分鐘；這是預期的行為變化（codex 的 hook 不再無條件信任），測試已更新。之後以 `--test-timeout` 跑，避免再卡住。

未驗證：用真的 `w4:p1` 或其他 codex pane 經 Discord 發問，確認 hook 被正確採用或退回 parser；同一工作目錄開兩個 codex 時 cwd 仍無法區分（hook 訊息仍可能對錯 session，此時 `session` 本身通常也錯，風險較低但未量化）；legit codex 在 session 中途 `cd` 後 cwd 對不上會退回 parser（較慢但安全）。

限制：這只是減輕風險；根本原因（daemon 環境）仍在 Herdr／Codex，見 ISSUE-088 的修法候選（3）。

**2026-11-05 實機檢查（本機 macOS，bridge 載入 main `2e729fb`，經 bridge console）：**
- 唯讀：對 live 的 codex pane 呼叫 `hookReplyTrusted`：`w3:p3`（你的 codex，無 session）→ `trusted=false`；新開的 `w27:p1`（無 session）→ `trusted=false`。當時 `w4:p1` 已不是 codex Agent（`herdr agent list` 沒有它），所以**無法**對 `w4:p1` 實測。
- 端到端：新開 `w27` 的 codex（工作目錄為本 repo），`wk use w27`、`agent use w27:p1`，從 bridge console 送「只回覆 bridge-test-090」→ console 收到 `bridge-test-090`（畫面 parser 路徑，因為沒有可信 session）。同時 console 出現 `hook Stop session=01a1aa51 pane=w4:p1 chars=105`——證實 hook 事件仍被記在 `w4:p1`（ISSUE-088 的根因），且該事件**沒有**被用在 `w27:p1` 的回覆上。收尾：關 workspace、路由切回 `w1:p1`。
- **這證明：** 修正沒有弄壞 codex 的正常串流（退回 parser 仍正確回覆）；hook 事件確實帶錯 pane。**這沒證明：** 「hook 可信時仍被採用」（沒有任何 live codex pane 的 session 對得上，無法驗）；「`w4:p1` 不會貼到別人的回覆」（`w4:p1` 當時不是 codex）。

**`w4:p1` 實機驗收（2026-11-05，本機 macOS，bridge 載入 main `2e729fb`，使用者同意在 `w4:p1` 啟動 codex）：**
1. 在 `w4:p1`（`python_test`）啟動 codex（`codex -a on-request -s read-only`）：它自己的 session `01a1aa56-…`，rollout 工作目錄 `~/git_wk/python_test` = pane 工作目錄 → `hookReplyTrusted = true`（hook 可信時被採用的對照組）。
2. 在另一個 workspace（本 repo）新開 codex 並送一個提問：`w4:p1` 的 `agent_session` 被覆蓋成 `01a1aa57-…`，其 rollout 工作目錄是 `~/git_wk/Herdr_Discord_Bridge`，≠ `w4:p1` 的 `python_test` → `hookReplyTrusted = false`（**重現出 ISSUE-088／090 的錯位狀態**）。
3. 用 bridge console（`wk use w4`、`agent use w4:p1`）對 `w4:p1` 送「只回覆 w4-own-reply」，並在 1 秒後讓另一個 codex 回「foreign-2」。console 出現 `hook Stop session=01a1aa57 pane=w4:p1 chars=9`（別人的回覆，剛好等於 `w4:p1` 被覆蓋後的 session）與 `hook Stop session=01a1aa56 pane=w4:p1 chars=102`（`w4:p1` 自己的），最後**貼出的是 `w4-own-reply`**。修正前，`streamAgent` 會對 `w4:p1` 採用 session `01a1aa57` 的 hook 訊息（`foreign-2`），這就是隱患；修正後該訊息被忽略、改走畫面 parser，回覆正確。
- 附帶發現：我用 `herdr pane run` 在 `w4:p1` 輸入 `codex -a on-request -s read-only` 後，codex 的畫面上第一則使用者訊息就是這串指令文字，它因此自己做了一次網路搜尋（唯讀沙箱、無檔案變更）後回到 idle。**原因未確認**（推測是我輸入時前景已有 codex 在接收輸入；我事前讀到的畫面是 shell 提示字元，可能是過時的）。屬我的操作疏失，已告知使用者；沒有造成設定或檔案變更。
- 收尾：關掉我開的測試 workspace，路由切回 `w1:p1`；`w4:p1` 的 codex 依使用者要求保持執行。

下一步：無（已驗收）；根本原因（daemon 環境）仍在 Herdr／Codex，可考慮回報。

## ISSUE-091：profile 啟動的 Worker 一律被判「未就緒」，Lead 自行分派的 `--coding` 任務在派工前失敗

更新日期：2026-11-05。狀態：已驗收（PR #112 已 merge，bridge 於 2026-11-05 用 `./scripts/run.sh -r` 重啟載入 `0fac55b`；實機驗收見下方「E14 實機驗收」：Lead 自行啟動 profile 當 Worker 的 `--coding` 完整跑完）。

使用者可見症狀：在 `w29`（只有 claude Lead）用 `team select` 勾選 `helper`、`reviewer`、`claude` 三個 profile 後，`card assign … --coding`。Lead 的計畫沒有問題（`impl`→`helper`、`review`→`reviewer`、`verify`→`claude`），但 `impl` 立刻失敗：「started Agent does not match requested profile/workspace or is not ready」，`review`、`verify` 因依賴失敗而沒執行，task `task-8fa522c1-e078-461d-8cae-7de1cfa8c003` 失敗。同時 pane `w29:p2` 其實已經正常啟動了 codex 並進入 idle。

預期行為：profile 啟動完成、CLI 就緒後才派工。

重現方式／環境：2026-11-05 本機 macOS，Herdr 當前版本，bridge 載入 main `2e729fb`。重現迴圈（約 10 秒，可重跑；腳本在 scratchpad `start091.mjs`）：對 live 的 Lead pane 直接呼叫 `HerdrClient.startProfile(lead, { kind: "codex" })` 並印出剛回傳那一刻的 Agent：**0.7 秒就回傳**，回傳的記錄沒有 `agent` 欄位、`agent_status` 是 `unknown`；之後 +1 秒仍 `unknown`、+3 秒 `working`、+8 秒 `idle`。

已確認根因：Herdr 的 `agent.start` 在約 1 秒內回傳，這時新 pane 還沒被偵測成該 CLI（需要約 2 到 8 秒，與追蹤清單 E9 記的「Agent 約 2–4 秒才被偵測到」一致）。`AgentPool.acquire`（`src/agent-pool.ts`）卻在 `startProfile` 回傳後立刻檢查 `agent.agent === kind` 且狀態 idle／done，所以一定失敗。這條路徑（Lead 自行啟動 profile 當 Worker）先前的 `--coding` 實機驗收都沒走過——那些 Worker 都是手動開好、用 `team add` 加進去的 pane。

修正範圍（2026-11-05）：`src/agent-pool.ts` 新增 `waitUntilReady`，`acquire` 在 `startProfile` 之後持續（每 0.3 秒）重讀同一個 pane，最多 `readyTimeoutMs`（預設 30 秒），直到偵測到預期的 CLI 且 idle／done；偵測成別的 CLI 時立刻失敗（不等）；逾時回傳最後狀態，由原本的檢查丟出原本的錯誤。

測試（2026-11-05，本機 macOS，非 CI）：`test/agent-pool.test.ts` 新增 3 項（啟動後 0.6 秒才被偵測成 codex、1.2 秒才 idle 時會等到就緒；一直不就緒仍以原錯誤失敗；偵測成別的 CLI 立刻失敗、不到 2 秒）。暫時拿掉等待時第一項**失敗**（紅），恢復後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1142 tests、1141 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：重啟 bridge 後在 live 重跑上述 `w29` 型的任務（勾選 profile、Lead 自己分派），確認 Lead 啟動 helper／reviewer 並走到 `ready-to-integrate`；claude profile 當 Worker 的身分辨識與「信任這個資料夾」提示（E9）仍未驗；agy、pi 當 Worker 未驗。

後續（E14，2026-11-05，使用者決定先用 claude、codex 把自動流程串起來）：同一個 PR 也實作了「`--coding` 沒有指定任何 Worker 時自動啟用 claude／codex profile」（`src/coding-roster.ts` 的 `autoEnableCodingProfiles`，`src/main.ts` 的 `startTeamTask` 呼叫；agy、pi 先排除；有指定一律照指定）。測試（2026-11-05，本機）：`test/coding-roster.test.ts` 新增 2 項（沒指定時啟用 helper／reviewer／claude 且排除 agy、pi；可用 profile 少於兩個時什麼都不啟用、仍被拒絕）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1144 tests、1143 pass、0 fail、1 skip（既有）；`npm run lint` ok。詳見追蹤清單 E14。**未實機驗收**——需 merge 後重啟 bridge，用 `card assign … --worktree --coding` 實跑。

**E14 實機驗收（2026-11-05，本機 macOS，政策 L1，bridge 載入 main `0fac55b`）：** 在 workspace `w2B`（只有一個 claude Lead，沒有勾選任何 profile，`team pool` 全部未勾）執行 `card assign REQ-20261105-e14 --worktree --coding`（task `task-431598d1-c6a9-4414-b73a-b0cfc7216869`）。結果：
- console 記「--coding 沒有指定 Worker；workspace w2C 自動啟用 profile：helper, reviewer, claude」；bridge 建好 worktree（分支 `card/REQ-20261105-e14`）與新 workspace `w2C`，並在其中啟動同種 Agent 當 Lead。
- Lead 自行分派：`implement-1`→`profile:helper`（codex）、`review-1`→`profile:reviewer`（codex）、`verify-1`→`profile:claude`（claude）；三個 Worker 都由 bridge 啟動（`new-session`）且就緒後才派工（ISSUE-091 的修正生效，先前同型任務在此失敗）。
- artifact：`implement`、`verify`（`verificationPassed: true`）、`review`（`independentReview: true`、`verdict: pass`），階段 `ready-to-integrate`；journal 最後事件 `task_completed`，從 07:04:21 到 07:05:59 共 98 秒，console 「Team Task completed」。
- 注意：`implement` 與 `review` 都是 codex（不同 profile、不同 session），獨立性由 rollout 辨識的 session 判定（ISSUE-088）。
- 收尾：關 workspace `w2B`、`w2C`，刪暫存檔、worktree、分支與驗收卡，路由切回 `w1:p1`；沒有 commit／push。
- 觀察到「信任這個資料夾」提示**沒有**出現：新 worktree 在 `~/.herdr/worktrees/…`（不在 `git_wk` 底下）也沒被擋；另做了隔離實驗（2026-11-05）：`git_wk` 底下的新子資料夾直接 idle、`git_wk` 以外的資料夾 `blocked` 並出現「Quick safety check」。Linked git worktree 沿用主 repo 信任是從觀察推論，未做隔離對照。

**未驗證：**agy、pi 當 Worker（E14 刻意先排除）；Lead 為 codex 或其他種類時 `--worktree --coding` 的自動啟用；profile 不足兩個時的實機拒絕（只有單元測試）。

下一步：無（已驗收）；進追蹤清單 H4 端到端案例。

## ISSUE-092：`--coding` 任務通過後沒有人 commit，`card pr` 無法接續（H4 端到端的第一個斷點）

更新日期：2026-11-05。狀態：已驗收（PR #114 已 merge，bridge 於 2026-11-05 重啟載入；`card commit` 在 H4 兩輪實機各成功一次，見下）。

使用者可見症狀（由程式閱讀確認，H4 端到端案例的準備階段）：`card assign --worktree --coding` 走到 `ready-to-integrate`（ISSUE-091／E14 已驗收）之後，驗證過的版本只是 worktree 裡的**未提交修改**。`--coding` 的規則禁止 Worker commit、push，bridge 本身也不 commit（SPEC）；但 `card pr` 要求分支上有比基準多的 commit 且 worktree 乾淨，否則拒絕：「worktree 有未提交的修改，請先 commit 或處理」。所以自動流程在這裡斷開，先前的驗收都是我或使用者手動補 commit。

預期行為：通過 review 與驗證的版本可以由 bridge 在嚴格條件下 commit 到卡片的分支（不 push），再接 `card pr`。

使用者決定（2026-11-05，AskUserQuestion）：選「bridge 新增 `card commit`」，而不是放寬 `--coding` 讓 writer commit，或維持手動。

修正範圍：新增 `src/card-commit.ts`（`commitVerifiedVersion`）、指令 `card commit <id>`（`src/card-command.ts`，`src/main.ts` 接線）、卡片事件 `committed`（`src/card-events.ts`）。條件與行為見 SPEC 的 `card commit` 段落。這是 bridge 第一次自己 commit，SPEC 中「Bridge 不執行 commit」的句子已改為列出這個例外。**沒有自動觸發**：第一版只能手動下，串成單一觸發留給後續。

測試（2026-11-05，本機 macOS，非 CI）：`test/card-commit.test.ts` 新增 6 項（真的 git repo：只提交已驗證的檔案、原本就存在的未追蹤檔不被帶進去且保留；task 未完成／階段不對／不是 --coding／沒有 task 都拒絕；驗證後內容被改就拒絕；分支或工作目錄不符就拒絕；暫存區原本就有東西就拒絕；已 commit 不重複）；`test/card-command.test.ts` 新增 3 項（成功時記 `committed` 並指向 `card pr`、不 push；失敗時顯示原因且不記錄；參數與卡片檢查）。

未驗證：實機（真的 `--coding` 任務之後 `card commit` → `card pr`）；git hook（pre-commit）失敗時的回報；repo 沒有設定 git 使用者時的錯誤訊息；`card loop` 自動呼叫（沒做）。

下一步：merge 後重啟 bridge，用真的卡跑 H4：`card assign --worktree --coding` → `card commit` → `card pr` → `card loop --merge`（merge 需要使用者把政策暫時設成 L2）。

**實機驗收（2026-11-05，本機 macOS，政策 L2，bridge 載入 main `4511651` 之後）：** H4 第一輪卡 `REQ-20261105-h4b`：`card commit` → 「已 commit 到分支 card/REQ-20261105-h4b（c65cd471e501）：docs/h4-e2e-trace.md…沒有 push」，worktree 乾淨，commit 只含該檔；第二輪卡 `REQ-20261105-h4c`（刪除檔案）：`card commit` → commit `9bbe3f38a497`，刪除也被正確提交。兩次之後 `card pr` 都成功（PR #116、#118），代表分支上有 commit 且 worktree 乾淨的前提成立。**未驗證：** pre-commit hook 失敗、repo 沒有 git 使用者時的訊息；`card loop` 自動呼叫（沒做）。

## ISSUE-093：Lead 漏排 verify 就回空計畫，驗收閘門失敗且沒有補救機會（H4 端到端的第二個斷點）

更新日期：2026-11-05。狀態：已驗收（H2 自動撿卡 L2 第一次嘗試的 task journal 顯示閘門回饋確實觸發，見下；PR #115 已 merge，bridge 於 2026-11-05 重啟載入）。

使用者可見症狀：H4 端到端案例 `REQ-20261105-h4`（`card assign … --worktree --coding`，task `task-0342e935-5be0-42af-93b6-d2df82fd55f3`，workspace `w2E`）：Lead 只排了 `write-h4-file`（implement，`helper`）與審查（`reviewer`，pass、findings 為空、與作者是不同 session），沒有排 verify 就回了空計畫；bridge 的閘門判「no successful verification for the current version」，整個 task failed。實作與獨立 review 都是好的（兩份 artifact 同一個指紋）。先前 7 次實機 coding 任務 Lead 都自己排了 verify，只有這次漏掉，屬模型行為的變異；流程卻因此沒有補救機會。

預期行為：閘門還缺什麼時，Lead 有機會補排，而不是直接失敗。

已確認根因（程式閱讀，`src/team-orchestration.ts`）：規劃迴圈在 Lead 回空計畫時直接 `break` 進入統整；閘門只在統整前後評估一次，原因只放在統整提示（那時已經不能再派工）。規劃提示只帶 `evidenceSummary()`（階段、artifact），不告訴 Lead 閘門缺什麼。

修正範圍（2026-11-05）：規劃迴圈在 coding 任務收到空計畫、且 `assess()` 仍有未滿足的原因時，不 `break`，改把原因附在下一輪規劃提示（「The bridge acceptance gate is authoritative and is not satisfied yet: …，請排新的指派，例如在目前版本上的唯讀 verify」），最多兩次；兩次之後 Lead 仍回空計畫就維持原本的結案方式（以閘門原因 failed）。**閘門本身不放寬**：仍然要有通過的獨立 review 與成功的 verify。

測試（2026-11-05，本機 macOS，非 CI）：`test/coding-workflow.test.ts` 新增 2 項——Lead 漏排 verify 就回空計畫，bridge 回饋一次原因後補排 verify，task 完成、階段 ready-to-integrate、只送出一次回饋；Lead 一直回空計畫時只被詢問兩次，之後仍 failed 且原因是 no successful verification。暫時把上限改成 0 時兩項都**失敗**（紅），恢復後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1155 tests、1154 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機（真的 Lead 收到閘門原因後補排 verify）；閘門原因是 Lead 無法解決的（例如 changes outside the writer scope）時，兩次詢問只是多花兩輪；回饋是否讓 Lead 改成排錯的東西（例如再寫一次）——閘門仍會擋下。

H4 端到端進度：第一次嘗試在此停住（`card commit` 與 `card pr` 都還沒跑到）。測試殘留：workspace `w2D`／`w2E`、worktree `card-req-20261105-h4`（含一個未提交的 `docs/h4-e2e-trace.md`）、分支 `card/REQ-20261105-h4`、卡片 `REQ-20261105-h4`（in_progress）；下一次用新卡重跑。

下一步：merge 後重啟 bridge，用新卡重跑 H4：`card assign --worktree --coding` → `card commit` → `card pr` → `card loop --merge`。


**H4 兩輪的觀察（2026-11-05）：** 兩輪實機 coding 任務 Lead 都自己排了 verify，所以閘門回饋**沒有被觸發**，這個修正仍只有單元測試證據，狀態維持「已修正、待驗收」。

**實機驗收（2026-11-05，task `task-cbc8ddf3-7de8-4e08-b9ae-38b185674efc`，bridge 載入含 #115 的版本）：**journal 顯示 Lead 在 review 之後回空計畫（seq 20）→ `coding_assessed`（閘門未滿足，seq 21）→ 再一次 `plan_requested`（seq 22，閘門回饋）→ Lead 補排 verify（`assignment_started`，seq 26）；同樣的循環在 verify 之後又發生一次（seq 35 → 40）。也就是 Lead 漏排／需要補排時，bridge 確實把閘門原因送回、Lead 確實補排了 verify。該 task 後來仍因 ISSUE-097（verify 的指令 exit code）失敗，與回饋機制無關。
## ISSUE-094：Lead 的 pane 被 profile Worker 一路切小，之後 `card review`／`card loop` 開不出 reviewer 的 pane（H4 端到端的第三個斷點）

更新日期：2026-11-05。狀態：已驗收（PR #117 已 merge，bridge 於 2026-11-05 重啟載入 `dfac751`；H4 第二輪 `card loop` 的 reviewer pane 開得出來，見下）。

使用者可見症狀：H4 端到端案例的第二次嘗試 `REQ-20261105-h4b`：`card assign --worktree --coding` 成功（Lead 自動啟用 helper／reviewer／claude 三個 profile，約 2 分 25 秒到 `ready-to-integrate`）、`card commit` 成功（commit `c65cd47`，worktree 乾淨、沒有 push）、`card pr` 成功（PR #116）。接著 `card loop REQ-20261105-h4b --agent codex --merge`：「loop 停下來了…停在 review。原因：review 沒有進行：基底 pane 太小，無法分割出 reviewer 的 pane（too small to split）」。

預期行為：reviewer 的新 pane 開得出來。

已確認根因：profile Worker 與 reviewer 的新 pane 都是從「基底 pane」（Lead 或作者）分割（`Herdr.startProfile`、`openReviewerPane`）。coding 任務連續啟動三個 profile Worker，每個都從 Lead 的 pane 分割出去，Lead 的 pane 只剩 6 列高（同 workspace 四個 pane 的高度是 6、29、13、6）；`card review` 之後再從這個 pane 分割時，低於門檻（往下切至少 16 列）就被拒絕。同一個版面裡其實還有 29 列高的 pane 可用。

修正範圍（2026-11-05）：新增 `src/pane-split.ts` 的 `chooseSplitTarget`：基底夠大照舊；太小就改選同一個版面裡面積最大且夠大的 pane 當分割對象；都不夠大才拒絕。`src/review-pane.ts` 的 `openReviewerPane` 與 `src/herdr.ts` 的 `startProfile` 都改用它。門檻（寬的往右至少 80 欄、否則往下至少 16 列）不變；新 pane 是獨立 terminal，關閉時只關它自己（既有安全規則不變）。

測試（2026-11-05，本機 macOS，非 CI）：`test/pane-split.test.ts` 新增 6 項（門檻不變；基底夠大照舊；基底太小時選最大且夠大的 pane；都不夠大或基底不在版面時不選；`openReviewerPane` 在作者 pane 太小時改從另一個 pane 分割、`workspace_id` 不變；都不夠大時仍拒絕且不建立 pane）。暫時拿掉備援時兩項**失敗**（紅），恢復後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1161 tests、1160 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機重跑 `card loop REQ-20261105-h4b --agent codex --merge`；分割對象不是 Lead／作者的 pane 時，Herdr 的版面是否合理（只是排版，不影響功能）；多次 review 後版面越來越擠（reviewer 用完會關閉，但 profile Worker 的 pane 仍保留以便重用 session）。

H4 目前進度（2026-11-05）：`REQ-20261105-h4b` 已走完 `card assign`→`card commit`→`card pr`（PR #116 開著，head `c65cd47`，CI 由 bridge 每分鐘輪詢），停在 `card loop` 的 review。另外觀察到：task 完成（07:39:47）之後，卡片狀態從 `in_progress` 變成 `done` 有延遲，我下的第一次 `card pr` 被拒絕「只有 done 的卡片可以開 PR」，幾秒到一分鐘後重下就成功（同步稍後出現「Card sync updated」）；當時尚未調查，後續根因及修正見 ISSUE-095。

下一步：merge 後重啟 bridge，重下 `card loop REQ-20261105-h4b --agent codex --merge`，走完 review → 等 CI → merge；merge 後另開 PR 刪除 `docs/h4-e2e-trace.md`，並清掉 H4 殘留（workspace `w2F`／`w2G`、worktree、卡片）。

**實機驗收（2026-11-05，本機 macOS，政策 L2，bridge 載入 main `dfac751`）：** H4 第二輪卡 `REQ-20261105-h4c`（同一個 workspace 同樣有三個 profile Worker 把 Lead 的 pane 切小），`card loop REQ-20261105-h4c --agent codex --merge`：bridge 用 codex 開出 reviewer 的 pane（先前同型情況在此失敗：「基底 pane 太小…too small to split」），review 第 1 輪 pass、驗收條件兩項都 ✓、reviewer pane 自己關閉，CI 全過，接著 bridge 自己 squash merge PR #118。**未驗證：** 多次 review 後版面越來越擠。

## ISSUE-095：task 完成後卡片要等到下一次掃描才變成 `done`，緊接著下 `card pr` 會被拒絕（H4 觀察）

更新日期：2026-11-06。狀態：已修正、待驗收（原始碼與自動化檢查完成；尚未實機驗收）。

使用者可見症狀：H4 兩輪都一樣：task `task_completed` 之後立刻下 `card commit`（成功）再下 `card pr`，第一次被拒絕「卡片 … 的狀態是 in_progress；只有 done 的卡片可以開 PR」，約幾十秒後 console 出現 `Card sync updated: <卡片>`，重下就成功。第二輪：`task_completed` 07:54:46、第一次 `card pr` 被拒絕約 07:55:25、重下成功約 07:56。

預期行為：task 完成後，`card pr` 不需要使用者猜時間；task 尚未完成時仍由「只有 done 的卡片可以開 PR」守門拒絕。

已確認根因（程式閱讀，`src/main.ts`、`src/card-sync.ts`）：卡片檔與 task journal 的同步是**每 60 秒掃一次**（`CARD_SYNC_INTERVAL_MS = 60 * 1000`，`sweep` → `syncCards`）；`task_completed` 的事件與 `status: done` 都是在下一次掃描才寫入（事件時間取 task 的 `finishedAt`，所以流程紀錄看起來「同時」）。所以最壞要等 60 秒。

決定與修正範圍（2026-11-06）：採用候選（1），範圍限於 `card pr`。`src/card-command.ts` 在該指令路徑讀卡片前呼叫單卡同步；`src/main.ts` 注入與定時掃描相同的 `taskSourceFrom`／`syncCards`，`src/card-sync.ts` 新增可選 card id，指定時只處理該卡。同步丟例外或回報問題都照原流程繼續，由既有狀態守門決定是否拒絕。其他 PR 守門、定時掃描與 `CARD_SYNC_INTERVAL_MS` 不變；`src/autopick-wiring.ts` 的 `waitCardDone` 保留。

測試（2026-11-06，本機 macOS，非 CI）：新增 `test/card-command.test.ts` 3 項，涵蓋 task 已完成但卡片檔尚為 `in_progress`、task 仍在跑、同步丟例外或回報問題；`test/card-sync.test.ts` 新增單卡同步不影響其他卡片。修正前 `node --test --test-name-pattern='card pr (syncs|still refuses|ignores sync)' dist/test/card-command.test.js` → 3 項中 1 fail（已完成 task 的卡仍被拒絕）；修正後同指令 → 3 pass、0 fail；`node --test dist/test/card-sync.test.js` → 19 pass、0 fail；`npm run build` → pass；`npm run lint` → pass（174 個 TypeScript 檔）；`node --test --test-timeout=60000 dist/test/card-command.test.js dist/test/card-sync.test.js dist/test/card-pr-flow.test.js dist/test/autopick-wiring.test.js` → 155 pass、0 fail。

未驗證／下一步：尚未做 Discord／Herdr／CLI 端到端實機驗收；bridge 未重啟、未部署，目前執行中的 bridge 不代表已載入此修正。合併並部署後，用 task 剛完成且卡片仍為 `in_progress` 的情境實測第一次 `card pr`，並確認未完成 task 仍遭拒絕；舊訊息不會補送。

H4 脈絡：這是自動串接最小的摩擦；已選用（1）的單卡同步。

## ISSUE-096：自動撿卡（H2）——政策選用的專案裡 `ready` 的卡片由 bridge 自己開始並依等級走到 merge

更新日期：2026-11-06。狀態：已驗收（主路徑：L1 於 2026-11-05、L2 於 2026-11-06 實機驗收；回報誤判見 ISSUE-101，已修正、待驗收）。

這是新功能，不是缺陷。使用者 2026-11-05 的決定（AskUserQuestion）：（1）自動做到哪一步：**一路到 merge**，由專案等級決定實際停在哪（L0 commit、L1 PR、L2 merge）；（2）哪些卡：**政策檔選用＋`ready`**（Agent 不能改政策檔，也不改變 `ready` 目前的意思）；（3）誰當 Lead：**bridge 自己開**，專案底下設定 repo 路徑與 Lead 種類；（4）並行：**一次一張**。

第一部分的內容（2026-11-05）：`src/policy.ts` 新增 `autopick_lead`、`autopick:` 區塊與 `autopickFor`；autopick 的專案必須也明確列在 `projects`（不能靠 `default`，避免寬鬆的 default 讓工作自己開始）；路徑必須是絕對路徑、不可有 `..` 或控制字元。`src/autopick.ts`：`pickNext`（ready、宣告的專案被選用、先建立的先做、略過已試過的）、`runAutopick`（依等級依序執行並在每個停止條件停下）、`createAutopicker`（一次一張、不重試、政策檔有問題不撿）。所有外部動作經注入的 `AutopickSteps`，所以邏輯可以單元測試。

現況補充（2026-11-09，ISSUE-129，已驗收）：以下為 ISSUE-096 初版設計歷史；現在未選用政策只是不撿新卡，仍每分鐘掃描終態卡；未結束且未成功 cleanup 的 stopped／failed 保留現場，in_progress 一律不關 Lead，結束卡片的 Lead 收尾依 ISSUE-129。

安全設計：失敗或需要人就停下、保留 Lead 的 workspace 與 worktree；不重試（同一個程序內已試過的卡不再撿）；L2 的 merge 仍完全受 `card merge` 的守門（獨立 review、CI、PR 乾淨、不動敏感路徑）；沒有選用就什麼都不做。

測試（2026-11-05，本機 macOS，非 CI）：`test/policy.test.ts` 新增 5 項（autopick 區塊與 Lead 種類、沒有區塊時政策物件形狀不變、Lead 預設 claude 且只收 claude／codex、autopick 專案必須在 projects 明確列出、路徑與重複的檢查）；`test/autopick.test.ts` 新增 11 項（選卡規則、legacy `project` 欄位、略過已試過的、L2 完整順序並在最後關閉 Lead、Lead 為 codex 時 reviewer 為 claude、L1 停在 PR 且 L0 停在 commit 都不 merge、失敗時停止並保留 Lead、task 未完成／卡片沒變 done／loop 沒 merge 都停下等人、Lead 開不起來就什麼都不做、排程器一次一張且不重試、政策檔缺少或不合法時不撿）。暫時破壞 L1 的停止條件時對應測試**失敗**（紅）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1177 tests、1176 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未做／未驗證（第二部分）：接線（定期掃描、bridge 自己開 Lead workspace 並把本機 console 路由指過去、`command` 用本機 console 的 `handleCommand`、`waitTask` 與 `waitCardDone`（觸發卡片同步，ISSUE-095）、`loop` 的結果判讀）；通知（目前只會有 console 輸出）；實機驗收（先用 L0／L1 的無害卡，再用 L2）；`card policy` 顯示 autopick 設定；bridge 重啟時進行中的卡不會自動接續（會留在 in_progress，需要人處理）。

下一步：第二部分——接線與實機驗收；先在 L1 專案用無害卡驗證到 PR，再驗 L2。

**第二部分（接線，2026-11-05）：**`src/autopick-wiring.ts` 的 `createAutopickSteps`：`startLead`（`workspace.create` 在 repo 路徑開 workspace、`agent.start` 啟動 Lead、狀態不是 idle／done 就失敗並關掉剛開的 workspace、再以 `wk use`／`agent use` 指定路由）、`waitTask`（輪詢 task；`blocked` 不等；預設 45 分鐘）、`waitCardDone`（預設 150 秒，ISSUE-095）、`loop`（以回覆是否為「loop 結束：…已 merge」判定）。`src/main.ts` 的 `startAutopick`：每分鐘 `tick`，以本機 console 使用者 id `autopick`（`createConsoleContext(print, userId)`）經 `handleCommand` 執行 `card …` 指令——守門全部沿用，且不動到使用者自己的 console 路由與 console Agent；停下或失敗時 console 輸出並在卡片寫一筆 `failed`（code `autopick_stopped`／`autopick_failed`）。`card policy` 列出自動撿卡設定。`allowedWorkspaceIds` 非空時不支援。

測試（2026-11-05，本機 macOS，非 CI）：`test/autopick-wiring.test.ts` 新增 7 項（Lead 的 workspace／agent／路由；白名單與路徑不合法時不建立任何東西；Lead 沒就緒時不留下空 workspace；waitTask 的終止、blocked、逾時與找不到；waitCardDone 的輪詢與逾時；loop 只在回覆確認 merge 時才算）；`test/card-command.test.ts` 新增 1 項（`card policy` 的自動撿卡顯示）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1185 tests、1184 pass、0 fail、1 skip（既有）；`npm run lint` ok。

**實機驗收計畫：**使用者已把 `policy.yml` 設成 `Herdr_Discord_Bridge: L1` 並加 `autopick:`（bridge 解析器驗證為 loaded）。merge 並重啟 bridge 後，匯入一張宣告 `project: local:Herdr_Discord_Bridge` 的無害卡並設成 ready，**不下任何指令**，等待 bridge 自己撿卡、做到 PR 為止（L1）；驗證完成後由使用者決定是否升到 L2 再驗 merge。重啟前確認卡片目錄沒有其他 ready 的卡（2026-11-05 查過是空的）。

**未驗證：**真的定期掃描與撿卡；Lead 開在新 workspace 的版面與 Claude 的信任提示（repo 在已信任的 `git_wk` 底下）；`autopick` 使用者 id 的路由與 console 路由確實互不影響；失敗時卡片 `failed` 事件的內容；長時間（45 分鐘）等待期間 bridge 重啟的處理（不接續）；Discord 通知（目前只有 console 輸出）。

**L2 實機驗收（2026-11-06，本機 macOS，政策 L2，bridge 載入 main `ed6c7f5`）：**卡 `REQ-20261106-auto5`（追蹤清單 H2 狀態欄位的一行替換），我只做了一個動作——03:41:28（UTC）把它改成 `ready`。之後全部由 bridge 自己完成：03:42:18 撿卡並 `assigned`；03:44:31 coding 任務完成（獨立 review 通過、verify 通過，階段 `ready-to-integrate`）；03:45:08 `card commit`（`c0bcc5c16557`）；03:45:16 開 PR #128；03:46:11 `card loop` 的 reviewer（codex）第 1 輪 `pass`（約 1 分鐘）；03:47:08 CI 全綠；**03:47:21 bridge 自己 squash merge 進公開 `main`（`94f92aa`）**；03:48:07 記 `merged`、03:48:08 自動清理 worktree。從 `ready` 到合併約 6 分鐘，沒有任何人下指令。合併的內容恰好是卡片要求的一行變更（`docs/card-to-merge-tracker.md` 1 行新增 1 行刪除，舊文字不見、新文字出現）。
**這次實機走通的環節：**撿卡、bridge 自己開 Lead、`--worktree --coding`、profile 自動啟用、`card commit`、`card pr`、`card loop --merge` 的獨立 review、CI、`card merge`、merge 後清理。**這次沒有碰到的（仍是待驗收）：**ISSUE-098（沒有發生 `agent_pane_busy` 競爭）、ISSUE-099（這次 reviewer 沒有開子 agent：最近 25 分鐘沒有任何 subagent rollout）、ISSUE-100（沒有 low 的 finding，也沒有觀察到 `UNKNOWN`）、`changes_requested` 之後的自動修正。
**已知的小問題：**runner 把成功的合併誤報成「停下來等人，停在 loop」，卡片多了一筆錯誤的 `failed`／`autopick_stopped`，也沒有關閉自己開的 Lead workspace——見 ISSUE-101。

## ISSUE-097：verify 的 Worker 回報了一個預期 exit 1 的指令，整個驗證被判失敗（H2 自動撿卡 L2 第一次嘗試的斷點）

更新日期：2026-11-06。狀態：已驗收（PR #123 已 merge；H2 自動撿卡 L2 實機：verifier 寫 `! grep -qF …` 並回報 exit 0，閘門通過，見 ISSUE-096 的 L2 驗收）。

使用者可見症狀：H2 自動撿卡 L2 第一次嘗試（卡 `REQ-20261105-auto2`，task `task-cbc8ddf3-7de8-4e08-b9ae-38b185674efc`）：bridge 自己撿卡、coding 完成、獨立 review pass，但兩次 verify 都被記成 `verificationPassed: false`，task failed「no successful verification for the current version」，自動撿卡停在 `task`（console：「停下來等人，停在 task」，卡片記 `failed`／`autopick_stopped`）。Worker 的文字報告兩次都寫「驗證通過」。

預期行為：Worker 實際驗證通過時，bridge 也判通過；失敗時 Lead 看得出是哪個指令。

已確認根因（task 的 verify 報告原文）：兩個 verify Worker 都在 `codingResult.commands` 另外列了 `grep -cF '<舊文字>' docs/card-to-merge-tracker.md`，用來確認舊文字已經不存在——找不到時 `grep` 本來就 exit 1，回報成 `exitCode: 1`。bridge 的規則是「回報的 `commands` 至少一個且全部 exit 0 才算 `verificationPassed`」（`src/team-task-engine.ts`），所以被判失敗。閘門回饋（ISSUE-093）生效、Lead 也補排了第二次 verify，但回饋只說「沒有成功的驗證」，Lead 看不出是哪個指令，第二個 verifier 做了同樣的事。卡片的驗收條件寫成「舊文字已不存在」也讓 verifier 很自然去檢查不存在——但這是很常見的驗收寫法，不是卡片的錯。

修正範圍（2026-11-05；**驗證規則本身不放寬**）：（1）Worker 提示（`codingWorkerAddendum`）與 Lead 的規劃提示（`codingPlanningAddendum`）明說：verify 回報的指令只要有一個 exit 非 0 就算失敗；只列必須 exit 0 的檢查；確認不存在要寫成 `! grep -q 'text' file` 並回報該指令的 exit code；不要列預期 exit 1 的 grep、不要列失敗無關緊要的探索指令。（2）Lead 看到的 coding evidence（`evidenceSummary`）對 verify artifact 多帶 `verificationPassed` 與 `commands`（最多 10 個、每個指令最多 160 字元，含 `exitCode`），失敗時才知道是哪個指令。（3）閘門回饋的訊息補一句：verify 失敗時請看 evidence 的指令與 exit code，並告訴下一個 verifier 只回報必須通過的檢查、不存在的檢查寫成 `! grep -q …`。

測試（2026-11-05，本機 macOS，非 CI）：`test/coding-workflow.test.ts` 新增 2 項——第一次 verify 另外列了一個 exit 1 的 grep 而失敗（`verificationPassed` 為 false、true），之後的規劃提示帶有那個指令、`"exitCode":1` 與 `! grep -q` 的說明，第二次 verify 通過後 task 完成；Worker 提示含有「任何一個指令 exit 非 0 就算失敗」「`! grep -q`」「不要列預期 exit 1 的 grep」。暫時關掉 evidence 的指令資訊時第一項**失敗**（紅），恢復後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1187 tests、1186 pass、0 fail、1 skip（既有）；`npm run lint` ok（lint 規則禁止出現小寫的 `any` 一字，所以提示文字用 one of…）。

未驗證：實機重跑 L2——merge 並重啟 bridge 後以新卡重做；模型是否真的遵守新提示（只有實機能驗）；Worker 仍列出非 0 指令時，Lead 是否能靠 evidence 的指令與 exit code 改正。

H2 自動撿卡 L2 目前進度：第一次嘗試停在 coding 階段的 verify（本 issue）；撿卡、開 Lead、assign、coding、獨立 review 都已實機走過（L1 驗收見 ISSUE-096）；L2 的 `card loop --merge` 在自動流程裡還沒走到。測試殘留：卡片 `REQ-20261105-auto2`（in_progress）、其 worktree 與 workspace，修正 merge 後清掉並用新卡重跑。

**實機驗收（2026-11-06，task `task-9fd82904-0c4d-4a7f-892d-e2cde29a04a7`）：**同樣的卡片寫法（驗收條件含「舊文字已不存在」）這次 verifier 回報的指令是 `! grep -qF '**已實作、待實機驗收**（ISSUE-096）' docs/card-to-merge-tracker.md`，exit 0，`verificationPassed: true`，一次就過（先前兩次各因回報 `grep -cF` 的 exit 1 而失敗）。

## ISSUE-098：Worker profile 啟動時新 pane 的 shell 還沒就緒，`agent.start` 被拒絕，整個任務失敗（H2 自動撿卡 L2 第二次嘗試的斷點）

更新日期：2026-11-05。狀態：已修正、待驗收（根因已確認；原始碼與自動化檢查完成；**尚未 merge、尚未重啟 bridge、尚未實機重跑 L2**）。

使用者可見症狀：H2 自動撿卡 L2 第二次嘗試（卡 `REQ-20261105-auto3`，task `task-35ce9dce-b492-4965-b38d-01376d0564d4`，ISSUE-097 修正已載入）：`impl`（`profile:helper`）完成後，`verify`（`profile:reviewer`）在啟動 Worker 時失敗：「herdr agent.start: agent_pane_busy agent target pane w2S:p3 is not an available shell」；task failed（「one or more Assignments failed…no passing review…no successful verification」），自動撿卡停在 `task`，卡片記 `failed`／`autopick_stopped`。公開 `main` 未被動到。

預期行為：新 pane 的 shell 初始化好之後再啟動 Agent。

已確認根因：與 ISSUE-067 是同一個 Herdr 錯誤（剛分割出來的 pane，shell 還沒初始化完時 `agent.start` 回 `agent_pane_busy`）。ISSUE-067 只修了 `card assign --worktree` 的 `startAgentInPane`（對這個錯誤短暫重試）；Worker profile 的啟動路徑 `Herdr.startProfile`（`src/herdr.ts`）直接呼叫 `agent.start`、沒有重試，所以這是競爭條件：shell 夠快初始化的時候沒事（先前十幾次實機 profile 啟動都沒遇到），慢一點就整個任務失敗。另外一個 assignment 失敗就會結束規劃（`reports.some(state !== done)` → break），沒有補救機會（既有行為，未改）。

修正範圍（2026-11-05）：`startProfile` 對 `agent.start` 的 `agent_pane_busy` 每 0.5 秒重試、最多 15 秒（與 `agent-start.ts` 相同的常數與規則）；這個錯誤代表什麼都還沒啟動，重試是安全的；任何其他錯誤立刻失敗、不重試。

測試（2026-11-05，本機 macOS，非 CI）：`test/profile-start.test.ts` 新增 2 項——前兩次 `agent.start` 回 `agent_pane_busy`、第三次成功時 profile 啟動成功（共 3 次呼叫、間隔至少約 1 秒）；`agent_not_supported` 之類的其他錯誤只呼叫一次就失敗。修正前第一項**失敗**（紅），修正後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1189 tests、1188 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機重跑 L2 全程；shell 超過 15 秒仍未就緒時的行為（仍是原錯誤，任務失敗）；是否該讓「基礎設施性」的 assignment 失敗允許 Lead 重排一次（目前不改）。

H2 自動撿卡 L2 進度（2026-11-05）：第一次嘗試停在 verify（ISSUE-097，已修）；第二次嘗試停在 Worker 啟動（本 issue）；`card loop --merge` 在自動流程裡仍沒走到。每次失敗都是不同的環節，也都被守門擋在 merge 之前，公開 `main` 沒有被動到。測試殘留：卡片 `REQ-20261105-auto3`（in_progress）與其 worktree、workspace，修正 merge 後清掉並用新卡重跑。

**2026-11-06 觀察：**H2 L2 第四次嘗試沒有遇到 `agent_pane_busy`（Worker 啟動一次成功），所以這個重試仍沒有實機證據，狀態維持「已修正、待驗收」。

## ISSUE-099：codex 開了子 agent，rollout 辨識遇到多個符合而判「不明」，reviewer 的回覆永遠讀不到（H2 自動撿卡 L2 第三次嘗試的斷點）

更新日期：2026-11-05。狀態：已修正、待驗收（根因已確認並用真實的 rollout 驗證；原始碼與自動化檢查完成；**尚未 merge、尚未重啟 bridge、尚未實機重跑 L2**）。

使用者可見症狀：H2 自動撿卡 L2 第三次嘗試（卡 `REQ-20261105-auto4`，政策 L2，bridge 載入含 ISSUE-097／098 修正的 main `17aab15`）：撿卡、coding、獨立 review、commit、PR #125、CI 通過（09:21:37）都順利；接著 `card loop --merge` 的 reviewer（codex）在 09:21:11 已經回覆，但 loop 沒有往下走：卡片沒有 `review_verdict`、PR 還是 1 個 commit、reviewer 的 pane（`w2V:p4`，6 列高、idle）沒有被關閉，過了 3 分多鐘仍沒動。console 沒有任何錯誤。reviewer 的判定其實是 `changes_requested`（兩條驗收條件 `met`，另有一個 medium finding）。

預期行為：reviewer 回覆後 loop 讀到它、寫入卡片、繼續（修正或 merge）。

**事後補充（2026-11-05，同一個 task 後續的實際結果）：**loop 並不是永遠卡住——第 1 輪 review 從 09:19:49 拖到 09:31:12（約 11.4 分鐘）才逾時，被記成 `inconclusive`，之後 loop 自動開了第 2 輪，約 1 分鐘就 `pass`（`review-125-r2`）。所以上面「等不到回覆」的結果是「白等一個逾時」，不是永遠不會恢復；第 1 輪慢、第 2 輪快，與「第 1 輪 reviewer 開了子 agent 而 nonce 辨識不明」一致（第 2 輪沒有開子 agent）。我在上一則回覆曾說「不會自己恢復」，那一句不正確，這裡更正。第 2 輪 `pass` 之後 `card merge` 拒絕合併是另外的原因，見 ISSUE-100。

已確認根因：reviewer 的 codex 在審的過程中自己開了兩個**子 agent**（rollout 的 `session_meta` 標 `thread_source: "subagent"`，`agent_path` 為 `/root/standards`、`/root/spec`，父 session 是 reviewer 自己）。子 agent 的 rollout 引用了父 agent 的 prompt，所以本回合的 nonce 同時出現在**三個** rollout（父 5 次、兩個子各 1 次）。ISSUE-088／089 的 `findCodexRolloutByNonce` 規則是「恰好一個符合才算，多個視為不明」，於是回傳不明；reviewer 的 pane 只有 6 列高，終端畫面讀不到完整回覆，bridge 只能等到逾時。實測驗證：同一個 nonce 在修正前會因多個符合而不明，修正後辨識為父 session `01a1ab01-e175-73e2-9d0b-709affe32534`。

修正範圍（2026-11-05）：`src/response-stream.ts` 的 `findCodexRolloutByNonce` 先排除第一行 `session_meta` 標示為子 agent（`thread_source: "subagent"` 或 `source.subagent`）的檔案，剩下恰好一個才算；零個、多個真正的 session、或只有子 agent 符合，仍然是「不明」（fail closed）。第一行讀不到或不是 `session_meta` 時不當作子 agent（最壞結果是候選變多而回傳不明，不會認錯）。

測試（2026-11-05，本機 macOS，非 CI）：`test/response-stream.test.ts` 新增 2 項——父 session 加兩個引用 nonce 的子 agent 時辨識為父 session；兩個真正的 session 都含 nonce、或只有子 agent 含 nonce，仍回傳不明。修正前兩項皆**失敗**（紅）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1191 tests、1190 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機重跑 L2；reviewer 之後的 `card fix`（因 `changes_requested`）→ push → 再 review → merge 的自動流程（H4 只走過 review pass 的路徑，手動版 `card fix` 與 `card loop` 在 2026-11-04 驗收過）；子 agent 的 rollout 若沒有 `session_meta` 標記（舊版 codex）的情況。

H2 自動撿卡 L2 進度（2026-11-05）：三次嘗試各停在不同環節——verify（ISSUE-097）、Worker 啟動（ISSUE-098）、reviewer 回覆辨識（本 issue），都被守門擋在 merge 之前，公開 `main` 沒有被動到；撿卡、開 Lead、assign、coding、獨立 review、commit、PR、CI 都已在自動流程裡走過。測試殘留：卡片 `REQ-20261105-auto4`、PR #125（開著，內容與預期相同、CI 通過）、worktree 與 workspace，修正 merge 後清掉（PR #125 不合併，直接關閉）並用新卡重跑。

**2026-11-06 觀察：**H2 L2 第四次嘗試的 reviewer 沒有開子 agent（最近 25 分鐘沒有任何 subagent rollout），第 1 輪約 1 分鐘就 `pass`，所以這個修正仍沒有實機證據，狀態維持「已修正、待驗收」。

## ISSUE-100：review 已 pass，卻因 `low` 等級的 open finding 與「GitHub 還在計算」而停在 merge（H2 自動撿卡 L2 第三次嘗試的後半）

更新日期：2026-11-06。狀態：已修正、待驗收（原始碼與自動化檢查完成；**尚未 merge、尚未重啟 bridge、尚未實機重跑 L2**）。

使用者可見症狀：H2 自動撿卡 L2 第三次嘗試（卡 `REQ-20261105-auto4`，PR #125，task `task-21c93caa…`）：第 1 輪 review 因 ISSUE-099 拖了約 11 分鐘逾時（記 `inconclusive`），第 2 輪約 1 分鐘 `pass`，接著 `card merge` 拒絕：「還有 1 筆 open 的 finding」與「GitHub 還在計算這個 PR 能不能合併，請稍後再試」，自動撿卡停在 `loop`（console：「停下來等人」，卡片記 `failed`／`autopick_stopped`）。公開 `main` 沒有被動到。

兩個原因：（1）第 2 輪 reviewer 判 `pass`、兩條驗收條件都達成，但另外留了一筆 `low` 的 open finding F1：「H2 已標示 L1 驗收完成，但同列後文仍將 L1 實測寫為下一步；本次需求明確要求保留後文，可另案更新。」——reviewer 自己註明「可另案更新」，是備註性質，但 `card merge` 的守門是「有 open 的 finding 就不 merge」。（2）GitHub 剛收到 push／剛開 PR 時 `mergeable` 是 `UNKNOWN`，過幾秒就算好，卻被當成拒絕。

使用者決定（2026-11-06，AskUserQuestion）：選「**low 等級的 finding 不擋 merge**」（而不是「pass 但有 open finding 就再修一輪」或維持現狀）。

修正範圍（2026-11-06）：（1）`src/card-findings.ts` 新增 `blockingOpenFindings`：只數 medium 與 high 的 open finding；`card merge` 的守門（`src/card-merge-wiring.ts`）改用它，拒絕訊息註明「medium 以上；low 等級的備註不擋 merge」。`low` 的 finding 仍留在卡片上；review 判 `changes_requested` 時 `card loop` 要不要修正的判斷**不變**（仍看全部 open finding）；其他守門（獨立 review 通過且在最新 head、CI 全綠、PR 乾淨、不動敏感路徑）**不變**。（2）`mergeCardPullRequest` 讀 PR 狀態時，`mergeable`／`mergeStateStatus` 是 `UNKNOWN` 就每 3 秒重讀、最多讀 10 次（約 27 秒）再判定；仍是 `UNKNOWN` 才維持原本的拒絕。

測試（2026-11-06，本機 macOS，非 CI）：`test/card-merge-wiring.test.ts` 新增 4 項——只有 low 的 open finding 時照樣 merge 且 finding 仍在卡片上；medium 或 high 的 open finding 仍拒絕並註明筆數；`UNKNOWN` 讀兩次後變 `CLEAN` 就 merge（讀 3 次、等 2 次）；一直 `UNKNOWN` 時在有限次數（2 到 12 次）內拒絕。暫時讓 low 也計入時第一項**失敗**，暫時把讀取次數改成 1 時兩項等待測試**失敗**（紅）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1195 tests、1194 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機重跑 L2——merge 並重啟 bridge 後用新卡；`low` 等級由 reviewer 自己判定，reviewer 若把重要問題標成 low 會被放行（這是使用者選擇的取捨，other 守門仍在）；`UNKNOWN` 超過約 27 秒的情況（仍拒絕）；`BEHIND`（PR 落後目標分支）目前仍直接拒絕、沒有自動 Update branch。

H2 自動撿卡 L2 進度（2026-11-06）：四次嘗試各停在不同環節——verify（ISSUE-097）、Worker 啟動（ISSUE-098）、reviewer 回覆辨識（ISSUE-099）、merge 的兩個守門（本 issue）；都被守門擋在 merge 之前，公開 `main` 沒有被動到；撿卡、開 Lead、assign、coding、獨立 review（含逾時後自動重審）、commit、PR、CI 都已在自動流程裡走過。測試殘留已清（PR #125 關閉不合併、分支、卡片、worktree、workspace）。

**2026-11-06 觀察：**H2 L2 第四次嘗試的 review 沒有 finding，也沒有觀察到 PR 狀態停在 `UNKNOWN`，所以這個修正仍沒有實機證據（只有單元測試），狀態維持「已修正、待驗收」。

## ISSUE-101：自動撿卡把成功的合併誤報成「停下來等人」（H2 L2 第四次嘗試）

更新日期：2026-11-06。狀態：已驗收（2026-11-06 實機：自動撿卡成功 merge 後 runner 不再誤報，Lead workspace 自動關閉）。

使用者可見症狀：H2 自動撿卡 L2 第四次嘗試（卡 `REQ-20261106-auto5`）：bridge 已經把 PR #128 squash merge 進 `main`（`94f92aa`，卡片也記了 `merged` 與 `cleanup_done`），console 卻同時印出「自動撿卡 REQ-20261106-auto5（local:Herdr_Discord_Bridge，L2）：停下來等人，停在 loop：review 完成…」，卡片流程紀錄多了一筆 `failed`（code `autopick_stopped`），而且 bridge 為這張卡開的 Lead workspace 沒有關閉（成功收尾才會關）。

預期行為：合併成功就回報「完成到 loop」，不寫 `failed`，並關閉自己開的 Lead workspace。

已確認根因：`src/autopick-wiring.ts` 的 `loop` 判斷有沒有合併用 `text.startsWith("loop 結束：")`。自動撿卡拿到的是 `card loop` 在本機 console 印出的**全部輸出**（進度行在前：「review 完成…判定：pass」「已 merge：…」，最後才是「loop 結束：…已 merge（共 3 個步驟）。」），所以字串開頭是進度行，判斷落空。卡片上 `failed` 事件的原因欄位也以「review 完成：…」開頭，印證這一點。ISSUE-096 第二部分的單元測試只餵了單行回覆，沒有涵蓋進度行在前的情況。

修正範圍（2026-11-06）：改成逐行比對 `/^loop 結束：.*已 merge/m`——必須有一行以「loop 結束：」開頭且同一行含「已 merge」。進度裡出現「已 merge」但沒有這樣收尾的一行（例如 merge 後的步驟出錯）、或只是沒有 `--merge` 的「loop 結束」（review 通過）都不算合併。

測試（2026-11-06，本機 macOS，非 CI）：`test/autopick-wiring.test.ts` 新增 1 項（含三個情境：進度行在前、最後以「loop 結束…已 merge」收尾 → 算合併；進度裡有「已 merge」但以「loop 停下來了」收尾 → 不算；進度在前、「loop 結束」但沒有「已 merge」 → 不算）。修正前該項**失敗**（紅，重現實機問題），修正後通過。`node --test --test-timeout=60000 dist/test/*.test.js` → 1196 tests、1195 pass、0 fail、1 skip（既有）；`npm run lint` ok。

未驗證：實機（merge 後 runner 回報「完成到 loop」、不寫 `failed`、關閉 Lead workspace）；這次誤報留下的殘留（Lead workspace `autopick-REQ-20261106-auto5`、卡片上的 `failed` 事件、遠端分支 `card/REQ-20261106-auto5`）需手動清理，卡片事件是事實紀錄不改寫。

**實機驗收（2026-11-06，本機 macOS，政策 L2，bridge 載入含 PR #129 的 main）：**卡 `REQ-20261106-plan-rounds`（PR #132）於 07:06:27Z 由 bridge 自己 squash merge（`dc9e15e`），之後同一張卡的流程紀錄只有 `merged` 與 `cleanup_done`，**沒有新增 `failed`／`autopick_stopped` 事件**，console 沒有「停下來等人」，該卡的 Lead workspace 與 worktree 都已自動關閉。其後 PR #133、#134、#137、#138、#139 的卡同樣如此。對照：修正前 `REQ-20261106-auto5`（PR #128）合併成功卻被誤報、Lead workspace 殘留。

## ISSUE-102：`SPEC.md` 在敏感路徑清單內，導致功能類的卡片在 L2 幾乎都退回人工 merge（H2 自動撿卡觀察）

更新日期：2026-11-06。狀態：已驗收（2026-11-06 實機：改動 `SPEC.md` 的 PR 由 bridge 自己 merge）。

使用者可見症狀：自動撿卡 L2 跑 ISSUE-095 的卡（`REQ-20261106-issue095`，PR #130）：獨立 review 第 2 輪 `pass`、CI 全綠，`card merge` 卻拒絕：「這個 PR 動到敏感路徑：SPEC.md。這類 PR 一律由人 merge」，runner 停在 merge、卡片記 `failed`／`autopick_stopped`、Lead workspace 保留。使用者 2026-11-06 手動 merge（`1e66fc4`）。

預期行為：敏感路徑只放「改了就能讓程式在 CI／使用者機器上執行任意東西，或改動守門規則」的檔案。`SPEC.md` 是文件，AGENTS.md 又要求「行為改變時必須同步 SPEC.md」，所以新功能的 PR 幾乎一定會改它；列在清單內等於讓 L2 對功能類卡片幾乎都退回人工。

使用者決定（2026-11-06）：把 `SPEC.md` 移出清單。取捨：Agent 可能靠改 `SPEC.md` 暗中降低驗收標準；仍有獨立 reviewer 看 diff 與 AGENTS.md 的規定把關，不再由 merge 守門硬擋。

修正範圍（2026-11-06）：`src/sensitive-paths.ts` 移除 `SPEC.md`；其餘清單（`.github/`、`AGENTS.md`、`package.json`、`scripts/`、`src/policy.ts`、`src/github.ts`、清單檔自己）不變。`SPEC.md` 的敏感路徑段落同步。

測試（2026-11-06，本機 macOS，非 CI）：`test/sensitive-paths.test.ts` 新增「SPEC.md 不是保護路徑」；原本用 `SPEC.md` 當敏感範例的 5 個測試改用 `AGENTS.md`／`package.json`（`card-merge-wiring`、`card-fix-flow`、`card-pr-flow`、`sensitive-paths`）。`node --test --test-timeout=60000 dist/test/*.test.js` → 1201 tests、1200 pass、0 fail、1 skip（既有）；`npm run build`、`npm run lint` ok。

未驗證：實機——merge 並重啟 bridge 後，一張會改 `SPEC.md` 的卡在 L2 能由 bridge 自己 merge。因為這個 PR 動到 `src/sensitive-paths.ts`（仍在清單內），本身必須由人 merge。

**實機驗收（2026-11-06）：**修正前，PR #130（改了 `SPEC.md`）在 05:53:27Z 被 `card merge` 以「動到敏感路徑：SPEC.md」擋下，停在 merge，由使用者手動 merge。修正（PR #131）後重啟 bridge，PR #132（`SPEC.md` +2 行，另改 `src/` 與測試）於 07:06:27Z 由 bridge 自己 merge，沒有被敏感路徑擋下；`src/sensitive-paths.ts` 等仍在清單內的檔案未動。限制不變：PR #131 本身因為改了 `src/sensitive-paths.ts` 仍由使用者手動 merge。

## ISSUE-103：規劃提示未說明實作前的唯讀工作須先排在沒有 writer 的獨立回合

更新日期：2026-11-06。狀態：已驗收（2026-11-06 實機：Lead 把實作前診斷排成沒有 writer 的獨立回合並通過驗證）。

使用者可見症狀／重現環境：2026-11-06 的卡 `REQ-20261106-agy-pool`，約 30 秒內連續兩次，Lead 將 `diagnose-agy`、`critique-plan`（唯讀）→ `implement-agy`（writer，依賴前兩者）→ `review-impl` 排在同一回合。整個計畫被 `read-only coding assignments in a writer round must depend on that writer` 拒絕，task 直接 failed，Worker 未開始實作。

預期行為：需要先診斷、研究或與其他 Agent 討論／批評時，Lead 先將唯讀工作排成沒有 writer 的獨立回合；完成後的下一回合再排 writer 與後續 review／verify，該回合每個唯讀指派仍在自己的 `dependsOn` 直接列出 writer id。

已確認根因：`codingPlanningAddendum()` 只說明有 writer 的回合中，其他指派必須直接依賴 writer，未說明實作前的診斷／討論必須放在更早、沒有 writer 的回合。這是規劃提示缺口，**不是 `validateCodingRound` 或其他驗證規則的 bug**。

修正範圍（2026-11-06）：只在 `src/coding-workflow.ts` 的 `codingPlanningAddendum()` 增加上述兩句規劃指引，並在 `test/coding-workflow.test.ts` 新增提示文字測試；`validateCodingRound` 與所有守門邏輯不變。`SPEC.md` 同步記錄回合規則。

測試（2026-11-06，本機，非 CI）：此 worktree 起初沒有依賴，`npm run build` 因找不到 `tsc` 失敗（exit 127）；`npm ci` 成功後，新增測試先以 `npm run build` 編譯，再執行 `node --test --test-name-pattern 'ISSUE-103' dist/test/coding-workflow.test.js`，修正提示前 **0/1 通過**（exit 1，紅）。提示修正後第一次測試的正規表示式把 `next round` 與 `writer` 順序寫反，`ISSUE-103|ISSUE-087` 為 **1/2 通過**（exit 1）；修正測試比對後，`npm run build` 成功，`node --test --test-name-pattern 'ISSUE-103|ISSUE-087' dist/test/coding-workflow.test.js` **2/2 通過**，`node --test --test-timeout=60000 dist/test/coding-workflow.test.js` **24/24 通過**，`npm run lint` 成功（174 個 TypeScript 檔）。

未驗證與下一步：**尚未實機驗證** Lead 是否會將「先診斷、後實作」拆成兩回合；卡 `REQ-20261106-agy-pool` 是第一個驗證對象。此工作樹尚未 commit／push，執行中的 bridge 未重啟；自動化測試通過不能當作 live 驗收。

**實機驗收（2026-11-06）：**修正（PR #132，`dc9e15e`）合併並重啟 bridge（07:09:11Z）後，卡 `REQ-20261106-agy-pool` 的三次嘗試（task `task-544ae3b7-5cdc-4086-b97f-7315def8ca39`、`task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd`、`task-e9cb8674-b86c-42b0-b639-544054c2632f`）第一回合都是只有診斷的計畫（無 writer）並通過 `plan_validated`，診斷完成後才在下一回合規劃 writer。修正前同一張卡兩次（`task-06eb2e97…`、`task-f10f36ba…`）都在約 30 秒內因為「read-only coding assignments in a writer round must depend on that writer」失敗。

## ISSUE-104：規劃提示未說明 review 只審已完成的實作，實作前批評應用 diagnose

更新日期：2026-11-06。狀態：已驗收（2026-11-06 實機：實作前的批評用 diagnose 角色並完成）。

使用者可見症狀／重現環境：2026-11-06，卡 `REQ-20261106-agy-pool` 第四次嘗試，task `task-544ae3b7-5cdc-4086-b97f-7315def8ca39`。兩個平行唯讀診斷 `diag-adapter`、`diag-session` 都完成後，Lead 將批評診斷結論的 `critique` 指派給 reviewer profile，角色填成 `review`；07:12:59 開始時被引擎以 `coding review has no implementation artifact` 退回，task failed，前兩個診斷成果也跟著作廢。

預期行為：`review` 只審這個任務已完成的實作，只能排在 writer 之後。實作前要批評或檢驗診斷結果、計畫時使用 `diagnose`（唯讀），可指定給任何 Worker，包括只標 review capability 的 profile，因為 capability 目前不是派工的守門；實作前的唯讀回合仍依 ISSUE-103 與 writer 回合分開。

已確認根因：`codingPlanningAddendum()` 未交代 review 的實作 artifact 前提，也未指引實作前批評使用 diagnose。這是**提示缺口，非引擎規則錯誤**；`src/coding-workflow.ts:127` 與 `src/team-task-engine.ts:393` 拒絕沒有已完成實作 artifact 的 review，規則正確，不應放寬。

修正範圍（2026-11-06）：只在 `src/coding-workflow.ts` 的 `codingPlanningAddendum()` 新增兩句角色與 capability 說明；`test/coding-workflow.test.ts` 新增提示文字測試，`SPEC.md` 同步角色語意。`validateCodingRound`、`src/team-task-engine.ts` 與其他驗證規則／守門完全不變，未修改 `config.json`、`policy.yml`。`CONTEXT.md` 沒有逐項 issue 索引，維持既有 ledger 連結。

測試（2026-11-06，本機，非 CI）：初次 `npm run build` 因缺少 `tsc` 失敗（exit 127），`npm ci` 成功後，`npm run build && node --test --test-name-pattern 'ISSUE-104' dist/test/coding-workflow.test.js` 在提示修正前 **0/1 通過**（exit 1，紅，缺少角色說明）。提示修正後首次 `npm run lint` 因腳本連字串內的 `any` 也禁止而失敗（exit 1）；改為同義的 `whichever Worker is selected` 並同步測試後，`npm run build` 成功（exit 0），`node --test --test-timeout=60000 dist/test/coding-workflow.test.js` **25/25 通過、0 fail**（exit 0），`npm run lint` 成功（exit 0，174 個 TypeScript 檔）。

未驗證與下一步：**尚未實機驗證** Lead 之後是否會把實作前批評排成 `diagnose`；`REQ-20261106-agy-pool` 下一次嘗試是第一個驗證對象。原始碼與 build 已更新，但執行中的 bridge 未重啟、未部署，既有失敗 task 與診斷成果不會因此自動恢復；未 commit／push。自動化通過不代表 Discord／Herdr／CLI 端到端驗收完成。

**實機驗收（2026-11-06）：**修正（PR #133，`be728e1`）合併並重啟 bridge（07:23:56Z）後，task `task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd` 的 `d3-critique`（交給 reviewer profile、依賴兩個診斷）用 `diagnose` 角色，07:28:57Z 完成，沒有再出現「coding review has no implementation artifact」。修正前 task `task-544ae3b7-5cdc-4086-b97f-7315def8ca39` 的 `critique` 用 `review` 角色，在 07:12:59Z 被引擎退回。

## ISSUE-105：規劃提示未說明 findingRefs 只能引用 review 登記的 finding，診斷成果應用 artifactRefs

更新日期：2026-11-06。狀態：已驗收（2026-11-06 實機：診斷之後的 writer 回合計畫通過驗證）。

使用者可見症狀／重現環境：2026-11-06，卡 `REQ-20261106-agy-pool` 第五次嘗試，task `task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd`。第一回合三個唯讀診斷完成，artifacts 為 `a-d1-adapter-flow-1`、`a-d2-roster-pool-2`、`a-d3-critique-3`，task 的 `coding.findings` 為空；第二回合 Lead 排 writer 時把 diagnose 報告的 finding id `d2-optin-roster` 放進 `findingRefs`，計畫被以 `references unknown finding` 拒絕，task 失敗，約 4 分鐘診斷成果作廢。

預期行為：Lead 只在 `findingRefs` 引用 review 判 `changes_requested` 時登記的 finding，id 以 coding 證據列出的為準。diagnose 回報的 finding 不是可引用的 finding；交接診斷成果時，在 `artifactRefs` 引用診斷 artifact id（`a-<assignmentId>-<n>`），並可在後續指派的 instruction 摘要內容。

已確認根因：`codingPlanningAddendum()` 原本只說用 findingRefs／artifactRefs 引用先前成果，未交代兩者的適用範圍。這是**提示缺口，非引擎規則錯誤**；`applyCodingResult` 只登記 review 判 `changes_requested` 的 findings，`validateCodingRound` 拒絕未登記的 finding id 是正確守門，不應放寬。

修正範圍（2026-11-06）：只在 `src/coding-workflow.ts` 的 `codingPlanningAddendum()` 加入兩句引用指引；`test/coding-workflow.test.ts` 新增提示文字測試，既有測試不變；`SPEC.md` 同步 findingRefs／artifactRefs 語意。`validateCodingRound`、`applyCodingResult` 與其他驗證規則完全不變，未修改 `config.json`、`policy.yml`。`CONTEXT.md` 已連到本清單，無需新增索引。

測試（2026-11-06，本機 macOS，非 CI）：初次 `npm run build` 因缺少 `tsc` 失敗（exit 127），`npm ci` 成功後，`npm run build && node --test --test-name-pattern 'ISSUE-105' dist/test/coding-workflow.test.js` 在提示修正前 **0/1 通過**（exit 1，紅，缺少引用說明）。提示修正後 `npm run build` 成功（exit 0）；`node --test --test-name-pattern 'ISSUE-105' dist/test/coding-workflow.test.js` **1/1 通過**（exit 0）；`node --test --test-timeout=60000 dist/test/coding-workflow.test.js` **26/26 通過、0 fail**（exit 0）；`npm run lint` 成功（exit 0，174 個 TypeScript 檔）。

未驗證與下一步：**尚未實機驗證** Lead 之後是否會改用 `artifactRefs` 交接診斷成果；`REQ-20261106-agy-pool` 下一次嘗試為第一個驗證對象。原始碼與 build 已更新，但執行中的 bridge 未重啟、未部署；既有失敗 task 與診斷成果不會自動恢復，未 commit／push。自動化通過不代表 Discord／Herdr／CLI 端到端驗收完成。

**實機驗收（2026-11-06）：**修正（PR #134，`495969f`）合併並於 07:57:34Z 重啟 bridge 後，task `task-e9cb8674-b86c-42b0-b639-544054c2632f` 在三個診斷完成後，08:03:56Z 的第二回合（writer `impl-agy-pool`）計畫通過 `plan_validated` 並完成實作與 review。修正前 task `task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd` 的同一步因 `references unknown finding d2-optin-roster` 失敗。注意：我沒有逐項檢查該計畫的 `artifactRefs`，只確認計畫通過了引擎驗證。

## ISSUE-106：coding 計畫驗證失敗沒有回饋 Lead 重排，直接令 task 失敗

更新日期：2026-11-06。狀態：已修正、待驗收（原始碼與自動化檢查完成；**尚未實機驗證、尚未重啟或部署 bridge**）。

使用者可見症狀／重現環境：2026-11-06，卡 `REQ-20261106-agy-pool` 的三類實機失敗：

- `read-only coding assignments in a writer round must depend on that writer`：task `task-06eb2e97-7b7b-496e-b1b7-a10d722c343b`、`task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6`，約 30 秒被拒。
- `coding review has no implementation artifact`：task `task-544ae3b7-5cdc-4086-b97f-7315def8ca39`，兩個診斷完成後第三個指派失敗。
- `Assignment w1-agy-optin references unknown finding d2-optin-roster`：task `task-4cf4eab3-0449-4dd3-af75-d4c2c26a39fd`，三個診斷完成約 4 分鐘後，第二回合計畫被拒。

預期行為：coding 計畫在解析／驗證、指派數量上限、跨回合 ID 重複檢查失敗時，把錯誤回給 Lead 在同一工作回合重排；拒絕的計畫不啟動指派，先前已完成指派及 artifacts 保留。每 task 最多回饋兩次，第三次拒絕以原錯誤與拒絕序號失敗。非 coding 任務立即失敗的行為不變。

已確認根因：規劃迴圈的上述檢查直接 throw，沒有像 ISSUE-093 空計畫 gate 回饋的補救路徑。ISSUE-103／104／105 補提示只能處理特定誤排，無法提供通用回饋。`coding review has no implementation artifact` 的實機錯誤發生在派工前 artifact 檢查；本修正只回饋規劃解析／驗證拒絕，不重試 Worker 執行或派工前檢查，因此不能保證三類實機症狀全部自動恢復。

修正範圍：`src/team-orchestration.ts` 在驗證成功、寫入 plan 與派工之前捕捉上述錯誤；`MAX_PLAN_REJECTIONS = 2` 為 task 共用額度，與 gate 額度分開。提示包含保留成果與不重做的指引；每次規劃嘗試仍消耗 `maxRounds`。`plan_rejected` 事件經 `src/team-task-engine.ts` reducer 寫入 `src/team-task-store.ts` 的 `planRejections` 快照，含零起算工作回合、累計拒絕次數及原錯誤；沿用完整快照重放，重啟不自動續跑。`validateCodingRound`、其他驗證規則、`config.json`、`policy.yml` 均未改。`SPEC.md` 同步契約；`CONTEXT.md` 已連結本清單與 durable task 文件，無需另增索引。

測試（2026-11-06，本機，非 CI）：初次 `npm run build` 因缺少依賴（`tsc`）失敗（exit 127），`npm ci` 成功。暫時停用新回饋、恢復遇錯即 throw，以 `npm run build` 與 `node --test --test-name-pattern ISSUE-106 dist/test/coding-workflow.test.js` 驗證紅燈：4 項中 3 fail、1 pass（一般任務仍立即失敗），隨後恢復實作。最終 `npm run build`、`npm run lint` 成功（exit 0，174 個 TypeScript 檔）。`node --test --test-timeout=60000 dist/test/coding-workflow.test.js dist/test/team-orchestration.test.js dist/test/team-task-engine.test.js` → 73/73 pass、0 fail（exit 0；含 store 的 journal 與重啟測試）。涵蓋新增 6 項：writer 計畫被拒後修正完成且未重複派工、journal 事件與重啟載入、第三次拒絕失敗、一般任務直接失敗、跨回合成果保留與輪數上限、解析拒絕、數量上限拒絕；既有 ISSUE-093 gate 回饋測試通過。

未驗證與下一步：**尚未實機驗證**；`REQ-20261106-agy-pool` 下一次嘗試是第一個驗證對象，觀察 Lead 被告知錯誤後是否真的修正計畫、被拒計畫未派工、已完成成果保留。原始碼／build 的檢查不代表執行中的 bridge 已更新；未重啟、未部署、未 commit／push，舊 failed task 不會自動恢復。既有輪數上限可能先於回饋額度用完而終止任務，這是保留的限制。

**2026-11-06 實機觀察：**修正（PR #135，`a64b4ff`）合併並重啟 bridge（07:57:34Z）後，task `task-e9cb8674-b86c-42b0-b639-544054c2632f` 的 journal 沒有任何 `plan_rejected` 事件（Lead 的計畫都一次通過），所以這個重排機制**還沒有被實機觸發**，狀態維持「已修正、待驗收」。下一次 Lead 計畫被引擎拒絕時才能驗證：要看 `plan_rejected` 是否記錄、Lead 是否真的依回饋修正。

## ISSUE-107：agy 作為 `--coding` Worker／Reviewer 的支援（分三部分）

更新日期：2026-11-06。狀態：已修正、待驗收。

**第 1、2 部分已合併；本卡補齊第 3 部分，整合合併後三部分即全部合併（本工作樹尚未 commit／merge）。agy 作為 Worker／Reviewer 的 `--coding` 全流程尚未實機驗證。使用者須自行在 agy profile 的 capabilities 加入 `implementation` 或 `review` 才會自動啟用。**

使用者可見症狀：`--coding` 未指定 Worker 時，即使 agy profile 宣告 implementation／review，也不會加入自動候選。手動勾選不能補齊 session 登記與獨立 reviewer 支援。

預期行為：claude／codex 預設規則不變；agy 只有 capabilities 含 `implementation` 或 `review` 才自動入池；未宣告、空清單或只有 `analysis` 時不啟用；pi 不論 capabilities 都不啟用。候選合計至少兩個才啟用，已指定 Worker 時不加人。capabilities 只是自動入池條件，不是角色守門，誰寫誰審仍由 Lead 決定。

重現方式／環境：2026-11-06，本機 worktree；以 roster fixture 放入 claude／codex、不同 capabilities 的 agy 與 pi，呼叫 `autoEnableCodingProfiles`。未執行 agy 的 Discord／Herdr／CLI 端到端流程。

已確認根因：自動候選原本只比對 `AUTO_CODING_KINDS` 的 claude／codex，未讀 agy capabilities。參考分支的診斷另指出 session 首次出現後的 pool 登記與 reviewer 身分傳遞缺口；第 1 部分未修第 2、3 部分；第 2 部分進度見下節，仍沒有實機確認其表現。

修正範圍（第 1 部分，以下保留該部分當時的範圍與測試紀錄）：`src/coding-roster.ts` 加入 `OPT_IN_CODING_KIND`、`OPT_IN_CODING_CAPABILITIES` 與 `autoCodingCandidate`，同步註解、錯誤訊息與 roster 測試；`src/main.ts` 只改 startTeamTask 的 E14 註解；同步 SPEC 與兩份 README。未修改 agent-pool、team-*、config.json 或 policy.yml，獨立 review、verify 與 card merge 守門不變。

測試命令與結果（2026-11-06，本機，非 CI）：首次 `npm run build` 因缺少 `tsc` 失敗（exit 127）；`npm ci` 成功後，`npm run build` 成功（exit 0），`node --test dist/test/coding-roster.test.js` 為 10/10 pass、0 fail（exit 0）。最終重跑 build 與同一測試仍成功（10/10 pass）；`npm run lint` 成功（exit 0，174 個 TypeScript 檔），`git diff --check` 成功。涵蓋 agy 未宣告／空清單／analysis-only 不入池、implementation／review／兩者入池、pi 排除、至少兩個與既有 claude／codex 行為。

未驗證與下一步：前兩部分與本卡第三部分整合後，Lead 安排 agy 首輪／重用 session、implement 與獨立 review 的實機驗收。本卡沒有部署或重啟 bridge，執行中的 bridge 不代表已載入新原始碼或 build；舊失敗 task／訊息不會自動補送。沒有 commit／push。


### 第 2 部分：首輪驗證後登記 pool session（2026-11-06，保留當時紀錄）

狀態：修正中。症狀／預期：agy 啟動時沒有 session，首輪完成才被 Herdr 登記，pool 仍保留未知身分，下一次 acquire 因 unknown → known 拒絕。預期僅將回合中核對一致的 session 回寫原綁定，讓之後可安全重用。

已確認根因（原始碼與 fixture）：`runTeamTurn` 原本只回傳 codex rollout session；非 codex 雖接受首次 session 出現並核對後續 identity，卻沒有將結果傳回 pool；orchestration／main 也沒有完成後更新綁定的接線。實機表現尚未驗證。

修正範圍：`src/team-turn.ts` 提前宣告 expectedSession；要求 observeSession 時回傳非 codex 回合內核對的 session。首次出現可接受，沒有 session 不回傳；已觀察 session 改變／消失，或 pane／terminal／workspace／kind 改變仍拋 identity error，不回傳結果。`src/agent-pool.ts` 新增 refreshSession：只有保留 owner、未知且非 uncertain 的原綁定、相同 profile 設定與 pane／terminal／workspace／kind，以及 live pane 完全相同的 session 全部符合才寫入。已有 session（即使相同）及 codex 一律 false；不符不修改狀態；等待 live 查詢後重新核對保留、綁定與設定。

`src/team-orchestration.ts` 新增 onWorkerSession；coding 或有此回呼時觀察 session，僅在完成且非 blocked、非 codex、有驗證 session 時呼叫。`src/main.ts` 以 task 內 pane → profile map 接回 pool；false 或例外只記錄，不放寬 acquire。E14 註解、task engine、coding roster、config.json、policy.yml、獨立 review／verify／card merge 守門均未修改。未引入第 3 部分 reviewer 延後判定測試。

測試命令與結果（2026-11-06，本機 macOS，非 CI）：`npm ci` exit 0；`npx tsc --noEmit` exit 0；`npm run build` exit 0；`node --test --test-timeout=60000 dist/test/agent-pool.test.js dist/test/team-turn.test.js dist/test/team-task-engine.test.js` 76/76 pass、0 fail、0 skip，exit 0；`npm run lint` exit 0（174 個 TypeScript 檔）。包含 pool 各項拒絕條件、查詢期間保留／綁定改變、持久化後重用、turn session 核對，以及真實 pool 接線的 done／blocked／failed／codex fixture。

未驗證與交接：**尚未實機驗證，沒有 Discord／Herdr／CLI 端到端驗收證據**。原始碼與 build 已更新，執行中的 bridge 未部署／重啟，舊 failed task／訊息不會補送；未 commit／push。第 3 部分原始碼進度見下節；Lead 接續整體實機驗收。本卡限定八個檔案，SPEC／README 的整體「尚未可用」限制仍適用；其中第 2 部分進度文字須由後續整合卡同步，不能據本次自動化結果宣稱 agy 已可用。


### 第 3 部分：reviewer 獨立性的守門時機（2026-11-06）

狀態：已修正、待驗收。症狀／根因（原始碼與 fixture 確認）：agy 首輪派工前沒有 session，原本的 review 派工檢查會以 unknown reviewer 拒絕；implement 入帳只用派工紀錄，亦遺失回合中確認的 authorSession。

修正範圍：只修改 `src/team-task-engine.ts`、`test/team-task-engine.test.ts` 與本節。新增 sessionDeferredKind；agy／antigravity 沒有 session 時，派工前只拒絕沒有 implementation artifact 與同作者 pane。已知 session 的 agy 與其他非 codex 種類仍走原本 assertIndependentReview；codex rollout 規則不變。入帳優先採用 `observedSession ?? sessionIdentity(worker)`（codex 仍只認 observedSession），讓首輪 authorSession 正確入帳。**這是守門時機的調整，不是放寬**：入帳仍呼叫既有 assertIndependentReview，未知作者、未知 reviewer、同 session 一律記 independentReview=false、independenceFailure 與 verdict=inconclusive，不能記 pass。verify／card merge 守門不變。

測試涵蓋：agy 首輪作者身分入帳、無 session reviewer 可派工並以不同已知 session 通過、未知作者／未知 reviewer／同 session 入帳 fail closed、同 pane 與沒有 implementation artifact 派工前拒絕，以及 opencode／claude／pi 無已知 reviewer 身分仍派工前拒絕。

測試命令與結果（2026-11-06，本機 macOS，非 CI）：初次工作樹缺依賴，`npx tsc --noEmit` 嘗試查 registry 遇 ENOTFOUND；`npm ci` 成功（exit 0）後，重跑 `npx tsc --noEmit` 成功（exit 0），`npm run build` 成功（exit 0），`node --test --test-timeout=60000 dist/test/team-task-engine.test.js` 39/39 pass、0 fail、0 skip（exit 0；含本卡新增 8 項測試），`git diff --check` 成功（exit 0）。

未驗證與交接：第 1、2 部分已在 main 合併，本卡第 3 部分交由 Lead／bridge 合併；三部分合併後仍為「已修正、待驗收」，**agy Worker／Reviewer `--coding` 全流程尚未實機驗證**，使用者須自行加入上述 profile capability 才會啟用。沒有部署／重啟 bridge，執行中程序未確認載入新版本，舊 failed task／訊息不會補送；未 commit／push。依本卡三檔限制未修改 SPEC／README，其中舊的第 1／2 部分進度敘述須由 Lead 後續整合同步；本節不把未合併改動或自動化結果宣稱為已部署或實機可用。

**2026-11-06 合併狀況：**因為第一次的完整實作（PR #136，diff 73638 字元）超過 review 上限 60000，bridge 的獨立 review 沒有執行（見 ISSUE-111），改拆成三個 PR，各自由 bridge 自己 review 並 merge：#137（`a96fda5`，選用機制）、#138（`fc7398c`，session 登記）、#139（`4e8a1d7`，reviewer 獨立性判斷）；bridge 已於 2026-11-06 09:23:02Z 重啟載入。**agy 作為 Worker 或 Reviewer 的 `--coding` 全流程仍未實機驗證**（從沒真的讓 agy 擔任過）；要驗證需使用者在 `config.json` 的 agy profile 加上 `implementation` 或 `review`，再用一張無害的卡跑一輪。PR #136 仍開著、等使用者決定關閉。

**agy 實機驗證卡（2026-11-06）：**本卡 `REQ-20261106-agy-verify` 的實作階段由 `agy` profile 擔任 writer 執行，實作完成時 `agy` 自報僅修改 `docs/known-issues.md` 一個檔案。至於後續獨立 review 是否通過，以及 `agy` 的 session 身分是否被正確登記，見這張卡的流程紀錄與 task journal，由使用者核對。

**2026-11-06 實機證據（agy 驗證卡 `REQ-20261106-agy-verify`，PR #141 `2d3b2ce`）：**第一次嘗試（task `task-9b81c6dc-…`，09:43–09:44Z）失敗，原因見 ISSUE-113（agy 停在信任資料夾提示，profile 啟動不就緒）。使用者在 agy pane 確認信任後清理重跑，第二次（task `task-6460f2c0-4562-49cb-9994-50c047049c2f`，11:04:17–11:07:19Z，約 3 分鐘；11:09:48Z 由 bridge 在 L2 下 squash merge）從 task journal 核對到：

- writer：`impl-agy` 的 `workerPaneId` 是 `profile:agy`，在 pane `w3Z:p2` 執行，agent 為 `agy`（`herdr:antigravity_cli`）；implement artifact `a-impl-agy-1` 的 `authorSession` 是 agy 的 session `0c50ac78-0e6b-43fb-a553-6ce72d927462`，與 agent-pool 的 `w3Z/agy` 綁定一致（第 2 部分 `refreshSession`、`onWorkerSession` 在實機上有作用）。
- reviewer 獨立性：review 由 codex（`w3Z:p3`，session `01a1b089-…`）執行，與作者 session 不同，結果 `pass`，沒有被 fail closed 擋下（第 3 部分的入帳身分判斷在實機上有作用）。
- verify：claude（`w3Z:p4`）的 `git diff` 檢查命令 exit code 皆為 0；diff 只有 `docs/known-issues.md` +2 行。

**仍未驗證：**agy 擔任 **reviewer**（這次 reviewer 是 codex）、agy 的 session 在 agy 為 reviewer 時是否能取得並判斷獨立。第 1 部分的自動候選（不指定 Worker 時由 roster 自動加入）這次是 Lead 在計畫裡明確指名 `profile:agy`，也沒有單獨驗證。狀態維持「已修正、待驗收」，是否驗收由使用者決定。

## ISSUE-108：同一個 workspace 有多個 Agent pane 時，Lead／Worker pane 只剩約 6 行，replan 的 prompt 沒有被 Lead 處理

更新日期：2026-11-07。狀態：已修正、待驗收（pane 分割與新 tab 備援已修正；Lead 未處理 replan prompt 的直接原因仍待調查，未新增重送或提早失敗機制）。

使用者可見症狀：卡 `REQ-20261106-plan-rounds` 第一次嘗試（task `task-2204c0af-69e9-41d3-b2a4-e2cff7bec906`）：3 個指派 06:37:07Z 完成後，bridge 在 06:37:08Z 把 replan 的 prompt 派給 Lead（`w37:p1`，journal 記為 `dispatched`），之後 Lead 畫面是空的輸入列、狀態 `idle`，沒有新的 Stop hook，約 15 分鐘後 06:52:13Z 逾時，task 變成 `blocked`：`Timed out waiting for current response from w37:p1 (last state: idle); no verified completion`。同一個 workspace 有 4 個 pane，Lead 與 claude Worker 的可視高度各只有 6 行（codex 兩個分別是 13 與 29 行），claude Worker 的畫面停在「Teach auto mode about your environment?」選單（我在 06:51 手動選了 Not now 才消失）。

預期行為：pane 太小時不要繼續分割，改開新 tab；prompt 送出後如果 Lead 沒有開始處理要能偵測並重送或明確失敗，不要等到 15 分鐘逾時。

**2026-11-06 再現（卡 `REQ-20261106-stream-first-session`，task `task-d1e2ff49-db63-4dd2-bf45-95fdfd7fd23f`）：**這次打到的是 bridge 自己的 review，不是 Lead。Team 完成後 PR #149 開出（14:00:29Z），`card loop` 在 14:00:32Z 停在 review：`review 沒有進行：基底 pane 太小，無法分割出 reviewer 的 pane（too small to split）；同一個版面裡也沒有夠大的 pane`，`autopick` 因此停止。當時 workspace `w43` 的四個 pane 可視高度為 6、6、7、7 行。我把三個已完成的 Worker pane 關掉，Lead pane 變成 35 行後，手動 `card loop … --merge`，review 才執行（第 1 輪 pass）。同一次還有另一個無關的衝突：PR 與剛 merge 的 main 衝突（`mergeStateStatus` 為 `DIRTY`，CI 因此沒有啟動），head 換了之後上一輪 review 對新 head 不算數，需再 `card review`。**根因仍未確認**，但 ISSUE-108 的「pane 太小」現在影響 Lead 規劃、Worker 與 reviewer 三處；人工緩解是關掉已完成的 Worker pane。

已確認：pane 高度如上；逾時由既有機制產生。**未確認：**Lead 沒有處理 replan prompt 的直接原因（小 pane 吞掉輸入、被選單遮住、或其他）；我試過放大 Lead pane 查看，但該 workspace 不在聚焦狀態、放大沒生效，沒有取得 Lead 當時的完整畫面。重跑同一張卡（06:57:37Z）沒有再發生，不能確定是小 pane 造成。

**2026-11-06 修正與根因補充：**回歸測試確認舊 `directionFor` 對往右分割完全不檢查高度（200 欄、8 列仍允許分割），往下只要求原 pane 至少 16 列，沒有保護分割後兩邊的高度；而 `openReviewerPane`／`startProfile` 在同版面全部不足時直接失敗，沒有新 tab 備援。這些是已確認的版面問題根因；不能據此斷言 Lead 當時漏處理 prompt 的原因。上面「根因未確認」的歷史敘述針對 Lead 沒有處理 prompt 的直接原因。

修正範圍：`src/pane-split.ts` 新增共用 `createAgentPane`，分割後兩邊 rect 至少 60 欄、18 列（含框線，另留 1 格分隔線）；高度檢查亦適用於往右分割。基底不足仍找同版面面積最大且可安全分割的 pane，全部不足則以 `tab.create` 的 `root_pane` 建立同 workspace、cwd、`focus=false` 的新 pane。`startProfile`、`openReviewerPane` 共用，因此涵蓋 Worker、reviewer／修正者與 `agent start`。基底 layout 缺失拒絕；建立操作 `retries: 0`，失敗不換另一種方式，避免不確定送達造成重複 pane；沿用身分核對及 reviewer 的安全關閉。

測試（2026-11-06，本機 macOS）：先執行 `npm run build && node --test --test-name-pattern=ISSUE-108 dist/test/pane-split.test.js`，兩項皆失敗（短而寬的 pane 仍往右分割、擁擠版面直接拒絕）；修正後兩項通過。更新既有門檻測試與 tab 行為預期，補上 Worker 啟動／登記順序、tab 身分錯誤、送達不明不重試、缺失 layout、遠端 tab ID 轉換。第一輪 sandbox 內 `npm test` 因 Unix socket `listen EPERM` 失敗，亦包含當時尚未更新的舊門檻測試失敗；預期已同步。獲准在 sandbox 外重跑 `npm test`（含 build）→ 1278 tests、1277 pass、0 fail、1 skip；`npm run typecheck`、`npm run lint` 通過。補上遠端 tab ID 轉換測試後，一輪完整測試發現預期少列既有的 `machine` 裝飾欄位而失敗；已修正測試預期，最終 `npm test`（含 build）再次通過：1278 tests、1277 pass、0 fail、1 skip（2026-11-06），包含遠端 tab ID 與 machine 欄位檢查。

第一階段狀態（2026-11-06）：原始碼與文件已修改，build 已產出；本輪未 commit、push、重啟或部署 bridge，執行中 bridge 未載入本輪修正。舊任務與訊息不會自動重送。

未驗證／下一步：重啟後在擁擠版面跑多 Worker → replan → reviewer／fix，確認新 tab 同 workspace／cwd、不搶焦點、關閉 reviewer root pane 的 tab 清理與既有 Agent 不受影響；遠端同機與 `agent start` 的 tab 路徑尚未實機驗證。既有小 pane 不會自動放大，視窗太小或之後縮小也可能不足。Lead 漏處理 prompt 的直接原因及提早確認是否開始處理仍未解決，若再發生需保留 hook／畫面證據繼續調查；不安全地重送 prompt 不在本次修正範圍。ISSUE-116 的信任提示誤判仍獨立待調查。

2026-11-07 card 接續：使用者授權走 card PR 與 L2 自動 merge。卡片 `REQ-20261106-issue108-pane-tabs` 的 task `task-c7fc2323-5756-4bdb-b4d0-a8ca79b3d1e8` 在獨立 worktree 套用既有 patch，11 個檔案的 SHA256 與原清單一致，並建立修正 commit。該 worktree 重跑 `npm test`（含 build）為 1278 tests、1277 pass、0 fail、1 skip，`npm run typecheck` 與 `npm run lint` 通過（2026-11-07，本機 macOS）。原目錄的同份未提交修改已在核對已提交副本後移除。接續 `card pr` 與 `card loop --merge`，獨立 review／CI／merge 結果記於營運卡片；合併不代表部署或實機驗收，bridge 尚未重啟，既有待驗收項目保持開放。

2026-11-07 PR／CI 接續：`card pr` 已建立 PR #151（https://github.com/jon888465/Herdr_Discord_Bridge/pull/151），head `1432360679f0` 的獨立 Codex review 第 1 輪 pass、無 findings，reviewer pane 已關閉。CI run `42248903152` 的 Ubuntu 全部通過，但 macOS job `127998371786` 排隊約 15 分鐘後 cancelled，沒有執行任何測試；annotation 確認 hosted runner 多次嘗試仍未取得，並提示 macOS arm64 runner 容量不足（https://github.com/jon888465/Herdr_Discord_Bridge/actions/runs/42248903152）。`card loop --merge` 正確停在 ci，沒有 merge。這是 GitHub runner 供應限制，不是已重現的程式測試失敗；不取消必要檢查、不修改 CI 規則、不繞過 merge gate。同步本紀錄後，透過 `card pr` 更新同一張 PR，再由 `card loop --merge` 對新 head 重新 review／等待 CI；後續執行結果保留在同一張營運卡片與 GitHub run。實機驗收與部署狀態不變。

## ISSUE-109：卡片只有「描述」與「驗收條件」會送給 Lead，其他段落被丟棄且沒有任何提示

更新日期：2026-11-06。狀態：待決定（根因已確認；尚未修正）。

使用者可見症狀：卡 `REQ-20261106-agy-pool` 一開始把流程要求放在「怎麼做」「不可做」兩個 `##` 段落，Lead 收到的 prompt（task `task-06eb2e97-7b7b-496e-b1b7-a10d722c343b` 的 `originalPrompt`）只有 `[描述]` 與 `[驗收條件]`，那兩段（包含「不可修改 config.json／policy.yml」這類護欄）完全沒有送出，也沒有任何警告。另外卡片缺少 `## 描述` 時，`card assign` 直接拒絕（第一次嘗試 06:18:50Z `autopick_failed`）。

預期行為：卡片上額外的段落要嘛送給 Lead，要嘛在 `card check`、assign 時警告「這些段落不會送給 Lead」。

已確認根因：卡片轉成 prompt 時只取描述與驗收條件。暫時的做法：卡片把所有要給 Lead 的內容放在 `## 描述` 底下（用 `###` 子標題）。修正範圍：無。待使用者決定：送出所有段落、或在 `herdr-card-check`／assign 時警告。
## ISSUE-110：驗收條件含「build／測試通過」時，唯讀 reviewer 無法驗證而判 `inconclusive`，連續兩次後退回人工

更新日期：2026-11-06。狀態：待決定（根因已確認；尚未修正）。

使用者可見症狀：PR #135（ISSUE-106）第 1、2 輪 review 都是 `inconclusive`（07:53:00Z、07:53:55Z）：四條驗收條件中第 1、2、4 條 ✓，第 3 條「新增的單元測試修正前失敗、修正後通過；build、lint 與相關測試全數通過」是 `?`——reviewer 是唯讀的，只能跑 typecheck 與 lint，不能跑會寫檔的 build 與測試。同一個 head 連續兩次 `inconclusive`，`card loop` 依規則退回人工（`autopick_stopped`）；CI（macOS、ubuntu）當時已全綠，使用者讀過 diff 後手動 merge。之前的卡之所以能 pass，是 reviewer 當時接受了文件中記載的結果。

預期行為：測試結果由 verify 與 CI 負責，不該讓 reviewer 的判定卡在它做不到的事。

已確認根因：驗收條件把「測試通過」同時交給 reviewer。修正範圍：無。候選：（1）卡片寫法：驗收條件只放 reviewer 讀 diff 能判斷的，測試／build 另列為 verify 的責任（agy 拆分後的三張卡已這樣寫，三張的 review 都一輪就 pass）；（2）`card loop` 讀 CI 結果補上這一類條件。待使用者決定。
## ISSUE-111：PR 的 diff 超過 60000 字元時 `card loop` 不執行 review，大型卡片無法自動走完

更新日期：2026-11-06。狀態：待決定（行為是設計上的守門；尚未決定是否要在規劃或開 PR 前事先提示）。

使用者可見症狀：卡 `REQ-20261106-agy-pool`（PR #136，+1297／-22、14 個檔案）task 完成、bridge commit 並開了 PR 後，08:51:49Z `card loop` 停在 review：「PR 的 diff 有 73638 字元，超過 review 上限 60000；請 Lead 把需求重新切分成較小的部分」，共 0 個步驟。此時 task 已花約 50 分鐘。

處理：依訊息把需求拆成三張卡（`REQ-20261106-agy-1-roster`、`agy-2-session`、`agy-3-reviewer`，各要求 diff 小於 40000 字元），各自由 bridge review 並 merge。這個守門本身是合理的（避免未完整審查的大 diff 自動 merge）。

觀察：大小是 PR 開出之後才發現，之前的工作已經做完。待決定：是否在規劃階段就要求 Lead 估計大小並先切分、或在 `card commit` 後、開 PR 前就檢查大小。

附帶觀察：同一個 task 的 verify（codex，`w3N:p3`）在 08:17:02Z 要求在 sandbox 外執行 `npm test > /tmp/…`（原因：sandbox 禁止本機 socket listen），bridge 把這個權限請求暫停等人，使用者在 08:29 選「只這一次」後繼續；請求 15 分鐘後過期。這是設計上的權限流程，不是缺陷，但表示完整測試需要人在場。
## ISSUE-112：`card cleanup` 在該卡的 worktree workspace 已被關閉時失敗，需手動移除 worktree 並補索引

更新日期：2026-11-06。狀態：待決定（已知限制；尚未修正）。

使用者可見症狀：我（Agent）在重試卡 `REQ-20261106-agy-pool` 前先用 `workspace close` 關掉 worktree 的 workspace `w32`，再下 `card cleanup` 回 `❌ herdr worktree.remove: workspace_not_found workspace w32 not found`；worktree 目錄與索引項目都還在，之後 `card assign` 一直報「已有作用中的 worktree」。需手動用 `git worktree remove`（不加 `--force`）移除，並在 `card-worktrees.json` 補上該項的 `removedAt`，才能重試。

預期行為：workspace 已不存在時，`card cleanup` 仍應能移除 worktree（沒有未提交修改的前提下）並更新索引，或至少給出明確的人工處理步驟。SPEC 目前只寫了「使用者手動移除 worktree 後 cleanup 會失敗」，這次是相反的順序（先關 workspace）。

已確認根因：`card cleanup` 經由 Herdr 的 `worktree.remove`，需要 workspace 還在。修正範圍：無。教訓：要清理時先下 `card cleanup`，再關 Lead workspace。

## ISSUE-113：agy 在新的 worktree 資料夾會停在「信任資料夾」提示，profile 啟動不就緒，錯誤訊息沒指出要去哪個 pane 處理

更新日期：2026-11-08。狀態：已驗收（選項 (b)，使用者 2026-11-07 明確決定的預先授權）；**2026-11-08 已做一次實機驗證（見下方「實機驗證」），使用者同日驗收通過（狀態：已驗收）**；先前：待決定（已知限制，靠使用者手動確認）。

**追加（使用者 2026-11-08 要求，已實作、尚未實機驗證）：**查 agy usage 時，`agent start agy` 在 `~/git_wk`（不是卡片 worktree）啟動，停在信任提示（Antigravity CLI 不繼承上層目錄的信任，家目錄 `~` 已在清單內也一樣）。使用者先要求手動把 `~/git_wk` 加入 `trustedWorkspaces`（備份 `agy-settings-pre-gitwk-20261108.json`，之後 agy 啟動無提示），再要求 bridge 的自動預先授權也涵蓋此目錄。做法：`config.json` 新增 `agyTrustedDirectories`（絕對路徑陣列，預設空，設定在不進 git 的使用者 `config.json`）；本機 agy 的 cwd 正好等於其中一個正規路徑時（卡片流程與 console／Discord `agent start` 都適用；`agent start` 對卡片 worktree 與其他 `--cwd` 仍不預先授權），bridge 缺才補、不自動移除、沒有所有權紀錄；不信任上層／子目錄／symlink／`/`／家目錄／相對路徑／不存在的目錄，遠端 agy 與其他 CLI 不適用，卡片 worktree 的授權與清理不變。測試（2026-11-08）：`test/agy-worktree-trust.test.ts` 新增 3 項（含 `agent start` 路徑）。**實機（2026-11-08，本機，bridge 以 main `c3f8fcd` 重啟後）：**第一版（PR #175）實測失敗——console `agent start agy`（含 `--cwd`）仍停在信任提示、設定檔沒變，**根因（已確認）：**`agent start` 一律 `skipWorkspaceTrust: true`（為了不信任任意 `--cwd`），新增的明列目錄檢查沒被呼叫；PR #176 讓 `agent start` 只走明列目錄那一段。修正後把設定檔暫時還原成不含該目錄的備份，再 `agent start agy`：bridge 記 `agy trusted directory added`、設定檔多一筆、agy 啟動沒有信任提示（pane `w3:p9`）。**尚未驗證：**重複啟動不重複（僅單元測試）、遠端 agy。這是比「只信任自己建立的卡片 worktree」更大的授權範圍，由使用者明列在 config 控制。

使用者可見症狀：agy 驗證卡 `REQ-20261106-agy-verify` 第一次執行時，Lead 的計畫正確（`implement` 給 `profile:agy`），但 agy pane `w3X:p2` 停在 Antigravity CLI 的選單 `Do you trust the contents of this project? > Yes, I trust this folder / No, exit`。bridge 的 `waitUntilReady` 等約 30 秒後回報 `started Agent does not match requested profile/workspace or is not ready`（09:44:19Z），implement 失敗，review、verify 因依賴它也失敗，task 在 09:44:31Z 失敗。訊息沒有提到是信任提示，也沒有指出是哪個 pane。

預期行為：bridge 不替使用者確認信任提示（與現有行為一致，不改）；但不就緒時應告知「agy pane 在等信任資料夾確認，請到 `<pane id>` 處理」，讓使用者知道要做什麼。

重現／環境：2026-11-06，本機 macOS，Antigravity CLI 1.4.12；每張卡的 worktree 都是新資料夾（`~/.herdr/worktrees/<repo>/card-<id>`）。

已確認根因：agy 的信任清單 `~/.gemini/antigravity-cli/settings.json` 的 `trustedWorkspaces` **只比對完整路徑，不含子資料夾**：清單裡雖然已有上層 `~/.herdr/worktrees/Herdr_Discord_Bridge`，仍然會詢問；過去 7 張卡的 worktree 也都是各自一條。因此每張卡的 worktree 對 agy 都要信任一次。Claude 不受影響，是因為它信任了上層的 `git_wk`。

處理：使用者在 pane 確認「Yes, I trust this folder」（我依使用者明確授權送出 Enter），agy 把該路徑寫進 `trustedWorkspaces`。清理（`card cleanup`、刪分支、關 workspace）後重跑，同一張卡的 worktree 路徑固定，已信任過所以第二次沒有再問；重跑成功，見 ISSUE-107 的實機證據。

修正範圍：無。可能的方向（未決定）：(a) 不就緒時抓畫面辨識信任提示並在訊息中指出 pane；(b) 建 worktree 時預先把路徑寫進 agy 的 `trustedWorkspaces`（會代替使用者做信任決定，需使用者同意）；(c) 先接受現狀，把「agy 每張卡要手動信任一次」寫進使用說明。

**修正（2026-11-08，`REQ-20261107-agy-worktree-trust`；使用者預先授權，範圍僅限 bridge 自己建立的卡片 worktree 的完整路徑）：**`src/agy-worktree-trust.ts`——bridge 啟動 agy 前，把該卡片 worktree 加入 `trustedWorkspaces`。只在「agy、本機、路徑在 `card-worktrees.json` 有效記錄、realpath 恰為 `~/.herdr/worktrees/<repo>/card-req-…`」時動；上層目錄、使用者資料夾、主 repo、symlink 導出一律不加；`agent start --cwd` 明確不授權；遠端 agy 只回報需人工處理，不碰本機設定。寫入只在最後一筆後多一行（沿用縮排），原子寫入、保留權限與其他欄位，解析失敗或結構不符、設定檔是 symlink 都不修改，寫前重核對檔案沒被改過；已存在的路徑不重複加也不記所有權，`card cleanup` 只移除 bridge 自己加的那一筆（所有權記在 state 目錄 `agy-worktree-trust.json`）；每次加入與移除寫 console log 與卡片事件 `agy_worktree_trust`；**不對 pane 送任何按鍵**，agy 的其他提示不變。`herdr.ts` 只 import 型別，實作由 `main.ts` 注入本機 hub，避免循環載入。

**測試（2026-11-08，本機非 sandbox，Node 26.12）：**22 個新測試，全用暫存目錄與可注入的設定檔路徑；人工接手時補上「symlink 設定檔不動」與「多行縮排只多一行、cleanup 後逐位元組還原」（先確認紅燈；Worker 版本的加入格式會讓移除後少一段空白）。**Worker 沒有跑過整套**（`npm test` 被權限提示擋住），接手時整套有 29 個檔案失敗：`herdr.ts` 載入時 import 實作造成循環 import（`Cannot access 'HerdrClient' before initialization`），已改為注入。最後整套 1499 項，1498 pass、0 fail、1 skipped，輸出無多餘 stdout；測試期間真實 `~/.gemini/antigravity-cli/settings.json` 內容與修改時間不變（37 行、mtime 1793962840）。

**獨立 review 的修正（2026-11-08，2 輪；bridge 的 `card review` 因作者 pane 已不在無法執行，改由手動開的 codex 做唯讀 review，含它的兩個子 reviewer）：**已登記的路徑若是 symlink（即使目標也在根目錄底下）會信任到不是 bridge 建立的目錄，現在路徑本身必須是正規路徑；symlink 檢查原本只做一次，設定檔在重試期間被換成 symlink（含指向自己）會被 `rename` 蓋成一般檔案，現在每次重試與 `rename` 前都檢查；核對與 `rename` 之間無法與 agy 互斥，**並行寫入造成的遺失更新無法完全消除**——每次修改前先把驗證過的原內容備份到 state 目錄 `agy-settings-backups/`（權限 600、只留 5 份，備份在最後核對之前完成，核對後立刻 `rename`）供使用者還原；cleanup 當下設定檔壞掉會殘留信任且沒有重試入口，bridge 啟動時 `sweep()` 對「所有權還在、worktree 已不存在」的項目重試移除。每項都先確認測試紅燈再修。

**實機驗證（2026-11-08，本機 macOS，Antigravity CLI，bridge 載入 main `2351f06`（PR #163）後；測試卡 `REQ-20261108-agy-trust-live-test`，task `task-9f4d9bd3-b42d-4e44-ab3e-106f068f144a`，PR #164）：**bridge 在 08:08:26Z 把卡片 worktree 寫進 `~/.gemini/antigravity-cli/settings.json` 的 `trustedWorkspaces`（寫入前先備份真實設定檔，與備份只差這一行），之後 agy Worker（pane `w4W:p2`）**沒有跳出信任提示**、直接收下 prompt，並只在 `docs/known-issues.md` 加了要求的那一行（PR #164 為 +1／-0）；08:11:39Z `card cleanup` 後信任項目被移除，`settings.json` 與備份**逐位元組相同**，所有權檔 `agy-worktree-trust.json` 為空，卡片事件有 `agy_worktree_trust` added 與 removed。因此未驗證項目①的答案：**agy 會在啟動時讀取 `settings.json`，預先授權有效**（一次實測，agy 每次啟動是否都重讀仍只是這一次的觀察）。**同一次測試的其他觀察：**(a) autopick 在 review 步驟停下（`loop_stopped`，狀態 `failed`），原因是測試卡沒有 `## 驗收條件` 條列、`card review` 無法逐條對照——是卡片寫法問題，不是信任機制問題；PR #164 因此沒有經過 bridge review，也沒有被合併；(b) agy pane 同時顯示警告「Sign-in update needed：登入缺少新要求的權限，部分請求可能失敗，請 `/logout` 重新登入」，本次任務沒受影響，**原因與影響未調查**，若之後 agy 請求失敗要先看這個。仍未驗證：遠端 agy、並行寫入的遺失更新（已知限制）、使用者驗收。

**未驗證：**①~~agy 啟動時是否重新讀取 `settings.json`~~（2026-11-08 已實測，見上）；②遠端 agy（`agy-pod`）不在範圍；③agy 的其他 profile（pi、opencode）有沒有類似提示；agy 是否有設定可改成信任子資料夾。

## ISSUE-114：新增 `agent start <machine:agent:model:level>`，臨時指定機器、Agent、model 與推理強度（level）

更新日期：2026-11-06。狀態：已修正、待驗收（**尚未做任何 Discord／Herdr／CLI 實機驗證**；bridge 尚未重啟，執行中的仍是舊版）。

症狀（卡片 `REQ-20261106-agent-launch-spec`）：開特定 model／強度的 Agent 只能事先寫 `agentProfiles`。預期：`agent start <規格> [--cwd <路徑>]` 在選定 Agent 的 workspace 開新 pane，規則見 `SPEC.md`。根因：非 bug，是功能缺口。

修正範圍：新增 `src/agent-launch-spec.ts`、`src/agent-launch.ts`；`cli-adapter.ts` 新增 `levelArgsFor`；`startAgentInPane` 新增選填 `args`；`main.ts` 新增分派。model 驗證呼叫 `validateProfiles`，未放寬。不改 `config.json`、`policy.yml`、profile、`--coding`、Team roster。

審查發現與修正（2026-11-06）：
- f1：遠端 `--cwd` 只比對文字，symlink 可越界。改為白名單非空時經 ssh `realpath` 比對 canonical path，無法驗證就拒絕。
- f2：成功前未核對實際 Agent。現在核對種類、workspace、pane、terminal，不符視為失敗。
- f3：`validateProfiles` 只擋 CR／LF／NUL。`agent start` 另拒絕 model 內所有 C0、DEL、C1；profile 行為不變。
- `waitUntilReady` 不改動，blocked 訊息的「reviewer」在此換成「Agent」。

測試（2026-11-06，本機 macOS，未實機）：typecheck、`npm test`（含 build）、`npm run lint` 退出碼皆 0；1266 項中 1265 通過、0 失敗、1 略過。新增 `test/agent-launch.test.ts` 涵蓋 f1–f3。

限制：v1 只能在選定 Agent 所在的機器啟動（跨機器另案）；遠端 canonical path 需 ssh 可用，否則拒絕；`--cwd` 以空白串接其餘參數；pane 太小沿用 ISSUE-108。

未驗證／下一步：實機確認 (1) pane 以指定 model 與強度啟動；(2) agy 信任提示被回報而非確認；(3) 白名單非空時 `--cwd` 的拒絕與遠端 realpath；(4) 遠端同機啟動。完成後改為已驗收並記錄日期與環境。

**2026-11-06 實機驗證（本機 macOS，bridge 以 main `27aa532` 重啟後，從 console 下指令）：**核心路徑通過，狀態維持「已修正、待驗收」，是否驗收由使用者決定。

- 拒絕路徑（都沒有啟動任何東西）：`agent start` 無規格顯示用法；`:agy::high` →「agy 沒有已確認的推理強度（level）參數，不猜」；`:codex::med;touch/x` →「不合法的 level」；`:a:b:c:d` →「規格最多四段，收到 5 段」；`nope:codex` →「未知的 machine "nope"（只接受 local、agy-pod）」。
- `agent start :codex:gpt-6.1-sol:medium` → 回報 pane `w1:p9`、機器 local、種類 codex、model `gpt-6.1-sol`、level `medium`、「未自動切換」。從行程確認實際參數為 `codex -m gpt-6.1-sol -c model_reasoning_effort=medium`，codex 畫面底部為 `GPT-6.1-Sol medium`（上一項(1)已驗）。
- `agent start claude` → 回報 model、level 皆「CLI 預設」；`agent start :::high` → 種類沿用 claude、level `high`，pane 畫面為 `Sonnet 5.5 with high effort`（省略寫法已驗）。測試用的兩個 pane 已關閉。

**同日補驗（同一個 bridge，console）：**
- 遠端同機啟動：`agent use agy-pod:w2:p1` 後 `agent start :agy` → 回報 pane `agy-pod:w2:p2`、機器 agy-pod、工作目錄 `/root`；ssh 到 pod 確認該 pane 真的跑著 agy（Antigravity CLI 1.4.7）。pod 上只裝了 agy，所以沒驗遠端的 claude／codex。
- 指定其他機器被拒：選定遠端 Agent 時 `agent start local:agy` →「v1 只能在選定 Agent 所在的機器（agy-pod）啟動，不能開在 local（跨機器另案）」。測試 pane 已關閉，選用已切回 `w1:p1`。
- agy 信任提示：用全新、agy 沒信任過的資料夾當 `--cwd` 啟動 agy，**bridge 回報「✅ 已啟動」，實際上 agy 停在 `Do you trust the contents of this project?`**。bridge 沒有替人確認（測試 pane 已關閉，信任清單沒有被寫入）。但「回報成功」是錯的，見 ISSUE-116。

**`--cwd` 白名單（同日，使用者同意暫時把 `allowedWorkspaceIds` 改成 `["w1"]`，重啟驗證後已還原為 `[]` 並再重啟；`config.json` 與備份一致）：**`--cwd /tmp` →「allowedWorkspaceIds 非空時，--cwd 必須在選定 workspace 之內」；不存在的資料夾 →「--cwd 不是存在的資料夾」；相對路徑 →「--cwd 必須是不含控制字元的絕對路徑」；在白名單根目錄內放一個指向 `/tmp` 的暫時 symlink 當 `--cwd` 也被拒絕（canonical path 比對生效，驗完已刪除該 symlink）。

**仍未驗證：**白名單非空時遠端的 realpath（`agy-pod` 只有 agy，且這次只驗了本機）；Discord 端 `/herdr agent start`（無法代使用者在 Discord 輸入）；遠端的 claude／codex；pane 太小時的行為（ISSUE-116）。另：卡片原意可指定其他 machine，v1 只在選定 Agent 所在的機器啟動（上面已驗證會被明確拒絕）。

## ISSUE-115：Team 的 verify 在 sandbox 內跑 `npm test` 一定撞 socket 限制，權限請求過期會讓整個 task 失敗

更新日期：2026-11-07。狀態：已修正、待驗收（僅限下方「2026-11-07 補充：codex 在卡片 worktree 寫 git」面向）；原本的 verify 逾時面向仍為待決定（已知限制；尚未修正）。

使用者可見症狀：卡片 `REQ-20261106-agent-launch-spec`（task `task-f1480af3-308c-412f-85d8-caf25adc194d`）的 verify 由 codex（`profile:helper`）執行，`npm test` 在 sandbox 內因禁止 Unix socket listen 失敗（`EPERM`），codex 要求在 sandbox 外重跑，bridge 把它轉成權限請求。12:25 開出第一次請求，使用者選「1」（只允許這一次）；12:43 第二回合 `verify2` 再問一次，等到 12:58 逾時（約 15 分鐘），`verify2` 回報 `Timed out waiting for current response from w41:p4 (last state: blocked)`，task 失敗（`autopick_stopped`），**即使實作與兩輪 review（第 2 輪 pass）都已完成**。更早的 `REQ-20261106-agy-pool` 也問過同一個請求。

預期行為：需要使用者回答的權限請求不應讓已經做完的 task 整個失敗；或 verify 不需要在 sandbox 內跑會被擋的測試。

已確認事實：(1) `npm test` 含需要 Unix socket 的測試，在 codex sandbox 內一定失敗；(2) 每個 verify 回合都會再問一次（選「這次」不會延續到下一回合）；(3) 權限請求有約 15 分鐘期限，過期即令該指派失敗；(4) 通知只靠聊天回報，使用者不在畫面前就會漏掉（我也在到期前沒有再催）。**根因（為什麼 verify 不改用 CI 或 sandbox 外的方式）未確認。**

處理：這次由我在 worktree 手動補跑 `npm run build` 與 `npm test`（1266 項中 1265 通過、0 失敗、1 略過），再手動 commit、開 PR #143，由使用者 merge。

修正範圍：無。可能的方向（未決定）：(a) 使用者選「以後都不問」（放寬 sandbox 範圍，由使用者決定）；(b) verify 的提示改成「`npm test` 的 socket 測試在 sandbox 內會失敗，改請求權限前先說明」，或讓 verify 只跑 build 與相關測試，完整測試交 CI；(c) 權限請求過期時把指派標為 blocked 等人，而不是令 task 失敗，並可重新發出；(d) 請求等待超過一半時間時由 bridge 再通知一次。

未驗證：codex 以外的 verify Worker（claude）是否也會撞同一個限制；(c) 的行為牽涉 `src/team-orchestration.ts`，修改前需確認不影響其他逾時語意。

### 2026-11-07 補充：codex 在卡片 worktree 寫 git 會卡在權限提示（REQ-20261107-codex-worktree-git）

**症狀：**卡片 Worker 若是 codex，執行 `git add`、`git add -N`、`git reset`、`git stash` 等寫 git 的指令會跳權限提示，約 15 分鐘沒人處理即逾時，Worker 任務失敗、整張卡失敗。2026-11-07 連續兩張卡（`REQ-20261107-flow-notify`、`REQ-20261107-tab-naming`）因此失敗；`flow-notify` 已寫完近乎全部程式，只差量 patch 大小用的 `git add -N`／`git reset`。

**已確認根因：**卡片的 worktree 是 git linked worktree，它的 index 與 HEAD 放在**主 repo 底下**的 `<repo>/.git/worktrees/<名稱>/`，在 codex workspace-write 沙箱可寫範圍（只有 worktree 目錄本身）之外。

**2026-11-07 實測（本機，拋棄式 repo 加 linked worktree）：**(1) 在 `codex sandbox` 內執行 `git add -N new.txt` 失敗：`fatal: Unable to create '…/.git/worktrees/wt/index.lock': Operation not permitted`；(2) `codex --add-dir <DIR>` 只有在有效沙箱是 workspace-write（或 danger-full-access）時才生效，否則 codex 印 `Error adding directories: Ignoring --add-dir … because the effective permissions do not allow additional writable roots` 並直接結束、不啟動（在未信任的測試資料夾實測；該資料夾另會先跳「Trust this folder」，不在本項範圍，bridge 仍不替人確認信任）。

**修正（原始碼，2026-11-07）：**`src/cli-adapter.ts` 新增 `extraLaunchArgsFor`（per-kind 設計旁，可注入 git 目錄解析函式），為唯一組裝點：只有 codex、cwd 是 linked worktree、`git rev-parse --git-dir` 的 realpath 直接位於主 repo `.git/worktrees/` 底下時，加**一個** `--add-dir <該 worktree 的 git 目錄>`；非 codex、一般 repo、非 git 目錄、解析失敗、路徑不符（如 symlink 指到別處）都不加、參數不變。入口：`src/agent-start.ts` 的 `startAgentInPane` 吃新的 `cwd`（`card review`／`card fix` 的 reviewer 與修正者經 `card-review-flow.ts`／`card-fix-flow.ts` 傳 `worktreePath`；autopick Lead 傳 `repoPath`；`agent start` 只在本機傳 `--cwd`），profile Worker 在 `src/herdr.ts` 直接呼叫同一函式。**沒有**加任何放寬旗標（`--dangerously-bypass-approvals-and-sandbox`、`-a never`、`--approve-for-me`、`-s danger-full-access`），沒有改 `~/.codex/config.toml`、`config.json`、`policy.yml`，沒有自動確認提示，approval 政策不變；其他指令（寫 worktree 外、網路、`herdr`）仍會問。codex 因忽略 `--add-dir` 而結束時（`agent.start` 錯誤，或啟動後偵測不到 Agent 且 pane 輸出含 `Ignoring --add-dir`／`do not allow additional writable roots`），呼叫端得到含「--add-dir 被忽略，有效沙箱不是 workspace-write」的錯誤；不退回無參數啟動、不改更寬鬆模式。`SPEC.md` 已同步。

**測試（2026-11-07，本機，非 sandbox；假 port，拋棄式 git repo／worktree，不呼叫真 codex）：**先寫測試，`npm run build` 得到預期 red（9 個 TS 錯誤，新匯出尚不存在）；實作後 `npm run build` 通過，`node --test dist/test/*.test.js`：1425 項，1424 pass、0 fail、1 skipped（既有的略過）。新增涵蓋：codex＋真實 linked worktree 恰一個 `--add-dir`；非 codex 不變；一般 repo／非 git／不存在的目錄不加；git 目錄被 symlink 導出 `.git/worktrees/` 外不加、注入解析結果的各種不符情形不加；參數清單直接掃無放寬旗標；profile Worker、`startAgentInPane`、`agent start` 的啟動參數；忽略 `--add-dir` 的明確錯誤（`agent.start` 失敗與啟動後結束兩條路徑，且只啟動一次）。為避免環境耦合，`test/agent-launch.test.ts` 原本以 `process.cwd()`（在本 worktree 內是 linked worktree）當 cwd 的夾具改成非 git 暫存資料夾，斷言沒有改動或刪除。

**狀態分開記錄：**原始碼已改、build 與上述自動化測試通過；**執行中的 bridge 尚未重啟或部署**，舊的執行檔不含此修正；舊的卡片失敗不會補送。**尚未實機驗證：**`--add-dir` 在已信任的卡片 worktree、有效模式為 workspace-write 時，是否真的讓 `git add -N` 不再跳提示，沒有驗證過；`--add-dir` 被忽略的錯誤路徑只以假 port 測過，沒有用真實 codex 測。下一步：重啟 bridge 後以 codex 當 Worker 跑一張會 `git add -N` 的卡片並記錄結果。在此之前不可標「已驗收」。

## ISSUE-116：`agent start` 在很小的 pane 啟動 agy 時，agy 停在信任提示卻被回報「已啟動」

更新日期：2026-11-06。狀態：待調查（現象已重現；偵測缺口的根因未確認）。

使用者可見症狀：`agent start agy --cwd <agy 沒信任過的新資料夾>`（本機，選定 Agent 在 `w1`）回 `✅ 已啟動 Agent：pane w1:pC`，但該 pane 畫面是 `Accessing workspace: … Do you trust the contents of this project?`，Agent 沒有就緒。Herdr 對該 pane 的 `agent_status` 一直是 `idle`（等了約 15 秒仍是 `idle`），`scroll.viewport_rows` 只有 7。

預期行為：停在信任提示時應回報「卡在啟動提示，請到 pane 處理」並保留 pane（`waitUntilReady` 對 `blocked` 本來就是這樣處理，見 ISSUE-091）。

重現／環境：2026-11-06，本機 macOS，Antigravity CLI 1.4.12，bridge 以 main `27aa532` 重啟後從 console 執行。對照：agy 驗證卡（ISSUE-113）時 agy pane 有 29 行，Herdr 狀態為 `blocked`，`waitUntilReady` 正確失敗。

已確認：(1) `waitUntilReady`（`src/agent-ready.ts`）只相信 Herdr 回報的 `agent_status`，`idle` 就視為就緒；(2) 兩次現象的差別是 pane 高度（7 行 vs 29 行）與狀態（`idle` vs `blocked`）。**根因未確認**：推測是 pane 太小時選單被截掉，Herdr 的畫面偵測看不到提示，與 ISSUE-108（小 pane）同類，但沒有驗證過把 pane 變大是否就會變成 `blocked`。

影響：`agent start` 的「已啟動」回報在小 pane 不可靠；使用者要自己看 pane 才知道。`card` 的 Worker 啟動也走 `waitUntilReady`，若 Worker pane 很小也可能把「在等信任」誤當就緒（ISSUE-113 那次沒有發生，因為 pane 夠大）。

修正範圍：無。可能的方向（未決定）：(a) 與 ISSUE-108 一起處理，pane 太小時改開 tab；(b) 就緒後額外讀畫面，看到已知的信任／更新提示字樣就視為 blocked（不替人確認）。

未驗證：pane 變大後是否變成 `blocked`；其他 CLI（claude、codex）在小 pane 的信任提示是否也被偵測成 `idle`。

關聯（2026-11-07）：ISSUE-118 僅讓共用 `waitUntilReady` 跳過已知更新提示，不自動處理信任／權限，也未修正本 issue 的偵測／接線問題；本 issue 狀態不變。

## ISSUE-117：自動撿卡的 Lead 設成 codex 時，`startLead` 一定失敗（只看 `agent.start` 當下的狀態，codex 啟動後先是 working）

更新日期：2026-11-09。狀態：已修正、待驗收（2026-11-09 見 ISSUE-130：來源 Lead 與 worktree 第二次啟動都會等 working；codex 當 Lead 已於同日實機走完一張卡，但沒有直接觀察到 working 狀態，也沒有保存啟動時的畫面）。下列 2026-11-07 內容是修正前的診斷歷史。

使用者可見症狀：2026-11-06，使用者要求把 `policy.yml` 的 `autopick_lead` 從 `claude` 改成 `codex`（備份 `policy.yml.bak-lead-20261106`），bridge 重啟後 `card policy` 顯示「Lead：codex」。ready 的卡 `REQ-20261107-small-pane-tab` 在 16:27:28Z 被撿起，立刻失敗（`autopick_failed`）：`lead：Lead（codex）沒有就緒，狀態是 working；可能卡在信任資料夾或登入提示`。bridge 依設計在失敗時關掉剛開的 workspace，所以事後沒有現場可看，無法確認當時是否真的有提示；卡片留在 `ready`。

預期行為：Lead 為 codex 時，等 codex 完成初始化（`working` → `idle`）再開始，與 `agent start`、`card review` 的 reviewer 一致；真的卡在信任或登入提示（`blocked`）時才失敗。

已確認根因（讀碼，2026-11-07）：`src/autopick-wiring.ts` 的 `startLead` 呼叫 `startAgentInPane` 後，只檢查它**回傳的** `lead.agent_status` 是否為 `idle` 或 `done`，不輪詢；codex 啟動後先是 `working`（ISSUE-079 已記錄「`agent.start` 回來時 Agent 常常還在初始化，實測 codex 啟動後先是 working」，`src/agent-ready.ts` 的 `waitUntilReady` 就是為此寫的，但 `startLead` 沒用它）。claude 啟動即 `idle`，所以只有 claude 當 Lead 能過。**尚未做的驗證：**沒有用 codex 重跑一次並保存當時的 pane 畫面，無法排除「同時也真的有提示」；也沒有用測試重現。

影響：`autopick_lead: codex` 目前不可用；測試 `Lead 為 codex 時 reviewer 為 claude`（`test/autopick.test.ts`）只用假 steps，沒有涵蓋 `startLead` 對 `working` 的處理，所以單元測試沒抓到。

修正範圍：無（只記錄）。建議：`startLead` 改用 `waitUntilReady`（同 `agent start`），`blocked` 或逾時才失敗並說明，並加測試涵蓋「回傳 working 後變 idle 成功、blocked 失敗、逾時失敗」。要先把 `autopick_lead` 改回 `claude` 才能用自動撿卡跑這張修正卡。

未驗證：其他 Lead 種類（agy、pi 目前不被政策接受）；修好後 codex 當 Lead 的完整卡片流程（規劃、`card review` 改用 claude 當 reviewer）仍沒有實機證據。

關聯（2026-11-07）：ISSUE-118 僅讓共用 `waitUntilReady` 跳過已知更新提示，不自動處理信任／權限，也未修正本 issue 的偵測／接線問題；本 issue 狀態不變。

## ISSUE-118：Agent 啟動時被已知 CLI 更新提示擋住（REQ-20261107-skip-update-prompt）

更新日期：2026-11-07。狀態：已修正、待驗收。

使用者可見症狀／重現環境：卡片提供的 2026-11-07 本機重現紀錄中，codex 0.166.0 → 0.167.0 的 `Update available`／`Skip until next version` 選單讓 `card review` reviewer 連續 blocked／inconclusive；人工按 `3` 後可啟動。本輪沒有實機重現或驗證。

預期行為：只跳過已知更新提示，信任、權限、approval、登入與未知畫面仍留給人；blocked 失敗沿用原訊息並保留 pane。

已確認根因（2026-11-07 讀碼）：共用 `waitUntilReady` 對 blocked 一律立即失敗，未辨識更新選單。此原因符合卡片描述的 reviewer 症狀；與 ISSUE-117 的實際因果關係尚未證實。

修正範圍：`src/update-prompts.ts` 宣告種類、必須同時出現的字樣與跳過鍵，通用 matcher 不寫死 codex。清單目前僅 codex 一筆（`Update available` + `Skip until next version` → `3`）；claude、agy、其他 CLI 未驗證，其清單項目留空。`src/agent-ready.ts` 僅在 blocked 且成功讀畫面、命中清單、無敏感提示文字時送一次按鍵；同 port／pane 跨等待呼叫也不重送，送達不確定不重試。送後以 bridge console log 記錄「已自動跳過 <CLI> 的更新提示（pane、按鍵）」，再讀畫面；提示仍在或讀不到即回原 blocked。`waitUntilReady` 本身沒有卡片事件上下文，所以不直接寫卡片；它把跳過資訊（CLI、pane、按鍵）放在回傳的 `updateSkip`，由呼叫端 `card review`／`card fix` 在 `src/card-command.ts` 寫入卡片事件 `update_prompt_skipped`（事件 ID 含輪次、pane 與時間，避免同輪重試被帳本去重）。`card-events` 因此新增 `update_prompt_skipped` 事件型別。

測試（2026-11-07，本機 sandbox，假 port）：先新增成功路徑測試，`npm run build && node --test dist/test/agent-ready.test.js` 得到預期 red（1 fail，原實作回 blocked）；實作後相關測試 21/21 pass，0 fail。涵蓋成功後就緒、提示持續與同 pane 重入不重送、輪詢中 blocked、agy／claude 信任、權限／未知、讀取失敗與無效資料、更新混合敏感字樣、種類不符、送達不確定、送後讀取失敗，以及直接掃清單無信任／權限／登入字樣。最終檢查命令：`npm run typecheck`、`npm run build`、`node --test dist/test/agent-ready.test.js dist/test/update-prompts.test.js`。完整套件未執行，因 Unix-socket 測試在 sandbox 會 EPERM（ISSUE-115）。最初 build 因未安裝依賴而找不到 tsc，`npm ci --ignore-scripts` 後解除。

未驗證／下一步：**尚未實機驗證** Discord／Herdr／codex；claude、agy 與其他 CLI 更新提示皆未涵蓋／未驗證，不得猜畫面或按鍵。autopick `startLead` 與 profile pool 使用獨立等待流程，未接線此共用函式，本輪不擴大範圍，ISSUE-117 仍待處理；ISSUE-116 的 idle 誤判也未修正。尚未部署或重啟執行中的 bridge；build 通過不代表 runtime 已更新，舊的失敗任務／訊息不會補送。Lead 應安排重啟後的真實更新選單與信任提示驗收。


## ISSUE-119：自動建立的 workspace／pane 未顯示實際 Agent 種類（REQ-20261107-agent-naming）

更新日期：2026-11-07。狀態：已修正、待驗收。

現況補充（2026-11-09，ISSUE-129，已驗收）：以下為 ISSUE-119 命名變更當時的範圍與驗證歷史；現行 Lead cleanup 另以卡片記錄 id 加上 label 現況核對守門，label 不再僅供顯示；不依名稱搜尋其他 workspace。

使用者可見症狀：autopick Lead workspace 原本只有 `autopick-<卡片 id>`；reviewer、profile Worker、`agent start` pane 未標示種類與角色，側欄難以辨認。預期名稱包含實際種類，workspace 保留卡片及 `autopick-` 前綴、最多 60 字元；名稱不作為關閉身分。

重現／環境：2026-11-07，本機 macOS sandbox、Herdr CLI 0.9.1，使用假 port 重現舊 workspace label 缺少 codex／claude；尚未在實機 Herdr 側欄驗證。已確認根因（讀碼）：workspace.create label 固定只拼卡片 id，相關 pane 建立入口未呼叫命名 API。`herdr pane --help`、`herdr pane rename --help` 確認 rename 支援；`herdr api schema --json` 的 `PaneRenameParams` 確認參數為 `pane_id`／`label`，沿用現有 port.request socket 呼叫方式，沒有為能力探測修改任何 live pane。

修正範圍：`src/cli-adapter.ts` 共用 `agentDisplayName`，共用原有 adapter 種類辨識而非另建對照表。workspace 使用 `autopick-<種類>-<卡片 id>` 並維持 `slice(0, 60)`，超長只截卡片尾端；reviewer、Worker、agent start pane 顯示 `<種類>·<角色>`，Worker／agent start 有 model 時附加 model。pane.rename 以 retries: 0 呼叫，失敗記錄警告，保留既有啟動與清理流程。Agent 啟動名稱、關閉 workspace／pane 的 id／terminal id 守門、card cleanup 與 console 的既有 label 查找沒有變更；config.json、policy.yml 未修改。

測試（2026-11-07）：先新增 workspace 假 port 測試，`npm run build && node --test dist/test/autopick-wiring.test.js` 得到預期 red：8 pass、2 fail（codex／claude label 缺少種類）；修正後 10/10 pass。pane 新增斷言先得到預期 red：`npm run build && node --test dist/test/agent-launch.test.js dist/test/profile-start.test.js dist/test/review-pane.test.js` 為 29 pass、3 fail（缺少 rename）。接線後第一輪相關檢查為 61 pass、2 fail（既有呼叫順序斷言尚未加入 rename），已補上新操作斷言、保留既有驗證。最初 build 找不到 tsc，`npm ci --ignore-scripts` 後解除。

最終檢查（2026-11-07）：`npm run typecheck`、`npm run build`；`node --test dist/test/autopick-wiring.test.js dist/test/agent-launch.test.js dist/test/profile-start.test.js dist/test/review-pane.test.js dist/test/card-review-flow.test.js dist/test/cli-adapter.test.js dist/test/pane-split.test.js`，101/101 pass、0 fail。涵蓋 codex／claude、長 id 與 60 字元上限、前綴、種類 alias、角色及 model、改名後仍用 id 關閉、terminal 被替換時拒絕關閉、命名不支援時不改清理行為。未跑完整套件：sandbox Unix socket listen 會 EPERM（既有限制 ISSUE-115），本輪只跑相關測試檔。`git diff --check` 通過。

未驗證／下一步：**尚未在實機 Herdr 側欄驗證**；本機／遠端的 pane.rename 實際顯示、CLI 啟動後 label 是否保留、人工改名後的實機清理仍需 Lead 安排驗收。舊版遠端 server 可能不支援 rename，會記警告並沿用未命名 pane。原始碼與 build 已完成，執行中的 bridge 未部署、未重啟；既有 workspace／pane 不會補改名，舊訊息不會補送。不代表 ISSUE-117 的 codex Lead 就緒問題已修正（該 issue 狀態不變）。未 commit、未 push。
