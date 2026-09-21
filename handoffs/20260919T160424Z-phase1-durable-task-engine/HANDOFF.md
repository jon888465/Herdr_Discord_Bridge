# Phase 1 Durable Task Engine — OpenCode checkpoint

2026-09-21 合併註記：本文保留 2026-09-19 的交接與授權歷史；本輪使用者已另行授權將 Phase 1 合併至 main。原 Phase 1 ISSUE-018 因與 main 的 macOS 問題重號，統一改為 ISSUE-020；最新合併驗證見 known-issues。

## Identity and ownership

- Handoff ID: 20260919T160424Z-phase1-durable-task-engine
- Prepared at: 2026-09-19T16:04:24Z
- State: checkpoint-only. 使用者說可能轉給 OpenCode，尚未發生／宣稱 takeover。
- Source: ChatGPT Work / Codex；版本及 exact session ID 未暴露，unknown。不是本機 Codex CLI rollout。
- Workspace: `/workspace/scratch/606aee077653/Herdr_Discord_Bridge`
- Repository: `https://github.com/jon888465/Herdr_Discord_Bridge`
- Branch: `phase1-durable-task-engine`；checkpoint 時 HEAD `e6cc552bb843e5345ba844eca712bd53e8a09e39`。
- Destination: OpenCode（使用者預計）；destination session／workspace unknown。
- Source writing: 正在收尾 commit；尚未標 ready。接收端需等本次來源回覆結束並核對最新 Git，再成為唯一 writer。
- Other writers: 本輪沒有 sub-agents。所有啟動的 build／test command 已結束；外部使用者／其他機器 writer 狀態 unknown。
- Scope: Phase 1 程式、測試、文件及後續驗收；不得修改／merge main，不包含 Phase 2 問題佇列。
- Limit signal: 使用者於本輪回報「用量快結束記得使用handoff skill，預計可能轉給opencode」。Provider quota 精確數值、單位及 reset time unknown；不是由 elapsed time 推估。

## Goal and constraints

實作 durable Team Task（ID／workspace／Lead session／原 prompt／frozen roster／assignments／timestamps／state）、狀態機、event journal、atomic persistence、restart reconciliation、whole-team cancellation、tests 與文件；commit 到指定分支。

開始先讀 `AGENTS.md`、`SPEC.md`、`CONTEXT.md`、`docs/known-issues.md`、相關原始碼／tests。
保留 Lead 動態分工、多輪 replanning、零 Worker 直接處理、AgentPool lazy start／existing-session reuse、ISSUE-014 response correlation／settlement、console conversation/attach/watch。
不固定 Planner→Coder→Reviewer→Tester，不加入 Phase 2 question queue，不把 unit tests 當 live 驗收。
使用者已授權實作、測試、文件及 branch commit。沒有授權部署／重啟使用者 Bridge、merge main、切換帳戶或發送他人訊息。

## Recovery evidence

- 沒有可定位的原生 session 或 export。使用本 packet + Git source + ISSUE-020 復原；不能聲稱完整對話／模型 context 已移轉。
- `docs/durable-task-engine.md` 是當前架構與 live acceptance 清單。
- `docs/known-issues.md` ISSUE-020 包含完整、targeted、中途失敗及限制；ISSUE-014／015／016 live 狀態保持未驗收。
- 決策：沿用原 scheduler 事件；Engine 管理 durable state／reservation／cancel，不另建 Assignment lifecycle。
- Version-1 每 task journal 保存完整 after-image，atomic temp+fsync+rename；未知版本／損毀 fail closed。
- Restart 只 reconcile，不 auto-resume／replay；same-session 不證明原 turn 還在跑。
- Cancel 先阻止派送，等待 in-flight acquisition／prompt，核對 active turns 後官方 Ctrl-C；不確定則 cancelling，不殺 pane／CLI。
- 對 recovered active turn 不自動 Ctrl-C，需人工核對停止，再 team cancel 清理。
- Herdr cancel primitive 改 retries:0，避免 acknowledgement 遺失後重複 Ctrl-C。

## Current work

已完成且經 fixtures 驗證：

- 新增 `src/team-task-store.ts`、`src/team-task-engine.ts`、`test/team-task-engine.test.ts`（21 tests）。
- 更新 `src/main.ts`、`src/team-orchestration.ts`、`src/team-turn.ts`、`src/herdr.ts`。
- 新增 `team status [task-id]`、`team cancel <task-id>`；普通 cancel／blocked reply 不繞過 Team ownership。
- 同步 SPEC、CONTEXT、README 雙語、known issues、Agent Pool/pending docs、orchestration spec/plan，新增 durable-task-engine.md。
- checkpoint 時上述 17 檔已 staged、無其他 unstaged 變更；本 checkpoint 是新檔，預計與此次變更一起提交。收件者應以實際 git status／log 為準。
- 原 checkout 初始乾淨；未覆蓋使用者修改。
- Build 已完成。真實 running Bridge commit unknown；未部署／重啟；沒有 live Discord／Herdr／CLI 驗收。
- 暫存 log 在來源 `/tmp/herdr-phase1-targeted.log`、`/tmp/herdr-phase1-final-full.log`；可能不隨機器轉移。必要數字及原因已寫入 ISSUE-020，不能假設目的端有 `/tmp` log 或 `node_modules`／`dist`。

## Verification and continuation

2026-09-19、以上 checkout、此次 staged 實作：

- `npm run typecheck` PASS；`npm run build` PASS；`npm run lint` PASS（42 TS files）。
- Targeted：`node --test dist/test/team-task-engine.test.js dist/test/team-orchestration.test.js dist/test/agent-pool.test.js dist/test/console-conversation.test.js dist/test/local-agent.test.js` **63/63 PASS**。
- `npm test`：build PASS，既有 socket `listen EPERM`，instance-lock 子程序等 ready 卡住；手動中止 exit 130，無完整總數。
- 完整 compiled suite：`node --test --test-timeout=15000 dist/test/*.test.js` **112：106 pass、5 fail、1 cancelled**，exit 1。5 fail = 2 Herdr socket + 3 instance-lock；1 cancelled = killed-owner fixture 15 秒 timeout。原因是本執行環境無法 listen Unix socket／abstract IPC。沒有修改既有測試 assertion／timeout 來假裝通過。
- TS Prettier check、git diff --check PASS；45 個本機 Markdown links 存在。
- 中途 TS2739／TS2749 已修；最終 typecheck PASS。

第一個動作（唯讀）：在目的端 checkout 執行 `git branch --show-current`、`git log -3 --oneline`、`git status --short`，確認最新 Phase 1 commit 與來源已停止 writing；**不要 reset／覆蓋目的端修改**。

剩餘順序：

1. 若來源尚未 commit，先確認 staged diff／ownership，再依原授權完成 branch commit；若已有 Phase 1 commit，不重做實作。
2. 在允許本機 Unix socket 的環境執行 `npm ci`、`npm run typecheck`、`npm run build`、`npm run lint`、原始 `npm test`；記錄真實結果，更新 ISSUE-020／ISSUE-007，不能沿用受限環境結論為全部通過。
3. 做程式 review；發現 defect 先重現、修正並同步 issues。保持 ISSUE-014 回歸。
4. 經使用者授權部署／重啟後，依 durable-task-engine.md 驗收真實多輪／零 Worker／lazy start／reuse／restart／cancel／console；未授權不要操作真實 session。
5. 更新 receiving receipt；不 merge main。Phase 2 仍未授權實作。

已知限制：無 auto-resume、multi-Agent question queue、journal retention/compaction/migration、跨 bot writer lock、durable Discord delivery；Windows rename／power-loss 未驗。Cancel 等待既有 atomic prompt 可能長達 approvalTimeoutMs + transport overhead；Herdr 無原子 compare-session-and-cancel，外部 pane 操作仍有競態。

## Receiving receipt

- Accepted/blocked at / destination session: not yet accepted.
- Verified destination workspace / HEAD / diffs: pending.
- Reconciled differences / uncertainty: pending; source native transcript unavailable.
- Writer ownership evidence: pending; wait for source final response and verify no overlapping writer.
- Accepted scope / next action / result: pending.

## Source milestone after checkpoint

- 2026-09-19：實作及本 packet 已 commit：`ed56de021703004b4144253e4e97dd35f61110fd`，message `feat: add durable team task engine with recovery and cancellation`。
- 本節另以 handoff 文件 commit 保存。上述 checkpoint 時的 base/staged 紀錄是歷史，不代表目前仍待 commit。接收端第一步仍核對最新 git log/status，不重做 implementation commit。
- 原始碼 commit 後工作樹乾淨、指定分支 ahead origin 1。
- **Push 未完成**：automatic approval review 拒絕 `git push origin HEAD:refs/heads/phase1-durable-task-engine`，理由是使用者授權 local branch commit，未明確授權將完整 source 送至外部 GitHub 並更新 remote branch。不得換工具繞過；需使用者明確同意 push 後才可重試。
- 沒有 merge／修改 main、沒有部署／重啟或額外背景 writer。来源在最終回覆後停止本輪寫入；接收端仍應核對實際狀態。
- 這份 packet 仍是 checkpoint-only；尚無 OpenCode receiving receipt，不宣稱 takeover 成功。
