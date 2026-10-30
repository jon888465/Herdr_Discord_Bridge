# CI

更新日期：2026-10-30。Workflow：`.github/workflows/ci.yml`。問題與驗收追蹤：[ISSUE-052](known-issues.md)。

> **狀態：已加入原始碼，尚未在 GitHub 上對 `main` 執行過。** 只有 workflow 檔存在，不代表 CI 已通過；`main` 的 branch protection 尚未設定，CI 目前不是必要檢查。

## 執行內容

`pull_request`、`main` 的 push、`workflow_dispatch` 觸發。Ubuntu 與 macOS matrix、Node 22，依 lockfile `npm ci`，依序 `npm run typecheck`、`npm run lint`、`npm test`（內含 build）。每個 job 最長 10 分鐘。兩個平台各自產生結果，不能把 Linux 通過當成 macOS 已通過。

權限只有 `contents: read`，checkout 不保留 credentials，不使用 Discord token 或模型 credentials，不部署、不送 Agent prompt。

## 不使用 `paths-ignore`

舊版（未合併分支 `followup-team-question-ui-ci`，PR #1）設有 `paths-ignore: **/*.md`。若把 CI 設為 `main` 的必要狀態檢查，只改文件的 PR 不會觸發 workflow，檢查會永遠停在等待狀態而無法合併。因此本版移除，文件 PR 也會跑完整套件（約 1 分鐘級，公開 repo 的標準 runner 免費）。

## 來源與取捨

- 取自 PR #1 的 `e7b9118`，只取 workflow 與本文件。PR #1 另含約 940 行 Team 答覆介面功能與 macOS Bash 修正，且比 `main` 落後 120 個 commit，未合併、未重用。
- `main` 現行的 `scripts/run.sh` 已不使用 macOS 系統 Bash 缺少的功能（以 `grep` 確認原始碼無相關用法）；是否在 macOS runner 全數通過，必須看實際 run，不由本機結果推定。
- 採用 `actions/checkout@v7`、`actions/setup-node@v7`（以 tag 引用，與 2026-09-20 成功的 run 相同）。作為自動 merge 閘門前，應改為釘住 commit SHA 並啟用 Dependabot 更新，目前未做。

## 本機檢查（2026-10-30，macOS，Node v26.12.0，非 CI 環境）

`npm ci`、`npm run typecheck`、`npm run lint` 通過；`npm test`：286 項，285 通過、0 失敗、1 略過。這不是 CI 結果：Node 版本（CI 為 22）與作業系統環境不同。

## 歷史（舊分支）

2026-09-20 PR #1 分支上 run `35509147934`：Ubuntu 206/206、macOS 205 通過加 1 略過。該結果屬舊程式，不能當成目前 `main` 的結果。

## 尚未完成

- 在 GitHub 實際執行並記錄 `main` 的 Ubuntu／macOS 結果。
- 設定 branch protection 或 ruleset，將本檢查設為必要。
- 處理 PR #1（關閉或改 base）。
- 釘住 action SHA。
