# Herdr Core runtime：邊界、限制與驗收

更新：2026-11-12；追蹤 ISSUE-151。原始碼與自動化已完成，實機啟動／Discord 往返待驗收，執行中的 bridge 未重啟、未部署。本文的驗收命令是待執行草案，不是已完成的證據。

## 邊界與設定

```text
run.sh --herdr (default) -> existing Herdr plugin/workspace/tab lifecycle
run.sh --core           -> Core status/start -> ls/get guard -> terminal.run

Node entry: env HERDR_BRIDGE_RUNTIME > config runtime > herdr
  herdr -> existing startBridge -> HerdrHub/HerdrClient -> old Herdr socket
  core  -> independent startCoreBridge -> CoreAdapter -> CoreTransport
                                        -> Core Unix socket (JSON-RPC 2.0)
           shared DiscordAdapter and bot instance lock
```

RuntimeAdapter／RuntimeCapability 定義操作邊界；HerdrAdapter 是既有 client 的委派包裝，舊主入口仍直接走 HerdrHub，並非整份 main 已遷移到 adapter。Core 不共用舊 request port 或 machines tunnel，不把 workspace/pane/tab 身分合成成 terminal 身分。

Core socket 實作規則：HC_SOCKET > HC_SESSION 對應 `~/.local/state/herdr-core/<session>/<session>.sock` > `~/.local/state/herdr-core/default/default.sock`。空白／非法 session 或非絕對 HC_SOCKET 明確拒絕。不讀 HERDR_SOCKET_PATH，也未實作 Core config.socket／XDG 優先序解析；這些安裝需顯式 HC_SOCKET。CLI 與 bridge 必須指向同一個 session/socket。

`coreAllowedTerminals` 是 canonical address 白名單，預設空；列出與讀取不受該輸入白名單限制。綁定或輸入前重新 hello/status 核對啟動時 Core identity、get 查核 address 與 live；alias 不會自動變成授權 address。非空 allowedWorkspaceIds／machines 啟動前拒絕，要求移除設定；沿用 Discord guild/channel/user allowlists。Core 的 CLI session continuity 無證據，不開放依賴它的 Team／handoff 功能。

`core-routing.json` 保存 runtime=core、coreId 與 guild/channel/thread→terminal 綁定；不同 coreId 的舊綁定不採用。DiscordAdapter 另用 core-discord.json 作核准查詢的獨立空間；Core 不建立 approval。兩檔在 bridge state directory，均不讀寫舊 routing.json。thread 自由文字只有明確綁定且再次通過授權才送出。

## 實際協定與中立結果

依本機 `hc 0.1.20` schema 與唯讀實測：JSON-RPC 2.0，每行一筆 JSON；也可用 `herdr-core connect` 的 stdin/stdout 代理。hello generation=1，回版本、Core identity、methods/features；server.status 需與 hello 版本／identity 一致。必要方法含 server.status 與 terminal.list/get/read/send/keys/wait。

request 為 `{jsonrpc:"2.0",id,method,params}`；成功回 `{jsonrpc:"2.0",id,result}`；錯誤為 numeric code、message、data.kind。CoreTransport 每次新建有界連線，解析分段 UTF-8、按 id 配對，不重送；無效 JSON／協定回應拒絕。RPC code/data.kind 保留於 RuntimeError.details，原始 server message、prompt、token、params 不進錯誤 log。

read 固定 terminal.read lines:0，保留 text/complete/how/why；不讀 history 以避免捲動全螢幕 CLI。target status 只採 reported=true 的 OSC 7501 root state；null／未回報保持 unknown。send 保存 turn/started，預設等候上限 70 秒以容納 draft/quiet 暫緩；不送 force。送出後斷線、逾時或確認不明回 DELIVERY_UNKNOWN，人工先讀畫面，禁止自動重送。keys 使用 terminal.keys，cancel 送 ctrl+c，不用可能送 esc 的 interrupt。

adapter 的 terminal.wait 以秒傳 timeout，回 ended/reason/turn；timeout/message/not_started 不能當完成。promptAndWait 使用單筆 terminal.send 的 wait 參數。本版 Discord 未開放 wait，也沒有自動完成通知／final 串流；send 成功不是 Agent 任務完成。

Core schema 另有 events.subscribe：snapshot＋seq，plain connection 後續專供 event/heartbeat/missed；唯讀實測收到 heartbeat。hello 可切 framed，但 binary framing／credit 未完整驗證，bridge 不使用 attach 或事件串流。

## 舊 Herdr 23 個 method 對照

來源：2026-11-11 的已安裝 Core 0.1.20 `schema --json` 與唯讀調查（assignment d2-core-api）。「部分等價」只是 API 能力對照，不表示本 bridge 開放該高階操作。

| 舊 method | Core 等價程度 | 差異／本版處理 |
| --- | --- | --- |
| workspace.list | 沒有 | terminal labels 不等同 workspace 授權；拒絕 |
| workspace.close | 沒有 | 不以 server.stop／批次 kill 代替；拒絕 |
| workspace.create | 沒有 | terminal.run 不建立 Desktop workspace；拒絕 |
| session.snapshot | 部分 | terminal.list／events snapshot 無 workspace/tab/pane；舊 snapshot 操作拒絕 |
| pane.send_keys | 等價 | terminal.keys；須改用已核對的 canonical address |
| pane.send_input | 部分 | terminal.send 貼上後提交，含 draft/quiet/blocked 行為；raw input 拒絕 |
| pane.split | 沒有 | terminal.run 不分割 UI；拒絕 |
| pane.rename | 沒有 | terminal.label 僅 metadata；拒絕 |
| pane.layout | 沒有 | cols/rows 無 pane geometry；拒絕 |
| pane.get | 部分 | terminal.get 無 workspace/tab/pane 身分；舊 pane.get 拒絕 |
| pane.close | 部分 | kill 結束程式、rm 移除 finished record，不等同 UI pane close；拒絕 |
| agent.read | 部分 | terminal.read 僅映射 visible lines:0；recent/recent_unwrapped/detection 拒絕 |
| agent.prompt | 部分 | terminal.send，blocked 不 force；保留 turn/started |
| agent.list | 部分 | terminal.list 包含非 Agent，狀態未回報是 unknown |
| agent.start | 部分 | terminal.run 建新 terminal，不能在指定既有 pane 啟動；bridge 拒絕 |
| agent.send | 部分 | terminal.send；不提供通用強制 blocked 回答 |
| agent.send_keys | 等價 | terminal.keys；ctrl+c 不改為 interrupt |
| agent.wait | 部分 | terminal.wait 無 until 陣列，秒制 timeout，回 ended/reason/turn；僅低階 adapter |
| tab.rename | 沒有 | Core 不管理 tabs；拒絕 |
| tab.create | 沒有 | terminal.run 不建立 Desktop tab；拒絕 |
| worktree.remove | 沒有 | 無原生 worktree API；拒絕 |
| worktree.list | 沒有 | 無原生 worktree API；拒絕 |
| worktree.create | 沒有 | 無原生 worktree API；拒絕 |

## Discord 支援／拒絕

使用既有 `/herdr` 前綴或原 mention 短指令規則：`agents`／無子指令 `agent`、`status`、`read [terminal]`、`ask <terminal> <text>`、thread 內 `target/use <terminal>` 或 `agent use <terminal>`、`agent keys <terminal> <keys...>`、`cancel [terminal]`、`help`。一般按鍵使用 agent keys 子指令；cancel 不停止程序，只送 Ctrl-C。

其他命令全部拒絕：workspaces/wk/workspace、card、team、handoff、worktree、machines、agent start/pool/detach、pool、approval、wait、quota、failover、assign、model、usage、hooks、discord、current、attach/watch/detach 等。拒絕原因是缺少 workspace/layout/session 等證據，或本版最小路由尚未接線；不嘗試另一 runtime。沒有 profile pool／fresh Worker／reviewer／card autopick 的替代實作。

| RuntimeError code | 訊息 |
| --- | --- |
| RUNTIME_UNSUPPORTED_OPERATION | `Core 不支援操作 <operation>（缺少 <capability>）；未執行操作。` |
| RUNTIME_IDENTITY_UNVERIFIED | Core 目標身分或授權無法確認；未送出輸入。 |
| RUNTIME_UNREACHABLE | 無法連線所選 Core runtime；未切換至 Herdr。 |
| RUNTIME_INCOMPATIBLE | Core 協定或必要 API 不相容；未切換 runtime。 |
| RUNTIME_DELIVERY_UNKNOWN | Core 指令送達狀態不明；未自動重送。 |

缺 method／設定互斥時附固定診斷；空白名單輸入拒絕另提示 coreAllowedTerminals。Discord 附錯誤碼；CLI 入口只印訊息。非 RuntimeError 記安全分類，使用者收到「處理失敗，已記錄」。

## run.sh 與生命週期

```text
Usage: scripts/run.sh [--herdr|--core] [-r|-rg]
Backend defaults to --herdr. Options may appear in any order.
-r: rebuild local checkout; -rg: reinstall from GitHub (Herdr only).
--core -rg is unsupported; no changes are made.
```

-h/--help exit 0；重複 backend（即使同值）、重複 mode、互斥、未知／位置參數與 Core -rg 都在 npm／runtime 呼叫前 exit 2。Herdr 原模式／呼叫順序保留，使用專用 bridge workspace/tab 1，不看 Core terminals。

Core -r：npm ci＋build；無 mode：要求現有 dist/src/index.js。接著 server status --json；只在非零且訊息精確是 no core running（純文字或 JSON error.message）時 server start 一次，輪詢就緒約 10 秒，每次 status 有 1 秒上限。permission/incompatible/timeout/不明 socket 錯誤停止。真實停止後啟動路徑尚未實測，此判定刻意保守。

ls --json --all 查 live terminals；摘要缺 labels 時 get address --json 補查，格式不完整拒絕。bridge.role=discord-bridge 且 bridge.project=目前專案 pwd -P 的既有 live terminal 會阻止啟動，印 address 要求操作者自行處理。沒有自動 kill/rm 或以 title/PID 猜測關閉資源；另一專案／finished terminal 不被關閉。

沒有重複者才執行以下命令（旗標已核對 0.1.20 run help，尚未真實啟動驗收）：

```bash
herdr-core run --json --bg --no-parent --no-notify \
  --cwd "$project_dir" --label bridge.role=discord-bridge \
  --label bridge.backend=core --label "bridge.project=$project_dir" \
  -- env -u HERDR_DISCORD_BOT_TOKEN -u DISCORD_BOT_TOKEN -u HC_SOCKET -u HC_SESSION \
  HERDR_BRIDGE_RUNTIME=core "HERDR_PLUGIN_CONFIG_DIR=$bridge_config_dir" \
  "HERDR_PLUGIN_STATE_DIR=$bridge_state_dir" node "$project_dir/dist/src/index.js"
```

上例省略 caller 設定時才加入的 HC_SOCKET/HC_SESSION assignments；script 以 Bash array 原樣傳值。先清除 server 的定位變數，再套 caller 有設定的值，避免繼承舊 session/socket。config/state 目錄有 caller 值則保留，否則依 bridge 規則解析預設絕對路徑。config.json 以與 config.ts 相同的 JSONC 註解／尾逗號方式讀取；只查 token 是否存在，不輸出值。環境 token 不能經可見 argv 傳遞；caller 僅用 HERDR_DISCORD_BOT_TOKEN/DISCORD_BOT_TOKEN 而檔案無 token 時拒絕。新程序也清除這兩個變數，確保使用檔案 token。

r7-f1 的 launcher 問題以實際可用的 `herdr plugin pane open --env HERDR_BRIDGE_RUNTIME=herdr` 修正；config core 不會使舊 pane 跑成 Core，不改寫 config，也不需要缺少 --env 時的衝突拒絕 fallback。r7-f2 以 env -i fake server 啟動假 node 驗證目錄、runtime、HC 定位與秘密不入 argv；實機程序驗收仍待安排。

script 印 Core bridge terminal: address，只確認 terminal 建立；程序可能因設定、bot lock 或 Discord 登入失敗而結束，須另驗。Core 分支完全不呼叫 herdr。同一 bot 的 OS instance lock 跨 backend 防重，不替操作者關閉已執行的 bridge。

Core 本身有 server start/status/stop/restart CLI，沒有 server.start RPC。schema/manual：stop 停止 Core 與程式，kept terminal 待下一次啟動給新 shell；restart 保存畫面、保留程式，下一個 Core 接管。holder 管 terminal 程序；同 build holder 接受新 terminals，舊 holder 可排空。macOS GUI 通常透過 launchd 啟動 Core，SSH 啟動可直接執行；這些屬 Core 生命週期，不是 script 已驗證的功能。run.sh 不 stop/restart server；停止 bridge 應先核對其 Core identity/address/project 與程序身分，不能用 server stop 或清理另一 runtime 代替。

## 測試證據與剩餘限制

2026-11-12 分段驗證：npm test（含 build）1889 項、1888 pass、0 fail、1 skipped；typecheck、lint 通過。Bash 語法檢查與系統 Bash 3.2.57 fake CLI 執行通過；restart＋run-sh-args 共 41 項。runtime tests 涵蓋 selector、capabilities、分段 UTF-8/id/錯誤 JSON/timeout/disconnect/numeric RPC error、握手、unknown/read incomplete、send 不 force／零重送、wait reason/秒制、keys、Discord 授權與獨立路由。fake CLI 涵蓋 backend×mode×順序、非法參數零副作用、status/start 判定、未就緒、重複 bridge 與缺 labels 補查。

2026-11-12 本機唯讀 `HERDR_BRIDGE_RUNTIME=core node dist/src/index.js --dry-run` 回 generation=1、terminals=2、allowed=0；前段 Core 版本為 hc 0.1.20。沒有登入真實 Discord、沒有真實輸入。自動化／唯讀證據不代表已完成以下驗收。Linux/Windows、XDG/config socket 路徑、Desktop UI、真實停機 start、正式鎖衝突及 CLI 實際狀態回報仍未驗證。

## 實機驗收草案（未執行）

1. 先記錄日期、OS、`git rev-parse HEAD`、build 時間、`herdr-core --version`、`herdr --version`、Desktop 版本，以及既有 bridge 的 backend／程序版本。以 `herdr-core server status --json`、`herdr-core ls --json --all` 核對 Core identity 與目標；不要記錄 token。
2. 準備測試 bot 或由操作者明確安排既有正式 bridge 的停機窗口。同一 bot 的正式 bridge 正持鎖時，不直接啟動第二個；不可用 pkill、server stop/restart 或另一 runtime 的 pane 關閉來繞過鎖。共用設定需確認 runtime env 優先序，並使用正確 config/state directory；Core 的 allowedWorkspaceIds/machines 必須為空。
3. 設 coreAllowedTerminals 為操作者明確選定的安全測試 terminal，先執行 `HERDR_BRIDGE_RUNTIME=core node dist/src/index.js --dry-run`。記錄 socket、generation、版本、數量與 exit code；驗證不可達 socket 立即失敗、不 fallback。
4. 在授權的窗口執行 `scripts/run.sh --core -r`，記錄建立的 address、labels、實際 bridge 程序與 Discord 登入結果；不能只憑 script exit 0 宣告成功。再次 --core 應因同專案 live bridge 而拒絕，確認未關閉／搬移任何資源。
5. Discord 測 `/herdr status`、`/herdr agents`、`/herdr read <terminal>`；白名單外 ask/cancel 應拒絕且畫面無輸入。對安全測試 terminal 執行 `/herdr ask <terminal> <harmless-text>`，再 read 核對，記錄送出一次與畫面結果。以 target 綁 thread、送自由文字，並在未綁 thread 驗證拒絕。keys/cancel 只在操作者允許的測試程序驗證。送達不明先讀畫面，不重送。
6. 測試 card/team/workspaces 等明確拒絕及 state 隔離；不要要求跑真實卡片。由操作者明確停止本次 Core bridge 後，另安排 `scripts/run.sh --herdr` 啟動與 Discord 基本往返，核對舊 Herdr workspace/tab 守門及 Core 資源未變。
7. 把每步命令、日期、版本、成功／失敗、未驗項、部署／重啟狀態補進 ISSUE-151。任一步失敗即重新開啟，保留先前自動化及唯讀歷史；舊事件不自動補送。
