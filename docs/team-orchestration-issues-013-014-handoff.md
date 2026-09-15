# ISSUE-013／014：Herdr 委派方法與修正交接

更新：2026-09-11。已依交接內容完成程式修正；完整 repository 驗證與 live
Discord／Herdr 驗收仍待完成。
問題狀態以 [known-issues.md](known-issues.md) 為準。

## 使用者提供的方法

### 1. CLI／Socket API 腳本化分派

使用者提供的流程為建立 pane、啟動 Agent、送 prompt、等待完成或 blocked：

```bash
# 以下為使用者提供的原始範例，不代表目前版本全部接受
herdr pane split --right --run "claude"
herdr agent prompt w1:p2 "請幫我重構 src/auth.ts 中的驗證邏輯"
herdr agent wait w1:p2 --until done
herdr agent wait w1:p2 --until blocked
```

重點是主控流程須真正等到被指派的 Agent 完成本次工作，再收回結果及統整；
blocked 應明確回報，不能當作完成。

### 2. A2A Task Delegation

使用者描述的進階方法：主編排 Agent 在任務過大或 context 不足時，透過
Herdr 委派子 Agent；以 `herdr --skill` 取得技能說明，使用 `@codex`／
`@claude` 呼叫子 Agent，自動建立 split pane 或 tab，背景監聽完工，
驗收與整合後回收 pane。另提及 `herdr-dispatch-skill` 一類社群工具，
涵蓋「寫任務書 → 派單 → 監聽完工 → 驗收回收」。

這是待核對的設計參考：尚未取得該社群工具的確切 repository／版本，也未
確認目前 Herdr 原生支援上述 @agent 自動建立與回收行為。不得據此把它
描述為 bridge 已實作功能；本輪沒有建立／關閉 pane 或向其他 Agent 派單。

## 已安裝 Herdr 的核對結果

2026-09-11，在 `HERDR_ENV=1` 的環境以只讀命令核對：
`herdr --version` 回報 **0.8.0**；另讀取 `herdr --help`、`herdr agent`、
`herdr pane`、`herdr --skill`、`herdr api` 與 `herdr api schema --json`。
本節來源為已安裝 binary 的 help／skill，未執行真實任務驗收。

| 項目            | 目前版本的說明／限制                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 分割 pane       | `herdr pane split --current --direction right --cwd "$PWD" --no-focus`；help 未列出 `--right --run` 組合            |
| 啟動 Agent      | `herdr agent start reviewer --kind claude --pane <新建 pane ID>`；需要既有可用 shell pane，不自動建立 layout        |
| 分派並等待      | `herdr agent prompt reviewer "任務內容" --wait --timeout 120000` 是內建 skill 建議的一般工作方式                    |
| 等待狀態        | `agent wait` 支援 `--until`／`--timeout`；預設 settled 為 idle、done、blocked                                       |
| idle／done      | 都涉及底層 idle；done 表示背景工作完成但 tab 尚未被查看，focus 會影響顯示，不能只等待 done                          |
| prompt --wait   | 說明要求從非 working 送 prompt 後五秒內觀察到 lifecycle change，否則 `agent_prompt_stalled`；仍非個別 turn 完成證明 |
| @agent 自動委派 | 此次 help／skill 未列出使用者描述的自動 split／tab／回收模式；不能推論所有版本或外部工具都不支援                    |
| Socket schema   | 已確認 agent.prompt／agent.wait 對應 AgentPromptParams／AgentWaitParams；`prompt(wait=...)` 的 settled 回傳直接作為本次 dispatch 狀態 |

因此應優先評估官方原子 prompt-with-wait 能否解決送出後仍讀到舊狀態的
時間差；仍需獨立核對本次回覆，不能把 lifecycle wait 當成 task/report 關聯。
目前正式 client 已加入 socket 原子 `agent.prompt` wait 欄位，舊版不支援時
fallback 到 `promptAgent` 加 `agent.wait`。完整 API 錯誤／重試的 live 行為
仍需驗收。

## 要修正的問題

### ISSUE-013：誤取 prompt 範例或歷史 JSON

失敗 Task：`task-05f771d6-7b47-48de-afed-900f8c2c060e`，原問題為
「討問1:1:N目前功能與實做問題」，Lead Codex，Workers agy `w2:p6`、
OpenCode `w2:p8`。實際 plan 是 `short-id / w2:p6 / boundedtask`，
與提示範例一致，缺少真正針對問題的拆解。

已重現的程式缺陷：擷取不到 Lead 回覆時，fallback 解析整段 transcript，
只含 prompt 範例也能啟動 Worker 並走到統整。必須只接受本次 Lead 完成的
回覆；範例、echo、舊 JSON、尚未完成的 commentary 均不能觸發 dispatch。
先前 JSON 終端折行問題與修正保留，但不代表本項已解決。

### ISSUE-014：沒有等 Worker 完成本次工作便統整

同一 Task 的 report 標為 done，內容卻是舊 GUI／mirror 討論、commit
指令、舊 13/13 測試與 working tree clean 宣稱。使用者補充實際沒有等待
Agent 結束並回報，就進入 Lead synthesis。

已重現的程式缺陷：一次 wait 的 idle/done 加上任意舊 terminal read 即可
標記 done；缺乏本次 dispatch／完成／report 關聯。不能據此斷言當時 Herdr
內部時序，因尚無原事件的 socket trace／狀態時間戳。

要求：等到所有必要 Assignment 的有效本次報告，才可作完成統整。
失敗／blocked 可產生明確標示的 partial synthesis；舊輸出、空報告或只有
idle/done 不可冒充完成。Lead synthesis 自身也須等到本次完整回覆。

## 修正與驗證

已套用並完成 targeted 驗證的修改；live 驗收仍待完成：

- `src/team-turn.ts`：新增共用 turn 接收器；每次請求隨機 begin/end 標記、
  各來源 baseline、Codex matching final、等待 deadline 與 identity 檢查。
  在 prompt 中先說明 end 再說明 begin，避免單純 echo 構成完整回覆。
- `src/team-orchestration.ts`：planning／Worker／synthesis 接入接收器，
  移除可直接採用的示範 JSON，排除整段 transcript fallback；同 Worker
  每 wave 最多一個 Assignment；有失敗報告時 task 不標 completed。
- `src/main.ts`：failed／blocked 的輸出明示 partial synthesis。
- `src/herdr.ts`：使用 Herdr 0.8 `agent.prompt` 的 `wait` options，舊版 fallback。
- `test/team-orchestration.test.ts`：增加 prompt echo、歷史 report、兩 Worker
  不同完成時間與 marker／structured final 回歸。
- `test/herdr.test.ts`：增加 `agent.prompt` wait socket 回歸。

2026-09-11 已執行：

```bash
npm run build && node --test --test-name-pattern='ISSUE-01' dist/test/team-orchestration.test.js
```

補丁前 **0/2 通過**：prompt echo 被接受（Missing expected rejection），
舊 Worker report 得到 done 而非 failed。補丁後 **2/2 通過**，build 通過。
之後 targeted orchestration／Herdr 合計 **14/14 通過**（2026-09-11），
包含兩個 Worker 的延遲完成順序與官方 prompt wait request。

完整 repository 檢查已執行：typecheck、build、lint 與 diff check 通過；
`npm run check` 為 72/73。先前同日 70/70 屬前一版歷史結果，不能套用；
本次 14/14 是 targeted 結果。
2026-09-11 另執行 `npm run check`，結果 72/73；唯一失敗為既有
`instance-lock.test.js` 真實入口測試 10 秒 timeout（exit code 預期 `1`、
實際 `null`），與本次 orchestration 變更無關，不能宣稱完整套件全通過。
本次新接收器對標記遵循、截斷輸出、structured transcript 未完成與不相容
格式的處理仍需 review／測試；未經驗收，不宜直接部署此中斷版本。

原始碼與 checkout build 已更新；執行中 bridge 未由本輪重啟／部署，
未 commit／push。既有其他修改均保留，失敗 task 不自動續跑或補送。

## 續作順序與驗收

1. Review 已完成的 turn 接收器與標記方案；確認 pending structured final
   不會退回採用 echo，marker 被折行／截斷時不誤收或誤派。
2. 補足 Lead 延遲回覆、Worker 初始仍 idle → working → done、空／歷史 report、
   不同完成時間的兩 Worker、blocked／timeout／identity 更換、synthesis 自身
   等待等測試。Worker 未完成前必須斷言沒有 synthesis prompt。
3. 執行 SPEC 要求的完整檢查，保留失敗與修正證據，再安排授權範圍內的 live
   驗收，記錄 Task／Assignment／pane／session 與各階段時間戳。
4. 若要引入使用者提出的 A2A 自動建立／回收，先取得工具來源與版本，另行
   定義 ownership、cleanup、權限與 topology 契約；不擴大本次兩 issue 的修正。
