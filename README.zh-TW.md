# Herdr Discord Bridge（繁體中文）

從 Discord 控制已在 Herdr pane 中執行的 coding agent。Bridge 使用 Discord outbound Gateway WebSocket 與 Herdr local socket，不提供公開 HTTP endpoint，也不會取代 Herdr 的 PTY/runtime。

[English](README.md) | 繁體中文

## 安裝與啟動

從 GitHub 安裝並啟用 plugin：

```text
herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
herdr plugin enable herdr-discord-bridge
```

取得設定目錄並建立設定檔：

```text
herdr plugin config-dir herdr-discord-bridge
cp config.example.jsonc <config-dir>/config.json
```

在 `config.json` 填入 Discord bot token，以及明確的 guild/channel/user allowlist。也可以使用 `HERDR_DISCORD_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN` 環境變數。不要把真實設定檔或 token commit 進 Git。必須在 Discord Developer Portal 開啟 Message Content Intent。

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

要暫停 Discord command 與 approval 處理但保持 bot 連線，可使用：

```text
/herdr discord disable
/herdr discord status
/herdr discord enable
```

只有 `discord.allowedUserIds` 內的 user ID 可以變更狀態。重建 script 會把 bridge
放在 tab 1 但不 focus；保留原本的 active tab，之後開啟的其他 Agent pane 就不會
因為重建流程被帶到 tab 1。

## 回覆擷取行為

每次收到 prompt 時，bridge 會先記錄 Herdr terminal snapshot，然後只轉送該 prompt 之後產生的最新回覆，不會重送 prompt 以前的歷史內容。

不同 CLI 的 prompt 格式由 adapter 分開處理：

- Codex：`› prompt`
- Antigravity / `agy`：`> prompt`
- OpenCode：`> prompt`
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
/herdr team ask <prompt>
```

設定 `requireMention` 後，兩種 command 都必須 mention bot，例如 `@bridge agents` 或 `@bridge /herdr agents`。在已 mapping 的 thread 中，普通文字會被當作 active Agent 的 prompt。
在 `bridge>` 執行 `agent use <pane>` 後，會保存目前 workspace 與 active Agent，並自動顯示該 Agent 的可見畫面、進度與追問。不需另開 mirror 或先進入 blocked。輸出以 Agent／workspace／pane 標示，限制 40 行／6,000 字元，有變化才更新；這是 terminal 節錄，不保證完整歷史或 final，也不自動送到 Discord。

直接輸入 `ask <文字>` 或非指令文字：idle/done 時發問，blocked 時回答 bridge 已顯示的問題。問題已變更或尚未顯示時，先看新問題再回答；同一問題不重複送答。`help`、`current`、`agent`、`agent use`、`wk` 等控制指令在 working／blocked 時仍可用；working/unknown 時不插入新 prompt。答案開頭若是指令名稱，請用 `ask current` 等明確格式。顯示輸出時保留正在編輯的輸入。多 Agent 問題識別／排隊與 Discord mirror 仍待做。


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
