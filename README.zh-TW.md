# Herdr Discord Bridge（繁體中文）

從 Discord 控制已在 Herdr pane 中執行的 coding agent。Bridge 使用 Discord outbound Gateway WebSocket 與 Herdr local socket，不提供公開 HTTP endpoint，也不會取代 Herdr 的 PTY/runtime。

[English](README.md) | 繁體中文

Agent quota 快用完時，可請 CLI 讀取 [handoff-session skill](skills/handoff-session/SKILL.md)
保存交接資訊，或由另一 CLI 復原指定 session，來源包含 Grok Build。整個目錄可稍後手動安裝。
Skill 可讀本機 `grok export`；Bridge runtime 不解碼 Grok session 檔。
詳見[用法及與 bridge handoff 的差異](docs/session-handoff.md)。
目前無供應商 quota 自動監控；Bridge Phase 4 支援明確額度回報與驗證切換（見下方），真實跨 CLI 驗收仍待完成。

## 安裝與啟動

從 GitHub 安裝並啟用 plugin：

```text
herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
herdr plugin enable herdr-discord-bridge
```

取得設定目錄並建立設定檔：

```text
herdr plugin config-dir herdr-discord-bridge
cp config.example.jsonc <confiig-dr>/config.json
```

在 `config.json` 填入 Discord bot token，以及明確的 guild/channel/user allowlist。也可以使用 `HERDR_DISCORD_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN` 環境變數。不要把真實設定檔或 token commit 進 Git。必須在 Discord Developer Portal 開啟 Message Content Intent。若要讓沒有其他 bot 在線的已綁定 thread 免 mention，另需開啟 Server Members Intent 與 Presence Intent，並設定 `discord.soloThreadNoMention: true`。

啟動 bridge：

```text
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

啟動後可用以下命令找 pane、讀取輸出或查看 process：

```text
herdr pane list
herdr pane read <pane_id> --lines 50
herdr pane process-info --pane <pane_id>
```

## 更新 GitHub 版本

先用 pane-open 回應中的 `pane_id` 關閉舊 pane，再重新安裝並啟動：

```text
herdr plugin pane close <pane_id>
herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

安裝流程會執行 plugin build。pane 啟動的編譯入口是 `node dist/src/index.js`。

## 使用本地修改

在 push 到 GitHub 前，可直接 link 目前 checkout：

```text
./scripts/run.sh
```

使用這個 script 時：

```text
./scripts/run.sh       # 只啟動，不 rebuild 或 reinstall
./scripts/run.sh -r    # npm ci、build，並執行本地 checkout
./scripts/run.sh -rg   # 從 GitHub 重新安裝 main 並啟動
```

如果 Herdr server 尚未啟動，`run.sh` 會先自動啟動 headless server 並等待 socket ready，再執行 bridge 重建流程；不需要先手動輸入 `herdr`，也不會停止既有 Herdr server。

三種模式固定使用名為 `bridge` 的專用 workspace 之 tab 1；不存在時以專案 cwd 建立並保留 focus，同名多個則拒絕。其他 Agent pane 留在原位置。若其他 workspace 仍有舊 bridge，script 會列出 pane ID 並停止，需先明確搬移或停止舊 bridge，避免兩個 bot 程序同時執行。只替換專用 tab 中明確標示且無 Agent 的 bridge pane，不修改 plugin 設定或 Discord token。

若要手動執行：

```text
herdr pane list
herdr plugin pane close <pane_id>
npm ci
npm run build
herdr plugin unlink herdr-discord-bridge
herdr plugin link . --enabled
herdr plugin pane open \
  --plugin herdr-discord-bridge \
  --entrypoint bridge
```

## 切換模型

使用目前 thread 的 Agent：

```text
/herdr model <model>
```

指定 Agent：

```text
/herdr model <agent-name-or-pane-id> <model>
/herdr discord enable|disable|status
```

切換不會重啟 pane 或清除對話；Agent 工作中時會拒絕切換。實際的 model
command 由 CLI adapter 處理，避免 Codex、Antigravity（`agy`）與其他 CLI
互相使用錯誤語法。

`/herdr model` 會顯示 Discord dropdown，列出該 CLI adapter 的 model 選項；也
可以直接指定 model 名稱。model 名稱仍需符合該 CLI 支援的名稱。
Claude 選單使用 `sonnet`、`opus`、`haiku` alias，送出 `/model <name>`；可用性依 CLI／帳號決定。

要暫停 Discord command 與 approval 處理但保持 bot 連線，可使用：

```text
/herdr discord disable
/herdr discord status
/herdr discord enable
```

只有 `discord.allowedUserIds` 內的 user ID 可以變更狀態。重建 script 會把 bridge
放在 tab 1 但不 focus；保留原本的 active tab，之後開啟的其他 Agent pane 就不會
因為重建流程被帶到 tab 1。

## Discord 單 Agent 回覆擷取行為

每次收到 prompt 時，bridge 會先記錄 Herdr terminal snapshot，然後只轉送該 prompt 之後產生的最新回覆，不會重送 prompt 以前的歷史內容。

不同 CLI 的 prompt 格式由 adapter 分開處理：

- Codex：`› prompt`
- Antigravity / `agy`：`> prompt`
- OpenCode：`> prompt`
- Grok：1.0.46 方形回答框與帶完成 footer 的無框回答，去除 UI 外框、捲軸與首行時間；支援折行的 Bridge 標記。不是原生 transcript，截斷或格式變更仍可能擷取不完整（見 ISSUE-023）。
- Claude：比對多行 prompt，清理訊息 gutter、輸入列與工具結果區塊；仍為終端摘錄，沒有原生 transcript adapter（ISSUE-026）。
- pi：以 prompt 回顯為邊界，清理輸入框／頁尾、spinner 與 `$ cmd … Took` 工具區塊；仍為終端摘錄，沒有 transcript adapter，待實機驗收（ISSUE-033）。
- 未知 CLI：使用保守的通用 adapter

model/path 等 terminal UI metadata 會被過濾。如果找不到可靠的 prompt 邊界，bridge 不會把整份歷史 snapshot 當作回覆轉送。

Agent 完成後，回覆會更新原本的 progress message；預設不會另外發送 `done` 通知。 回應標頭的 WK（Workspace） 會同時顯示 Herdr ID 與名稱（名稱可取得時）。只有 `blocked` 狀態會依設定發送額外通知。

## Discord 指令

支援 mention 形式：

```text
@bridge agents
@bridge use codex
@bridge help
```

也支援 `/herdr` 前綴形式：

```text
/herdr workspaces
/herdr wk use <workspace-id-or-name>
/herdr agents
/herdr status
/herdr current
/herdr use <agent-name-or-pane-id>
/herdr ask <prompt>（pane 使用目前選定 Agent）；Discord 使用 ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr model <model>
/herdr model <agent-name-or-pane-id> <model>
/herdr read <agent-name-or-pane-id>
/herdr wait <agent-name-or-pane-id>
/herdr cancel <agent-name-or-pane-id>
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team list
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask [--coding] <prompt>
```

設定 `requireMention` 後，兩種 command 都必須 mention bot，例如 `@bridge agents` 或 `@bridge /herdr agents`。在已 mapping 的 thread 中，普通文字會被當作 active Agent 的 prompt；在頻道中選取 Agent（`agent use`）後，`@bot 文字` 也會送給該 Agent，無選取時 bot 會提示。
在 `bridge>` 執行 `agent use <pane>` 後，只保存對話目標，不自動刷出 CLI 畫面。本次發問只顯示相符的回答；`attach [pane]` 才顯示終端快照（40 行／6,000 字元），`watch [pane]` 顯示狀態變化，`detach` 回對話模式。檢視其他 pane 不改對話目標。blocked 問題仍會顯示並可回答。attach 是有界快照 inspector，不是完整 stdout/stderr 或原生 PTY attach；不自動送往 Discord。

直接輸入 `ask <文字>` 或非指令文字：idle/done 時發問，blocked 時回答 bridge 已顯示的問題。問題已變更或尚未顯示時，先看新問題再回答；同一問題不重複送答。`help`、`current`、`agent`、`agent use`、`wk` 等控制指令在 working／blocked 時仍可用；working/unknown 時不插入新 prompt。答案開頭若是指令名稱，請用 `ask current` 等明確格式。顯示輸出時保留正在編輯的輸入。多 Agent 以 team questions/reply 明確指定問題；Discord mirror 仍待做。

`bridge>` 的 Agent 選取以 workspace scope 保存；Discord user／thread mapping 仍各自獨立。請輸入 `agent use <pane ID>` 後再執行 `current`。

### 選擇 Agent

選擇 workspace 與選擇 Agent 是兩個不同動作。要把 Discord thread 導向
Herdr 中已經執行的 Agent，請依序輸入：

```text
@bridge agents
@bridge use w2:p1
@bridge current
```

`wk use <workspace>` 只會記錄 workspace route，不會移動、重啟或自動選擇
Agent。請使用 `agents` 清單顯示的 pane ID；如果不同 workspace 有同名 Agent
（例如都叫 `codex`），不要只輸入 Agent 名稱。

## 開發與驗證

```text
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

主要 output adapter 位於 `src/cli-adapter.ts`，Discord/Herdr routing 主流程位於 `src/main.ts`。

### Discord 與 bridge console 共用 mapping

在 `bridge>` 依序輸入 `threads`、`thread <清單中的 thread ID>`、`current`。
之後兩邊共用同一份 active Agent；Team 以 workspace 為 scope，任何授權 Discord thread 都能看到同一 Team。
選取會保存，重啟後仍有效。輸入 `thread off` 回到本機獨立路由。
未知或未授權 thread 會拒絕。本機回覆仍輸出在 pane；這不會啟用 Agent pane
直接對話的 Discord 鏡像功能。

正常啟動會在登入 Discord 前拒絕同一 bot 的第二個本機實例，鎖不依賴 workspace 或 config directory；Linux 即使異常退出也會釋放。舊版沒有此鎖，首次升級仍需先處理舊 bridge 程序。

附件目錄 `<cwd>/.herdr-discord-bridge/attachments/message-*` 超過 3 天會自動清理（啟動時與每 6 小時，本機與遠端皆是；ISSUE-043）。

## 遠端 Herdr 機器

用 `herdr machine add` 加入遠端機器後，在 plugin `config.json` 加入 `machines`（見 [設定範例](config.example.jsonc)）：`id`、`ssh`（`~/.ssh/config` 的 Host）與遠端 Herdr API socket 的絕對路徑 `socket`。bridge 會以 `ssh -L` 轉發該 socket，遠端 Agent 的 ID 帶 `<id>:` 前綴（如 `agy-pod:w2:p1`），沒帶前綴的一律是本機。支援文字對話與 Discord → 遠端 Agent 的附件（經 ssh 上傳到遠端 cwd）；不支援 Agent → Discord 的檔案回送與 `herdr-discord-send`。文字對話已驗收，遠端附件待驗收（ISSUE-041）。

## 可用 Agent 池與動態分工

在 plugin `config.json` 加入 `agentProfiles`（見 [設定範例](config.example.jsonc)），定義 CLI kind、可選的 model／args 及 capabilities。模型名稱需符合你的 CLI 與帳號。

```text
agent use <lead-pane>
team pool
team select
team bind helper <已存在的-worker-pane>
team ask <任務>
attach <worker-pane>
detach
```

`team select` 在 bridge pane 顯示編號勾選清單：輸入編號切換，`done` 儲存，`cancel` 取消；Discord 用 `team select <profile> on|off`。也可使用 `team add/remove profile:<id>`。
`team bind` 是重用既有 CLI 的選擇性步驟；未綁定的 profile 只有在 Lead 實際分派時才開 pane／啟動長駐 CLI。
Lead 自行決定角色、是否委派，以及依報告追加工作，無固定 coding pipeline；也可以不使用 Worker。

釋放任務租用或移出 Team 不會停止 CLI。Bridge 會核對 session identity，不能確認時不宣稱 context 延續；新 session 收到原任務與有界報告。
啟動送達不確定時不重試開 pane，需檢查後明確 bind。完整操作、限制與驗收見 [Agent Pool 與 console 架構](docs/agent-pool-console.md)。

## Durable Team Task（Phase 1）

`team ask <prompt>` 保存任務、Lead/session、凍結 roster、Assignment、事件與報告。`team ask --coding <prompt>` 才啟用本機 Git coding 驗收：單一 writer、不同已知 session review、版本指紋相符的 review／test 證據。Review 或 verify 期間工作樹若改變，該證據不算通過。旗標不會從 prompt 文字推論。它不 commit、不 push，write scope 也不是作業系統鎖。見 [本機 coding workflow](docs/coding-workflow-proposal.md) 與 ISSUE-025。
`team status [task-id]` 查看目前 workspace 的持久狀態；`team cancel <task-id>` 取消整個任務。Discord 使用 `/herdr` 前綴。
重啟後先核對 pane/session，標示 blocked/recoverable 或 unknown，不自動重送工作。取消只使用既有 Ctrl-C，確認停止後才 cancelled；不確定時保留 cancelling 與 reservation，不關閉 CLI。
Team 多 Agent 問題使用 `team questions <task-id>` 查詢、`team reply <task-id> <question-id> <answer>` 回答。詳見 [Phase 2 行為與限制](docs/team-question-queue.md)。一般單 Agent 問答不會繞過 Team reservation。
詳見 [架構、操作限制與 live 驗收](docs/durable-task-engine.md)及 ISSUE-020。

### 持久化 Session Handoff（Phase 3）

`handoff checkpoint <source> <goal>` 保存後，依序執行 `handoff verify <id> <destination> confirm-source-stopped`、`handoff accept <id>`、`handoff continue <id>`。以 `handoff status [id]`／`handoff packet <id>` 查詢；`handoff cancel <id>` 僅釋放已停止的交接，不殺 CLI。操作者須確認來源與背景 writer 停止；Bridge 核對同機同 workspace／工作樹、HEAD、dirty 內容與 session。詳見 [完整限制、adapter 與驗收](docs/session-handoff-runtime.md)。Phase 4 額度與切換政策見下方。

### Phase 4：Quota / Failover Manager

`failover arm <source> <candidate1,candidate2> <goal-and-constraints>` 保存任務與候選優先序；`quota report <pane> <available|limited|exhausted|unknown> <budget-group> [valid-seconds]` 記錄明確額度觀察。來源 limited/exhausted 會先建立 checkpoint，不呼叫來源模型。確認來源／背景 writer 停止後，`failover run <id> confirm-source-stopped` 選擇不同額度池且有新鮮 available 回報的目的地，驗證復原／工作樹、移交 ownership 再續作。`quota status`、`failover status [id]`／`cancel <id>` 可查詢／釋放。

第一版採操作者回報，沒有 provider quota API。過期、unknown、同額度池或衝突觀察不准派送；不改帳號／憑證，不重試不明送達。詳見 [完整指令、journal、限制及驗收](docs/quota-failover-manager.md)。

Discord 回覆擷取遇到原 Agent 或已知 session 資料暫時消失時，會等待最多 30 秒重新核對；確認原 identity 後才續接，明確 session 更換仍停止。沿用 Discord 舊 thread 只會路由到 live pane，不會還原舊 CLI 對話。實際驗收仍待完成（ISSUE-003／008）。

Claude 圖片交付已改為本機路徑交付（2026-10-05，待 Discord 實機驗收）。Herdr 未回報 Claude session identity 時，coding reviewer、
session handoff／failover 保持已知 session 的要求；不猜測最近歷史檔。Claude
實際 Discord 回覆仍待驗收，詳見 [ISSUE-026](docs/known-issues.md)。

## 回送檔案到 Discord

Agent 可在最終回覆中單獨一行寫 `[[discord-attach: /絕對路徑]]`，Bridge 會把檔案以附件送回 Discord。檔案須為一般檔案、非空、每個 ≤ 8 MiB、每則至多 10 個，且位於 Agent 工作目錄之下（`.env`、`.git` 等敏感路徑會被拒絕）。請在 Agent 的 `AGENTS.md` 告知此約定。詳見 SPEC.md 與 ISSUE-034。

直接在 Herdr 對 Agent 說話時，Agent 也能請 bridge 送到對應的 Discord thread：訊息用 `[[discord-send]]`／文字／`[[/discord-send]]`，檔案用 `[[discord-attach: /路徑]]`；Agent 轉為 idle 時由 bridge 代送（ISSUE-037，待實機驗收）。

標記約定已包成 [discord-send skill](skills/discord-send/SKILL.md)；請連結到 Agent 的 skills 目錄（如 `ln -s "$PWD/skills/discord-send" ~/.claude/skills/discord-send`），各專案的 Agent 才會知道。

### Hook 通道（Claude、Codex）— ISSUE-045

預設 bridge 從終端畫面解析回覆（parser）。CLI hook 能直接提供回覆內容與權限請求，比較可靠。**hook 優先，parser 永遠保留為備用**，所以 hook 沒裝或事件遺失都不會壞掉。

| CLI    | 要開啟的 hook                                                                           | 設定位置                                                                                                                                                        | 額外步驟                                                                                    |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude | `Stop`、`PermissionRequest`                                                             | `~/.claude/settings.json`                                                                                                                                       | 無                                                                                          |
| Codex  | 只開 `Stop`（權限走 `y`／`esc` 快捷鍵；開 `PermissionRequest` 會擋住 Codex 的核准提示） | `~/.codex/hooks.json`                                                                                                                                           | 在 Codex 內輸入 `/hooks`，信任這一項（信任前會被略過）                                      |
| agy    | 只開 `Stop`（權限仍走畫面 parser）                                                      | `~/.gemini/config/hooks.json`（群組 `herdr-discord-bridge`：`{ "Stop": [{ "command": ".../scripts/herdr-discord-hook", "timeout": 10, "type": "command" }] }`） | 無                                                                                          |
| pi     | 擴充 `agent_settled`（pi 沒有內建權限提示）                                             | `~/.pi/agent/extensions/herdr-discord-bridge.ts`                                                                                                                | `cp scripts/pi/herdr-discord-bridge.ts ~/.pi/agent/extensions/`，再重開 pi 或輸入 `/reload` |
| 其他   | 尚不支援                                                                                | —                                                                                                                                                               | 只用 parser                                                                                 |

兩個事件都指向 `scripts/herdr-discord-hook` 的絕對路徑（`Stop` 逾時可短，`PermissionRequest` 建議約 300 秒）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/絕對路徑/scripts/herdr-discord-hook",
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/絕對路徑/scripts/herdr-discord-hook",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

- 用 Discord 的 `@bot hooks` 或 `bridge>` console 的 `hooks` 查看目前模式與各事件是否已註冊。Codex 的信任狀態無法偵測，請在 Codex 內用 `/hooks` 確認。
- 在 plugin `config.json` 依 CLI 選擇通道：`"hookTransport": { "claude": "auto", "codex": "auto" }`。`auto`（預設）＝hook 優先、缺事件退回 parser；`parser`＝該 CLI 忽略 hook。改完需重啟 bridge。
- 有 hook 時，在核准 thread 回覆 `allow`／`deny`（或按核准按鈕）即可回答權限請求；其他文字（含選項數字）照舊打進 TUI。權限 hook 只有 CLI 真的詢問時才觸發（Claude 的 auto mode 不會詢問；Codex 只在需要核准的指令才詢問）。
- bridge 必須在執行中 hook 才有作用；沒有 bridge 時 hook 靜默結束，TUI 照常使用。

建議 Agent 使用 `herdr-discord-send` 指令（`scripts/herdr-discord-send`，請連結到 PATH，如 `ln -s "$PWD/scripts/herdr-discord-send" ~/.local/bin/herdr-discord-send`）：`herdr-discord-send "文字"`、`--file 路徑`、`--stdin`。它經由僅限本機使用者的 socket（`~/.config/herdr-discord-bridge/send.sock`）請執行中的 bridge 發送，以 `HERDR_PANE_ID` 識別 pane；pane 沒有對應 thread 時會明確報錯。待實機驗收（ISSUE-037）。

傳入附件：除 PNG/JPEG/WebP 圖片外，其他 Discord 檔案（≤ 10 MiB、每則至多四個）會存到 Agent cwd 並把路徑交給 Agent（ISSUE-039，待實機驗收）。
