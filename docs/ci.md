# CI 與啟動入口

2026-09-20。Workflow：`.github/workflows/ci.yml`；完整結果追蹤在 [ISSUE-021](known-issues.md)。

## 執行內容

Pull request、main push、workflow_dispatch 執行 Ubuntu／macOS matrix，Node 22，依 lockfile `npm ci`，依序 typecheck、lint、原始 `npm test`（內含 build）。每個 job 最長 10 分鐘，只限制掛起工作，不跳過 IPC tests、不改寫 assertion／test timeout。兩個平台各自產生結果；不能把 Linux 通過當成 macOS 已通過。

Workflow 只需 contents:read，checkout 不保留 credentials，不使用 Discord bot token／模型 credentials，不做部署或 Agent prompt。PR 只含 Markdown 時不觸發重跑；文件後續記錄的 code commit／run 是測試證據，不把新的文档 HEAD 說成已重跑。

採用官方 [checkout](https://github.com/actions/checkout) 與 [setup-node](https://github.com/actions/setup-node) 的 v7 介面；workflow 事件與執行方式參考 [GitHub Actions 文件](https://docs.github.com/en/actions/get-started/quickstart)。未發出 workflow run 時只能說 CI 已配置，不能宣稱全套通過。

本地 IPC 禁止 listen 的環境可執行 `npm run build` 後 `node --test --test-timeout=15000 dist/test/*.test.js` 收集失敗。它會保留 EPERM／timeout 的失敗結果，不能代替原始 npm test gate。實機需要 rerun npm test，且不能因 fixtures 通過宣稱已重啟 Bridge。

## 啟動入口修正

TypeScript `rootDir: "."` 產生 `dist/src/index.js`；原 package.json 的 bin/start/dry-run 卻指向不存在的 `dist/index.js`。已統一 npm scripts／bin／lockfile 至實際路徑，並在 src/index.ts 加上 Node shebang，與 Herdr manifest 使用同一入口。

入口測試在臨時設定中明確停用 Discord，確認 npm start 與 packaged bin 到達正確設定驗證並以 exit 1 回報 disabled；不連線 Discord、Herdr 或使用真實 token。這只測試入口可達與啟動拒絕，不代表 dry-run watcher 或 live Bridge 已運行。
