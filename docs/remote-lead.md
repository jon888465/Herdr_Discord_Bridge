# 遠端 Lead：卡片指定 Lead 跑在遠端 machine

需求卡 `REQ-20261127-remote-lead`（plugin 狀態目錄，不在 repo）。ISSUE-225。2026-11-27 設計文件，**狀態：A 到 E、C 的 hook 要求都已由使用者確認（2026-11-27），第 1 階段已實作待驗收，其餘階段尚未開始。本文所有「現況」來自讀碼（引用檔案與函式），沒有實機驗證，標明「實測」的除外。**

## 1. 目標與非目標

**目標：**卡片（含自動撿卡）可以指定 Lead 在哪台 machine、哪個 agent 種類、哪個 model 與 effort，例如使用者要的寫法：

```
lead: agy-machine:agy:neon:medium
```

**非目標（這份設計先不做）：**
- 遠端 Lead 直接寫本機 worktree（Lead 本來就不寫；寫入仍由 `implement` 角色經快照與 patch 取回完成）。
- 手動 `card assign`（console）指定 Lead：手動流程的 Lead 就是目前路由的 agent，不讀卡片欄位（`docs/multi-lead-plan.md`）。
- 修改 `roles` 對含冒號 model 的既有語意（見 §3 B）。

## 2. 現況與證據（讀碼）

| 項目 | 現況 | 來源 |
| --- | --- | --- |
| 卡片 `lead` 欄位 | 只接受 `claude`／`codex`／`agy`／`pi`，沒有 machine、model、effort | `src/card.ts`（`invalid lead; use claude, codex, agy or pi`） |
| `roles` | 鍵為 `implement`／`diagnose`／`review`／`verify`／`reviewer`／`fixer`；值 `machine:agent:model`，第二個冒號之後整段是 model（可含冒號，上限 80 字）；**沒有 lead** | `src/card-role-assignment.ts`（`CARD_ROLES`、`parseCardRoles`、`CARD_MODEL`） |
| worktree 卡的 Lead | `card assign --worktree` 在本機建 worktree，並在新 worktree workspace 啟動「同種類」agent 當 Lead；ISSUE-221 之後沒有來源 workspace，只靠 `{repoPath, kind}` 的來源紀錄 | `src/card-worktree-flow.ts`（`prepareCardWorktree`）、`src/autopick-wiring.ts`（`WorktreeSource`） |
| readonly 卡的 Lead | autopick 在本機開 workspace、啟動 Lead、`agent use` | `src/autopick-wiring.ts`（`startLead`） |
| 引擎怎麼驅動 Lead | 對 `lead.pane_id` 下 `agent.prompt` 並等回覆；pane id 帶 `<machine>:` 前綴時 hub 依前綴轉發（遠端角色就是這樣被驅動） | `src/team-orchestration.ts`、`src/machines.ts` |
| 遠端角色怎麼起 | `startRemoteRole`：本機做快照（bundle）→ 送到遠端 clone → 在遠端建 workspace、啟動 agent；唯讀角色在 `afterTurn` 比對遠端指紋；`cleanup` 保留或清理遠端 workspace、目錄與信任項目 | `src/remote-snapshot.ts` |
| 遠端 Stop hook | `machines[].hookSocket` 設定後，bridge 以 `ssh -R` 把遠端 hook socket 轉回本機，遠端 agent 的 Stop 事件才送得回來；沒設定就只能靠終端畫面解析 | `src/machines.ts`（`hookSocket`） |
| Lead 事件紀錄 | 流程紀錄已有 `lead：<種類>；machine=<id>` 的格式（目前 machine 恆為 local） | `src/card-role-assignment.ts`、卡片紀錄 |
| PR 階段 review／fix 與「作者」 | 以「最後一個 task 的 Lead」當作者：決定 reviewer／新作者的種類，並在**作者的 pane 旁邊**開新 pane；作者在遠端時**直接拒絕**（「作者在遠端機器…目前 review／修正只支援本機（跨機器是後續階段）」） | `src/card-review-wiring.ts`、`src/card-fix-wiring.ts` |
| effort | `levelArgs` 只有 claude（`--effort <level>`）與 codex（`-c model_reasoning_effort=<level>`）；agy、pi 沒有，`agent-launch-spec` 對不支援的種類拒絕 | `src/cli-adapter.ts`、`src/agent-launch-spec.ts` |
| agy CLI（**實測，2026-11-27，本機與遠端 machine 各一次，`--help` 與 `agy models`，唯讀**） | 有 `--model` 與 `--effort`（`low\|medium\|high\|xhigh\|max`）；`agy models` 列出的 id 含 effort 後綴，例如 `gemini-4-neon-medium`、`gemini-4-neon-high`，另有不含後綴的 `gemini-pro-orchestrator-neon` | CLI 輸出 |
| 多種 Lead 的已知缺口 | (3) `parseAssignmentPlan` 只有 codex 的終端 fallback 會做 JSON 硬換行 unwrap，非 codex 的長 JSON 可能失敗；(1)(2)(4) 見文件 | `docs/multi-lead-plan.md` |

**兩個關鍵含意：**
1. **Lead 回的是長 JSON（指派計畫），而遠端 agent 的回覆在沒有 hook 時走終端畫面。**ISSUE-212、ISSUE-224 證明遠端終端畫面會吃掉跳脫的雙引號並折行；目前只有 review／fix／verify 的解析器有補救，**計畫的解析器沒有**。遠端 Lead 在沒有 hook 時，風險直接落在計畫 JSON。
2. **PR 階段的 review 與 fix 現在要求「作者在本機」**，所以遠端 Lead 的卡走到 PR 階段會被拒絕。這不是遠端 Lead 的附帶問題，而是設計必須先回答的問題（§3 D、E）。

## 3. 設計決定

### A. 遠端 Lead 怎麼讀到程式碼

| 選項 | 說明 | 評估 |
| --- | --- | --- |
| **(a) 任務開始時的唯讀快照（建議）** | 重用 `startRemoteRole` 的快照：把本機 worktree 當下內容送到遠端、在那裡啟動 Lead（新增唯讀角色 `lead`） | 機制已存在、已實機驗證過遠端唯讀角色；缺點：implement 之後本機 HEAD 往前走，Lead 看到的是過期內容 |
| (b) 每輪規劃前重送快照 | 在同一個遠端目錄用 bundle 補上新 commit，agent 不重啟 | 遠端目錄正被 agent 使用，補內容要處理檔案被改動與指紋；複雜度高，先不做 |
| (c) Lead 不讀 repo | Lead 只看 bridge 給的證據摘要（`evidenceSummary`、前輪報告）規劃 | 最簡單，但 Lead 目前的提示假設它能看目錄；要改提示並驗證規劃品質 |

**建議 (a)，並以「證據摘要」補過期的部分：**規劃提示本來就附 `Coding evidence`（stage、版本指紋、各 artifact 的角色與命令結果）與前輪報告，交付內容的實際狀態由 worker 的 verify／review 判斷，不靠 Lead 自己讀。**要驗證的假設（第 3 階段實機）：快照過期不會讓 Lead 排出明顯錯誤的後續步驟。** 這個假設目前沒有證據。

Lead 在遠端是唯讀角色：沿用 `afterTurn` 的遠端指紋比對，Lead 改動遠端目錄就判這一輪失敗（與 diagnose／review 一致）。

### B. model 與 effort 怎麼寫

使用者的寫法是 `lead: agy-machine:agy:neon:medium`（第四段 `medium`）。現有 `roles` 的值是三段，第二個冒號之後整段是 model，所以 `neon:medium` 目前會被整段當成 model 名稱；**使用者在 `roles` 寫的 `GPT-6.2-Astra:medium` 也是同樣的語意（整段是 model）**，需要使用者確認他的意圖是否是「model 加 effort」。

| 選項 | 說明 | 風險 |
| --- | --- | --- |
| **(1) `lead` 用四段，第四段是 effort；`roles` 不動（建議）** | 新欄位沒有相容包袱：`lead` 值解析為 `machine:agent:model:effort`，三段以下維持語意；`roles` 完全不改 | `lead` 與 `roles` 的寫法不一致，需要在範例卡與文件說明 |
| (2) 兩者都改：第二個冒號之後若最後一段是已知 effort 詞（low、medium、high、xhigh、max）就當 effort | 寫法一致 | 改變既有 `roles` 含冒號 model 的語意，需遷移與相容檢查；model 名稱剛好以這些字結尾會誤判 |
| (3) 另開欄位 `lead_effort: medium` | 完全不碰冒號語法 | 欄位變多，不是使用者要的寫法 |

**建議 (1) 先做 `lead`**；`roles` 要不要比照，等使用者確認意圖後另案（它牽涉既有卡片的相容）。

**effort 的實作缺口：**`levelArgs` 要加上 agy 的對應（`--effort <level>`，agy CLI 已有）；pi 沒有查證。**待實測（第 4 階段）：**agy 的 model id 本身帶 effort 後綴（`gemini-4-neon-medium`），所以「`--model neon` 加 `--effort medium`」與「`--model gemini-4-neon-medium`」哪個才是 CLI 接受的組合，我沒有驗證；model 名稱要不要做別名解析（`neon` → 完整 id），也沒有決定。建議做法：啟動前呼叫該 machine 的 `agy models` 驗證 model id 存在，不存在就拒絕並說明（不猜）。

### C. 閘門與設定

- **新增 `machines[].cardReview.lead: true`（預設關閉，與 `write`、`toolchain` 同樣明示開放）。**理由：遠端 Lead 會讓一個長時間、會規劃並呼叫 worker 的 agent 活在遠端，風險面比唯讀 review 大，應該明確開放。
- 沿用 `cardReview.kinds` 限制種類；沿用 `leadGateFor`（agy、pi 當 Lead 需要同種類且宣告 `implementation` 的 profile）。遠端 Lead 的 profile 判斷要不要也依遠端隱含 profile（ISSUE-211）：**建議是**，與遠端角色一致，由第 2 階段實作時再確認。
- 斷線時拒絕且**不 fallback 到本機**，訊息沿用 ISSUE-223（已斷線，不帶 machine 名稱）。
- **遠端 Lead 的 machine 必須設定 `hookSocket`（使用者 2026-11-27：「理論上都要有 hook」）。**這裡的 hook 指 **bridge 自己的 CLI hook 通道**（`src/hook-events.ts`：agent CLI 的 `Stop` hook 把「回合結束與最終回覆全文」送到 bridge 的 hook socket），**不是 Herdr 的狀態偵測**；遠端要靠 `machines[].hookSocket` 讓 bridge 以 `ssh -R` 把遠端的 hook socket 轉回本機（`src/machines.ts`）。沒有 hook 時 bridge 只能讀終端畫面解析回覆，ISSUE-212、224 證明畫面會破壞長 JSON，而 Lead 回的是計畫 JSON。**第 1 階段就檢查：**沒設 `hookSocket` 的 machine 一律拒絕當 Lead。注意：**目前設定裡不是每台遠端 machine 都有 `hookSocket`**（有些只用畫面解析），所以這個要求實際上會讓那幾台不能當 Lead，要先補設定。

### D. worktree、Lead 與 PR 階段的「作者」

這是本設計最大的問題。現在的流程：

```text
card assign --worktree → 本機 worktree workspace 裡的 agent = Lead = 之後 review／fix 的「作者」
```

遠端 Lead 之後，本機 worktree workspace 沒有 agent。**建議：把「作者」與「Lead」拆開記錄，PR 階段的 review／fix 不再依賴作者的 pane：**

1. `card review`：reviewer 用卡片的 `roles.reviewer`（遠端）或在**本機新開 workspace** 啟動（不再「在作者 pane 旁邊開」）；reviewer 種類偏好改看「作者種類」這個記錄欄位，而不是活著的 pane。
2. `card fix`：作者角色用 `roles.fixer`；沒有指定時，改用 Lead 的種類在本機 worktree workspace 啟動新作者（現在的「新作者」本來就是新 session，只是借用 Lead 的種類與 pane 位置）。
3. 取消 `card-review-wiring`／`card-fix-wiring` 對 `lead.machine !== local` 的直接拒絕，改成依上面兩條處理；**這一步會動到 L1／L2 的 review 迴圈，要單獨有測試與實機驗證，不和遠端 Lead 的啟動混在同一個 PR。**
4. 不在本機 worktree workspace 開 agent（沿用 ISSUE-221 的方向）；Lead 在遠端時，task 結束後本機沒有常駐 agent。

### E. 獨立性（作者與 reviewer 不同 session）

**先講現在的程式實際怎麼做（讀碼修正，2026-11-27；本文第一版寫成「作者是 writer」是不準確的）：**
- **task 內的 review：**比對的是 reviewer 與 **implement 的 writer**（coding 的 artifact 記錄 `authorPaneId`／`authorSession`），這是真正的「作者不能審自己」。
- **PR 階段的 `card review`：**`src/card-review-wiring.ts` 的 `author` 是「**最後一個 task 的 Lead**」的 pane（agent、paneId、session），reviewer 的種類偏好與獨立性比對都以它為準（`chooseReviewerKind({ authorKind: live.agent })`）。也就是說 PR 階段是把 **Lead 當成作者的代理**，並不是比對真正寫程式的 writer。

**遠端 Lead 的問題：**agy 與 pi 沒有可讀的 transcript（codex 有，經 ssh 讀遠端 rollout，ISSUE-175），所以遠端 agy 或 pi 當 Lead 時，bridge 取不到它的 session，PR 階段「Lead 當作者」的比對會變成「不明」。

**建議：PR 階段的作者改成「task 內 implement 的 writer（與之後 fixer）」，不再用 Lead。**理由：這才是真正寫程式的一方，而且它的身分在 task 內已經被記錄（遠端 writer 也有）；Lead 只負責規劃與下指派，不需要在 PR 階段扮演作者。這樣 Lead 在不在遠端都不影響獨立性判斷。**代價：**PR 階段的 reviewer 種類偏好要改看 writer 的種類；沒有 writer artifact 的卡（例如整張卡是 Lead 自己做的 readonly 卡，沒有 PR）不受影響。**使用者已確認，照這個建議做（2026-11-27，經白話說明之後）。**實作放在第 3 階段（worktree 卡的 PR 階段 review／fix），不在第 1 階段。

### F. 失敗模式

| 情境 | 建議處理 |
| --- | --- |
| 啟動前 machine 斷線 | 撿卡前檢查拒絕，不 fallback（ISSUE-223 的訊息） |
| 啟動後 machine 斷線（Lead 在規劃中） | task 失敗，記固定標籤；遠端 workspace、目錄保留並記 `cleanup_pending`（沿用遠端角色的 `RoleCleanupReason`） |
| Lead 卡在信任提示或更新提示 | 沿用遠端角色的信任項目 add／remove 與已知更新提示跳過；其餘提示 `blocked` 失敗，由人處理（agy、codex 在新資料夾都會停在信任提示） |
| Lead 的計畫 JSON 在遠端被畫面破壞（引號、折行） | **先補解析**：把 `repairJsonStrings`（ISSUE-224）套到 `parseAssignmentPlan` 的失敗路徑，並對遠端 Lead 優先使用 hook 取最終訊息；**這是第 2 階段的前置條件，不是選配** |
| 遠端 Lead 修改了遠端目錄 | `afterTurn` 指紋不符，該輪失敗（與唯讀角色一致） |
| 取消 | 沿用 `cancel` 與 `cleanup`，取回前取消不採用任何遠端結果 |

## 4. 設計總覽

```text
card（lead: <machine>:<agent>:<model>:<effort>）
  autopick 撿卡
    驗證：machine 存在且已連線、cardReview.lead、kinds、leadGate、model（agy models）、effort 對應
  card assign --worktree
    本機建 worktree（事實來源，不變）；不在本機 worktree workspace 啟動 agent
  startRemoteRole(role: "lead", snapshot of worktree)
    遠端 workspace + 唯讀快照 + Lead agent（lead 角色，唯讀）
  runTeamTask
    plan_requested → 對遠端 Lead 下 prompt；回覆優先走 hook，沒有才走終端解析（含 repairJsonStrings）
    assignments → worker（本機或遠端，不變）
    每個 Lead turn 之後 afterTurn（遠端指紋）
  結束 / 取消 / 失敗 → cleanup（遠端 workspace、目錄、信任項目）
card commit → card pr → card review／card loop（不再要求作者 pane 在本機，見 D）
```

**相容性：**舊的 `lead: agy`（只寫種類）與沒有 `lead` 的卡，行為完全不變（machine 預設 `local`）。`lead` 解析新增三段、四段寫法，`local:agy` 等同舊寫法。

## 5. 分階段與驗收

| 階段 | 內容 | 驗收（每項要實機證據，且明寫樣本數與範圍） |
| --- | --- | --- |
| 0 | 本設計文件經使用者確認 A 到F | 使用者回覆決定 |
| 1 | **（已實作，待實機驗收，2026-11-27）**解析與驗證：`lead` 四段格式、`cardReview.lead` 閘門、hook 要求、斷線拒絕、撿卡前檢查；**不啟動任何遠端 Lead** | 單元測試（已有）；撿卡前拒絕訊息實機一次 |
| 2 | **前置：**`parseAssignmentPlan` 套 `repairJsonStrings`、遠端 Lead 優先走 hook。接著 readonly 卡（沒有 worktree，最單純）啟動遠端 Lead | 沙盒 readonly 卡，遠端 Lead 完成一個計畫與回報；斷線不 fallback；cleanup 乾淨 |
| 3 | worktree 卡：快照、`afterTurn` 指紋、PR 階段 review／fix 不再依賴作者 pane（D） | 沙盒 L0 到 commit；L1 開 PR 並 `card review`；L2 loop 到停在 CI |
| 4 | model 與 effort：agy `levelArgs`、`agy models` 驗證 | 沙盒卡指定 `neon`／`medium` 實際啟動並確認 session 的 model 與 effort |

## 6. 風險與限制（預先列出）

1. **快照過期**（A）：Lead 看到的程式碼比本機 worktree 舊。沒有證據顯示這會造成問題，也沒有證據顯示不會。
2. **計畫 JSON 在遠端終端畫面被破壞**（§2 含意 1）：不處理就不能開放。
3. **PR 階段 review／fix 的重構**（D）影響所有卡的 L1／L2 流程，必須單獨驗證，不能因為「只是遠端 Lead」而輕率合併。
4. **agy 與 pi 的 transcript 不可讀**（E）：無法為遠端 Lead 做 session 獨立性判斷，所以不讓 Lead 擔任獨立性判斷的一方。
5. **遠端 Lead 的長時間存活**：一個會規劃多輪的 agent 活在遠端，pod 重建、斷線、額度耗盡（quota-failover，見 `docs/quota-failover-manager.md`）都會中斷它；第 2 階段起要有逾時與 `cleanup_pending`。
6. **沒有 hook 的遠端 machine**（沒設 `hookSocket`）只能走終端解析，風險最高；**已決定直接拒絕當 Lead（見 C）**。hook 本身是否對每種 agent 都能送出完整的最終回覆（claude、codex、agy 是否都支援 `Stop` hook），我沒有逐一驗證。
7. **這份設計的範圍：**只有讀碼與兩個唯讀 CLI 查詢（`agy --help`、`agy models`）；沒有在遠端實際啟動過 Lead，所有行為都是推論。

## 7. 決定紀錄（使用者 2026-11-27）與仍待確認的事

| 項目 | 決定 |
| --- | --- |
| B | **同意：`lead` 用四段，第四段是 effort；`medium` 的意圖就是 effort。**`roles` 暫時不動——但使用者在 `roles` 也寫了 `GPT-6.2-Astra:medium`（意圖同樣是 effort），而現在 `roles` 會把整段當 model 名稱，所以 **`roles` 的 effort 寫法要另案決定**（沿用 B 的選項 2 或另開欄位），不在第 1 階段 |
| D | **同意**：PR 階段 review／fix 不再依賴作者 pane |
| A | **同意**：先用任務開始時的快照，接受它會過期 |
| C／風險 6 | **遠端 Lead 的 machine 必須有 hook**（見 C 對 hook 的說明）；第 1 階段實作這個檢查 |
| 順序 | **同意先做第 1 階段**（解析與撿卡前檢查，不啟動任何遠端 Lead） |
| E | **確認（照建議）**：PR 階段的作者改成 implement 的 writer（與之後 fixer），不再用 Lead |
