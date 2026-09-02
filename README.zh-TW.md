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
./scripts/rebuild-and-run.sh
```

這個 script 會執行 `npm ci`、`npm run build`、找出並關閉 Discord bridge pane、unlink 舊 plugin、link 本地 plugin，最後開啟新的 bridge pane。它不會修改 plugin 設定或 Discord token。

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
```

切換不會重啟 pane 或清除對話；Agent 工作中時會拒絕切換。實際的 model
command 由 CLI adapter 處理，避免 Codex、Antigravity（`agy`）與其他 CLI
互相使用錯誤語法。

`/herdr model` 會顯示 Discord dropdown，列出該 CLI adapter 的 model 選項；也
可以直接指定 model 名稱。model 名稱仍需符合該 CLI 支援的名稱。

## 回覆擷取行為

每次收到 prompt 時，bridge 會先記錄 Herdr terminal snapshot，然後只轉送該 prompt 之後產生的最新回覆，不會重送 prompt 以前的歷史內容。

不同 CLI 的 prompt 格式由 adapter 分開處理：

- Codex：`› prompt`
- Antigravity / `agy`：`> prompt`
- 未知 CLI：使用保守的通用 adapter

model/path 等 terminal UI metadata 會被過濾。如果找不到可靠的 prompt 邊界，bridge 不會把整份歷史 snapshot 當作回覆轉送。

Agent 完成後，回覆會更新原本的 progress message；預設不會另外發送 `done` 通知。只有 `blocked` 狀態會依設定發送額外通知。

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
