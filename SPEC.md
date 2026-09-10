# Herdr Discord Bridge 規格

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

Bridge 不是 ACP broker，也不會自行啟動 coding CLI。因此 Discord 斷線不會
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
Herdr 會注入 `HERDR_SOCKET_PATH` 與 `HERDR_PLUGIN_CONFIG_DIR`；standalone
執行時也支援文件定義的預設 socket 與 `HERDR_SESSION` 解析方式。

設定從 `HERDR_PLUGIN_CONFIG_DIR` 中的 `config.json` 讀取（standalone 時為
`~/.config/herdr-discord-bridge/config.json`）。Token 可由
`HERDR_DISCORD_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN` 提供。範例檔是 JSONC，
實際設定檔會被 gitignore。環境變數會覆蓋檔案設定。狀態儲存在
`HERDR_PLUGIN_STATE_DIR` 下（或 config directory 的 `state/`）；設定的
state filename 僅允許單一 basename，以防止 path traversal。

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

一般 socket failure 最多重試兩次；本機 blocked 回答不重試不確定的送達，避免重複回答。一般重試使用從 `reconnectBaseMs` 開始的 exponential
backoff。Protocol error 不重試。Watcher 在故障後於下一個 interval 繼續，
因此 socket failure 只會被回報，不會形成 crash loop，也不影響 Herdr pane。

Client 使用下列官方方法：

| Bridge 操作 | Herdr method |
| --- | --- |
| health | `ping` |
| workspaces | `workspace.list`，以 `session.snapshot` fallback |
| agents | `agent.list` |
| output | `agent.read` |
| assign | `agent.prompt`，以 legacy `agent.send` fallback |
| blocked reply | 相容 legacy 的 `agent.send`，以 `agent.prompt` 與官方 `pane.send_input` fallback |
| wait | `agent.wait` |
| cancel | `agent.send_keys`，傳送 `ctrl+c` |

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

## 5. Discord 指令與輸出

文字指令 prefix 預設為 `/herdr`；可用 `requireMention` 或
`HERDR_DISCORD_REQUIRE_MENTION` 啟用 mention 要求。提及 bridge bot 時，已知
指令可省略 prefix，因此 `@bridge agents` 與 `@bridge /herdr agents` 都接受。
未知的 mention 文字只有在訊息位於已映射 thread 時才會當成 direct prompt；這
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
/herdr team ask <prompt>
```

Bridge pane 的 stdin 也接受相同指令，可直接輸入 `agent`、`agent use w2:p1`、`status`、`ask <prompt>`、`read w2:p1`、`wait w2:p1`、`cancel w2:p1`，或使用 `/herdr` prefix。結果與 streaming progress 會印回 pane。Team routing 指令需要目前已選取的 workspace；Discord thread 只提供 route context，本機可用 `wk use <workspace>` 選取。
`workspaces` 顯示 Herdr 回傳的 label/path、ID 與 agent state。`wk use
<workspace-id-or-name>` 只會將目前 route 綁定到既有且已授權的 Herdr workspace；
不會建立 workspace、pane 或 Agent。之後使用 `use`、`target` 或 `assign` 選擇
Agent。`current` 顯示有效 mapping，並回報過期的 agent/pane 資料。

`use` 會在目前 Discord thread（若不在 thread 則為 user）綁定一個 live Agent
作為 active target，但不送出 prompt。Thread 有 active target 時，普通 user
message 會直接送給該 Agent，並套用與 `assign` 相同的 allowlist、過期 mapping
與 busy 檢查。`target` 是向後相容的 alias。`ask` 對指定 Agent 發送一次性
prompt，並將該 Agent 記錄到 thread，但不改變 active target。`team list` 列出所有 workspace Teams；`team add`、`team remove` 與 `team ask` 操作目前 workspace 的 Team。Team mapping 會持久化，Discord thread 不是 Team scope；
`team remove` 管理獨立的 thread participants；`team ask` 只將指定 prompt 送給
每個同 workspace participant，不會廣播 thread 或 terminal history。

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

Reasoning 與 commentary record 不會作為 final。Bridge 不會啟動第二個 Agent。
Transcript 缺少、不明確、無法存取或格式不相容時，使用 terminal fallback。每個
pane 不同的 `CODEX_HOME` 必須使用相同 catalog；不支援只存在遠端的 session
file。

Terminal fallback 保留最長的、限定於 prompt scope 的已觀察摘錄；不會宣稱此
摘錄是完整 final 或累積 transcript。只有在 idle/done 狀態連續四次未變且成功的
read，再持續 settlement 十秒，才允許 fallback 完成。blocked、unknown、輸出
變動或 read failure 都會重設 settlement。Structured completion 可在沒有成功
terminal read 時完成。Agent session 被替換後停止觀察；identity 比較 terminal、pane、workspace、agent kind，以及 session 的 kind/value，不以 source、欄位順序或其他 metadata 判斷替換。缺少或無法辨識的 session 不自動認定為新的相同 session。

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

Discord 單一 Agent 的 blocked／approval 以 pane、terminal、workspace、thread identity 綁定。本機單 Agent 通道見「本機選取 Agent 後的互動」；Team Task 的多 Agent 問題回覆尚未支援，見 ISSUE-012。

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
但 bot ID 相同也互斥。鎖只占用本機 IPC 名稱，不提供 command API 或 HTTP。
Linux 使用 abstract Unix socket，Windows 使用 named pipe，程序退出由 OS 釋放；
其他 Unix 使用 temporary-directory socket，異常退出殘留時 fail closed，需確認
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
Herdr socket。Final diff scan 不得包含真實 credential、token、private local
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
禁止 redirect，具有 timeout、streamed byte limit 與 signature check。產生的本機
路徑位於 target Agent cwd 下的 `.herdr-discord-bridge/attachments`，並以明確
指示要求 Codex/agy 使用 image-viewing tool。這是本機檔案傳遞，不是原生
multimodal input，且要求 Agent 可存取相同 filesystem。不支援的 agent/format
與下載失敗會回報。成功檔案會保留（目前尚無自動 retention cleanup）；失敗批次
只會刪除自己新建的 temporary directory。準備期間會保留 terminal，避免並行
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

互動式 `bridge>` 啟動一個單 Agent 觀察器，依 `pollIntervalMs` 讀取所選 Agent 的 `visible` 輸出，最多 40 行／6,000 字元。選取後顯示當前畫面，之後只在文字或狀態改變時重印；idle、working、blocked、done、unknown 均可顯示。每次標示 Agent、workspace、pane、狀態與 terminal snapshot，移除 ANSI／控制字元。這是可見 terminal 節錄，可能含 UI／工具文字，不宣稱完整 transcript、問答邊界或完整 final；不讀隱藏 reasoning 事件、不自動轉發 Discord。切换或關閉後丟棄舊的 in-flight read，失效 identity 停止輸出與送入，須明確重新選取。

本機 `ask <text>` 和非指令文字：保留大小寫與內部空白，idle/done 時送出新 prompt；blocked 時回答已顯示的問題。傳送前重新檢查 workspace allowlist、pane、terminal、Agent kind、session kind/value、blocked 狀態與 state sequence，並比較可見問題畫面；若問題改變或尚未顯示，先顯示後拒絕舊回答，要求重新回答。相同問題只接受一次回答，不重試 socket 不確定送達。缺少 session metadata 時僅能靠 terminal/pane/kind 辨識，無法保證同 terminal 內無 metadata 的 CLI restart 可被偵測；Herdr API 也不提供驗證與送字的原子 question ID 契約。

working/unknown 時一般 prompt 會明確拒絕；`help`、`current`、`agent`、`agent use`、`wk` 等控制指令仍可操作，無須等 blocked。若答案開頭恰為指令，以 `ask <answer>` 明確指定。觀察輸出會重畫 `bridge>` 並保留正在編輯的輸入。`cancel` 是另行明確的 Ctrl-C 操作。單 Agent 本機 `ask` 由持續觀察器顯示結果；既有 Discord dispatch 的 progress/final 路徑不變。

Codex 本機新 prompt 保留既有 transcript final 擷取，另外顯示本機快照；agy 等 CLI 目前使用快照回饋。多 Agent 同時提問的 question ID／排隊／回覆 UI、是否暫停其他 Agent、agy 未被 Herdr 辨識為 blocked 的選單按鍵、直接 pane → Discord mirror 仍待做，不自動暫停其他 Agent 或猜測答案目的地。

本機專用 `threads` 列出已映射且符合 guild/channel/workspace allowlist 的 thread；
`thread <thread ID>` 明確選定共用路由，`thread off` 回到原本本機路由。
選取儲存在同一 routing state，重啟後保留；共用模式直接操作該 thread 的 active
Agent 與 Team，兩邊變更立即反映，不複製 mapping，也不冒用 Discord 使用者。
每次指令再次檢查 thread 存在與授權，失效時拒絕，不自動挑其他 thread。
此模式只共用 routing；本機 command 回覆／stream 仍輸出到本機，直接在 Agent
pane 的對話不會因此鏡像到 Discord。未知 thread 必須先在 Discord 建立 mapping。
