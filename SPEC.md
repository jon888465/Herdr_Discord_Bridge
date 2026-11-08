# Herdr Discord Bridge 規格

### 卡片通知（2026-11-07，REQ-20261107-flow-notify，待驗收）

有記錄通知對象的卡，CI／merge 結果由卡片通知送出（PR 監看對這些卡只印 console，避免重複）；沒有記錄通知對象的舊卡、PR 關閉與刪卡維持原本回報到原 thread；`card loop` 在 Discord 的進度回覆不變。通知只處理 notifier 啟動之後的事件，沒有通知對象的舊卡歷史事件不回溯、不寫入紀錄。選填 `notify: discord:<thread id>` 或 `notify: agent:<pane id>:<terminal id>:<agent>`，parser／serializer／check 共用驗證。匯入清空不可信來源，Discord thread import／assign 記來源，Agent 自填。無來源不猜，console／帳本記「沒有通知對象」，舊卡不通知 Agent。

每 5 秒掃帳本，通知撿卡、PR、review、CI、merged、failed／autopick_stopped、merge_blocked、loop_stopped；event id 去重、凍結對象。Discord 僅原 thread，沿用分段／速率限制，最多三次；先持久化 sending，只有明確 failed 才重試，結果不明不重送。認領寫失敗不送，同程序最多試三次（無法寫盤的計數不能跨重啟保存）。Agent 僅原 pane，working／blocked／unknown 排隊；idle／done 送前雙查 pane／terminal／Agent，權限／選單不送，身分不符放棄。兩路當機皆寧可漏送、不重送。

`[bridge 通知]` 僅含 id、引用標題、事件、已有的完整純文字 PR 網址、固定分類原因，不含描述／finding／credentials。通知失敗不改流程，互斥 merge 仍拒絕並記事件；不做停滯提醒。已部署（bridge 2026-11-07 重啟載入），尚未實機驗證。Agent 寫的卡片要自己填 `notify`（AGENTS.md「建立任務卡片」，ISSUE-121）。

### Usage 唯讀快照（REQ-20261106-usage-query，2026-11-08，待實機驗收）

Console `usage`／`usage <pane 或 profile id>`，Discord 加 `/herdr` 前綴，沿用 quota status 的 Discord allowlist、目前選定 workspace 與 allowedWorkspaceIds 守門。全部只列該 workspace 的 Agent pane、config.json agentProfiles（可安全核對綁定 session 時讀其 pane，否則 unknown），另列設定遠端的不可達狀態；遠端 pane 仍不得跨目前 workspace。已連線但不在目前 workspace 的遠端不讀畫面。單一目標只接受確切 pane 或 profile id，有歧義、跨 workspace 或未知目標拒絕。

三項預設：授權 workspace＋已設定遠端（不可達 unknown）；所有狀態均只被動讀取，不對 idle/done/working/blocked 送指令或按鍵；純文字表格，無 JSON。每列含 machine、pane/profile、kind、usage、source、fetched-at（本次擷取／嘗試時間，不是供應商更新時間）。不快取 usage、不把遠端快取 pane metadata 當用量；來源明載 CLI freshness unknown，畫面數值不保證供應商即時更新。

Adapter 可選 parseUsage hook：Codex 只接受目前 visible 畫面底部最後 4 個非空列中、整列恰為（可帶模型名稱前綴的）`5h 35% left · weekly 85% left` 類格式的那一列（真實畫面該列下面還有一行快捷鍵提示），只輸出用量字樣本身（原字樣／單位保留，不含模型名稱）；不輸出其他畫面內容，避免帳號／credentials／API key／billing。claude、agy、pi 與其他未知 CLI 沒有已確認安全被動來源時 unknown；解析失敗、拋錯、不可讀、遠端不可達均逐列 unknown 與原因，不中斷其他列。不估算 token、百分比或 reset；不讀 credentials、不寫 quota report、不觸發 failover。實機底列其他格式留後續 adapter 卡片，不擴大擷取範圍。

## 1. 範圍與架構

此 plugin 是本機 Herdr 控制端，以 Discord 作為人類使用者介面。程式 CLI
仍是 Herdr pane 中運作的真實程序：

```text
Discord Gateway（outbound WebSocket）
        -> 此 bridge
        -> Herdr 本機 Unix socket / Windows named pipe
        -> Herdr workspace、pane 與已辨識的 agent
        -> 該 pane 中已經執行的 CLI
```

Bridge 不是 ACP broker；Team 可透過明確啟用的 Agent profile，按需建立 pane 並啟動長駐 CLI。一般 use/ask 不會自行啟動 CLI。Discord 斷線不會
停止 agent。Bridge 也不會開啟 HTTP listener 或 public endpoint。

設計遵循 Herdr 文件中的 plugin v1 manifest 與 socket API，以及
`herdr-hail` 的 blocked/approval 模式：觀察狀態、讀取 terminal context、
建立 Discord thread，再透過 API 傳送回應。

## 2. 執行環境與設定

Plugin 以 TypeScript 編譯至 `dist/`，由 manifest pane 以
`node dist/src/index.js` 啟動。本機 restart script 在所有模式下都以名為 `bridge` 的專用 workspace 之 tab 1
為目標：無參數時啟動已安裝 plugin，`-r` 重新建置並連結本機 checkout，
`-rg` 從 GitHub 重新安裝 `jon888465/Herdr_Discord_Bridge`。它不會聚焦該
tab，也不搬移其他 Agent pane。依名稱查找 `bridge` workspace，沒有時以專案 cwd
建立並保留 focus；同名多個時拒絕，不猜測 ID。若其他 workspace 尚有舊 bridge
pane，停止並列出位置，要求先明確遷移／停止舊 bridge，避免重複 bot 程序。
選定目標 tab 後，僅關閉該 tab 明確標示 Discord bridge 且無 Agent 的 pane；
若 bridge 是唯一 pane，先 split 保留 tab。缺少 tab 1 時停止，不關閉 pane。
啟動腳本須相容 macOS 內建 Bash 3.2；首次啟動沒有舊 bridge pane 時，空陣列不得觸發 `set -u` 錯誤。
Herdr 會注入 `HERDR_SOCKET_PATH` 與 `HERDR_PLUGIN_CONFIG_DIR`；standalone
執行時也支援文件定義的預設 socket 與 `HERDR_SESSION` 解析方式。

設定從 `HERDR_PLUGIN_CONFIG_DIR` 中的 `config.json` 讀取（standalone 時為
`~/.config/herdr-discord-bridge/config.json`）。Token 可由
`HERDR_DISCORD_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN` 提供。範例檔是 JSONC，
實際設定檔會被 gitignore。環境變數會覆蓋檔案設定。狀態儲存在
`HERDR_PLUGIN_STATE_DIR` 下（或 config directory 的 `state/`）；設定的
state filename 僅允許單一 basename，以防止 path traversal。

等待上限有兩個獨立設定（ISSUE-124）：`approvalTimeoutMs`（預設 `900000`）只管批准提示的有效期；`teamTurnTimeoutMs`（預設 `1800000`，正整數，無效值回到預設）是 Team 任務每個回合（Lead 規劃、各 Worker、Lead 彙整）的等待上限。回合逾時的失敗原因須寫明逾時、assignment id、等待時間與上限，並分類為「等待逾時」通知；Worker 仍在 working 時不自動延長或重送。

Handoff context 受 `handoffLines`（預設 `40`）與 `handoffMaxChars`（預設
`6000`）限制。這些限制會在 handoff 發到 Discord 或送往目的 Agent 前套用。

Discord adapter 需要 `messageContent`，因為 `/herdr ...` 指令、已映射 thread
中的 prompt，以及純文字 approval 回覆都是文字訊息。它只使用 guild message
與 message content 所需的 Gateway intents；沒有 inbound web server。Command、
reply 或 button 處理前會檢查 guild、channel 與 user allowlist。空清單表示
該維度不限制；敏感部署應改用明確 ID。非空的 `allowedWorkspaceIds` 會再增加
一層 Herdr workspace 授權邊界。

## 3. Herdr protocol client

`HerdrClient` 會在新的本機 socket connection 上送出一筆以換行分隔的 JSON
request。帶有 `error` 的 response 會轉成 typed `HerdrError`；錯誤 log 不會
包含 request parameters 或 prompt 文字。每個操作使用新的 bounded connection，
避免長連線故障使所有 operation 的 multiplexing 一起失效。

一般唯讀 socket failure 最多重試兩次；prompt（含 legacy fallback）、Ctrl-C 取消與本機 blocked 回答不重試不確定的送達，避免重複回答。一般重試使用從 `reconnectBaseMs` 開始的 exponential
backoff。Protocol error 不重試。Watcher 在故障後於下一個 interval 繼續，
因此 socket failure 只會被回報，不會形成 crash loop，也不影響 Herdr pane。

Client 使用下列官方方法：

| Bridge 操作   | Herdr method                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| health        | `ping`                                                                           |
| workspaces    | `workspace.list`，以 `session.snapshot` fallback                                 |
| agents        | `agent.list`                                                                     |
| output        | `agent.read`                                                                     |
| assign        | `agent.prompt`，以 legacy `agent.send` fallback                                  |
| blocked reply | 相容 legacy 的 `agent.send`，以 `agent.prompt` 與官方 `pane.send_input` fallback |
| wait          | `agent.wait`                                                                     |
| cancel        | `agent.send_keys`，傳送 `ctrl+c`                                                 |

ID 一律複製自 Herdr JSON response。Bridge 不會預測 workspace 或 pane ID，也
不接受 filesystem path 作為 workspace selector。`agent.prompt` 與
`agent.send` 傳送 JSON text；Discord input 不會經過 shell。

## 4. 路由與授權

持久化 routing record 包含下列 Discord 與 Herdr 欄位：

```json
{
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordThreadId": "...",
  "discordUserId": "...",
  "workspaceId": "...",
  "agentName": "...",
  "paneId": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Mapping 分成不同 map，並依下列確切順序解析：

```text
thread mapping > user mapping > channel default
```

Thread mapping 以 guild、parent channel 與 thread 作為 key。每個 thread route
Team 成員 mapping 會持久化在 routing state；重啟後會保留原 Team。若對應 pane 或 CLI 尚未啟動，成員保留為 stale，不能 dispatch，待 Herdr 重新回報該 pane 後才可使用。新增 Team 成員時，所有成員必須屬於同一 workspace。
包含 `activeAgentKey` 與獨立的 Agent mapping：

```json
{
  "activeAgentKey": "w1:p2",
  "agents": {
    "w1:p2": {
      "workspaceId": "project-backend",
      "agentName": "codex",
      "paneId": "w1:p2"
    },
    "w1:p3": {
      "workspaceId": "project-review",
      "agentName": "hermes",
      "paneId": "w1:p3"
    }
  }
}
```

User mapping 以 guild 與 user 作為 key，因此一位使用者的預設值不會取代另一
位使用者的選擇。`/herdr use <agent>` 只會變更 `activeAgentKey`，不會呼叫
Herdr 的 focus、move、close、restart 或 create method。變更 routing 不會重設
既有 Agent session。

Agent 指令會從 `agent.list` 解析 live agent。Target 可比對唯一的 agent
name/alias、agent kind、pane ID、terminal ID 或 terminal title；若有歧義則
拒絕並要求使用 pane ID。每個解析出的 target 都會檢查 selected workspace
與設定的 workspace allowlist。Pane 不存在、agent 已退出、workspace 改變或
mapping 過期時，一律 fail closed。

### 啟動就緒與更新提示（ISSUE-118）

`src/agent-ready.ts` 的 `waitUntilReady` 在啟動或輪詢到 `blocked` 時，只有成功讀取 visible 畫面、CLI 種類與已知更新提示清單相符，且畫面不含信任、權限、approval 或登入字樣時，才送清單指定的跳過鍵。**只自動跳過更新提示，信任與權限提示仍由人處理**。目前清單只有 codex：同時包含 `Update available` 與 `Skip until next version`，送 `3`；claude、agy 與其他 CLI 尚無清單項目，不猜按鍵。

每個 bridge port 下的同一 pane 最多嘗試送一次（包含重入／並行等待；不確定送達也不重試），以 `pane.send_keys`、`retries: 0` 送出且不附 Enter；送出後 console log 記錄 CLI、pane 與按鍵，重讀畫面，若仍是同一提示或讀取失敗，沿用原 `BLOCKED_AT_START` 失敗，不關閉 pane。其他未知、信任、權限、登入或讀取失敗畫面不送按鍵；更新提示混有上述字樣也不送。畫面已離開更新提示則繼續既有就緒輪詢，後續再次 blocked 仍失敗並保留 pane。此變更只適用呼叫此共用函式的流程；autopick `startLead` 與 profile pool 的獨立等待流程未接線，ISSUE-117、ISSUE-116 狀態不變。原始碼與假 port 測試已完成，尚未實機驗收。

## 5. Discord 指令與輸出

文字指令 prefix 預設為 `/herdr`；可用 `requireMention` 或
`HERDR_DISCORD_REQUIRE_MENTION` 啟用 mention 要求。提及 bridge bot 時，已知
指令可省略 prefix，因此 `@bridge agents` 與 `@bridge /herdr agents` 都接受。
設定 `soloThreadNoMention`（需 Server Members 與 Presence Intent）且已映射 thread 中除本 bot 外沒有「在線」的 bot 時，thread 內的文字與已知指令（如 `agent`）皆視同已 mention，且不要求 thread 已綁定 Agent（ISSUE-029）。未知的 mention 文字在已映射 thread，或頻道內已有 user／channel route 且明確 mention bot 時，才會當成 direct prompt；頻道內無 route 時回覆「尚未選取 Agent」提示，未 mention 的閒聊忽略；這
可避免普通對話意外成為指令，同時支援較短語法。`help` 會說明這些形式與所有
支援的操作。

```text
/herdr workspaces
/herdr agents
/herdr status
/herdr current
/herdr use <agent-name-or-pane-id>
/herdr ask <prompt>（pane 使用目前選定 Agent）；pane 也支援 ask <agent-name-or-pane-id> <prompt> 明確指定目標；Discord 使用 ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr read [agent-name-or-pane-id]
/herdr wait [agent-name-or-pane-id]
/herdr cancel [agent-name-or-pane-id]
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team list
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask [--coding] <prompt>
```

Bridge pane 的 stdin 也接受相同指令，可直接輸入 `agent`、`agent use w2:p1`、`agent detach`、`status`、`ask <prompt>`、`read w2:p1`、`wait w2:p1`、`cancel w2:p1`，或使用 `/herdr` prefix。`agent detach`（相容 `detach`）回到安靜對話模式，保留 blocked 問題通知，不停止／取消 Agent，也不清除 routing；要顯示終端快照輸入 `attach <pane>`。結果與 streaming progress 會印回 pane。Team routing 指令需要目前已選取的 workspace；Discord thread 只提供 route context，本機可用 `wk use <workspace>` 選取。

agy 卡片 worktree 預先信任（ISSUE-113，2026-11-08，已實作，已做一次實機驗證（agy 啟動時有讀取設定、無信任提示、cleanup 後設定檔還原），使用者 2026-11-08 已驗收；使用者預先授權）：bridge 啟動本機 agy 前，把 `card-worktrees.json` 記錄、realpath 為 `~/.herdr/worktrees/<repo>/card-req-…` 的完整路徑加入 agy 的 `trustedWorkspaces`；不信任上層目錄、`agent start --cwd`、遠端 agy；只移除自己加的那一筆；不對 pane 送按鍵。

`agent start <machine:agent:model:level> [--cwd <路徑>]`（console 與 Discord `/herdr`，ISSUE-114）臨時啟動 Agent。規格以 `:` 分四段，後面的段落與空段落視為省略，超過四段拒絕；單段（無冒號）若是已知種類（`claude`、`codex`、`agy`、`pi`）視為 agent，否則視為 machine。省略的 `machine`／`agent` 沿用目前選定的 Agent（無選定時為 `local`）；省略的 `model`／`level` 不帶參數（CLI 預設，bridge 不猜）。範例：`claude`、`:codex`、`::opus`、`:::high`、`agy-pod:codex:gpt-6.1-sol:medium`。驗證不符就拒絕並說明、不開 pane：`machine` 必須是 `local` 或 `machines[].id`；`agent` 必須是已知種類；`model` 沿用 `validateProfiles`（非空、≤200 字元、種類須有 `modelFlag`：codex `-m`、claude `--model`，agy／pi 拒絕），另外拒絕任何控制字元（C0、DEL、C1）與以 `-` 開頭；`level` 只允許 `[A-Za-z0-9_-]`、不得以 `-` 開頭、≤32 字元，由 adapter 對應（codex `-c model_reasoning_effort=<level>`、claude `--effort <level>`），agy、pi 一律拒絕。新 pane 開在選定 Agent 的 workspace（沿用 `openReviewerPane`、`startAgentInPane`、`waitUntilReady`）。`--cwd` 預設為選定 Agent 的 cwd，須為絕對路徑；`allowedWorkspaceIds` 非空時須落在選定 workspace 路徑之內（與 `workspace.create` 同方向），比對用 canonical path（本機 realpath；遠端經 ssh `realpath`，無法驗證就拒絕）。信任資料夾提示（blocked）**不自動確認**，回報並保留 pane（ISSUE-113）；`agent.start` 失敗則關閉新 pane；回報成功前核對實際 Agent 的種類、workspace、pane、terminal 與要求相符，不符視為失敗。成功回報 pane id、機器、種類、model 與 level（未指定顯示「CLI 預設」）。**不**自動 `agent use`、不寫 `config.json`、不影響 profile、`--coding`、Team roster。v1 限制：只能在選定 Agent 所在的機器啟動（machine 不同則拒絕，跨機器另案）。

**codex 啟動參數：linked worktree 的 git 目錄（ISSUE-115，2026-11-07，已實作、待實機驗收）：** `extraLaunchArgsFor`（`src/cli-adapter.ts`）是唯一的組裝點；所有 bridge 啟動 codex 的入口（profile Worker、`card review`／`card fix` 的 reviewer 與修正者、`agent start`、autopick Lead）都經它。只有種類是 codex、cwd 是 git linked worktree、且用 `git rev-parse --git-dir` 取得的 git 目錄 realpath 直接位於主 repo `.git/worktrees/` 底下時，才在啟動參數**加一個** `--add-dir <該 worktree 自己的 git 目錄>`，不加整個 `.git`、主 repo、家目錄或其他路徑。非 codex、一般 repo、非 git 目錄、解析失敗、路徑不在該位置（例如 symlink 指到別處）一律不加，啟動參數維持不變；遠端機器（`agent start` 的非本機 machine）不加。**其餘權限與提示不變**：不加任何放寬旗標（`--dangerously-bypass-approvals-and-sandbox`、`-a never`／`--ask-for-approval never`、`--approve-for-me`、`-s danger-full-access`），不改 `~/.codex/config.toml`、`config.json`、`policy.yml`，不自動確認任何提示。codex 只在有效沙箱是 workspace-write（或 danger-full-access）時才接受 `--add-dir`；加了參數卻因 `Ignoring --add-dir`／`effective permissions do not allow additional writable roots` 而啟動失敗或結束時，呼叫端得到含「--add-dir 被忽略，有效沙箱不是 workspace-write」的錯誤，不會無聲退回成沒有該參數的啟動，也不會改用更寬鬆的模式。`--add-dir` 實際讓 `git add -N` 在已信任的卡片 worktree 免提示，**尚未在實機驗證**。
`workspaces` 顯示 Herdr 回傳的 label/path、ID 與 agent state。`wk use
<workspace-id-or-name>` 只會將目前 route 綁定到既有且已授權的 Herdr workspace；
不會建立 workspace、pane 或 Agent。之後使用 `use`、`target` 或 `assign` 選擇
Agent。`current` 顯示有效 mapping，並回報過期的 agent/pane 資料。

`use` 會在目前 Discord thread（若不在 thread 則為 user）綁定一個 live Agent
作為 active target，但不送出 prompt。Thread 有 active target 時，普通 user
message 會直接送給該 Agent，並套用與 `assign` 相同的 allowlist、過期 mapping
與 busy 檢查。`target` 是向後相容的 alias。`ask` 對指定 Agent 發送一次性
prompt，並將該 Agent 記錄到 thread，但不改變 active target。`team list` 列出所有 workspace Teams；`team add`、`team remove` 與 `team ask` 操作目前 workspace 的 Team。Team mapping 會持久化，Discord thread 不是 Team scope；
`team remove` 管理 workspace Team 成員；`team ask` 會以目前 thread 的
active Agent 作為 Lead，先要求 Lead 產生受驗證的 Assignment plan，再透過 Herdr
將 bounded 子任務送給同 workspace Workers，收集報告後讓 Lead 決定後續 Assignment，空計畫才進入直接處理／驗證／synthesis；失敗或 blocked 則只做 partial synthesis。它
不會廣播完整 thread 或 terminal history。Phase 1 已加入 durable task、restart reconciliation 與 whole-team cancel；blocked Assignment 的後續問答已由 Phase 2 question queue 接續（live 待驗收），詳見下方 Durable Task Engine 契約。

`team ask --coding <prompt>` 是明確選用的本機 Git coding 任務。**Coding 任務至少要有一個 Worker（同 workspace 的 Team pane 或已勾選的 profile）；沒有指定任何 Worker 時，bridge 會自動在該 workspace 勾選 `config.json` 的 `agentProfiles` 裡 kind 為 claude／codex 的 profile，以及 `capabilities` 含 `implementation` 或 `review` 的 agy profile（合計至少兩個；E14／ISSUE-107，2026-11-06；agy 未宣告 capabilities、空清單或只有 `analysis` 時不自動啟用，pi 不論 capabilities 都排除；capabilities 只決定是否自動入池，不是角色守門；**目前 ISSUE-107 只完成第 1 部分，第 2 部分 session 登記與第 3 部分 reviewer 獨立性尚未完成，agy 尚不可用，使用者不應現在開啟 agy 選用**），誰寫、誰審由 Lead 在計畫裡決定，bridge 只檢查規則；有指定時一律照指定、不自動加；仍沒有 Worker（也沒有兩個以上的可用 profile）就在啟動前拒絕並說明原因（ISSUE-085，已驗收）**，因為 Lead 不能用空計畫自己實作、不能指派自己、review 又要與作者不同的 session；`card assign --worktree` 會切到只有 Lead 的新 workspace，所以該組合預設沒有 Worker，請不帶 `--coding`。沒有這個旗標時，prompt 文字即使包含 `--coding` 仍走一般 team ask：零 Worker、原指令文字、空計畫由 Lead 直接完成，以及既有 blocked／cancel／restart／輪數限制都保持原行為。Coding 任務仍用同一個 scheduler、TaskState、最多 8 輪 planning、每輪 16 個 Assignment、總計 64 個；跨輪依賴仍只能引用本輪 ID。首版只有一個 writer，diagnose／review／verify 為 read，review 必須是與作者不同的已知 session。**codex 的身分（ISSUE-088，2026-11-05，已修正、待實機驗收）：** Herdr 對 codex 的 `agent_session` 不可信（codex 的 hook 由長駐 app-server daemon 執行，`HERDR_PANE_ID` 是 daemon 啟動時的值），所以 codex 的 author／reviewer 身分改在回合結束後，用本回合 prompt 的唯一 nonce 從 `~/.codex/sessions` 的 rollout 找出（恰好一個非子 agent 的檔案符合才算（codex 自己開的子 agent 也有 rollout 並引用父 agent 的 prompt，所以 `session_meta` 標示為 `subagent` 的檔案先排除，ISSUE-099，2026-11-05，已實作、待實機驗收）；零個或多個＝不明）。因此 codex reviewer 的獨立性在 review 入帳時才判定：身分不明、與作者相同或作者不明，artifact 記 `independentReview: false` 與 `independenceFailure`，verdict 為 inconclusive，不算通過的 review（fail closed）；派工前仍先擋同一個 pane。claude 等其他 Agent 維持派工前用 Herdr 的 session 檢查。**codex 的最終回覆（ISSUE-089，2026-11-05，已修正、待實機驗收）：** codex 的回覆比 pane 可視高度長時，Herdr 的終端讀取只剩最後幾列、`BRIDGE_BEGIN…END` 框會遺失，回合因此逾時；所以 codex 回合在 idle／done 後，用同一個 nonce 找到本回合的 rollout 並從 `final_answer` 取框內內容（完整、未被 pane 寬度換行），找不到才退回終端畫面；**codex 的 hook 最終訊息（ISSUE-090，2026-11-05，已修正、待實機驗收）**：codex 的 hook 事件都記在 daemon 啟動時的 pane，沒有 nonce 可驗證，所以 Discord 串流與核准後補貼只在「session 為 id 型、其 rollout 的 `session_meta.cwd` 等於 pane 的 `cwd`／`foreground_cwd`」時才採用 hook 訊息，其餘（含沒有 session、對不上工作目錄、查不到 rollout）一律改走畫面 parser，不會把別的 codex 的回覆貼到這個 pane；claude／agy／pi 不受影響；退回終端畫面時，codex 依 pane 寬度硬換行的 `codingResult` JSON 由 `unwrapCodexJson` 接回換行後再解析（先照原文解析，失敗才接回；只對 codex）。不同 pane 不是獨立 session 的證明，prompt 與 write scope 也不是作業系統寫入隔離。Review 回合成功完成時 Assignment 為 done，findings／verdict 另記；有待處理 findings、版本改變、驗證失敗或缺少證據時，不得 `task_completed`，由 Lead 下一輪以 artifact／finding reference 派工。diagnose／review／verify 在派工時捕捉開始指紋，結束時再捕捉。review 或 verify 期間工作樹改變、缺少開始指紋，或 review 對不上實作 artifact 時，該報告保留可查，verdict 為 inconclusive 或驗證不算通過；不得把 pass 改貼到開始或結束指紋，不得因此解決 findings 或結案。同輪有 writer 時，其他 assignment 必須依賴該 writer，不能與它平行。重複的 finding 原始 id 保留第一筆儲存 id，後續存成 `assignmentId:id`；`findingRefs` 使用已儲存 id，既有的原始 id 在未被占用時仍可引用。結案前 Lead 不得藉空計畫改碼。Lead 在 coding 任務回空計畫、但驗收閘門還有未滿足的原因時（例如漏排 verify），bridge 把閘門的原因回給 Lead 再排一輪，最多兩次（ISSUE-093，2026-11-05，已實作、待實機驗收）；兩次之後 Lead 仍回空計畫就照原本的方式以閘門原因結案為 failed，閘門本身不放寬。verify 的 `verificationPassed` 規則不變：回報的 `commands` 全部 exit 0 才算通過（至少一個指令）；因此 Worker 與 Lead 的提示都明說「只列必須 exit 0 的檢查，確認不存在要寫成 `! grep -q …`，不要列預期 exit 1 的 grep」，且 Lead 的規劃提示（coding evidence）會帶出每個 verify 實際回報的指令與 exit code，失敗時才知道是哪個指令（ISSUE-097，2026-11-05，已實作、待實機驗收）。Lead 直接實作後再回派 review、多 writer、worktree 隔離與 GitHub 不在首版。Bridge 在 coding 任務本身不執行 commit、merge、push（唯一的例外是使用者明確下的 `card commit <id>`，見下方；merge 只有 `card merge`），也不重跑 Worker 回報的測試命令；它只把回報的 exit code 綁到目前版本指紋。Ignored 檔與 submodule 不在指紋內。Live 驗收見 ISSUE-025。

實作前若需要唯讀的診斷、研究或與其他 Agent 討論／批評，Lead 應先規劃沒有 writer 的獨立回合；完成後下一回合才規劃 writer 及後續 review／verify。該 writer 回合的每個唯讀指派仍須在 `dependsOn` 直接列出 writer id（ISSUE-103；僅補規劃提示，驗證規則不變）。

`review` 角色只用來審這個任務已完成的實作，只能排在 writer 之後；實作前批評或檢驗診斷結果、計畫應使用 `diagnose`（唯讀）。這樣的 diagnose 可指定給任何 Worker，包括只標 review capability 的 profile，因為 capability 目前不是派工的守門（ISSUE-104；僅補規劃提示，驗證規則不變）。

`findingRefs` 只能引用 review 判 `changes_requested` 時登記的 finding，id 以 coding 證據列出的已儲存 id 為準；diagnose 回報的 finding 不會登記為可引用的 finding。將診斷成果交給後續指派時，應在 `artifactRefs` 引用該診斷的 artifact id（`a-<assignmentId>-<n>`），並可在指派的 instruction 摘要其內容（ISSUE-105；僅補規劃提示，驗證規則不變）。

Coding 計畫回饋（ISSUE-106，2026-11-06，已修正、待實機驗收）：只在 coding 任務，`parseAssignmentPlan`、`validateAssignmentPlan`（含 `validateCodingRound`）、每輪／總指派數上限或跨輪 ID 重複檢查拒絕計畫時，把原錯誤回給 Lead 在同一工作回合重排；被拒計畫不得啟動任何指派，已完成的指派與 artifacts 保留。每 task 的 `MAX_PLAN_REJECTIONS = 2` 最多回饋兩次，第三次拒絕仍記錄後，以包含拒絕序號及原錯誤的訊息失敗。每次 planning 嘗試（含被拒重排）仍計入既有 `maxRounds` 上限；gate 回饋額度與驗證規則不變，非 coding 無效計畫仍立即失敗。`plan_rejected` journal 事件的完整 task 快照保存 `planRejections`（零起算工作回合 `round`、task 累計 `rejectionCount`、`errorMessage`），重啟載入保留紀錄；既有保守 reconciliation 不自動恢復或重新派工。本回饋不涵蓋 Worker 執行或派工前 artifact 檢查失敗。

Coding 首版對 review／verify 期間漂移採保守失敗：任務若保留此類 drift artifact，後續 pass 不解除最終 gate 的拒絕；需另建任務與 baseline 重新驗收。正常 changes_requested 的修正與再 review 仍可在同一任務完成。

Lead planning 對 Codex 優先讀取 dispatch 前連接的本機 transcript，以相符
prompt／turn 且 task_complete 的 final 解析 plan。無可用 final 時使用 CLI
read-source fallback；Codex 終端 JSON 僅在 strict parse 失敗時消除字串內
換行與兩欄 continuation 縮排，保留 JSON 跳脫與既有空白。終端已丟失的
空白無法保證還原；非 Codex 與結構化 final 不套用此恢復。所有 plan 仍須
通過 roster／dependency 驗證才可分派，失敗 task 不自動補送。

2026-09-11 live 驗收仍有缺口（ISSUE-013／ISSUE-014）：出現採用 prompt
範例 plan、未等 Worker 完成就以歷史輸出統整的回報。驗收要求為 plan 與
report 均對應本次任務；不得僅憑 idle/done 或歷史文字判定完成。必要
Assignment 未完成時不得作完成統整，blocked／failed 的 partial synthesis
須明確標示。上述要求尚未通過本次 live 驗收。

2026-09-11 修正：planning、Worker、synthesis 已改接共用 turn
接收器；structured final 需對應本次 prompt／turn，terminal fallback 需有
本次隨機 begin/end 標記與 settled 狀態，不再接受任意 transcript JSON。
prompt 先描述 end 再描述 begin，避免 echo 構成完整回覆；逾時／空報告不標
完成。Herdr client 使用 `agent.prompt` 的內嵌 wait options，舊版 fallback
到 prompt 加 wait。Targeted orchestration／Herdr 測試 14/14 通過；完整
驗證與 live 驗收仍未完成，
詳見 [修正交接](docs/team-orchestration-issues-013-014-handoff.md)。

Bridge pane 的 stdin 會使用同一個 command handler；啟動後可在 `bridge>` prompt 輸入指令，輸出與 Discord 相同的 Agent routing 與回應流程。
`assign` 將目前 thread 或 user 綁定至選定的 workspace/agent，並使用
`agent.prompt`；正在工作的 Agent 或重複的 active stream 會被視為 busy 而拒絕。
`read` 使用 `recent_unwrapped`，`wait` 使用 event-driven Herdr wait，
`cancel` 使用 Herdr 官方 key API，而非模擬鍵盤輸入。

每個 Agent response 與 progress message 都包含明確的 Agent、Workspace、Pane
identity header。WK row 在可取得時同時包含 Herdr ID 與名稱。一個 thread 有
多個 participant 時，每個輸出都會以獨立且有 label 的 response 發送；Bridge
不使用多個 Discord bot token。

`handoff <from> <to>` 只讀取來源最近 `handoffLines` 行，並將產生的 handoff
限制在 `handoffMaxChars`。它會遮罩常見 token 與 authorization 格式，將摘錄
包裝為不可信的 observed output，再將該 bounded summary 與可選的使用者指示
送往目的地。這支援在 token/context limit 後進行明確轉交，不會複製來源 Agent
的完整 history。只有在 handoff prompt 成功送出後，目的地才成為 active thread
Agent。

### Response streaming v1

本節描述 Discord 單 Agent 回覆；本機 console 使用後述明確回答通道。

Progress message 顯示 prompt scope CLI response 的最新 1,500 個字元，並每十秒
（下一次 stream poll）重新整理。即使輸出沒有變化，status 後仍會顯示經過的
wall time。第一張 card 與 final 會即時送出。Final duration 在觀察到完成時
凍結，不包含 Discord delivery time；等待 blocked 的時間會計入。這是以 polling
為基礎的 rolling preview，不是 token stream。即使沒有新文字，state change
仍會顯示。Progress delivery failure 不會阻止 final delivery。

對 Codex 而言，dispatch 前 Bridge 會在 `CODEX_HOME/sessions`（預設
`~/.codex/sessions`）下解析確切的 Herdr `agent_session` ID，並記錄檔案 offset。
只會消費之後的 event_msg record。`task_started` 加上完全相符的
`user_message` 用來關聯 turn；`agent_message` 的 `phase final_answer` 提供
答案；相符的 `task_complete` 確認完成。支援 legacy `user_message`/
`agent_message`，以及包含 `UserMessage`/`AgentMessage` 的 `item_completed`
envelope。Item event 必須符合 active `turn_id`。當 terminal prompt extraction
無法使用時，公開的 commentary 與 command-execution status 可提供 preview；
Reasoning item 會忽略。

Reasoning 與 commentary record 不會作為 final。回覆擷取不會另啟 Agent；Team profile 啟動是獨立的明確授權流程。
Transcript 缺少、不明確、無法存取或格式不相容時，使用 terminal fallback。每個
pane 不同的 `CODEX_HOME` 必須使用相同 catalog；不支援只存在遠端的 session
file。

Terminal history 讀取若遇 Herdr `agent_not_idle`，改讀 `visible`（使用設定的 outputLines），
避免要求工作中的 alternate screen 捲動歷史。其他讀取錯誤仍按失敗處理；
idle 後繼續嘗試 `recent_unwrapped`。Visible 仍須通過 prompt scope 擷取，
不是完整 transcript，不能據此宣稱已取得完整 final。

Terminal fallback 保留最長的、限定於 prompt scope 的已觀察摘錄；不會宣稱此
摘錄是完整 final 或累積 transcript。一般在 idle/done 狀態連續四次未變（解析結果與原始畫面皆不變，ISSUE-028）且成功的
read，再持續 settlement 十秒，允許 fallback 完成。另於 idle/done 連續 30 秒後
強制收尾，避免畫面重繪造成持續輪詢；缺少擷取內容仍標示 capture incomplete。強制收尾後仍輕量觀察 15 分鐘，Agent 再度 working／blocked 或回覆內容改變時接續擷取（最多 5 次，ISSUE-031）。
blocked、unknown、輸出變動或 read failure 都會重設 settlement。Structured completion 可在沒有成功
terminal read 時完成。Agent session 被替換後停止觀察；identity 比較 terminal、pane、workspace、agent kind，以及 session 的 kind/value，不以 source、欄位順序或其他 metadata 判斷替換。缺少或無法辨識的 session 不自動認定為新的相同 session。
2026-10-02：Discord 單 Agent 回覆觀察若 Agent 暫時未列出，或已知 session 的 metadata 暫時缺失／無效，先顯示等待核對，最多等待 30 秒並在下一輪成功查詢判定逾時。等待期間不讀 terminal／transcript、不送 final，並重設 settlement；原完整 identity 回來才續接。明確 session ID 或 pane／terminal／workspace／agent kind 改變仍立即停止。初始未知 session 不因稍後出現 ID 就自動接納為原 session。此邏輯不重送 prompt，也不變更 thread mapping。

Final 會獨立發送，使用 Markdown-aware chunks，且不超過 Discord content limit。
所有 chunks 發送完後才顯示 finished。缺少 final 時會描述為 capture incomplete，
絕不把它當成 Agent 回覆為空的證據。部分或失敗的 Discord delivery 會另外回報。
Progress edit failure 與 final delivery 隔離。Bridge 不會消費 hidden reasoning
event；terminal preview 仍是被觀察到的 CLI text，不是 semantic tool-event feed。

第一版不實作 persistent delivery retries、mirror commands、agy／OpenCode structured
transcript adapter 或 automatic attachment mode。已送出的 chunks 在 delivery
failure 時不會重播；SDK transport handling 仍有效。Monitoring 上限為 24 小時。
此實驗性本機 transcript format 依版本而異，必須保留 regression fixtures。

Discord command 與 approval handling 可用 `/herdr discord disable` 暫停，而不
斷開 bot；status 與 enable 仍可使用。只有 `discord.allowedUserIds` 能變更此
狀態。預設 `notifyOn` 維持 `blocked`，避免重複的 done notification。

較長期的 event contract 與實作階段請參閱
[中文回應設計](docs/response-events-design.zh-TW.md)。

## 6. Blocked 與 approval 流程

Discord 單一 Agent 的 blocked／approval 以 pane、terminal、workspace、thread identity 綁定。本機單 Agent 通道見「本機選取 Agent 後的互動」；Team Task 使用明確 task/question ID 的 questions/reply 指令，見 ISSUE-012 與 docs/team-question-queue.md。

Watcher 以 bounded interval polling `agent.list`，並忽略初始 snapshot。偵測到
設定的 `blocked` transition 後，讀取 detection snapshot，並將它發送到該 Agent
所有已映射的 Discord destination。若 destination 已是 mapped thread，就重用該
thread；否則 Bridge 建立 Discord thread。Thread 建立後，Bridge 才產生隨機且
不透明的 approval token，並連同 guild、channel、thread、message、terminal、
workspace、pane identity 與 expiry 一起儲存。

Root message 會收到帶 token 的「Approve / continue」button。只有 token 由此
Bridge mint、guild/channel 相符、呼叫者通過 allowlist、token 仍 active 且未過期，
並且最新的 `agent.list` 仍顯示相同 terminal、workspace、pane 為 `blocked` 狀態
時，button 才會被接受。純文字 reply 只有在 approval 儲存的精確 thread 內才
接受，並通過相同 allowlist 與 live-target 檢查。文字透過 `agent.send`/`agent.prompt`
送出；在新版 Herdr 有意拒絕 blocked `agent.prompt` 時，使用官方
`pane.send_input` API 原子地送出文字與 Enter。絕不以 shell 評估。

Approval 會過期且數量受限；agent 恢復、退出或 target 過期時會停用。Recovery/
exit notice 採 best effort；被刪除的 Discord thread 可安全忽略。State 以限制性
檔案權限原子寫入，並在 shutdown 時 flush。

## 7. 生命週期與失敗行為

Discord.js 負責 Gateway reconnect。Herdr watcher 同一時間只允許一個 in-flight
poll，socket operation 也只有限次重試。Discord 或 Herdr failure 會回報給 Discord
command 或 process log，不會停止遠端工作。長時間 assignment stream 最長可執行
24 小時，任何時候都可用 `read` 檢查；當 Herdr 不再回傳 target 時，會回報 pane
已退出並停止追蹤。

### 同一 bot 的單一實例

正常啟動在讀取 routing state 與 Discord login 前取得本機 IPC 排他鎖，第二個
相同 bot 實例立即失敗；鎖不依賴 cwd、workspace 或 config directory。以 token
的 bot ID 建立雜湊 key（無有效 ID 時使用 token 雜湊），不輸出 token；token 輪替
但 bot ID 相同也互斥。鎖只占用本機 IPC 名稱，不提供 command API 或 HTTP（Agent 回送用的 send socket 是另一個專用端點，見「Agent 指令回送」）。
Linux 使用 abstract Unix socket，Windows 使用 named pipe，程序退出由 OS 釋放；
其他 Unix 使用 temporary-directory socket，若在 macOS（Darwin）或路徑長度超過 104 位元組時使用 `/tmp` 避免超出 `sockaddr_un` 限制觸發 `EINVAL`；異常退出殘留時 fail closed，需確認
舊程序已退出後清除殘留 socket。不能防止舊版未實作鎖的 bridge 或另一台主機
重複登入；首次升級仍須處理舊程序。dry-run 不登入 Discord，因此不取得 bot 鎖。

## 8. 驗證與完成定義

Repository 必須通過：

```text
npm run lint
npm run typecheck
npm test
npm run build
```

測試涵蓋 message splitting/ANSI handling、routing precedence 與
authorization/stale mapping、active Agent selection、多 thread Agent mapping、
legacy state migration、Agent identity header、config path safety，以及用於
ping/list/read/prompt/wait/cancel 與 bounded retry 的 mock newline-delimited
Herdr socket。CI（`.github/workflows/ci.yml`，見 [docs/ci.md](docs/ci.md)，ISSUE-052）
在 Ubuntu 與 macOS 執行 typecheck、lint、test；CI 結果與本機結果分開記錄，不互相
替代，CI 通過也不等於 Discord／Herdr／CLI 端到端驗收。Final diff scan 不得包含真實 credential、token、private local
config 或 runtime state。Plugin manifest 必須能被 Herdr link。Commit/push 與
runtime restart 或 deployment 依使用者授權執行；自動檢查本身不代表已授權發布。

## Discord reply 與本機圖片傳遞（2026-09-09）

對此 bot 的同 channel 授權 reply 可滿足 prompt mention gate。Bridge 會取得並
驗證 reference 的 bot、guild 與 channel identity。無法解析的 reference，以及
parent channel 的 image/reply prompt 會回報錯誤；Bridge 絕不猜測跨 thread 的
destination。既有 routing 與 workspace validation 仍會套用。暫停中的 prompt
不會 dispatch。

只有圖片的 thread message 使用預設 image-inspection prompt。最多下載四個
PNG/JPEG/WebP attachment，每個最多 5 MiB；下載來源限 Discord HTTPS CDN host，
禁止 redirect，具有 timeout、streamed byte limit 與 signature check。下載後以
實際二進位 magic bytes 簽章判定真實格式（支援 PNG、JPEG、WebP）；若 Discord 宣告
格式與二進位簽章不一致，但在支援格式範圍內（例如宣告 image/png 但實質為 JPEG），
Bridge 會自動依實際二進位格式正規化副檔名（如儲存為 `.jpg`），避免下游解碼器崩潰；
若二進位內容非受支援圖片格式，則拒絕並清除暫存。產生的本機路徑位於 target Agent cwd 下的
`.herdr-discord-bridge/attachments`，並以明確指示要求 Codex/agy 使用 image-viewing tool（Codex／Claude／agy 皆在 allowlist；Claude 以 Read 工具讀取路徑，尚待實機驗收；pi 於 2026-10-29 加入 allowlist，以完全相等比對 agent 名稱，ISSUE-049，待實機驗收）。
非圖片附件（ISSUE-039，2026-10-21）：PNG/JPEG/WebP 以外的 Discord 附件視為一般檔案，至多 10 MiB、同樣限 Discord HTTPS CDN host、禁止 redirect，存成同目錄下 `message-*/<序號>-<清理後檔名>`（去除路徑與特殊字元），prompt 附「使用者附檔」路徑；每則總附件上限仍為四個；純檔案不受 Agent 白名單限制。Bridge 不執行或解析內容。
這是本機檔案傳遞，不是原生 multimodal input，且要求 Agent 可存取相同 filesystem。
不支援的 agent/format 與下載失敗會回報。成功檔案會保留（目前尚無自動 retention cleanup）；
失敗批次只會刪除自己新建的 temporary directory。準備期間會保留 terminal，避免並行
dispatch。

## 文件與 issue 生命週期（強制）

所有 agent 都必須遵循 [AGENTS.md](AGENTS.md)。每個行為變更都必須在同一工作
階段更新本規格與受影響文件。新 defect、failed test、使用者 acceptance failure
與 regression 必須記錄在 [known issues](docs/known-issues.md)，即使沒有修正也
一樣要記錄。重新發生的 issue 要保留過往調查歷史，不得刪除後重建。

記錄有日期的 evidence、reproduction condition、已確認與推測的原因、測試指令/
結果及剩餘 acceptance step。區分 source-fixed、built、running/deployed 與
live-verified 狀態。Unit test 與 build 成功不能關閉仍需要 Discord/Herdr/CLI
acceptance 的 issue。提議中的 feature 必須與已實作行為分開，並在交接前調和
過時或互相矛盾的敘述。純文件變更只需要 content/link/diff check，不需無關的
完整程式測試重跑。

### 本機 console 選取範圍（2026-09-10）

`bridge>` 預設使用獨立的 `local-console` guild/channel/user routing identity，
不繼承 Discord user 或 thread 的 active Agent，也不跟隨 Herdr 聚焦 pane。
本機 `current` 沒有 mapping 時會提示先執行 `agent use <pane ID>`；pane 的 active Agent 以 workspace scope 保存。

### 本機選取 Agent 後的互動（2026-09-10）

`agent use <pane>`（相容 `use agent <pane>`）同時記錄本機選取的 workspace 與該 workspace 的 active Agent，`current`、省略 target 的操作與本機觀察器使用相同目標。Discord user/thread route 維持獨立；明確選定 `thread <ID>` 時才共用該 route。本機來源由獨立 source 欄位識別，不能因共用 Discord routing 而被當作 Discord 訊息。

互動式 `bridge>` 的 `use` 只選對話目標，預設不印 CLI 畫面。`attach [pane]` 明確開啟 terminal inspector（40 行／6,000 字元 visible snapshot，不是原生 PTY attach 或完整 stdout/stderr）；`watch [pane]` 只印狀態變化；`detach` 回對話模式。blocked 問題在三種模式都以有界快照顯示，以保留安全回答驗證。這些模式只在本機顯示，不 mirror Discord。切換目標／模式時丟棄舊 read；選取新目標回到對話模式。attach/watch 檢視目標獨立於對話目標；模式切換不清除已回答問題的去重紀錄。

本機 `ask <text>` 和非指令文字：保留大小寫與內部空白，idle/done 時送出新 prompt；blocked 時回答已顯示的問題。傳送前重新檢查 workspace allowlist、pane、terminal、Agent kind、session kind/value、blocked 狀態與 state sequence，並比較可見問題畫面；**例外（ISSUE-069，已驗收，僅 console 路徑）：** 選取當時 Agent 完全沒有 session（剛啟動的 `agy`，要處理完第一個 prompt 才被 Herdr 登記），而 pane、workspace、terminal、種類都沒變時，session「第一次出現」會被接受並記住，不算替換；之後換成別的值或消失、或其他欄位改變，仍是替換並要求重新 `use`；若問題改變或尚未顯示，先顯示後拒絕舊回答，要求重新回答。相同問題只接受一次回答，不重試 socket 不確定送達。缺少 session metadata 時僅能靠 terminal/pane/kind 辨識，無法保證同 terminal 內無 metadata 的 CLI restart 可被偵測；Herdr API 也不提供驗證與送字的原子 question ID 契約。

working/unknown 時一般 prompt 會明確拒絕；`help`、`current`、`agent`、`agent use`、`wk` 等控制指令仍可操作，無須等 blocked。若答案開頭恰為指令，以 `ask <answer>` 明確指定。觀察輸出會重畫 `bridge>` 並保留正在編輯的輸入。`cancel` 是另行明確的 Ctrl-C 操作。本機新 prompt 使用與 Team 相同的 runTeamTurn 接收器，優先相符 Codex transcript final，否則僅接受本次隨機 marker 內的完整回覆；不把任意 CLI 片段當回答。blocked 時保留擷取直到回答後完成或逾時。既有 Discord 單 Agent progress/final 路徑不變。

各 CLI 的本機回答使用上述共同回覆流程；agy 等 CLI 需遵守 marker 格式，無可靠回覆時明示 capture incomplete，可用 read/attach 診斷。多 Agent question ID／排隊／明確 reply 已實作；其他 Worker 不因提問被中斷。Agent 為 blocked 且原串流仍在監看時，Discord 文字回覆一律當作回答送入，不受 busy 擋下（ISSUE-030；handoff、Team task 與附圖仍拒絕）。點選 UI、agy 未被 Herdr 辨識為 blocked 的選單按鍵、直接 pane → Discord mirror 仍待做。

本機專用 `threads` 列出已映射且符合 guild/channel/workspace allowlist 的 thread；
`thread <thread ID>` 明確選定共用路由，`thread off` 回到原本本機路由。
選取儲存在同一 routing state，重啟後保留；共用模式直接操作該 thread 的 active
Agent 與 Team，兩邊變更立即反映，不複製 mapping，也不冒用 Discord 使用者。
每次指令再次檢查 thread 存在與授權，失效時拒絕，不自動挑其他 thread。
此模式只共用 routing；本機 command 回覆／stream 仍輸出到本機，直接在 Agent
pane 的對話不會因此鏡像到 Discord。未知 thread 必須先在 Discord 建立 mapping。

## Agent Pool 與動態 Lead 分工（2026-09-18）

詳見 [使用與架構](docs/agent-pool-console.md)。Profile、session、pane 與 conversation 分開管理。
`config.json.agentProfiles` 定義 id/kind/model/modelFlag/args/capabilities，最多 64 個，不預設任何模型名稱。
Codex modelFlag 預設 -m，Claude 預設 --model；其他 CLI 指定 model 時需明確 modelFlag。args 直接經 socket 傳給 agent.start，不經 shell。

`team pool`／`team list` 顯示設定與啟動狀態；本機 `team select` 提供編號勾選、done 儲存、cancel 取消。
Discord 或非互動情境使用 `team select <profile> on|off`。`team add/remove profile:<id>` 也是明確的啟用／停用形式，既有 live pane 語法保留。
`team bind <profile> <pane>` 明確採用同 workspace、相符 kind、idle/done 的既有 session；不變更其模型，操作者應先確認模型設定。
Team profile 授權及 session identity 原子寫入 state directory 的 agent-pool.json；與 routing.json 的 live mapping 分開。

Lead 仍由已選取的 live Agent 擔任。可不委派而直接完成工作；不固定 planner/coder/reviewer/tester 角色。
規劃的 workerPaneId 相容既有 pane ID，亦接受 roster 中的 profile:<id>。只有選中的 profile 才 acquire。新 pane（profile Worker、reviewer／修正者與 `agent start`）的建立遵循下述 ISSUE-108 尺寸與新 tab 備援規則。Profile 啟動後（ISSUE-091，2026-11-05，已修正、待實機驗收）bridge 會持續重讀該 pane，最多 30 秒，直到偵測到預期的 CLI 且狀態為 idle／done 才算就緒（Herdr 的 `agent.start` 約 1 秒就回傳，這時新 pane 還沒被偵測成該 CLI、狀態是 unknown，約 2 到 8 秒後才 idle）；偵測成別的 CLI 時立刻失敗，逾時則維持原本的「not ready」錯誤。新 pane 的 shell 還沒初始化完時 `agent.start` 會被 Herdr 以 `agent_pane_busy` 拒絕，Worker profile 的啟動也和 `card assign --worktree` 一樣只對這個錯誤每 0.5 秒重試、最多 15 秒；其他錯誤立刻失敗、不重試（ISSUE-098，2026-11-05，已實作、待實機驗收）。
沒有綁定 session 時依下述 ISSUE-108 規則建立 pane 或 tab（同 workspace/cwd、focus=false），使用官方 agent.start 啟動長駐 CLI。
不以 one-shot exec 取代 session，不任意接管未綁定 pane。release 只釋放任務租用，不關閉 pane 或 CLI。
連線失敗時 split/start 不重試；啟動前先記錄 uncertain，需人工檢查並 bind，避免重啟後重複建立。

**ISSUE-108 更新（2026-11-06，原始碼已修正、待實機驗收；取代 ISSUE-094 的舊分割門檻及「不足就拒絕」規則）：** Worker、reviewer／修正者與 `agent start` 共用 `createAgentPane`。只有分割後兩邊 rect 都至少 60 欄、18 列（含框線，分隔線另預留 1 格）才分割；優先往右，否則往下。基底不夠大時選同版面面積最大且可安全分割的 pane；全部不足則以 `tab.create` 在同 workspace、指定 cwd 開新 tab，`focus=false`。基底不在 layout 時拒絕。`pane.split`／`tab.create` 都不重試，建立失敗或送達不明後不換另一種方式；沿用回傳的 pane/workspace/terminal 身分檢查。reviewer／修正者只核對並關閉自己的 pane，不呼叫 `tab.close`；profile release 仍保留 CLI 與 pane。新 tab root pane 的實際清理待驗收。不放大既有小 pane，不保證視窗縮小後仍達門檻，不自動確認啟動提示或重送 prompt。

**一個 tab 最多 2 個 pane（ISSUE-122，2026-11-07，原始碼已修正、待實機驗收）：** `createAgentPane` 先數基底 pane 所在 tab（`pane.layout` 回傳的就是這個 tab）內的 pane 總數，**含 Lead、使用者自己的與其他 Agent 的 pane**；已有 2 個以上就不分割，不論尺寸是否夠大都直接 `tab.create`；只剩基底一個 pane 時才套用上面的尺寸規則。每個溢出的新 tab 只放這一個新 pane，第一版不重用先前建立的 tab 去湊成兩個。因此上面「改選同版面別的 pane」的退路實際上只剩基底一個 pane 時才可能走到。不放大、搬動或關閉任何既有 pane／tab；`pane.layout` 讀不到或基底不在其中時沿用原本的錯誤，不改走 tab。`createAgentPane` 只在這次**自己建立**了新 tab 時回傳 `tabId`，呼叫端把它交給 `nameAgentPane`，用與 pane 同一個 `agentDisplayName` 結果以 `tab.rename`（參數 `tab_id`、`label`）替新 tab 命名；分割出的 pane 不命名任何 tab。命名失敗只 `console.warn`，不影響啟動與關閉；關閉仍只靠 id 與 terminal id，不依名稱判斷。

重用前核對 workspace、pane、terminal、kind 與 session identity；busy/blocked、identity 改變、profile 設定變更均拒絕。
已消失的綁定 session 可另建新 pane；同 pane 被替換則需明確 bind。缺少 session metadata 時回報 unknown，不能聲稱 context 延續。
新 Worker prompt 包含原任務、當前 Assignment、過往有界報告與 continuity；不複製 hidden reasoning，也不保證重建完整 context。

同一 bridge 內以 terminal reservation 及 profile lease 防止不同任務搶用；同 Worker 每波最多一個 Assignment。
完成一輪後 Lead 可再規劃，最多 8 次 planning、每次 16 個 Assignment、總計 64 個；ID 跨輪唯一，相依關係限當輪。
正常 blocked 等待 Phase 2 問答與原 turn 完成；無法續接或 failed 時結束後續規劃並回報 partial synthesis；達輪數上限明示未完成。Task persistence/reconciliation 與取消見下方 Phase 1；跨 bridge 排他仍未實作；Team 多問題續接見 Phase 2 契約。
這些自動化檢查不代表真實 Discord／Herdr／CLI 已驗收；部署狀態以 known-issues 為準。

## Session handoff skill（2026-09-18）

`skills/handoff-session/` 是獨立可攜技能，不改變 Bridge 的 bounded handoff、routing、AgentPool 或 quota 行為。流程契約：

- Prepare 在可見 quota 警告、使用者要求或明確門檻時保存 checkpoint；無訊號時 quota 記 unknown，不把 context 剩餘量當 account quota。
- Takeover 以確切來源 identity／workspace 選擇可讀原生歷史，依序 fallback 到本機匯出、checkpoint＋專案證據、終端摘錄。來源已無額度時不要求它再次推論。
- 覆蓋 Claude Code、Codex CLI、Copilot CLI、Antigravity CLI、OpenCode、Grok Build（`grok`）與其他 CLI 的共通流程；各版本原生歷史可讀性不保證，AGY 不等同 Gemini CLI。
- Grok 優先使用 `grok export <exact-id>` 的本機 Markdown。直接讀取時只保留 `updates.jsonl` 的 user／assistant／tool 更新，排除 thought／reasoning 與 system prompt。匯出是公開摘要，不是完整 raw tool result。`grok usage` 與 context window 不是帳戶 quota。此技能不讓 Bridge runtime 自動解碼 Grok session 檔。
- 接手核對實際工作樹、HEAD、修改、授權與驗證證據，標記缺漏，不移轉 hidden reasoning／credentials。跨機器不假設 uncommitted files 已同步。
- Checkpoint-only 不代表來源停止；真正 takeover 在重疊寫入前確認 ownership，保存接收紀錄。Markdown 不是原子鎖，也不會自動停止 process。
- Skill 目錄可單獨複製；手動讀取 SKILL.md 為共通入口，各 CLI 自動發現位置與 slash 語法分開處理。

本次僅 Markdown skill／文件，依 AGENTS.md 驗證 frontmatter、附件連結、內容一致性與 diff，不需重跑未改動的 Bridge 程式測試。真實來源→目的地接手（含 AGY 雙向）、quota 耗盡、歧義 identity、過期封包與其他 writer 情境另列 live 驗收，未通過不得宣稱全 CLI 原生相容。詳見 [用法與比較](docs/session-handoff.md)及 ISSUE-017。

## Phase 1 Durable Task Engine（2026-09-19）

完整契約、儲存格式、狀態轉移、取消限制及 live 驗收清單見 [Durable Task Engine](docs/durable-task-engine.md)。

- `team ask` 先持久保存 task，再接受派送；`team status [task-id]`／`team cancel <task-id>` 只操作目前授權 workspace。
- Task：planning、running、blocked、synthesizing（包含直接工作／驗證）、cancelling、completed、failed、cancelled。Assignment 沿用 pending、assigned、working、blocked、done、failed、cancelled。
- 原 prompt、Lead/session、frozen roster、plans、reports、timestamps 與 lifecycle journal 保存至 atomic journals（Phase 1 為 v1，Phase 2 寫入 v2 並相容讀取 v1，coding 任務寫入 v3 並相容讀取 v1/v2）；未知 schema／損毀 fail closed。v2 不可帶 coding mode。Coding baseline、stage、artifact metadata 與 findings 在 journal；artifact 檔放在 journal 目錄下、工作樹之外，讀取限制在該 task 目錄且單檔最多 256 KiB。版本指紋含 base／head SHA，以及 staged、unstaged 與未忽略 untracked 內容；任務開始前的 dirty baseline 不當成交付，也不會被清掉。
- 重啟後 non-terminal task 不自動執行，標 blocked/recoverable 或 unknown；cancelling 保留。核對 live pane/session，但不將 same-session 或 idle/done 當成本次 turn 已完成。
- cancel 停止後續派送，重用官方 Ctrl-C，等待 active turn 停止後才 cancelled／release；**等待派送期間（Herdr 的 `agent.prompt` 要等 Agent 自己停下才返回）每秒檢查一次，已記錄的 turn 其 Agent 身份相符且在 working 時先送一次 Ctrl-C，不必等 Agent 目前的長時間指令結束（ISSUE-061，已驗收：agy；Claude Code 與 Worker 路徑未實測，Ctrl-C 不保證子行程停下）；idle 的 turn 不送、每個 turn 至多一次、派送仍須先 settle 才釋放保留；**未知 identity、uncertain delivery、recovered active turn 保留 cancelling 並要求檢查。不得關閉共享 CLI。
- **剛啟動、還沒有 session 的 Agent（ISSUE-066，已驗收；`working` 且身份不明的拒絕分支僅有單元測試）：** 派工時 Lead／Worker 的 session 可能是空的（例如 `agy` 要處理完第一個 prompt 才被 Herdr 登記 session）。等待回應時，若派工時沒有 session，**允許 session「第一次出現」**（pane、terminal、workspace、Agent 種類都沒變），並記住它；之後換成別的值或消失仍是「Agent identity changed」。派工時就有 session 的 Agent 規則不變（必須維持同一個 session）。`team cancel` 遇到「任務記錄的 session 是空的」的 turn：pane／terminal／workspace／Agent 種類都相符且目前已 `idle`／`done` → **不送任何訊號**直接收尾並釋放保留；`working`／`blocked` 且身份不明仍照舊拒絕送訊號、保留 cancelling。
- ISSUE-014 correlation/settlement、動態 replanning、零 Worker、lazy start、existing-session reuse 與 conversation/attach/watch 保留。
- 不實作 auto resume、prompt replay、跨 bot writer lock、journal compaction／retention 或 durable Discord delivery。

自動化只驗證 fixtures；部署／live 驗收以 ISSUE-020 為準。

## Phase 2 Team Questions（2026-09-20）

行為契約與 live 驗收見 [Team question queue](docs/team-question-queue.md)。
`team questions <task-id>` 查詢有界問題卡片；`team reply <task-id> <question-id> <answer>` 僅回答指定問題。
Discord 限 task 原 guild/channel/thread、console 限目前 workspace，沿用既有授權。
問題保存 session／assignment／phase／sequence／snapshot fingerprint；送答前再核對、持久化 sending、不重試不明送達。
同 wave Worker 繼續工作，不固定 Lead 分工；blocked Assignment 回 working/done、原 turn 保留 response correlation。
有問題時 task blocked，回答後恢復 planning/running/synthesizing；不能把 pending 問題當成完成報告。
Timeout 沿用原 turn 上限；取消等待 in-flight reply；重啟將待處理問題標 unknown 且不允許 replay。
新 journal v2 向前讀 v1，未知版本 fail closed；不支援舊版直接讀取 v2 或自動恢復舊 turn。

## Phase 3 Session Handoff Runtime（2026-09-20）

契約與 live 驗收：[Session Handoff Runtime](docs/session-handoff-runtime.md)，ISSUE-021。

- versioned checkpoint registry、來源／目的 session identity、original goal、task artifacts、public evidence、repo／HEAD／branch／dirty fingerprint、owner／receipt／journal。
- `handoff checkpoint <source> <goal>` 與 `checkpoint-file <source> <relative-export> <goal>` 不呼叫來源模型；`status [id]`、`packet <id>` 可檢視。
- `verify <id> <destination> confirm-source-stopped` 需操作者確認來源／背景 writer 已停止，兩端為同 workspace／同 Git tree 的已知 settled sessions。整個 workspace 在交接期間拒絕其他 Bridge dispatch；外部 writer 仍需人工控管。
- 目的地只做唯讀復原，回傳相符 receipt；Bridge 前後核對實際 filesystem。`accept <id>` 才持久移交 ownership／切换該 context route；`continue <id>` 才派送後續工作，使用 ISSUE-014 receiver。
- `cancel <id>` 僅釋放 settled 交接，不送 Ctrl-C 或殺 CLI；restart、timeout、blocked、未知送達保留 blocked/quarantine，不 replay。
- 新 runtime 同機同工作樹，拒絕 submodule、不包含 ignored files／外部資料，Git／untracked 尺寸上限詳見文件。
- Codex 支援 exact-ID/cwd 公開 event_msg；其他 CLI 以 Bridge public-export-v1 或 checkpoint/artifact fallback。AGY／Gemini 分開，不读取 hidden reasoning，缺漏明示 partial。
- 一般 prompt 與 legacy fallback retries=0；已收到明確 method-not-found 才走相容方法，不重試不明送達。
- Active Team 須先依既有 lifecycle 結束／取消；不替換 frozen Lead／roster。舊 bounded `handoff <from> <to>` 功能保留但不能繞過 runtime／Team reservation。
- Phase 4 沿用本契約，見下方；不自動切帳號、不改憑證，也不宣稱 quota 移轉。

## Phase 4 Quota / Failover Manager（2026-09-20）

完整契約與 live checklist：[Quota / Failover Manager](docs/quota-failover-manager.md)，ISSUE-022。

- `quota report <pane> <available|limited|exhausted|unknown> <budget-group> [valid-seconds]` 保存 exact session、來源操作者、observation time／TTL；`quota status [pane]` 查詢。無來源量測時保持 unknown，不把 context 或時間推算為 account quota。
- `failover arm <source> <candidate1,candidate2> <goal-and-constraints>` 持久保存授權候選優先序及任務；來源 limited/exhausted 明確 report 自動觸發 checkpoint，不呼叫來源模型。
- `failover run <id> confirm-source-stopped` 才開始派送：選第一個新鮮 available、不同 budget group、exact settled candidate；同池衝突拒絕。沿用 Phase 3 repo／dirty／receipt 驗證，accept ownership 後 continue；成功後更新目前指令 context route。
- `failover status [id]`／`cancel <id>` 查詢／釋放。Discord policy 限原 context、console 限 workspace；quota observations 為授權 workspace 共享，但不洩漏其他 context policy 回覆。
- schema v1 atomic after-image journal，先保存 intent；checkpointing/running 重啟 blocked，不 replay。不明送達／驗證後失敗不自動再選別人；quota 過期不自動 reset；無候選保留 ready。
- 第一版為明確 operator observation adapter；沒有 provider API watcher、credentials/account rotation、自動啟動 CLI、百分比／reset 推測或 active Team roster replacement。候選能力及真實額度池歸屬由操作者確認。
- 兩個 journals 可能於崩潰邊界不同步，需查 linked handoff，不能假報完成或重送。完整 suite／live gate 狀態見 ISSUE-022；原始碼通過不代表實機驗收。

## Grok terminal adapter（2026-10-01）

Grok（Herdr agent kind `grok`）使用專用終端 parser，依 1.0.46 實測的方形回答框
擷取內容，移除外框、每列固定 UI 縮排及首列右側時間，保留內文縮排。
也接受有 user-message 邊界、空行分隔與 `Worked for` 完成 footer 的無框回答，
去除右側 scrollbar；未完成／無可辨識邊界時不猜測回答。
Discord preview／fallback 使用最新可辨識完整回答；與 dispatch baseline 任一回答相同時
不重播。Console／Team turn 使用相同清理後文字，再驗證本次隨機 begin/end 標記
與 idle/done；支援被折行的標記，不放寬原本完成契約。
這不是 Grok structured transcript adapter；不還原一般內文軟折行、不讀 hidden reasoning。
框線被截斷、格式版本改變、相同答案與 baseline 無法區分時，保守回報擷取缺失；
終端已捲出的內容無法恢復。模型清單不在本 parser 範圍。跨 CLI 的 Grok session
讀取由 [handoff-session skill](skills/handoff-session/SKILL.md) 描述；Bridge runtime
仍不自動解碼 Grok session 檔。驗證／部署狀態見 ISSUE-023。

## Claude terminal adapter（2026-10-05）

Herdr kind 含 `claude`（大小寫不敏感）使用專用 adapter；模型選單為
`sonnet`、`opus`、`haiku`，送出 `/model <name>`，仍可直接指定完整 model ID。
這些是 CLI alias，不保證帳號可用，也不固定 alias 對應版本。Profile 的
`--model` 啟動行為維持原契約。

Discord fallback 以最新非空 `❯`／`>` user block 比對 prompt，容許空白與
兩欄 continuation 的換行差異，包含中文／英文單字中間的軟折行；只在顯示列
邊界容許零或多個空白，每列其他字元維持核對。保留回答 code indentation。`⏺`／`●` 訊息
移除兩欄 gutter、輸入列、分隔線、頂層耗時 footer 及帶 `⎿` 結果的工具區塊（含工具標頭）。
Claude 附圖回顯比對會去除雙方的 `[Image #n]` 與 bridge 附圖路徑行，
容許 CLI 將路徑轉為附件標記並省略路徑。
可見 user block 不相符時拒絕；prompt 不可見時只接受與非空 baseline 有
重疊的新增訊息。相同擷取內容與 baseline 視為重繪，不重播；空 baseline
不可拿無 prompt 邊界的歷史回答代替本次回覆。

Console／Team turn 使用同一清理器，仍須本次隨機 begin/end envelope 與
idle/done 才完成。沒有 Claude native structured transcript reader；Discord
仍標示 captured excerpt／capture incomplete，訊息標頭可能含工具名稱或公開
進度，不能宣稱 semantic final。工具區塊／UI 格式改變、壓縮的
paste prompt、截斷與無 overlap 可能失敗；不猜測丟失內容。

2026-10-05 安裝 integration 前 Herdr 未提供 Claude `agent_session`；使用者
安裝 integration 並重開 Claude 後已取得 session ID。普通 prompt 與共用
Console／Team turn receiver 的真實短回答已驗證，見 ISSUE-026。缺 metadata
時仍無法可靠辨識同 terminal 內的 restart；Coding reviewer、session handoff／
failover 的已知 session gate 不放寬，也不猜最近 `.claude` 檔。這些進階流程、
blocked 問答、長回答與實際 Discord delivery 尚未驗收，bridge 未重啟。
Discord 回覆串流在 Agent 進入 idle／done 連續 30 秒後必須強制收尾，不得無止境輪詢 pane（ISSUE-026，待實機驗收）。
Claude 會把貼上的圖片路徑轉成 [Image #n] 附件並可能吞掉 Enter，bridge 會偵測輸入框殘留並補送 Enter（ISSUE-026）。
Claude 圖片交付已加入本機路徑交付 allowlist（2026-10-05，原始碼已改、待實際 Discord 驗收）；fixture 證據與本次 CLI 短回答證據分別記錄。

## pi terminal adapter（2026-10-19）

Herdr kind 等於 `pi`（大小寫不敏感）使用專用 adapter，模型指令為 `/model <name>`。pi TUI 的 user／assistant 文字都沒有前綴符號，只縮排一欄，因此 adapter 以最後一次出現的 prompt 回顯（容許顯示列邊界的軟折行與空白差異）為邊界，取其後文字；移除底部輸入框（含草稿）與頁尾狀態列、spinner，以及以 ` $ cmd`／`read|write|edit|grep|find|ls` 標題開頭、至 ` Took <時間>` 結束的工具區塊（沒有 `Took` 結尾時只丟標題列），並去除一欄 gutter、保留 code 縮排。prompt 不可見時只接受相對非空 baseline 的新增內容；與 baseline 舊回答相同視為重繪，不重播。

Console／Team turn 使用同一清理器，仍須本次隨機 begin/end envelope 與 idle/done；Discord 在畫面穩定後以清理後文字為 final。沒有 pi structured transcript reader，仍是擷取摘要。工具格式改變、捲出畫面的內容與無法辨識的工具輸出可能失敗或混入。驗證與限制見 ISSUE-033（原始碼與 fixture 測試完成，待實機驗收）。

## Agent 檔案回送 Discord（2026-10-19，ISSUE-034）

Agent 要回送檔案時，在最終回覆中單獨一行輸出 `[[discord-attach: /絕對路徑]]`（可多行，路徑可加引號）。Bridge 在送出最終回覆前移除這些標記行，文字照常送出，再以 Discord 附件把檔案送到同一 thread（不 ping 任何人）。

限制（fail closed）：路徑須為絕對路徑；以 realpath 解析後必須位於該 Agent 的 `cwd` 或 `foreground_cwd` 之下（symlink 指向外部會被拒絕）；僅限一般檔案、非空、每個至多 8 MiB、每則至多 10 個；拒絕 `.env*`、`.git`、`.ssh`、`.aws`、`.gnupg`、`id_rsa*`、`id_ed25519*` 路徑；重複路徑只送一次。被拒檔案以一則警告列出原因，不影響文字回覆。正式 final 與「擷取片段」後備訊息都會處理標記（2026-10-20 起；原先僅處理正式 final，Claude 閒置強制收尾時標記會被原樣貼出）；標記一律受上述路徑沙箱限制。Agent 需被告知此約定（例如寫入該專案 `AGENTS.md`）；Bridge 不自動改寫 prompt。驗收尚待 Discord 端到端，見 ISSUE-034。

強制收尾後的 rewatch（ISSUE-036，2026-10-20）：每輪先讀畫面，若本次 prompt 最後出現位置之後已有其他使用者輸入列，視為對話已前進並結束觀察，不再以舊 prompt 重新擷取或貼回 Discord。

Herdr 直接互動回送（ISSUE-037，2026-10-20）：Agent 轉為 idle／done 且無進行中的 Discord stream 時，bridge 讀取畫面，僅取最後一次使用者輸入列之後的 `[[discord-send]]…[[/discord-send]]` 文字區塊與 `[[discord-attach: 路徑]]`，送到該 Agent 對應的 Discord 目的地（第一個；無對應則不送）。檔案沿用上述沙箱；以 terminal 記憶體去重。僅在狀態轉換時掃描；實機驗收尚待。

Agent 指令回送（ISSUE-037，2026-10-20）：bridge 另開僅限「送到 Discord」的本機 socket（預設 `~/.config/herdr-discord-bridge/send.sock`；Unix 目錄 0700、socket 0600；`HERDR_DISCORD_SEND_SOCKET` 可覆寫；Windows 為 named pipe）。`herdr-discord-send [--file 路徑]... [--stdin] [文字]` 以 `HERDR_PANE_ID` 識別 Agent；bridge 查出該 pane、檢查 `allowedWorkspaceIds`、要求有對應 Discord thread（否則明確回錯誤），文字至多 8000 字元，檔案沿用 ISSUE-034 沙箱。請求大小上限 256 KiB。Agent 不需 Discord token。標記版本為指令不存在時的後備。實機驗收尚待。沒有對應 thread 時，改送回最近（12 小時內）把 prompt 派給該 Agent 的 Discord 對話（私訊亦可，文字與檔案皆可）；thread 對應優先；兩者皆無才回錯誤（ISSUE-037 2026-10-21 補充，待驗收）。

多行 prompt 回顯（ISSUE-038，2026-10-21）：標記式 adapter 找不到「標記＋完整 prompt」時，若 prompt 為多行，改以第一行定位最後一次回顯，並略過縮排續行、空行與壓縮分隔線後取其後內容為回覆；仍找不到才退回基準差異。實機驗收尚待。

Claude 回合完成判定（ISSUE-040，2026-10-24）：無 transcript 的 Claude，只有在畫面最後一個內容列（略過「Update available!」提示與輸入框）是回合尾巴「✻ <動詞> for <時間>」時，settled 才可作為最終回覆；否則繼續等待，至 30 秒閒置強制收尾（改貼不完整片段並標示）。「Update available!」列不屬回覆內容。實機驗收尚待。

## 遠端 Herdr 機器（2026-10-24，ISSUE-041）

設定 `machines: [{ "id": "agy-pod", "ssh": "agy-pod", "socket": "/root/.config/herdr/herdr.sock" }]`。沒帶機器前綴的 ID 一律是本機；`<機器>:` 前綴的 ID（如 `agy-pod:w2:p1`、`agy-pod:term_xxx`）轉給該機器並去掉前綴，回傳的 ID 補上前綴，因此 thread 對應、routing.json 與 `allowedWorkspaceIds` 都用同一種字串 ID，既有本機資料不需遷移。bridge 為每台機器維持 `ssh -N -L` 轉發（斷線退避重連），遠端暫時不通時沿用上次 Agent 清單、本機不受影響。機器 ID 須為 `[A-Za-z][A-Za-z0-9_-]{1,31}` 且不可像本機 ID；`ssh` 不可以 `-` 開頭、`socket` 須為遠端絕對路徑。混用本機與遠端 ID 的請求被拒絕。Discord → 遠端 Agent 的附件：本機暫存驗證後經 `ssh` 串流上傳到遠端 `<cwd>/.herdr-discord-bridge/attachments/message-*/`（0700／0600、檔名白名單），prompt 帶遠端路徑。Agent → Discord 的檔案回送與 `herdr-discord-send` 不支援遠端。文字對話已驗收，遠端附件實機驗收尚待，見 ISSUE-041。

## 附件保留期限（2026-10-25，ISSUE-043）

Discord 傳入的附件目錄 `<cwd>/.herdr-discord-bridge/attachments/message-*/` 超過 3 天（mtime）即清理：bridge 啟動時與每 6 小時，對目前 `agent.list` 內每個（機器, cwd）掃描；本機直接刪除，遠端經 ssh `find … -mmin +4320`。僅刪名稱為 `message-<英數>` 的真目錄，不跟隨 symlink，其他內容不動。已不在列表中的 Agent 的 cwd 不會被掃描。實機驗收尚待。

## Claude Stop hook 通道（2026-10-28，ISSUE-045，首版）

- bridge 啟動時在 `~/.config/herdr-discord-bridge/hooks.sock`（目錄 0700、socket 0600）接收 hook 事件；`scripts/herdr-discord-hook` 讀 Claude hook 的 stdin，只轉送主 agent 的 `Stop`（含 `session_id`、`last_assistant_message`、`prompt_id`、`HERDR_PANE_ID`），任何失敗都靜默 exit 0。
- `streamAgent` 對 Claude：若在本次回合開始後收到同一 `agent_session`（kind `id`）的 `Stop` 且訊息非空，立即以該訊息為最終回覆收尾，不等畫面穩定或 30 秒閒置強制收尾。
- agy Stop hook（ISSUE-045）：`~/.gemini/config/hooks.json` 註冊 `herdr-discord-hook` 於 `Stop`；hook 先輸出 `{}`，只在 `terminationReason=NO_TOOL_CALL` 且 `fullyIdle` 不為 false 時，從 `transcriptPath` 取最後一個沒有 tool_calls 的 `PLANNER_RESPONSE.content` 當最終回覆，以 `conversationId` 轉給 bridge；`hookTransport.agy` 控制是否採用，失敗退回 parser。agy 權限不使用 hook（`PreToolUse` 每次工具呼叫都觸發），維持 parser。
- pi 擴充（ISSUE-045）：`~/.pi/agent/extensions/herdr-discord-bridge.ts`（來源 `scripts/pi/`）在 `agent_settled`（未中止、TUI、已 idle）時把最後一則 assistant 文字以 session 檔路徑為 sessionId 送到 hook socket；bridge 對 `agent_session.kind` 為 `id` 或 `path` 都比對。pi 沒有內建權限提示，不做權限 hook；`hookTransport.pi` 控制是否採用，失敗退回 parser。此擴充須在每台執行 pi 的機器各自安裝，並由該 pi `/reload` 或啟動時載入；重啟 bridge 不會替 pi 載入擴充。無 hook 且 parser 失去 prompt／baseline 邊界時，不保證取得 final；帶警告的較早擷取片段不得視為 CLI 最後回答（ISSUE-045／033，2026-10-29）。
- 遠端 machine hook（ISSUE-045）：machine 的選填 `hookSocket` 啟用額外的 `ssh -R`（與 `-L` 獨立）把遠端 hook socket 轉回本機 hook socket；遠端以 `scripts/remote/herdr-discord-hook.py`（Python 3）送 Stop 事件，bridge 以 session id 比對；遠端沒有 `agent_session` 時改以 pane ID 比對，遠端腳本以 `--machine <id>` 在 paneId 加上 `<id>:` 前綴。未設定 `hookSocket` 的 machine 只用 parser。權限事件不支援遠端。
- Team 回合改用 hook 完整訊息（ISSUE-086，2026-11-05，已修正、待實機驗收）：`runTeamTurn` 在 `hookTransport` 為 `auto` 且 hook 的 Stop 訊息在本回合送出之後到達時，優先從該訊息取 `BRIDGE_BEGIN…END` 框內的內容（不受 pane 寬度影響；Claude Code 依寬度硬換行會切斷 JSON）。畫面已見到框但 hook 事件還沒到時最多再等 1.5 秒；沒有 hook（未安裝、事件遺失、`parser` 模式）時行為與原本相同，仍讀畫面。Team 任務的規劃、Worker 回報與統整都適用。
- 串流續傳（ISSUE-042）：Discord 驅動的回合在送出 prompt 後登記到 `active-streams.json`（terminal、pane、進度訊息、prompt、baseline、startedAt），結束後移除；bridge 重啟並連上 Discord 後，對仍存在的 Agent 與進度訊息重新啟動 `streamAgent`，沿用原 `startedAt`。Agent 或訊息已不存在、超過 24 小時者丟棄；重啟期間的 Stop hook 事件不補回（改由 parser 判斷）。team／console 路徑不在範圍。Codex 的 session 若在送問後才建立（UUIDv7 時間不早於送問時間），`streamAgent` 改追蹤新 session，首次登記則不要求 session 建立時間：只有 initial 與目前追蹤值都沒有可辨識 session、候選有 session，且 pane／terminal／workspace／Agent 種類完全相同時才接受並記錄 log；Console 使用同一判斷函式。首次登記後不同的舊 session 仍停止，候選消失或 session 暫時缺失維持既有身份不可用處理；其餘 session 變動仍停止擷取（ISSUE-047）。
- 核准後補貼回覆（ISSUE-042）：沒有串流的 Agent（終端機發問或重啟補發的核准）在 Discord 回覆核准後，回到 idle／done 時以 hook 的 Stop 訊息補貼到核准 thread（每筆一次、1 小時內、`hookTransport` 為 `auto`）；沒有 hook 事件則只送狀態通知。
- 重啟補發（ISSUE-042）：`AgentWatcher` 首輪輪詢對已在 `blocked` 的 Agent 補發一次 `unknown → blocked` 轉換，使 Discord 收到核准通知；舊核准先被收掉，舊通知按鈕失效。
- **TUI 讀取（2026-10-29，ISSUE-050 依來源調整，第三版待驗收）**：依回合來源決定可否讀歷史。非 Discord 來源（本機直接操作）的回合完成後，bridge 的 direct marker 掃描只讀 `visible`，不讀歷史、不得造成滾動。Discord 發起的回合（`streamAgent`、baseline、forced-finish rewatch）：相符 Stop／transcript final 優先，已有則完全跳過畫面讀取；無 final 的備援中，工作中（working／blocked／unknown）只讀 `visible`，idle／done 才允許讀 `recent_unwrapped`（可能捲動，遇 `agent_not_idle` 退回 `visible`）。Parser 為備援；本機回合若明確要求送 Discord，須用 `herdr-discord-send`，標記僅掃可見畫面。明確 read／handoff 與 Team／console 獨立路徑不在保證範圍。實際 TUI 滾動待重啟後驗收。
- **Parser 永遠保留**：沒裝 hook、事件遺失（bridge 重啟、socket 斷）、訊息為空或非 Claude agent 時，行為與原本完全相同（畫面 parser、強制收尾、rewatch）。事件只存記憶體。
- `PermissionRequest` hook：`herdr-discord-hook` 把請求送給 bridge 並保持連線等待。Herdr 將該 agent 標為 `blocked` 後，Discord 既有的核准通知上，按鈕或在 thread 回覆 `allow／approve／yes／y／ok／continue` 即回傳 allow，`deny／reject／no／n／cancel` 回傳 deny，TUI 提示隨之消失。其他文字（含數字選項）照舊打進 TUI，並放棄對 hook 的等待。agent 離開 `blocked`（含使用者在 TUI 先決定）、pane 消失或連線逾時／中斷時，bridge 結束等待，hook 不輸出決定，Claude 回到 TUI 原流程；**絕不預設 allow**。每個 pane 同時最多一筆等待中的請求。需 Claude 以非 auto 權限模式執行才會觸發（auto mode 本來就不會提示）。
- 尚未實作：`transport` 設定、Codex／agy／pi／遠端 machine；Discord 端沒有獨立的 Deny 按鈕（以文字回覆）；請求內容（工具與輸入）尚未顯示在 Discord 通知上（通知仍用畫面快照）。見 [hook-transport-proposal.md](docs/hook-transport-proposal.md)。
- 驗收要求：實際 Claude 回合在 Discord 只貼一次、無「capture incomplete」，並確認 hook 未安裝時仍走 parser。
- **通道設定與狀態（2026-10-28）**：`hookTransport: { claude, codex }`，值 `auto`（預設，hook 優先、缺事件退回 parser）或 `parser`（該 CLI 忽略 hook 事件與 hook 權限回覆，`allow`／`deny` 文字改為照舊打進 TUI）；值不合法時 config 載入失敗；其他 CLI 一律 parser。指令 `hooks`（Discord 與 console）回報各 CLI 的模式，以及 `~/.claude/settings.json`、`~/.codex/hooks.json` 是否已註冊 `Stop`／`PermissionRequest` 的 `herdr-discord-hook`；Codex 的信任狀態無法偵測。安裝步驟見 README。
- **Codex（2026-10-28）**：只註冊 `Stop`（`~/.codex/hooks.json`；需在 Codex `/hooks` 信任後才會執行）。**不註冊 `PermissionRequest`**：實測 Codex 在該 hook 執行期間不顯示核准提示且 Herdr 不標 `blocked`，且 hook 行程的 `HERDR_PANE_ID` 不可信（ISSUE-045）。Codex 的 `Stop` 尚未取得實測證據。
- **Codex 權限回覆（2026-10-28）**：Codex 的核准提示在 Discord 回覆 `allow`（含按鈕的 `continue`）時送 `y` 鍵、`deny` 時送 `esc` 鍵（`pane.send_keys`）；其他文字照舊打進 TUI。拒絕會中斷該回合。其他 CLI 不轉換。

## 卡片驗證指令（2026-10-30，ISSUE-054）

`scripts/herdr-card-check [--ledger] FILE...`（需先 `npm run build`）逐檔檢查 Markdown 卡片是否符合 [ADR-0001](docs/adr/0001-portable-md-cards.md) 的格式（`parseCard` 規則：受限 frontmatter 子集、必填欄位、id 與檔名、`type`／`status` 列舉、日期、`version`、標題長度、`links`／`external` 結構、8 KiB frontmatter，以及整檔上限：預設 512 KiB，加 `--ledger` 為 1 MiB）。每檔輸出 `OK`（stdout）或 `FAIL`（stderr，附原因）；任何檔案不合格或讀不到則結束碼 1，用法錯誤 2，全部合格 0；失敗不中斷後續檔案；超過所選上限的檔案不讀取。只檢查格式，不判斷內容正確性或敏感資訊。待使用者驗收。bridge 端的 `card` 指令見下一段。

## 機敏內容遮蔽（2026-11-02，ISSUE-056）

`src/redact.ts` 的 `redactSecrets` 是 handoff 公開文字（`publicText`）與 handoff 摘要（`src/handoff-summary.ts` 的 `boundedHandoffSummary`）共用的遮蔽邏輯。涵蓋：私鑰區塊（含被截斷的）、`sk-`／`gh*_`／`github_pat_`／Slack／AWS access key、JWT、`Bearer`、名稱含 token／password／secret／api_key 等的 `name=value`，以及網址中的 `user:pass@` 與名稱像憑證的查詢參數。標記為 `[redacted private key]`、`[redacted token]`、`[redacted]`。順序是**先遮蔽再截斷**。這是黑名單式規則，**不保證完整**；它只用在 handoff 文字與摘要，一般回覆轉送到 Discord 的路徑沒有套用。待實際 handoff 驗收。

### 營運卡片指令（階段 2a，已驗收 2026-11-02）

`card list [status]`、`card show <id>`、`card import [--slug <名稱>] [<本機路徑>]` 可在 Discord（沿用 `allowedUserIds`）與本機 console 使用；卡片存放於 `<stateDirectory>/cards/`，**不進 git**。見 [ADR-0002](docs/adr/0002-operational-cards-in-plugin-state.md)。

- 目錄：第一次寫入（`card import`）時以 0700 建立；已存在但群組或其他人可存取、是符號連結或不是目錄時**拒絕並提示 `chmod 700 <路徑>`**，不自動修改。`list`／`show` 不會建立目錄。
- `list`：最多 30 行，標題截為 50 字，最多列 5 個不合格檔案。`show`：摘要、人寫內文前 1200 字、最近 5 筆流程紀錄；有 `## Review 發現` 時另列一個區塊：各狀態的數量與最多 10 筆 `open` 的 finding（ISSUE-073）。id 不合法或找不到卡片時明確回報。所有輸出先經 `redactSecrets`。
- `import`：Discord 必須附上恰好一個 `.md` 檔，宣告大小 1 byte 到 512 KiB，超過不下載；Discord **不接受路徑參數**。console 接受一個本機 `.md` 路徑（拒絕符號連結、非一般檔案、超過 512 KiB、非 UTF-8）。匯入的卡片一律為 `draft`、清空 `external`、不覆蓋既有 id；沒有 id 時需 `--slug`。回覆列出調整項目並提醒人審閱後把 `status` 改成 `ready`。
- `list`／`show`／`import`（階段 2a）**不啟動 Agent、不改卡片狀態、不寫流程紀錄**。
- `card assign <id> [--coding]`（階段 2b 第二步，**已實作，主流程 live 驗收通過 2026-11-02**，ISSUE-058）：只有 `status: ready` 的卡片可指派；卡片必須有非空的 `## 描述`。Lead 與 Workers 的選擇與 `team ask` 完全相同（目前 thread 所屬 workspace 的 Team、active Agent 當 Lead）。交給 Agent 的 prompt 只含標題、`## 描述`、`## 驗收條件`（每段最多 3000 字，標題 200 字），先過 `redactSecrets` 再截斷，包在 `<<<CARD_DATA …>>>`／`<<<END_CARD_DATA>>>` 分隔內並聲明為資料；卡片內文中的 `CARD_DATA` 字樣會被改寫以免假冒分隔線。這**不能防止** prompt injection，人要在設成 `ready` 前審閱內容。任務啟動後：卡片 `ready → in_progress`、`tasks` 加入 task id、寫入 `assigned`（事件 id `<taskId>-assigned`）與 `started`（`<taskId>-started`）兩筆紀錄；回覆後與 `team ask` 一樣送出 Team Task 回條與結果。同一程序內同一張卡同時兩次指派，第二次被拒絕。任務啟動失敗時卡片維持 `ready`；任務已啟動但卡片更新失敗時回覆警告並要求不要重複指派（不丟錯誤）。任務結束後的狀態同步見下一條。
- 限制：卡片內容可能來自外部（例如 Mantis），顯示前遮蔽是黑名單式，不保證完整。
- **任務結果同步**（階段 2b 第三步，**已實作，live 驗收通過 2026-11-02**，ISSUE-059）：bridge 啟動時與之後每 60 秒掃描卡片目錄，對 `status: in_progress` 且有 `tasks` 的卡片，依 Team 任務 journal 的最終狀態處理：`completed` → 記 `completed` 並把卡片設為 `done`；`failed` → 只記 `failed`（原因為任務 detail，疑似機敏則整筆省略），卡片維持 `in_progress`；`cancelled` → 只記 `cancelled`（`by` 一律記為 `user`，目前無法分辨使用者取消或 bridge 取消），卡片維持 `in_progress`。事件 id 為 `<taskId>-<journal 第一次進入終止狀態的 sequence>`，事件時間為任務的 `finishedAt`，重複同步不會重複寫入；先記事件再改狀態。一張卡有多個任務時，只有**最後一個**任務完成才會變 `done`，較早結束的任務只記事件。只處理 `in_progress` 的卡片，人已經改動狀態（例如退回 `draft`）的卡片不碰。任務仍在進行中、或 journal 找不到該任務時不動卡片。同步失敗只在 bridge console 印出（內容改變時才再印），不通知 Discord。限制：輪詢，結果最多延遲約 60 秒。
- **卡片被刪除而任務還在跑**（階段 2c，**已實作，live 驗收通過 2026-11-02**，ISSUE-060）：`card assign` 成功後，bridge 把「task → 卡片 id、類型」記在 `<stateDirectory>/card-assignments.json`（0600，只是索引，不是權威資料）。同一輪輪詢中，若某個**進行中**（非 completed／failed／cancelled）的任務對應的卡片檔**確實不存在**（讀不到或內容壞掉不算），且尚未通知過，bridge 會：停止寫入那張卡（它本來就不存在，也不會被自動重建）、在任務的來源 thread 送出通知，列出三個選項——`card recreate <id>`、`team cancel <task-id>`、不處理；來源是本機 console 的任務則印在 bridge console。**不會自動取消任務、不會自動重建卡片。** 通知送成功才標記已通知（只通知一次）；送不出去下一輪再試，同一任務的失敗只印一次。任務已結束或 journal 找不到任務時不通知。
- `card recreate <id>`：只在卡片不存在、且索引裡有由該卡指派過的任務時可用。從**最新任務**的 journal prompt 取回標題、描述、驗收條件（即當初交給 Agent 的內容，已遮蔽機敏內容、可能被截斷），建立 `status: in_progress` 的卡片，`tasks` 含該卡所有任務，寫入 `assigned`／`started` 紀錄（事件 id 與原本相同），內文開頭註明這是重建的；背景、風險等其他段落**無法還原**。任務之後照常同步結果（若任務已結束，下一輪同步會補上 `completed`／`failed`／`cancelled`）。卡片已存在、沒有相關任務、任務紀錄已不存在、prompt 格式不符時拒絕。
- 限制：若人手動建立同 id 的新卡片，沒有 `tasks` 的卡片不會被同步改動；索引檔損毀時不會當成空的：只有用到索引的動作失敗並說明原因（卡片刪除偵測停用、`card recreate` 與記錄索引失敗），任務結果同步與其他 `card` 指令不受影響，需人工處理該檔案；偵測依賴輪詢，最多延遲約 60 秒；`card assign` 在記錄索引失敗時會警告「卡片若被刪除，bridge 不會主動通知」。
- **隔離 worktree**（階段 3b，**已實作，主流程 live 驗收通過 2026-11-03**，ISSUE-062）：`card assign <id> --worktree [--coding]` 在目前 thread 的 active Agent 所在的 git repo 建立 Herdr 原生 worktree，再指派。流程：驗證（卡片須 `ready` 且有 `## 描述`；Agent 要有工作目錄且在 git repo 內；Herdr 版本 ≥ 0.9.1）→ 建立 worktree（分支 `card/<卡片 id>`、基準＝repo 目前 HEAD、**不**先 `git fetch`；路徑由 Herdr 決定，`/` 換成 `-` 並轉小寫）→ **先寫進索引** `<stateDirectory>/card-worktrees.json`（0600）→ 授權 → 在新 workspace 的 root pane 用 `agent.start` 啟動**與目前 Agent 同種**的 Agent（名稱 `card-<小寫卡片 id>`；Herdr 只接受 1–32 字元，超過時截成 27 字元（去掉結尾的 `-`／`_`）加 `-` 加 4 碼雜湊（取自完整卡片 id），同一個 id 永遠得到同一個名稱、前綴相同的長 id 不會撞名，ISSUE-072 已驗收 2026-11-04；新 pane 的 shell 還沒就緒時 Herdr 會回 `agent_pane_busy`，**只對這個錯誤碼**每 0.5 秒重試、最多約 15 秒，其他錯誤立刻失敗；啟動後輪詢最多 30 秒等它被偵測到）→ 把這個 thread 的路由切到新 workspace 的 Agent → 在卡片記 `## 異動專案` 與 `worktree_created` 事件 → 照常啟動任務（Lead 是新 workspace 的 Agent）。沒帶 `--worktree` 的 `card assign` 與 `team ask` 行為不變；`--worktree` 可與 `--coding` 並用。
  - **Agent 不是 idle 時不啟動任務**：實測 Claude Code 在新資料夾會先顯示「信任這個資料夾」提示（Agent 狀態 `blocked`）。bridge **不會替你確認信任**；回覆說明 worktree 路徑與 pane，卡片維持 `ready`，路由已切過去，你到該 pane 處理後再下 `card assign <id>`（不帶 `--worktree`）。
  - 失敗處理：驗證或建立失敗 → 卡片不動；worktree 已建立但 Agent 沒起來 → worktree 保留在索引、錯誤訊息含路徑與 `card cleanup`；任務沒啟動 → 卡片 `ready`、`## 異動專案` 已記錄，可直接 `card assign <id>` 重試。
  - **授權**：`allowedWorkspaceIds` 有設限時，只放行 bridge 自己建立並記錄的 worktree workspace，前提是來源 workspace 本來就被授權；bridge 重啟會依索引重新納入；清理時撤銷。沒設限就不動。
  - 一張卡同時只能有一個作用中的 worktree。
- `card cleanup <id>`：移除該卡的 worktree。**卡片最新一個任務還沒結束（`planning`／`running`／`synthesizing`／`cancelling` 等）時拒絕**並說明（ISSUE-070，已驗收；`planning` 以外的非終態僅有單元測試）：移除 worktree 會連 Agent 的 pane 一起拿掉；`completed`／`failed`／`cancelled`，以及在等人處理的 `blocked`，都可以清理；沒有指派過任務的卡片不受影響；PR merge 後的自動清理不經過這個檢查。**永不強制**（強制會永久丟失未提交修改）：有未提交修改就保留、回覆說明並寫 `cleanup_pending`；成功寫 `cleanup_done`、撤銷授權。**分支一律保留**（Herdr 從不刪分支），**來源 repo 的 workspace 不會被關閉**（它可能是你自己開的；關閉需要 `close_group` 會連帶關掉其他 worktree workspace）。不會自動清理，也不會自動把路由切回原 workspace（回覆提醒用 `wk use`）。
  - 限制：只處理本機；用 `workspace close` 關掉 worktree workspace 不會刪檢出；使用者自己手動移除 worktree 後，`card cleanup` 會因 Herdr 回報找不到而失敗（需人工處理索引）；索引檔損毀時只有用到索引的動作失敗並說明原因。
- **卡片上的 worktree 狀況與自由文字決議**（階段 3b 後續 E12，使用者 2026-11-03 選「選項 1」，**已實作，主要路徑 live 驗收通過 2026-11-03**；「作用中」與「保留」兩個狀態的 Discord 顯示未取得證據）：
  - **worktree 狀況（bridge 產生的結構化事實）：** `## 異動專案` 小節新增一行 `- worktree 狀態：<文字>`，緊接在 `- worktree：` 之後；值只有三種——`作用中`（`card assign --worktree` 成功後）、`已清理（分支保留）`（`card cleanup` 移除後）、`保留（有未提交修改）`（`card cleanup` 因髒檢出保留）。`card cleanup` 會就地更新那一行（不重複、不清掉其他欄位）。`card show` 在卡片摘要中**單獨列出**這一行，內文很長被截斷時也看得到。
  - **`## 決議`（人或 Agent 自己寫的自由文字）：** 慣例的段落名稱；內容完全由人或 Agent 撰寫，**bridge 不會改寫它**（自動化測試涵蓋 `setStatus`／`recordTask`／`recordProject`／`recordEvent` 之後該段逐字不變）。建議格式：`- <日期> <誰>：<決議>`，需要時加縮排的理由。`card show` 會在 `── 決議 ──` 下**單獨顯示**（最多 1000 字，超過截斷並提示開卡片檔），顯示前經 `redactSecrets`；它**不會**出現在重複的「內容」區塊，也**不會**被交給 Agent 當作指派內容（指派只含標題、`## 描述`、`## 驗收條件`）。
  - **這不是放寬 ADR-0002 決定 11：** 決定 11 限制的是 bridge **自動**寫進 `## 流程紀錄` 的說明（預設只寫結構化事實）；人寫的段落（含 `## 決議`）本來就是自由文字。bridge 不會自動把 Agent 的輸出摘要寫進 `## 決議`；若之後要自動摘要，需另行決定並走機敏檢查（追蹤清單 E12 的選項 2，尚未做）。
  - 限制：`## 決議` 沒有機敏檢查保護（寫的人要小心，且若匯出到 Mantis／Notion 會一併帶出）；`card show` 只是顯示時遮蔽。

### 專案政策（追蹤清單 F1，階段 4 第一步，**已實作，live 驗收通過 2026-11-03**，ISSUE-063）

每個專案的自動化等級（使用者 2026-11-03 決定）。**目前只有載入與唯讀查詢，沒有任何動作依政策行為**（還沒有 push／PR／merge 功能）。

- **位置：只放在 plugin 設定目錄**（`<config dir>/policy.yml`，`<config dir>` 由 `HERDR_PLUGIN_CONFIG_DIR` 決定；**以 Herdr plugin 執行時是 `~/.config/herdr/plugins/config/herdr-discord-bridge/`，也就是 `config.json` 所在的目錄**；只有環境變數沒設時才退回 `~/.config/herdr-discord-bridge/`。`card policy` 會印出實際讀取的完整路徑），**不放在專案 repo**（取代先前「政策檔放專案 repo 的 `.herdr/policy.yml`」的預定做法）：Agent 在 worktree 或 PR 裡改 repo 的檔案不會影響 bridge 的權限。bridge **只讀、永不寫**這個檔案。
- **格式：受限 YAML 子集，自己解析**（無相依套件）：
  ```yaml
  version: 1 # 必填，目前只有 1
  default: L0 # 選填，預設 L0
  projects: # 選填
    local:Herdr_Discord_Bridge: L1
    agy-pod:other.repo: L0
  ```
  只認這三個頂層 key，專案縮排固定 2 個空白，專案名稱是 `<機器 id>:<repo 目錄名>`（同卡片 `projects` 的格式），等級只能是 `L0`／`L1`／`L2`（大小寫敏感）。允許整行 `#` 註解與空行；**不支援**行尾註解、清單、錨點、tab、重複的 key 或專案。每行最多 200 字、最多 200 個專案、檔案最多 16 KiB。
- **等級：** L0 只在 worktree／分支工作、不 push；L1 push 分支並開 PR、由人 merge；L2 review、測試與 CI 都過後自動 merge（授權止於 merge，不含部署、重啟與驗收）。
- **安全預設：** 檔案不存在（不是錯誤）、不合法、或不安全（符號連結、非一般檔案、超過 16 KiB、非 UTF-8、群組或其他人可寫）時，**所有專案都是 L0**，並在 console／`card policy` 說明原因。沒列出的專案用 `default`。
- **`card policy [<機器 id>:<專案目錄>]`**（Discord 與 console）：列出檔案狀態、預設等級與各專案等級；帶專案名稱時顯示該專案的有效等級（沒列出就標示用預設）。bridge 啟動時也會檢查一次並在 console 印出載入結果或問題。
- **限制（誠實說明）：** 同一個 OS 使用者的任何程序（包含 Agent）都能改這個檔案；這裡只拒絕「別人可寫」的檔案，**不能防止同一使用者的 Agent 改檔案**。要真正防止，需要之後的防護（追蹤清單 G）或把檔案放在 Agent 無法寫入的位置。政策檔改動後需重啟 bridge 才會在啟動檢查中反映；`card policy` 每次都重新讀檔。
- **已決定、未實作（追蹤清單 F3）：** push 與開 PR 第一版不做（使用者 2026-11-03：先只做政策檔載入）。之後開 PR 時，標題用卡片標題，內文只放卡片 id 與 bridge 產生的結構化事實（分支、基準、task id 等），**不貼卡片的描述與驗收條件**（卡片不進 git、可能含 Mantis 內容；repo 是公開的）。

### 開 PR 與 CI 回報（追蹤清單 F3，L1，**已實作，主要路徑 live 驗收通過 2026-11-03**，ISSUE-064；失敗路徑與 Discord 通知原文未取得證據）

**自動 Agent 顯示命名（ISSUE-119，2026-11-07，已修正、待驗收）：**autopick 的 Lead workspace label 使用 `autopick-<實際 Lead 種類>-<卡片 id>`，保留 `autopick-` 前綴，以 `slice(0, 60)` 限長，超長截斷卡片 id 尾端、保留種類。reviewer、profile Worker 與 `agent start` 的新 pane 透過 `pane.rename` 設定 `<種類>·reviewer`、`<種類>·worker`、`<種類>·agent`，Worker／agent start 有 model 時附加 `·<model>`；agent start 使用解析後的 agent 種類。組字共用 `src/cli-adapter.ts` 的 `agentDisplayName` 與既有 CLI 種類辨識，Agent 啟動用的唯一名稱不變。pane 命名失敗只記錄警告、不重試，不影響啟動或清理；名稱僅供顯示，workspace／pane 關閉仍依原有 id／terminal id，card cleanup 與既有 console label 查找不變。尚未在實機 Herdr 側欄驗證、未部署／重啟。

**自動撿卡（H2，ISSUE-096，2026-11-05；政策解析、執行器與接線都已實作，待實機驗收）：**政策檔（`<config dir>/policy.yml`）明確選用才會有專案被自動撿卡：`autopick_lead: claude|codex`（全域，預設 claude）與 `autopick:` 區塊（`<專案>: <repo 絕對路徑>`，不可有 `..` 或控制字元，最多 20 個）；autopick 的專案必須也明確列在 `projects`（不能靠 `default`）。選用專案裡 `status: ready` 的卡片（`projects` 或舊的 `project` 欄位宣告該專案）由 bridge 自己開始，先建立的先做，**一次只做一張**，這個 bridge 程序已經試過的卡不重試。bridge 自己開 Lead（在 repo 路徑開 workspace），依序：`card assign --worktree --coding` → 等 task 完成 → 等卡片同步成 done → `card commit`；**自動做到哪一步由專案等級決定**：L0 到 commit（不 push）、L1 再 `card pr`（由人 review 與 merge）、L2 再 `card loop --agent <與 Lead 不同種類> --merge`（仍受 `card merge` 的全部守門：獨立 review 通過、CI 全綠、PR 乾淨、不動敏感路徑）。任何一步失敗或需要人（task 沒完成、review 沒過、CI 紅）就停下、保留 Lead 的 workspace 與 worktree 供檢查，不重試、不繞過；政策檔缺少、不合法或不安全時不撿任何卡。**接線：**bridge 每分鐘掃描一次（政策檔沒有 `autopick:` 時立刻返回、什麼都不做）；Lead 開在 `autopick:` 指定的 repo 路徑的新 workspace（`workspace.create`＋`agent.start`，狀態不是 idle／done 就失敗並關掉剛開的 workspace）；所有 `card …` 指令都以另一個本機 console 使用者 id（`autopick`）經 `handleCommand` 執行，所以守門全部沿用且不動到使用者自己的 console 路由與 console Agent；等 task 結束時 `blocked` 不等（需要人回答）、預設最多 45 分鐘；等卡片變 `done` 預設最多 150 秒（卡片檔每 60 秒才同步，ISSUE-095）；`card loop` 的回覆以「loop 結束：…已 merge」判定有沒有真的 merge。停下或失敗時除了 console 輸出，卡片流程紀錄寫一筆 `failed`（code `autopick_stopped`／`autopick_failed`，短原因）。`allowedWorkspaceIds` 非空時第一版不支援自動撿卡（新開的 workspace 不在名單內）。`card policy` 會列出自動撿卡的專案、repo 路徑、Lead 種類與等級。bridge 重啟時進行中的卡不會自動接續（留在 in_progress，需要人處理）。

`card merge` 讀 PR 狀態時，GitHub 回 `UNKNOWN`（剛 push 或剛開 PR，還在計算能不能合併）會每 3 秒重讀、最多讀 10 次再判定，不把這個暫時狀態當成拒絕理由（ISSUE-100）。

`card commit <id>`（Discord 與 console，ISSUE-092，2026-11-05，已實作、待驗收；**bridge 第一次自己 commit**）：`--coding` 任務走到 ready-to-integrate 後，驗證過的版本只是 worktree 裡的未提交修改，而 Worker 與 bridge 都不 commit，`card pr` 卻要求分支上有 commit 且 worktree 乾淨；這個指令替卡片的分支做一次 commit，**不 push、不 merge**。全部成立才 commit：最新 task 已完成且階段是 ready-to-integrate；task 的工作目錄就是這張卡的 worktree；目前分支是卡片的分支；worktree 的版本指紋與通過驗證的指紋完全相同（驗證之後被改動就拒絕）；版本是全部未提交（已 commit 或混合都拒絕）；暫存區原本是空的。只 stage 已驗證版本裡的檔案（原本就存在於基準的未追蹤檔不會被帶進去），暫存結果與預期不一致就還原暫存區並取消；commit 訊息用卡片標題（疑似機敏就拒絕）、卡片 id、task id 與指紋前 12 碼，作者是該 repo 的 git 設定；成功後卡片記一筆 `committed`。之後照原本的 `card pr <id>`。

`card attach-pr <id> <PR 編號或完整 PR 網址>`（ISSUE-123，2026-11-07，已實作、待驗收，尚未實機驗證；Discord 與 console，沿用 `card` 的授權）：把任務失敗後由人或 Agent 接手開的既有 PR 登記回卡片（補洞，**不是讓任意 PR 登記**）。任何一項不成立就拒絕、列出所有原因、什麼都不寫：(1) 卡片 `in_progress` 或 `done`、沒有任務或 review／fix／loop／merge 在跑；(2) 專案政策至少 L1、github.com（同 `card pr`，不放寬；卡片需有 worktree 紀錄）；(3) PR 開著、來源是卡片專案 origin（非 fork）、head 分支 `card/<卡片 id>`、base 是預設分支；(4) 同卡已登記同一 PR 編號則冪等、不重複寫事件，已登記別的開著的 PR 或該 PR 屬別張卡則拒絕；(5) 只讀 GitHub，不 push、不 merge、不強制、不改 PR。寫入只有 `card-prs.json`（同 `card pr` 的同一份）一筆登記、`## 異動專案` 的 PR 與 head、`pr_opened`（id `pr-<編號>-opened`）；**不改卡片狀態**。**`card merge` 的條件 (2) 因此改為：**卡片 `done`，或 `in_progress` 且 PR 已登記（`draft`／`ready`／`cancelled` 仍拒絕）；其餘守門完全不變。`card loop` 的 push 對這類卡片可 push 到已登記開著的 PR。有 `notify` 的卡依 ISSUE-120 通知。

`card pr <id>`（Discord 與 console）：把卡片的分支 push 並開 PR。**這是 bridge 第一次對外 push。** 使用者 2026-11-03 的決定：卡片要 `done`、第一版包含 CI 輪詢與回報、第一次 live 驗收用 Herdr_Discord_Bridge 本身的無害文件卡、身分用現有的 `gh`／ssh 登入（F2；L2 也用現有登入，使用者 2026-11-03 選 A，尚未實作）、PR 標題用卡片標題且內文只放卡片 id 與結構化事實。

`card pr` 在讀取卡片並檢查前提之前，先用與每分鐘掃描相同的 task 來源及 `syncCards` 邏輯，只同步指定的這張卡片一次（ISSUE-095，2026-11-06，已實作、待實機驗收）。task 已完成而卡片檔仍是 `in_progress` 時，這次同步可把它更新為 `done`。同步丟出例外或回報問題時仍照原流程讀卡片，由原有的狀態守門拒絕；不新增錯誤型態。定時掃描間隔與 `card loop` 的 push 路徑不變，自動撿卡的 `waitCardDone` 仍保留。

- **前提（任何一項不符就拒絕，什麼都不 push、不開）：**
  1. 卡片 `status: done`（失敗或取消的任務卡片仍是 `in_progress`，不能開 PR）。
  2. 卡片有 worktree 紀錄（`card assign --worktree` 建立；worktree 已被 `card cleanup` 清掉也可以，改用 repo 的分支），且 `## 異動專案` 記有 `base`。
  3. **專案政策是 L1 以上**（專案名稱 `local:<repo 目錄名>`；政策檔不存在、不合法或不安全時一律 L0，會拒絕並提示 `card policy <專案>`）。
  4. repo 的 `origin` 是 github.com（`git@github.com:…`、`ssh://git@github.com/…`、`https://github.com/…`；其他主機一律拒絕）。
  5. worktree（若還在）沒有未提交修改，且分支比基準多至少一個 commit。
  6. 卡片標題不含疑似機敏資料（會放進 PR 標題）。
  7. 分支先前沒有已 merge 或已關閉的 PR（bridge 不會自動再開第二個，請換新分支或手動處理）。
- **bridge 對 GitHub 只做這些：** `git push origin refs/heads/card/<id>:refs/heads/card/<id>`（**只有 `card/` 分支、明確 refspec、不帶任何旗標，永不 `--force`**，不 push `main`、不 push 標籤）、`gh pr list`／`create`／`checks`／`view`、`gh repo view`（取得預設分支）。不 merge、不改設定或 workflow。外部程式一律以參數陣列執行（不經 shell），錯誤訊息先遮蔽機敏資料再截斷。
- **PR 內容：** 標題＝卡片標題；內文只有卡片 id（並註明卡片不進 git、內容不隨 PR 公開）、分支、基準與 head 的前 12 位、**最新一個** task id（ISSUE-068，已修正、待驗收：先前失敗或卡住的嘗試留在卡片的流程紀錄，不公開到 PR）、政策等級；**不貼描述與驗收條件**。目標分支是 repo 的預設分支。
- **已有開著的 PR：** 只 push 新的 commit（不重複開），回覆說明；bridge 沒追蹤過的開著的 PR 會被納入追蹤。push 被拒（例如遠端分支有不同的歷史）就失敗並說明，**不會強制**。push 成功但開 PR 失敗時，回覆說明「已 push」，可重下 `card pr <id>`（不會重複）。
- **記錄：** 成功後卡片 `## 異動專案` 記 `PR` 網址與 `head`，流程紀錄寫 `pr_opened`（事件 id `pr-<number>-opened`）；索引 `<stateDirectory>/card-prs.json`（0600）記下 PR 與當初的來源 thread。
- **CI 與狀態輪詢：** bridge 每分鐘檢查索引中仍開著的 PR（`gh pr view`／`gh pr checks`）：
  - CI 全部完成（通過、失敗、取消、略過）→ 卡片寫 `ci_result`（事件 id `ci-<number>-<head 前 12 位>`）並在原 thread 通知（本機 console 的任務印在 console）；**每個 head sha 只回報一次**，push 新的 commit 後會對新的 head 再回報；還在進行中或沒有任何 check 就繼續等。
  - PR 被**關閉**（沒有 merge）→ 通知一次並停止輪詢，**不會**自動清理。
  - PR 被 **merge** → 見下一條（E11）。
  - 讀 GitHub 失敗只在 console 印出（內容改變時才再印），PR 維持追蹤中。通知送不出去時索引仍已更新、不會重送，訊息會印在 console。
- **限制（誠實說明）：** 用的是使用者現有的 `gh`／ssh 登入，PR 會顯示是使用者開的；同一環境的 Agent 也能用同一份憑證。只支援本機、只支援 github.com；`card pr` 不會替 Agent commit（沒有 commit 就拒絕）；輪詢最多延遲約 60 秒；`gh` 需要已登入且有該 repo 的 Contents 與 Pull requests 讀寫權限。
- **PR merge 後自動清理**（追蹤清單 E11，使用者 2026-11-03：「卡片 merge 了就應該清理」，**已實作，主要路徑 live 驗收通過 2026-11-03**，ISSUE-065；髒檢出保留、squash／rebase 推斷、清理失敗通知未取得 live 證據）：輪詢發現 PR 被 merge 時，bridge 依序：
  1. **卡片寫 `merged`**（事件 id `pr-<number>-merged`），含 merge commit 前 12 位與 merge 方式。**merge 方式是推斷的，不是 GitHub 回報的事實**：merge commit 有兩個 parent → `merge`；一個 parent 且標題以 ` (#<PR 編號>)` 結尾 → `squash`；其餘 → `rebase`（自訂過 squash 標題的 repo 可能被誤判成 rebase）。取得失敗只回報問題、略過這筆事件。
  2. **自動清理這張卡的 worktree**，與 `card cleanup` 同一套規則：**永不強制**；有未提交修改就保留（卡片 `worktree 狀態` 顯示「保留（有未提交修改）」、記 `cleanup_pending`）；成功則記 `cleanup_done`、`worktree 狀態` 變「已清理（分支保留）」並撤銷授權；**分支一律保留、來源 repo 的 workspace 不關閉**。沒有作用中的 worktree 就不動。
  3. 在原 thread 通知「PR #N 已 merge（<方式>）」並附上清理結果；自動清理失敗（例如 Herdr 連不上）只在通知裡說明並提示手動 `card cleanup <id>`，**不會自動重試**。
  - 只有 **merge** 會觸發；PR 被關閉不會。bridge 不會 `git pull` 或更新使用者本機 repo 的 `main`，也不刪遠端或本機分支。
  - 限制：merge 方式是推斷；通知送不出去時索引仍已更新、不重送；merge 發生在 bridge 停止期間時，下次啟動後的第一輪輪詢會補上（索引中仍標為開著）。
- **Review 發現（追蹤清單 F8，使用者 2026-11-04 決定，已實作並驗收 2026-11-04（隨 `card review` 的 live 驗收：真實 findings 寫入與 `card show` 顯示），ISSUE-073；目前沒有任何呼叫者會寫入）：** 卡片內文的 bridge 段落 `## Review 發現`，存 reviewer 的問題清單，**不貼 PR 留言**。每筆：編號 `F<n>`、嚴重度（`high`／`medium`／`low`）、狀態（`open` → `fixed` → `resolved`，或 `dismissed`，只能往前）、位置（相對路徑加選填行號）、最多 200 字的單行摘要（疑似機敏整段省略）。批次標題記第幾輪、範圍（整體或 commit sha 前 12 位）、head sha 與判定；同一輪同一範圍冪等；每卡最多 100 筆、每批最多 30 筆，超過整批拒絕、不輪替。這是 ADR-0002 決定 9／11 的有界例外（決定 12）。限制：reviewer 輸出是不可信資料，將來回傳給作者 Agent 時必須放進資料區（本階段不處理）。
- **`card merge <id> [--method squash|merge|rebase]`（L2，追蹤清單 G7，使用者 2026-11-04 決定先做手動版、預設 squash、驗收接受用公開 repo 的 main、政策由使用者自己改；已實作、核心路徑已驗收 2026-11-04（真實 PR 的拒絕路徑與一次真的 squash merge 進 main，之後輪詢記 `merged` 並清理 worktree），ISSUE-083；Discord 與 console，沿用 `card` 的授權；**前提：`gh` 的 fine-grained token 對這個 repo 要有 Pull requests 與 Contents 讀寫（2026-11-04 驗收時一開始沒有，合併被 GitHub 拒絕，由使用者提高）**；政策 L2 下的其他拒絕條件、merge／rebase 方式未實機驗證）：** 合併卡片開著的 PR。**這是 bridge 第一次自己合併進 main。** 原則：**什麼都不滿足就不 merge**，事實在「這一刻」重新從 GitHub 與卡片讀取（不信索引或開 PR 時的結果），所有不成立的條件**一次列出**後拒絕、什麼都不做。條件：(1) 專案政策是 **L2**（政策檔由使用者手寫，bridge 不改）；(2) 卡片 `done`；(3) 最新一輪**整體** review 是 `pass` 且沒有 medium 以上的 open finding（`low` 等級的 open finding 是 reviewer 的備註，留在卡片上但不擋 merge，ISSUE-100，使用者 2026-11-06 決定，已實作、待實機驗收）；(4) **review 通過的 head 等於 PR 現在的 head**（review 之後沒有新 commit）；(5) CI 檢查全部成功（進行中、失敗、取消、全部略過、沒有任何檢查都拒絕）；(6) PR 開著、不是草稿、GitHub 回報可合併且是 `CLEAN`（衝突、落後 main、被 branch protection 擋住、還在計算、`UNSTABLE` 等各自拒絕並說明）；(7) PR **現在**沒有動到敏感路徑（用 PR 當下的檔案清單重查；查不到或到 GitHub 的 3000 筆上限就當作敏感）；(8) 同一張卡沒有 review、修正、loop 或 merge 在跑。合併方式預設 squash，`--method` 可指定，**必須是 repo 允許的**（repo 不允許預設的 squash 時要明確指定，不會偷偷換）。合併只做一次、是最後一步，而且只合併剛才檢查過的那個 head（`gh pr merge --match-head-commit <head>`：檢查之後 head 變了 GitHub 會拒絕）；**永不帶 `--admin`（不繞過 branch protection）、`--auto`、`--delete-branch`**。身分是使用者現有的 `gh` 登入（2026-11-03 決定）。合併之後 bridge 不在這裡寫卡片：既有的每分鐘輪詢（E11）會偵測到 merge、記 `merged`（含方式推斷）並清理這張卡的 worktree；**不部署、不重啟、不刪遠端分支；merge 不等於「已驗收」**。限制：只有手動指令（`card loop` 通過後不會自動 merge）；只支援本機；只支援 github.com；GitHub 端的 branch protection 仍是最後一道防線（`protect-main` 要求 PR 與兩個 CI 檢查、`strict` 已開、沒有 bypass）；bridge 的檢查不等於人看過程式碼——review 是另一個 Agent 做的，獨立的只有 session，不是判斷能力。
- **`card loop <id> [--agent <種類>] [--fix-agent <種類>] [--merge]`、`card loop stop <id>`（追蹤清單 F5-loop 的自動版，使用者 2026-11-04 決定：push 自動、「每次審查最多 2 輪」＝同一個 head 的 review 最多試 2 次、只做手動觸發；已實作、核心路徑已驗收 2026-11-04（完整自動一圈含 bridge 自己 push、stop、從 fix 接著跑、敏感路徑不 push），ISSUE-082；Discord 與 console，沿用 `card` 的授權；到第 3 輪、兩次 inconclusive、失敗的一圈、push 被拒、Discord thread 未實機驗證）：** 一個指令跑 review → fix → push → review …，直到 `pass`，或遇到需要人的情況就停下來退回人工。**這是 bridge 第一次自己 push**（`card pr` 之外）：只 push 這張卡自己的 `card/<id>` 分支到**既有的 PR**（沿用 `card pr` 的流程與前提：專案政策 L1 以上、永不強制、不碰 main、不 merge），這是「真實 push 每次都要明確同意」的例外，使用者 2026-11-04 明確同意。流程由 `src/card-loop.ts` 的狀態機決定（review、fix、push、讀卡片、回報都由 `card-command.ts` 注入）：卡片已 `pass` 就不用跑；最新一輪是 `changes_requested` 且有 open finding 就從 fix 接著跑（可中斷後再續）；否則先 review。**push 之後的新 head 一定先 review**，即使還有 open 的 finding。**一律停下來退回人工：** review 輪次到上限 3 還沒通過；同一個 head 的 review 連續 2 次 `inconclusive`（push 後新 head 重新計）；review、fix 或 push 丟出錯誤（前提不符、Agent 啟動失敗、卡在啟動提示、PR 已關閉或 merge…）；一圈修正失敗；**修正動到敏感路徑——commit 留在 worktree、不 push**；使用者下 `card loop stop <id>`（只在步驟之間生效，不打斷進行中的步驟；已 commit 但還沒 push 的修正會留在 worktree）。每一步完成就在原處回報一則（回報失敗不中斷 loop），結束時回覆通過或停下的原因。同一張卡同時只能有一個 review、修正或 loop。`--agent` 是 reviewer 的種類、`--fix-agent` 是作者的種類（預設沿用最後一個作者）。**`--merge`（ISSUE-084，使用者 2026-11-04 決定：等 CI 但有逾時、紅燈就停、守門全交給 `card merge`；已實作、核心路徑已驗收 2026-11-04（真實 PR：L1 被 `card merge` 拒絕、L2 一次真的合併、CI 紅燈時停在 `ci`）；等 CI 時 `card loop stop`、逾時、Discord thread 未實機驗證）：** review `pass` 之後，`card loop` 每 30 秒讀一次這張卡 PR 的 CI（`src/card-ci-wait.ts`），最多等 30 分鐘；CI 全部 `success` 才呼叫與 `card merge` 完全相同的合併步驟（它自己重新讀所有事實、列出所有不成立的條件、只合併剛檢查過的 head，所以政策 L2、敏感路徑、落後 main、open finding、review head 不一致…仍由它擋，`--merge` **不新增也不繞過任何條件**）。**一律停下來退回人工：** CI 失敗／取消／全部略過、等 CI 逾時（review 已通過，CI 好了之後可手動 `card merge`）、讀 CI 連續 3 次出錯、`card merge` 拒絕或失敗（回覆含所有原因）、使用者 `card loop stop`（等 CI 的過程中也生效）。沒有 `--merge` 時行為不變。限制：沒有 `--merge` 時**不等 CI、不以 CI 紅作為停止條件**（`pass` 只代表 review 通過，bridge 不會自動 merge）；剛 push 後 CI 還沒登記（`none`）當作還在等；只支援本機；只審整個 PR；停止要求只對 `card loop` 有效。
- **`card fix <id> [--agent <種類>]`（追蹤清單 F5 的 loop 手動版，使用者 2026-11-04 決定「先做手動版 card fix」，已實作、核心路徑已驗收 2026-11-04（完整一圈在真實 claude 與 codex 上走完），ISSUE-081；Discord 與 console，沿用 `card` 的授權；部分修正、失敗的一圈、作者改到範圍外的檔案未實機驗證）：** 把卡片 `## Review 發現` 裡 **open** 的 findings 交給**新開 pane 的新作者**修一圈。**前提（不符合就丟出說明原因的錯誤，卡片不動、不開 pane）：** 最新一輪**整體** review 是 `changes_requested`（`pass` 不需要修、`inconclusive` 要先重新 `card review`）、還有 open 的 finding、輪次 **小於 3**（總上限 3 次 review，到了退回人工；每次 `card review` 都算一次，含 inconclusive）；卡片有作用中的 worktree；最後一個作者（卡片最後一個任務的 Lead）已知、在本機、pane 還在（新 pane 從它分割，種類預設沿用它，`--agent` 可指定）；**同一張卡同時只能有一個 review 或修正在跑**。流程（`runCardFix`）：組提示 → 確認 worktree 乾淨（有未提交修改就不開始）→ 開新 pane → 啟動新作者 → 等就緒 → 送出並讀回覆 → 解析 → 確認 HEAD 有新 commit 且工作樹乾淨 → **一定**關閉 pane。提示：卡片的標題、描述、驗收條件與 findings 放進 `<<<FIX_DATA …>>>` 資料區並聲明為資料（reviewer 的輸出是不可信資料），要求只修列出的 findings、建立**一個** commit（訊息 `fix: <卡片 id> review round <N>`）、不 push／merge／開 PR／用 GitHub，並回覆 `{"fixed": [...], "skipped": [{"id", "reason"}]}`，每一筆 finding 都必須剛好出現在其中一處，任何不合格整份拒絕。成功時：被修好的 finding 標為 `fixed`（只能往前的狀態機的第一個呼叫者）、記一筆 `fix_applied` 事件（第幾圈、幾筆 fixed、幾筆略過、head）；**不 push**——由人下 `card pr` 把新 commit 推到既有 PR、再 `card review` 審下一輪；review `pass` 時，先前標為 `fixed` 的 finding 自動標為 `resolved`。失敗的一圈（沒就緒、卡住、回覆不合格、沒有新 commit、有 commit 卻沒宣告修好任何 finding、工作樹留下未提交修改…）**不改任何 finding 的狀態**，回覆說明原因；動到敏感路徑只警告、不阻擋（目前沒有自動 merge）。限制：只支援本機；只處理整個 PR 的 findings；沒有自動 loop（每一圈都要人下指令）；作者唯讀以外的限制只靠提示與事後檢查（不是作業系統層隔離）；作者可能動到 findings 以外的檔案，bridge 只列出改動的檔案、不判斷是否超出範圍。
- **取得 review 用的 PR 材料（追蹤清單 F5 階段 3b，已實作、待驗收（核心路徑由 ISSUE-078 的 live 驗收間接用到，2026-11-04；對真實開著的 PR 取材料已走過，單一 commit 範圍與含空白路徑未驗），ISSUE-075；唯讀，目前沒有呼叫者）：** `src/card-review-fetch.ts` 的 `fetchReviewMaterial(exec, repo, number)` 只用 `gh pr view`、`gh api --paginate …/pulls/<n>/files`（GET）、`gh pr diff`。只 review **開著**的 PR；先讀 head sha、再讀檔案清單與 diff、最後再讀一次 head，兩次不同就拒絕（讀取期間有新 commit，review 的判定必須綁單一 head）；diff 標頭列出的路徑（改名的新舊路徑都算）必須和檔案清單**完全一致**，對不上或標頭無法解析就拒絕，不猜；檔案數上限 20、diff 上限 60,000 字元（`gh` 輸出超過 2 MiB 緩衝也算太大），超過就拒絕並說明請 Lead 把需求重新切分。沒有任何寫入：不 merge、不留言。限制：只支援整個 PR 的 diff，單一 commit 的範圍（每個 commit 審一次）尚未支援；標頭含引號的路徑（例如含空白）無法解析而被拒絕。
- **Review 提示與回覆解析（追蹤清單 F5 階段 3a，已實作、待驗收，ISSUE-074；純函式，目前沒有呼叫者，沒有任何 reviewer 會被啟動）：** `src/card-review.ts`。使用者 2026-11-04 對第一版的決定：手動觸發（`card review <id>`，之後實作）、reviewer 由使用者指定 pane、diff 上限 20 個檔案與 60,000 字元（超過就拒絕並要求 Lead 重新切分需求）、唯讀靠提示約束加工作樹指紋檢查而不是作業系統層隔離。提示：交給 reviewer 的只有卡片的標題、描述、驗收條件（先遮蔽再截斷；`## 決議`、`## 異動專案` 等不給）與 PR 的檔案清單、diff，放進 `<<<REVIEW_DATA …>>>` 資料區並聲明為資料，內容裡的分隔字樣會被改寫；要求 reviewer 逐條對驗收條件回答。回覆：必須剛好是一個 JSON 物件（可包在一個 ```json 區塊裡，上限 64 KiB；**嚴格解析失敗時**才用 Team 計畫解析同一套的 `unwrapCodexJson` 把字串內被窄 pane 折行的內容接回去——續行縮排兩格，合格的回覆不會被改動，ISSUE-080），含 `verdict`、每條驗收條件各一筆的 `criteria`（`met`／`unmet`／`unknown`）與 `findings`；任何欄位不合格（含 finding 的路徑不在 PR 動到的檔案內）就**整份拒絕**，呼叫端記成 `inconclusive`、不做部分採用。`pass` 要有證據才成立：有未達成條件或 high／medium 的 finding 降為 `changes_requested`；有無法判斷的條件降為 `inconclusive`；`changes_requested` 卻沒有任何 finding 也沒有未達成條件則降為 `inconclusive`。限制：reviewer 輸出是不可信資料；分隔線與遮蔽不能防止 prompt injection；各條件的判定結果（`criteria`）目前只回傳給呼叫端、**還沒有地方存進卡片**；路徑含英數與 `._/@+-` 以外字元的 PR 目前無法 review。
- **敏感路徑檢查（追蹤清單 F6 階段 1，使用者 2026-11-04 決定，已實作並驗收 2026-11-04，ISSUE-071；只提醒、不阻擋任何事）：** `card pr` 開出 PR（或對既有 PR 推新 commit）之後，用 `gh api repos/<owner>/<repo>/pulls/<n>/files`（含改名的原路徑）取得 PR 動到的所有路徑，與 `src/sensitive-paths.ts` 的清單比對，在回覆裡警告並列出命中的檔案。清單：`.github/`、`AGENTS.md`、`package.json`（只指 repo 根目錄那一個）、`scripts/`、`src/policy.ts`、`src/github.ts`，以及（`SPEC.md` 曾在清單內，使用者 2026-11-06 決定移出：它是文件，新功能的 PR 幾乎都會改，列入會讓 L2 對功能類卡片幾乎都退回人工，ISSUE-102）**清單檔 `src/sensitive-paths.ts` 本身**（否則 Agent 可以先改清單再 merge）；結尾 `/` 是目錄前綴、其餘是精確檔案路徑；比對不分大小寫、忽略開頭 `./`，會爬出 repo 的路徑（`..`）視為敏感。**查不到（網路、權限）或檔案數到 GitHub 的 3000 筆上限時回報「無法確認」（null），不讓 `card pr` 失敗；將來自動 merge 時 null 要當作敏感。** 目前**沒有**自動 merge，所以這個檢查不阻擋任何動作；調整清單由使用者要求並經人工 merge。限制：檢查發生在開 PR／推 commit 當下，之後 PR 被別人改動不會重查（將來 merge 前必須再查一次）；只認路徑，不看內容。
- **`card review <id> [--agent <種類>]`（追蹤清單 F5 階段 3d，已實作、核心路徑已驗收 2026-11-04，ISSUE-078；Discord 與 console，沿用 `card` 的授權；2026-11-04 以 codex 當 reviewer 對測試 PR 走完 `inconclusive`、`pass` 與 `changes_requested`（含 findings 寫入卡片與 `card show` 顯示）；Claude 當 reviewer 未實機驗證）：** 對卡片**開著的 PR** 做一次獨立 review，reviewer 是新開的 pane 與新 Agent、用完關閉。**前提（不符合就丟出說明原因的錯誤，卡片不動、不開任何 pane）：** 卡片有作用中的 worktree（reviewer 在那裡啟動）；專案政策 L1 以上（要讀 GitHub，與 `card pr` 一致）；`card-prs.json` 有開著的 PR（先 `card pr`），多個時取最新一個；作者（卡片最後一個任務的 Lead）已知、在本機、pane 還在（新 pane 從它分割）。**同一張卡同時只能有一個 review 在跑。** 流程：取 PR 材料（`fetchReviewMaterial`，head 以讀取當時為準）→ `runCardReview`（見下一條）→ 把結果寫進卡片：`recordFindings`（輪次＝已記錄的「整體」批次的最大輪次加一）與一筆 `review_verdict` 流程紀錄（角色 `reviewer`、判定、第幾輪，事件 id `review-<PR 編號>-r<輪次>-<head 前 12 位>`）。**沒有開始 review 的情況（前提不符、Agent 啟動失敗…）不動卡片**；review 已經發生之後的卡片寫入失敗只警告、不丟錯誤，verdict 事件照記。回覆含：PR 完整網址、head、輪次、判定、reviewer 種類（同種類時註明獨立的只有 session）、inconclusive 的原因、降級原因、各條驗收條件的逐條結果、findings（最多 5 筆）、是否已寫入卡片、reviewer 的 pane 是否已關閉。**限制：** 各條驗收條件的逐條結果只顯示在回覆裡，**卡片沒有地方存**；只支援本機；只審整個 PR（單一 commit 範圍尚未支援）；啟動提示依 ISSUE-118 處理：成功讀取 pane 畫面且種類與 `src/update-prompts.ts` 的已知更新提示相符、沒有信任／權限／approval／登入字樣時，bridge 可自動跳過後繼續等就緒，不會僅因該更新提示就判 `inconclusive`。目前只有 codex（`Update available` 且有 `Skip until next version`，按 `3`），每個 bridge port 下的同一 pane 最多送一次，並記錄 CLI、pane、按鍵的 log。信任資料夾、權限／approval、登入、未知畫面、讀取失敗，以及送一次後仍在的更新提示，仍維持 blocked、保留 pane、沿用 `BLOCKED_AT_START` 並使 review 判 `inconclusive`，絕不自動確認；更新提示混有上述敏感字樣也不送鍵。
- **review 流程（追蹤清單 F5 階段 3c-2，已實作並驗收 2026-11-04，ISSUE-077；所有外部動作由呼叫端注入，沒有呼叫者，不寫卡片、不讀 GitHub）：** `src/card-review-flow.ts` 的 `runCardReview`。順序：組提示（前提不滿足就在開任何 pane 之前回報）→ 選種類 → 取工作樹指紋（`git rev-parse HEAD` 加 `git status --porcelain`，由呼叫端提供）→ 從作者的 pane 分割新 pane（工作目錄為卡片的 worktree）→ 啟動 reviewer → **等它變成 `idle`（ISSUE-079：剛啟動時常是 `working`，最多等 30 秒；`blocked` 時依 ISSUE-118，僅在成功讀取畫面且符合已知更新提示清單、無信任／權限／approval／登入字樣時，最多送一次跳過鍵、記錄 log、重讀畫面後繼續等待；其他提示、未知畫面、讀取失敗或送一次後提示仍在，沿用 `BLOCKED_AT_START` 失敗並保留 pane，不自動確認；逾時寫出實際狀態）** → 送出提示並讀回覆 → 解析 → 再取一次指紋 → **關閉這個 pane（啟動就緒等待以 `BLOCKED_AT_START` 失敗時保留 pane）**。分類：還沒開始就失敗（提示、種類、指紋、開 pane、Agent 啟動失敗）回 `ok: false` 並指出階段，Agent 啟動失敗時**不自動換種類**；review 開始後的任何問題（reviewer 沒就緒例如卡在信任提示、卡住、逾時、回覆不合格、工作樹被改動、事後無法確認工作樹）都回 `ok: true` 但判定為 `inconclusive`、沒有 findings，並附原因，bridge 不替人確認信任提示；關閉 pane 失敗只回報（`closed: false`），不改變 review 結果。reviewer 的 Agent 名稱為 `review-<卡片 id 雜湊前 6 碼>-r<輪次>`（Herdr 限 32 字元）。限制：reviewer 唯讀是提示約束加指紋檢查，**不是作業系統層隔離**；指紋抓得到檔案被改與 commit 被新增，**抓不到只改了被 gitignore 的檔案**。
- **reviewer 的新 pane（追蹤清單 F5 階段 3c-1，已實作並驗收 2026-11-04，ISSUE-076；沒有呼叫者）：** `src/review-pane.ts`。`chooseReviewerKind`：沒指定種類時選偏好順序（`claude`、`codex`、`agy`）中第一個與作者不同的；`--agent` 指定的種類照用並回報是否與作者同種；不合法的種類名稱拒絕；種類能不能啟動由 `agent.start` 決定，失敗時回報並停下、不自動換。`openReviewerPane`：依 ISSUE-108 尺寸規則開新 pane（不足以分割就開同 workspace 的 tab），工作目錄設為指定目錄、不搶焦點；結果沒有 terminal id 或在別的 workspace 就拒絕（之後無法安全關閉）。`closeReviewerPane`：關閉前重新讀 pane、確認還是我們開的那個 terminal 才呼叫 `pane.close`；pane 已不在（`pane_not_found`）算已關閉；terminal 不同、讀取或關閉失敗都**不丟錯誤**、回報原因讓呼叫端告訴使用者。原分割路徑的 `terminal_id` 與關閉行為已在 2026-11-04 驗收（ISSUE-076／078）；新 tab root pane 的實際清理列入 ISSUE-108 驗收。
- **review 與 coding 的 Agent 一律新開 pane、用完關閉（使用者 2026-11-04 決定，已決定、未實作）：** `card review <卡片 id> [--agent <種類>]` 由 bridge 在新 pane 啟動全新的 reviewer（種類預設與作者不同，不行才同種類），在卡片的 worktree 裡唯讀審 PR，寫入 findings 與 `review_verdict` 後關閉這個 pane；`card assign --worktree` 的 coding Agent 在任務完成後也關閉它的 pane、worktree 保留。只關 bridge 自己開的 pane 且核對 terminal id；reviewer 逾時或卡住記 `inconclusive` 並仍然關閉；種類啟動失敗（含 quota）回報並停下、不自動換種類。跨機器（coding 在 A pod、review 在 B pod，都從 repo 拉同一個 feature branch）的方向已決定、尚無設計（F9），目前所有卡片功能只支援本機。
- **L2 的 review 閘（追蹤清單 F5，使用者 2026-11-04 決定，已決定、未實作）與 F6 的 merge 端行為（未實作）：** L2 自動 merge 要求：PR 上由**不同 session** 的 Agent 審 diff，判定連同 head commit sha 記在卡片（`review_verdict`），`pass`、head 沒變、CI 全綠才 merge，新 commit 使判定作廢；PR 動到敏感路徑一律不自動 merge、退回人工。**目前沒有 merge 功能，L2 仍只是政策檔的設定值。** 使用者 2026-11-04 對子決定的回答（reviewer 盡量不同種類、repo 唯讀、逐條對驗收條件、每個 commit 審一次加最後整體 review、先審 2 輪後交 Lead 決定、quota 不夠要記錄並 handoff、敏感路徑清單加上 `SPEC.md`／`src/policy.ts`／`src/github.ts`）記在需求卡；使用者同日定奪：「審查→修正」loop **總上限先設 3 次**（使用者 2026-11-04 由 5 改為 3；可依要求調整，超過退回人工）、每次審查最多 2 輪；findings **寫在卡片的新欄位、不貼 PR 留言**（需擴充卡片格式，尚無設計）。限制：reviewer 與作者可能是同一家模型，獨立的只是 session，不是判斷能力。


### 卡片角色紀錄（2026-11-08，ISSUE-127，2026-11-08 已實機驗證並由使用者驗收）

卡片帳本新增 `role_assigned` 固定模板事件：role、AGENT 格式的 CLI 種類、machine（local 或已選定機器 id）、已知 model／profile id，並含 task id 或 review／fix round。種類沿用 cli-adapter 的 identifyCli（經 agentDisplayName），不猜未知 model／profile。Lead 在 task 啟動記錄；Team 每個 assignment 在 acquire 實際 Worker 後、派工前記錄，role 使用 Lead 的 assignment id，不固定角色清單；card review／fix 在 Agent 成功啟動後記 reviewer／fixer 每輪身分（之後失敗仍保留）。不存任何 session 內容、prompt、輸出、卡片描述或 credentials。

事件 id 由 task id、role、round 與執行者（agent、machine、profile id、model）決定並 hash，沿用 CardStore 跨旁檔的 event id 去重；同一個執行者在同卡同作用域重送／重啟只保留第一筆，同一輪換另一個執行者重試則是新的事實、另記一筆（`card show` 依時間列出）。角色紀錄的 model 只在 bridge 用 profile 啟動新 session（`acquire` 的 `continuity` 為 `new-session`，啟動時帶了該 model）時記 profile 設定值；重用或綁定的既有 session、沒有 profile 的 Worker 都不記 model（Agent 自己回報的 model 永遠優先）。Herdr 的 `AgentRecord` 沒有 model 欄位，拿不到實際值，所以即使記了也不保證等於 Worker 目前實際的模型。Team 的 assignment id 若與 Lead 的角色 `lead` 同形（含已加前綴的 `assignment-lead` 等），角色名加上 `assignment-` 前綴，與 Lead 分開記錄。無 agent 欄位的舊事件照常解析，不補寫舊卡。role 為英數與 `_ . -`、≤64，agent／profile 沿用 AGENT ≤40；model 為英數起頭及 `_ . / : + -`、≤80。其他欄位沿用原驗證，單筆 ≤300 字；不合法／超限拒絕，寫入失敗只印固定 console error，不能影響 autopick、loop、review、fix、merge 或其通知結果。

`card show <id>` 從完整帳本（含輪替旁檔）按時間排序，單行 `角色紀錄：Lead：claude · impl：codex（gpt-6.1-sol）· reviewer（第 2 輪）：agy`；重複角色不合併，無紀錄顯示「沒有角色紀錄」。本輪不增加 PR 內文角色摘要，不把角色放進 ISSUE-120 通知，不改任何權限、review、CI 或 merge gate。原始碼／假 port 測試完成，live bridge 尚未部署及實機驗證。
