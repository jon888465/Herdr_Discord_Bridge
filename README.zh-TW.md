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

三種模式都會讓 tab 1 專門給 Discord bridge 使用。如果 tab 1 已有其他 Agent pane，script 會建立或重用 `Agents` tab 並將它們搬過去；bridge 與 Agents tab 都不會被 focus，因此之後開啟的 Agent 不會被放到 tab 1。它不會修改 plugin 設定或 Discord token。

```text
./scripts/run.sh       # 只啟動，不 rebuild 或 reinstall
./scripts/run.sh -r    # npm ci、build，並執行本地 checkout
./scripts/run.sh -rg   # 從 GitHub 重新安裝 main 並啟動
```

三種模式都會找出並關閉既有 Discord bridge pane，使用 tab 1 的既有 pane 作為 split target，最後將新的 bridge pane 開在 tab 1。script 不會 focus bridge，因此之後開啟的其他 Agent pane 不會因重建流程被帶到 tab 1。它不會修改 plugin 設定或 Discord token。

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
/herdr ask <agent-name-or-pane-id> <prompt>
/herdr target <agent-name-or-pane-id>
/herdr assign <agent-name-or-pane-id> <prompt>
/herdr model <model>
/herdr model <agent-name-or-pane-id> <model>
/herdr read <agent-name-or-pane-id>
/herdr wait <agent-name-or-pane-id>
/herdr cancel <agent-name-or-pane-id>
/herdr handoff <from-agent> <to-agent> [instruction]
/herdr team add <agent-name-or-pane-id>
/herdr team remove <agent-name-or-pane-id>
/herdr team ask <prompt>
```

設定 `requireMention` 後，兩種 command 都必須 mention bot，例如 `@bridge agents` 或 `@bridge /herdr agents`。在已 mapping 的 thread 中，普通文字會被當作 active Agent 的 prompt。

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
